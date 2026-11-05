import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { availableQty, lockPairs, pairKey, plannedLines } from '../../core/material-issue/planned-stock';
import { MaterialIssueReleaser } from '../../core/material-issue/release-request';
import { recordRequestAudit } from '../../core/material-issue/request-lifecycle';
import { chooseSources, resolveCandidates } from '../../core/material-issue/source-warehouse';
import { NumberingService } from '../../core/numbering';
import { PickingHandoverNotifier } from '../../core/picking';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterialIssueRequestView, materialIssueRequestLineView, materialIssueRequestView } from './material-issue-request-view';
import { MaterialIssueRequestCreate } from './material-issue-request.service';

/** 다른 W/O 의 예정분을 확인 뒤 가져갈 수 있는 사유(FR-017). */
const OVERRIDE_REASONS = ['URGENT_WO_RESPONSE', 'SHORTAGE_SUPPLEMENT'];
const ZERO = new Prisma.Decimal(0);

interface Conflict {
  itemId: number;
  sourceWarehouseId: number | null;
  requestedQty: number;
  freeQty: number;
  takeFromPlannedQty: number;
  overridable: boolean;
  noStockedWarehouse?: boolean;
  affectedRequests: { issueRequestNo: string; workOrderNo: string; issueWorkDate: string | null }[];
}

export interface PlannedCreateResult {
  materialIssueRequest: MaterialIssueRequestView;
  lines: ReturnType<typeof materialIssueRequestLineView>[];
  requests: MaterialIssueRequestView[];
}

/**
 * 생산 창고를 쓰는 공장의 추가 출고 요청(W-02-10 · 피처 003 · research R-13, FR-011·017·018).
 *
 * 출발 창고를 고르지 않으면 자재마다 배포와 같은 규칙으로 채우고 창고별로 요청을 나눈다. 쓸 수 있는 양(가용 − 예정)을
 * 넘으면: 긴급 대응·부족 보충은 가져갈 예정분이 있을 때만 확인(acceptPlannedOverride) 뒤 실제 가용까지 가져가고
 * (다른 요청에 동적 부족 · 이력), 가져갈 예정분이 없거나 그 밖 사유면 쓸 수 있는 양까지만 담는다(0 이면 409).
 * 만든 요청은 바로 배포한다(FR-005).
 */
@Injectable()
export class PlannedManualRequestCreator {
  private readonly releaser: MaterialIssueReleaser;

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    documentState: DocumentStateService,
    pickingNotices: PickingHandoverNotifier,
  ) {
    this.releaser = new MaterialIssueReleaser(documentState, pickingNotices);
  }

  async create(input: MaterialIssueRequestCreate, appUserId: number, plantId: bigint): Promise<PlannedCreateResult> {
    const plan = await this.prepare(input, plantId);
    const count = plan.warehouseIds.length;
    const requestNos = await this.numbering.nextMany('MATERIAL_ISSUE_REQUEST', plantId, input.businessDate, count);
    const pickingNos = await this.numbering.nextMany('PICKING_ORDER', plantId, input.businessDate, count);
    const ids = await this.prisma.$transaction((tx) => this.write(tx, input, appUserId, plan, requestNos, pickingNos));
    const rows = await this.prisma.material_issue_request.findMany({ where: { material_issue_request_id: { in: ids } }, orderBy: { material_issue_request_id: 'asc' } });
    const lines = await this.prisma.material_issue_request_line.findMany({ where: { material_issue_request_id: ids[0] }, orderBy: { line_no: 'asc' } });
    const views = rows.map((row) => materialIssueRequestView(row));
    return { materialIssueRequest: views[0], lines: lines.map((line) => materialIssueRequestLineView(line)), requests: views };
  }

  /** 트랜잭션 밖 — 후보 창고 D(또는 고른 창고)·입고지·공장 오늘·보충 행. */
  private async prepare(input: MaterialIssueRequestCreate, plantId: bigint) {
    const workOrder = await this.prisma.work_order.findUniqueOrThrow({
      where: { work_order_id: input.workOrderId },
      select: { production_line_id: true, production_plan: { select: { production_order: { select: { plant: { select: { timezone_code: true } } } } } } },
    });
    const timezone = workOrder.production_plan?.production_order.plant.timezone_code ?? 'UTC';
    const scope = workOrder.production_line_id === null
      ? { errors: [field('workOrderId', ERROR_CODE.LINE_DEPARTMENT_MISSING, 'W/O 에 생산라인이 없습니다.')], warehouseIds: [] }
      : await resolveCandidates(this.prisma, { plantId, productionLineId: workOrder.production_line_id });
    // 라인 부서의 생산 창고가 없으면 배포와 같은 사유로 막는다 — 입고지를 직접 고르면 생산 현장 누락은 넘어간다.
    if ('errors' in scope) {
      const errors = scope.errors.filter((e) => e.code !== ERROR_CODE.PRODUCTION_FLOOR_LOCATION_MISSING || input.destinationLocationId == null);
      if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    }
    const candidates = scope.warehouseIds;
    let warehouseIds = candidates;
    if (input.sourceWarehouseId != null) {
      // 고를 수 있는 창고는 W/O 상세 productionWarehouses 와 같다 — 라인 부서의 이 공장 활성 생산 창고.
      if (!candidates.includes(BigInt(input.sourceWarehouseId))) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [field('sourceWarehouseId', ERROR_CODE.INVALID, '라인 담당 부서의 생산 창고가 아닙니다.')]);
      }
      warehouseIds = [BigInt(input.sourceWarehouseId)];
    }
    const destination = input.destinationLocationId != null ? BigInt(input.destinationLocationId) : 'errors' in scope ? null : scope.destinationLocationId;
    if (destination === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('destinationLocationId', ERROR_CODE.REQUIRED, '입고지를 고르거나 라인에 생산 현장 위치를 지정해야 합니다.')]);
    }
    if (input.unsourcedShortageId != null) {
      const row = await this.prisma.material_issue_unsourced_shortage.findUnique({ where: { material_issue_unsourced_shortage_id: input.unsourcedShortageId } });
      if (row === null || row.work_order_id !== BigInt(input.workOrderId) || row.resolved_request_id !== null) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [field('unsourcedShortageId', ERROR_CODE.INVALID, '이 W/O 의 보충되지 않은 부족 행이 아닙니다.')]);
      }
    }
    return { warehouseIds, destination, today: localDate(new Date(), timezone), chooseAuto: input.sourceWarehouseId == null };
  }

  private async write(
    tx: Prisma.TransactionClient,
    input: MaterialIssueRequestCreate,
    appUserId: number,
    plan: Awaited<ReturnType<PlannedManualRequestCreator['prepare']>>,
    requestNos: string[],
    pickingNos: string[],
  ): Promise<bigint[]> {
    const itemIds = [...new Set(input.lines.map((line) => BigInt(line.itemId)))];
    const sourceOf = new Map<bigint, bigint>();
    const conflicts: Conflict[] = [];
    if (plan.chooseAuto) {
      const choice = await chooseSources(tx, { warehouseIds: plan.warehouseIds, itemIds });
      for (const [itemId, chosen] of choice.chosen) sourceOf.set(itemId, chosen.warehouseId);
      for (const itemId of choice.unsourced) {
        conflicts.push({ itemId: Number(itemId), sourceWarehouseId: null, requestedQty: this.desired(input, itemId).toNumber(), freeQty: 0, takeFromPlannedQty: 0, overridable: false, noStockedWarehouse: true, affectedRequests: [] });
      }
    } else {
      await lockPairs(tx, itemIds.map((itemId) => ({ warehouseId: plan.warehouseIds[0], itemId })));
      for (const itemId of itemIds) sourceOf.set(itemId, plan.warehouseIds[0]);
    }

    const pairs = [...sourceOf].map(([itemId, warehouseId]) => ({ itemId, warehouseId }));
    const [available, planned] = await Promise.all([
      availableQty(tx, [...new Set(pairs.map((p) => p.warehouseId))], itemIds),
      plannedLines(tx, { warehouseIds: [...new Set(pairs.map((p) => p.warehouseId))], itemIds }),
    ]);
    const override = OVERRIDE_REASONS.includes(input.reasonCode ?? '');
    const take = new Map<bigint, Prisma.Decimal>();
    const overridden: bigint[] = [];
    for (const { itemId, warehouseId } of pairs) {
      const key = pairKey(warehouseId, itemId);
      const pairLines = planned.filter((l) => pairKey(l.warehouseId, l.itemId) === key);
      const avail = available.get(key) ?? ZERO;
      const free = Prisma.Decimal.max(avail.minus(pairLines.reduce((s, l) => s.plus(l.plannedQty), ZERO)), ZERO);
      const desired = this.desired(input, itemId);
      // 가져갈 수 있는 사유라도 실제로 다른 요청의 예정분을 쓰는 것은 「가용까지 − 쓸 수 있는 양」 만큼이다.
      // 그 양이 0 이면(예정이 없거나 가용이 모자란 것뿐) 묻지도, 이력을 남기지도 않는다(omf-all-around#232 3).
      const fromPlanned = override ? Prisma.Decimal.max(Prisma.Decimal.min(desired, avail).minus(free), ZERO) : ZERO;
      if (desired.lte(free)) {
        take.set(itemId, desired);
      } else if (fromPlanned.gt(0) && input.acceptPlannedOverride === true) {
        take.set(itemId, Prisma.Decimal.min(desired, avail));
        overridden.push(itemId);
      } else if (fromPlanned.isZero() && free.gt(0)) {
        take.set(itemId, free);
      } else {
        conflicts.push({
          itemId: Number(itemId),
          sourceWarehouseId: Number(warehouseId),
          requestedQty: desired.toNumber(),
          freeQty: free.toNumber(),
          takeFromPlannedQty: fromPlanned.toNumber(),
          overridable: fromPlanned.gt(0),
          affectedRequests: await this.affected(tx, pairLines),
        });
      }
    }
    if (conflicts.length > 0) {
      throw new ContractException(
        HttpStatus.CONFLICT,
        [{ scope: 'screen', code: ERROR_CODE.PLANNED_STOCK_CONFLICT, message: '생산 창고의 쓸 수 있는 양을 넘습니다 — 다른 W/O 의 출고 예정분입니다.' }],
        { plannedStockConflicts: conflicts },
      );
    }

    const byWarehouse = new Map<bigint, { line: (typeof input.lines)[number]; requested: Prisma.Decimal; shortage: Prisma.Decimal }[]>();
    for (const line of input.lines) {
      const itemId = BigInt(line.itemId);
      const qty = new Prisma.Decimal(line.requestedQty);
      const left = take.get(itemId) ?? ZERO;
      const requested = Prisma.Decimal.min(qty, left);
      take.set(itemId, left.minus(requested));
      const warehouseId = sourceOf.get(itemId) as bigint;
      byWarehouse.set(warehouseId, [...(byWarehouse.get(warehouseId) ?? []), { line, requested, shortage: qty.minus(requested) }]);
    }
    const ids: bigint[] = [];
    for (const [index, [warehouseId, rows]] of [...byWarehouse].sort(([a], [b]) => (a < b ? -1 : 1)).entries()) {
      const header = await tx.material_issue_request.create({
        data: {
          issue_request_no: requestNos[index],
          work_order_id: input.workOrderId,
          source_warehouse_id: warehouseId,
          destination_location_id: plan.destination,
          issue_work_date: new Date(`${plan.today}T00:00:00.000Z`),
          required_at: input.requiredAt == null ? null : new Date(input.requiredAt),
          status_code: 'WAITING',
          requested_by: appUserId,
          reason_code: input.reasonCode ?? null,
          remarks: input.remarks ?? null,
          created_by: appUserId,
        },
        select: { material_issue_request_id: true },
      });
      const id = header.material_issue_request_id;
      await tx.material_issue_request_line.createMany({
        data: rows.map(({ line, requested, shortage }, lineIndex) => ({
          material_issue_request_id: id,
          line_no: lineIndex + 1,
          bom_component_id: line.bomComponentId ?? null,
          item_id: line.itemId,
          requested_qty: requested,
          shortage_qty: shortage,
          uom_id: line.uomId,
          created_by: appUserId,
        })),
      });
      await recordRequestAudit(tx, { requestId: id, action: 'CREATED', actorId: appUserId, detail: { reason: input.reasonCode ?? null } });
      const took = rows.filter(({ line }) => overridden.includes(BigInt(line.itemId)));
      if (took.length > 0) {
        // FR-018 — 누가 어떤 사유로 다른 W/O 의 예정분을 가져갔는지.
        await recordRequestAudit(tx, {
          requestId: id,
          action: 'PLANNED_OVERRIDE',
          actorId: appUserId,
          detail: { after: took.map(({ line, requested }) => ({ itemId: line.itemId, requestedQty: requested.toNumber() })), reason: input.reasonCode ?? null },
        });
      }
      await this.releaser.release(tx, id, pickingNos[index], appUserId);
      ids.push(id);
    }
    if (input.unsourcedShortageId != null) {
      await tx.material_issue_unsourced_shortage.update({
        where: { material_issue_unsourced_shortage_id: input.unsourcedShortageId },
        data: { resolved_request_id: ids[0] },
      });
    }
    return ids;
  }

  private desired(input: MaterialIssueRequestCreate, itemId: bigint): Prisma.Decimal {
    return input.lines.filter((line) => BigInt(line.itemId) === itemId).reduce((sum, line) => sum.plus(line.requestedQty), ZERO);
  }

  /** 예정을 잡은 요청 — 늦은 출고 작업일부터(가져가면 그쪽에 부족이 생긴다). */
  private async affected(tx: Prisma.TransactionClient, lines: { requestId: bigint; issueWorkDate: Date | null }[]): Promise<Conflict['affectedRequests']> {
    const ids = [...new Set(lines.map((l) => l.requestId))];
    const rows = await tx.material_issue_request.findMany({
      where: { material_issue_request_id: { in: ids } },
      select: { issue_request_no: true, issue_work_date: true, work_order: { select: { work_order_no: true } } },
      orderBy: [{ issue_work_date: 'desc' }, { material_issue_request_id: 'desc' }],
    });
    return rows.map((row) => ({ issueRequestNo: row.issue_request_no, workOrderNo: row.work_order.work_order_no, issueWorkDate: row.issue_work_date?.toISOString().slice(0, 10) ?? null }));
  }
}
