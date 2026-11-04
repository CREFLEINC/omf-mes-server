import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { weeklyWorkingDays } from '../../app/policy/working-days';
import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { availableQty, lockPairs, pairKey, plannedLines } from '../../core/material-issue/planned-stock';
import { resolveCandidates } from '../../core/material-issue/source-warehouse';
import { MaterialIssueReleaser } from '../../core/material-issue/release-request';
import {
  REQUEST_AUDIT_TARGET,
  closePickings,
  RequestAction,
  RequestEventDetail,
  recordRequestAudit,
  requestProgress,
  requestTransition,
} from '../../core/material-issue/request-lifecycle';
import { NumberingService } from '../../core/numbering';
import { PickingHandoverNotifier, allocateStock, writePicking } from '../../core/picking';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterialIssueRequestQueryService } from './material-issue-request-query.service';
import { MaterialIssueRequestDetail } from './material-issue-request-view';

/** 계약 `MaterialIssueRequestUpdate`. */
export interface MaterialIssueRequestUpdate {
  versionNo: number;
  issueWorkDate?: string;
  sourceWarehouseId?: number;
  destinationLocationId?: number;
  lines?: { materialIssueRequestLineId: number; requestedQty: number }[];
  acknowledgeHoliday?: boolean;
}

export interface MaterialIssueRequestCancel {
  versionNo: number;
  reason?: string | null;
}

/** 계약 `MaterialIssueRequestHistoryItem` — 문장은 화면이 `eventCode` 로 만든다. */
export interface HistoryItem {
  occurredAt: string;
  actorName: string | null;
  eventCode: string;
  detail: RequestEventDetail;
}

type Event = { action: RequestAction; detail: RequestEventDetail };

const OPEN = ['WAITING', 'REGISTERED'];
const ZERO = new Prisma.Decimal(0);

type Locked = Prisma.material_issue_requestGetPayload<{
  include: {
    material_issue_request_line: { include: { item: { select: { item_code: true } } } };
    source_warehouse: { select: { plant: { select: { plant_id: true; timezone_code: true } } } };
  };
}>;

/**
 * 출고 요청 수정·취소·이력(W-02-11 · 피처 003 · research R-11). 생산 창고 규칙으로 만든 요청만 고친다.
 *
 * 피킹 전 변경은 「피킹 지시를 닫고 대기로 되돌린 뒤, 출고 작업일이 오늘 이하면 다시 배포」로 통일한다 — 피킹 줄을
 * 부분 수정하지 않는다. 진행이 있으면 수량만, 기출고 이상으로, 집었지만 출고하지 않은 양이 없을 때만 고친다.
 */
@Injectable()
export class MaterialIssueRequestEditService {
  private readonly releaser: MaterialIssueReleaser;

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly numbering: NumberingService,
    private readonly pickingNotices: PickingHandoverNotifier,
    private readonly queries: MaterialIssueRequestQueryService,
  ) {
    this.releaser = new MaterialIssueReleaser(documentState, pickingNotices);
  }

  async update(id: number, body: MaterialIssueRequestUpdate, appUserId: number): Promise<MaterialIssueRequestDetail> {
    const head = await this.head(id);
    // 다시 배포·다시 배정할 수 있으니 피킹 번호를 tx 밖에서 하나 받아 둔다 — 안 쓰면 결번이다.
    const pickingOrderNo = await this.numbering.next('PICKING_ORDER', head.plantId, head.today);
    await this.prisma.$transaction(async (tx) => {
      const request = await this.lock(tx, id, body.versionNo);
      const progress = await requestProgress(tx, request.material_issue_request_id);
      if (progress.started) {
        await this.updateStarted(tx, request, body, progress, pickingOrderNo, appUserId);
      } else {
        await this.updateWaiting(tx, request, body, head, pickingOrderNo, appUserId);
      }
    });
    return this.queries.get(id);
  }

  async cancel(id: number, body: MaterialIssueRequestCancel, appUserId: number): Promise<MaterialIssueRequestDetail> {
    await this.head(id);
    await this.prisma.$transaction(async (tx) => {
      const request = await this.lock(tx, id, body.versionNo);
      if ((await requestProgress(tx, request.material_issue_request_id)).started) {
        throw locked('피킹·출고가 시작된 요청은 취소할 수 없습니다.');
      }
      await closePickings(tx, this.documentState, request.material_issue_request_id, appUserId);
      const now = new Date();
      await tx.material_issue_request.update({
        where: { material_issue_request_id: request.material_issue_request_id },
        data: {
          status_code: requestTransition(this.documentState, 'material-issue-request-cancel', request.status_code),
          cancelled_at: now,
          cancelled_by: appUserId,
          updated_at: now,
          updated_by: appUserId,
          version_no: { increment: 1 },
        },
      });
      await recordRequestAudit(tx, {
        requestId: request.material_issue_request_id,
        action: 'CANCELLED',
        actorId: appUserId,
        detail: { reason: body.reason ?? null },
        at: now,
      });
    });
    return this.queries.get(id);
  }

  async history(id: number): Promise<{ items: HistoryItem[] }> {
    const exists = await this.prisma.material_issue_request.count({ where: { material_issue_request_id: id } });
    if (exists === 0) throw new NotFoundException('없는 출고 요청입니다.');
    const rows = await this.prisma.audit_event.findMany({
      where: { target_type_code: REQUEST_AUDIT_TARGET, target_id: BigInt(id) },
      orderBy: [{ occurred_at: 'desc' }, { audit_event_id: 'desc' }],
    });
    // 이름은 한 번에 — 이력 줄마다 사용자를 읽지 않는다.
    const actorIds = [...new Set(rows.map((row) => row.performed_by).filter((v): v is bigint => v !== null))];
    const users = await this.prisma.app_user.findMany({ where: { app_user_id: { in: actorIds } }, select: { app_user_id: true, user_name: true } });
    const nameOf = new Map(users.map((u) => [u.app_user_id, u.user_name]));
    return {
      items: rows.map((row) => {
        const stored = (row.after_value ?? {}) as { eventCode?: string; detail?: RequestEventDetail };
        return {
          occurredAt: row.occurred_at.toISOString(),
          actorName: row.performed_by === null ? null : (nameOf.get(row.performed_by) ?? null),
          eventCode: stored.eventCode ?? row.event_type_code,
          detail: stored.detail ?? {},
        };
      }),
    };
  }

  /** 404 · 지금 방식 요청 409 · 공장 오늘. 트랜잭션 밖이다. */
  private async head(id: number): Promise<{ plantId: bigint; timezone: string; today: string }> {
    const row = await this.prisma.material_issue_request.findUnique({
      where: { material_issue_request_id: id },
      select: { source_warehouse: { select: { plant: { select: { plant_id: true, timezone_code: true } } } } },
    });
    if (row === null) throw new NotFoundException('없는 출고 요청입니다.');
    if (row.source_warehouse === null) throw locked('생산 창고 규칙으로 만든 요청만 고치거나 취소할 수 있습니다.');
    const { plant_id: plantId, timezone_code: timezone } = row.source_warehouse.plant;
    return { plantId, timezone, today: localDate(new Date(), timezone) };
  }

  private async lock(tx: Prisma.TransactionClient, id: number, versionNo: number): Promise<Locked> {
    await tx.$queryRaw`SELECT 1 FROM logistics.material_issue_request WHERE material_issue_request_id = ${id} FOR UPDATE`;
    const request = await tx.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: id },
      include: {
        material_issue_request_line: { orderBy: { line_no: 'asc' }, include: { item: { select: { item_code: true } } } },
        source_warehouse: { select: { plant: { select: { plant_id: true, timezone_code: true } } } },
      },
    });
    if (request.version_no !== versionNo) assertUpdated(0);
    if (!OPEN.includes(request.status_code) || request.closed_at !== null) {
      throw locked('끝났거나 닫힌 요청은 고칠 수 없습니다.');
    }
    return request;
  }

  /** 진행 있음 — 수량만, 기출고 이상. 남은 피킹을 집은 만큼으로 줄이고 나머지를 새 지시로 낸다(FR-025·026). */
  private async updateStarted(
    tx: Prisma.TransactionClient,
    request: Locked,
    body: MaterialIssueRequestUpdate,
    progress: Awaited<ReturnType<typeof requestProgress>>,
    pickingOrderNo: string,
    appUserId: number,
  ): Promise<void> {
    if (
      (body.issueWorkDate !== undefined && body.issueWorkDate !== dateOf(request.issue_work_date)) ||
      (body.sourceWarehouseId !== undefined && BigInt(body.sourceWarehouseId) !== request.source_warehouse_id) ||
      (body.destinationLocationId !== undefined && BigInt(body.destinationLocationId) !== request.destination_location_id)
    ) {
      throw locked('피킹이 시작된 요청은 출고 작업일·출발 창고·입고지를 바꿀 수 없습니다.');
    }
    if (progress.inFlight) throw locked('집었지만 아직 출고하지 않은 자재가 있습니다. 출고를 마친 뒤 다시 저장하세요.');
    const wanted = this.wantedQty(request, body);
    const errors: ErrorItem[] = [];
    for (const [index, line] of request.material_issue_request_line.entries()) {
      const qty = wanted.get(line.material_issue_request_line_id);
      if (qty !== undefined && qty.lt(line.issued_qty)) {
        errors.push(field(`lines[${index}].requestedQty`, ERROR_CODE.RANGE, `요청 수량은 기출고량(${line.issued_qty.toString()})보다 적을 수 없습니다.`));
      }
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    if (wanted.size === 0) return;

    // 늘리는 양에도 상한을 건다(FR-012) — 집은 양은 이미 가용에서 빠졌으므로 「요청 − 집은 양」이 쓸 수 있는 양 안이어야 한다.
    const events: Event[] = [];
    await this.cap(tx, request, request.source_warehouse_id as bigint, wanted, progress.picked, events);
    await closePickings(tx, this.documentState, request.material_issue_request_id, appUserId);
    const lines = await tx.material_issue_request_line.findMany({ where: { material_issue_request_id: request.material_issue_request_id } });
    const demands = lines.flatMap((line) => {
      const rest = line.requested_qty.minus(progress.picked.get(line.material_issue_request_line_id) ?? ZERO);
      return rest.gt(0) ? [{ lineNo: line.line_no, itemId: line.item_id, uomId: line.uom_id, qty: rest }] : [];
    });
    if (demands.length > 0) {
      const plantId = request.source_warehouse?.plant.plant_id as bigint;
      const allocation = await allocateStock(tx, { plantId, warehouseId: request.source_warehouse_id as bigint, demands });
      const pickings = await writePicking(
        tx,
        { ...allocation, orderNos: allocation.orders.length === 0 ? [] : [pickingOrderNo], assignedWorkerId: null },
        {
          materialIssueRequestId: request.material_issue_request_id,
          issueRequestNo: request.issue_request_no,
          requestLineIds: new Map(lines.map((line) => [line.line_no, line.material_issue_request_line_id])),
        },
        appUserId,
      );
      await this.pickingNotices.notify(tx, pickings, { workOrderId: request.work_order_id, requiredAt: null });
    }
    // 미출고가 모두 0 이면 더 나갈 것이 없다 — 출고 전기와 같은 완료(POSTED)로 옮기고 집은 만큼으로 줄인 피킹도 닫는다(FR-025).
    const done = lines.every((line) => line.requested_qty.lte(line.issued_qty));
    await this.touch(tx, request, done ? { status_code: requestTransition(this.documentState, 'material-issue-request-issue', request.status_code) } : {}, appUserId);
    if (done) await this.finishPickings(tx, request.material_issue_request_id, appUserId);
    await record(tx, request, events, appUserId);
  }

  /** 진행 없음 — 날짜·창고·입고지·수량. 수량·창고가 바뀌면 상한을 다시 건다(FR-010·012). */
  private async updateWaiting(
    tx: Prisma.TransactionClient,
    request: Locked,
    body: MaterialIssueRequestUpdate,
    head: { plantId: bigint; timezone: string; today: string },
    pickingOrderNo: string,
    appUserId: number,
  ): Promise<void> {
    const workDate = body.issueWorkDate ?? dateOf(request.issue_work_date) ?? head.today;
    if (body.issueWorkDate !== undefined && body.issueWorkDate !== dateOf(request.issue_work_date) && !body.acknowledgeHoliday) {
      const days = await weeklyWorkingDays(tx, head.plantId, head.today);
      const weekday = new Date(`${workDate}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || (days === 5 && weekday === 6)) {
        throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
          field('issueWorkDate', ERROR_CODE.HOLIDAY_ACK_REQUIRED, `${workDate} 은 공장 휴일입니다. 그래도 바꾸려면 확인 후 다시 저장하세요.`),
        ]);
      }
    }
    const source = body.sourceWarehouseId === undefined ? (request.source_warehouse_id as bigint) : BigInt(body.sourceWarehouseId);
    if (source !== request.source_warehouse_id) await this.assertWarehouse(tx, request, source, head.plantId);
    const destination = body.destinationLocationId === undefined ? request.destination_location_id : BigInt(body.destinationLocationId);
    if (destination !== request.destination_location_id && (await tx.location.count({ where: { location_id: destination } })) === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('destinationLocationId', ERROR_CODE.INVALID, '없는 위치입니다.')]);
    }

    const events: Event[] = [];
    const wanted = this.wantedQty(request, body);
    if (source !== request.source_warehouse_id) {
      // 출발 창고가 바뀌면 줄 전부를 새 창고의 쓸 수 있는 양으로 다시 담는다 — 소요(요청 + 부족)는 그대로.
      const all = new Map(request.material_issue_request_line.map((line) => [
        line.material_issue_request_line_id,
        wanted.get(line.material_issue_request_line_id) ?? line.requested_qty.plus(line.shortage_qty),
      ]));
      await this.cap(tx, request, source, all, new Map(), events);
    } else if (wanted.size > 0) {
      await this.cap(tx, request, source, wanted, new Map(), events);
    }
    if (request.status_code === 'REGISTERED') await closePickings(tx, this.documentState, request.material_issue_request_id, appUserId);
    if (workDate !== dateOf(request.issue_work_date)) {
      events.unshift({ action: 'ISSUE_DATE_CHANGED', detail: { before: dateOf(request.issue_work_date), after: workDate } });
    }
    if (source !== request.source_warehouse_id) {
      const names = await tx.warehouse.findMany({ where: { warehouse_id: { in: [request.source_warehouse_id as bigint, source] } }, select: { warehouse_id: true, warehouse_name: true } });
      const name = (id: bigint | null) => names.find((w) => w.warehouse_id === id)?.warehouse_name ?? null;
      events.push({ action: 'SOURCE_CHANGED', detail: { before: name(request.source_warehouse_id), after: name(source) } });
    }
    if (destination !== request.destination_location_id) {
      const names = await tx.location.findMany({ where: { location_id: { in: [request.destination_location_id, destination] } }, select: { location_id: true, location_name: true } });
      const name = (id: bigint) => names.find((l) => l.location_id === id)?.location_name ?? null;
      events.push({ action: 'DESTINATION_CHANGED', detail: { before: name(request.destination_location_id), after: name(destination) } });
    }

    const releaseNow = workDate <= head.today;
    const backToWaiting = request.status_code === 'REGISTERED';
    await this.touch(
      tx,
      request,
      {
        issue_work_date: new Date(`${workDate}T00:00:00.000Z`),
        source_warehouse_id: source,
        destination_location_id: destination,
        ...(backToWaiting ? { status_code: requestTransition(this.documentState, 'material-issue-request-postpone', request.status_code), released_at: null } : {}),
      },
      appUserId,
    );
    await record(tx, request, events, appUserId);
    if (releaseNow) {
      await this.releaser.release(tx, request.material_issue_request_id, pickingOrderNo, appUserId);
    } else if (backToWaiting) {
      await recordRequestAudit(tx, { requestId: request.material_issue_request_id, action: 'REVERTED_TO_WAITING', actorId: appUserId });
    }
  }

  /**
   * 고칠 줄(`targets` — 줄 → 새 소요)만 출발 창고의 쓸 수 있는 양까지 담고 넘는 양은 부족으로 남긴다(FR-012).
   * 쓸 수 있는 양 = 가용 − 다른 요청의 예정 − 이 요청의 고치지 않는 줄이 잡은 예정. 고치지 않는 줄은 값도 이력도 그대로다.
   * 집은 양(`picked`)은 이미 가용에서 빠졌으므로 줄의 예정은 「요청 − 집은 양」이다.
   */
  private async cap(
    tx: Prisma.TransactionClient,
    request: Locked,
    source: bigint,
    targets: Map<bigint, Prisma.Decimal>,
    picked: ReadonlyMap<bigint, Prisma.Decimal>,
    events: Event[],
  ): Promise<void> {
    const lines = request.material_issue_request_line;
    const itemIds = [...new Set(lines.filter((l) => targets.has(l.material_issue_request_line_id)).map((l) => l.item_id))];
    if (itemIds.length === 0) return;
    await lockPairs(tx, itemIds.map((itemId) => ({ warehouseId: source, itemId })));
    const [available, planned] = await Promise.all([availableQty(tx, [source], itemIds), plannedLines(tx, { warehouseIds: [source], itemIds })]);
    const free = new Map<bigint, Prisma.Decimal>();
    for (const itemId of itemIds) {
      const held = planned
        .filter((l) => l.itemId === itemId && (l.requestId !== request.material_issue_request_id || !targets.has(l.requestLineId)))
        .reduce((sum, l) => sum.plus(l.plannedQty), ZERO);
      free.set(itemId, Prisma.Decimal.max((available.get(pairKey(source, itemId)) ?? ZERO).minus(held), ZERO));
    }
    for (const line of lines) {
      const need = targets.get(line.material_issue_request_line_id);
      if (need === undefined) continue;
      const took = picked.get(line.material_issue_request_line_id) ?? ZERO;
      const left = free.get(line.item_id) ?? ZERO;
      const requested = Prisma.Decimal.min(need, took.plus(left));
      free.set(line.item_id, Prisma.Decimal.max(left.minus(requested.minus(took)), ZERO));
      const shortage = need.minus(requested);
      if (requested.eq(line.requested_qty) && shortage.eq(line.shortage_qty)) continue;
      await tx.material_issue_request_line.update({
        where: { material_issue_request_line_id: line.material_issue_request_line_id },
        data: { requested_qty: requested, shortage_qty: shortage },
      });
      events.push(qtyChanged(line, requested, shortage));
    }
  }

  /** 완료된 요청의 열린 피킹 — 집은 만큼으로 줄였으니 더 집을 것이 없다. 출고 전기가 닫는 것과 같은 전이다. */
  private async finishPickings(tx: Prisma.TransactionClient, requestId: bigint, appUserId: number): Promise<void> {
    const orders = await tx.picking_order.findMany({
      where: { source_document_type_code: 'MATERIAL_ISSUE_REQUEST', source_document_id: requestId, status_code: 'REGISTERED' },
      select: { picking_order_id: true, status_code: true },
    });
    for (const order of orders) {
      const to = this.documentState.assertTransition('logistics.picking_order.status_code', 'picking-issue', order.status_code, HttpStatus.CONFLICT).to;
      await tx.picking_order.update({ where: { picking_order_id: order.picking_order_id }, data: { status_code: to, updated_by: appUserId, version_no: { increment: 1 } } });
    }
  }

  private wantedQty(request: Locked, body: MaterialIssueRequestUpdate): Map<bigint, Prisma.Decimal> {
    const own = new Set(request.material_issue_request_line.map((line) => String(line.material_issue_request_line_id)));
    const errors = (body.lines ?? [])
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !own.has(String(line.materialIssueRequestLineId)))
      .map(({ index }) => field(`lines[${index}].materialIssueRequestLineId`, ERROR_CODE.INVALID, '이 요청의 줄이 아닙니다.'));
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    return new Map((body.lines ?? []).map((line) => [BigInt(line.materialIssueRequestLineId), new Prisma.Decimal(line.requestedQty)]));
  }

  /** 새 출발 창고는 W/O 라인 담당 부서의 이 공장 활성 생산 창고여야 한다(FR-010 「출발 생산 창고」). */
  private async assertWarehouse(tx: Prisma.TransactionClient, request: Locked, warehouseId: bigint, plantId: bigint): Promise<void> {
    const workOrder = await tx.work_order.findUniqueOrThrow({ where: { work_order_id: request.work_order_id }, select: { production_line_id: true } });
    const scope = workOrder.production_line_id === null ? null : await resolveCandidates(tx, { plantId, productionLineId: workOrder.production_line_id });
    if (scope === null || !scope.warehouseIds.includes(warehouseId)) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('sourceWarehouseId', ERROR_CODE.INVALID, '라인 담당 부서의 생산 창고가 아닙니다.')]);
    }
  }

  private async touch(tx: Prisma.TransactionClient, request: Locked, data: Prisma.material_issue_requestUncheckedUpdateInput, appUserId: number): Promise<void> {
    await tx.material_issue_request.update({
      where: { material_issue_request_id: request.material_issue_request_id },
      data: { ...data, updated_at: new Date(), updated_by: appUserId, version_no: { increment: 1 } },
    });
  }
}

const locked = (message: string): ContractException =>
  new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);

function dateOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** 소요(요청 + 부족)가 바뀌었다 — 요청이 상한에 걸려 그대로여도 부족이 바뀌면 남긴다(FR-027). */
function qtyChanged(line: Locked['material_issue_request_line'][number], qty: Prisma.Decimal, shortage: Prisma.Decimal): Event {
  return {
    action: 'QTY_CHANGED',
    detail: {
      itemCode: line.item.item_code,
      before: line.requested_qty.toNumber(),
      after: qty.toNumber(),
      shortageBefore: line.shortage_qty.toNumber(),
      shortageAfter: shortage.toNumber(),
    },
  };
}

/** 한 저장의 바뀐 칸마다 이력 한 줄 — 같은 시각이다. */
async function record(tx: Prisma.TransactionClient, request: Locked, events: Event[], appUserId: number): Promise<void> {
  const at = new Date();
  for (const event of events) {
    await recordRequestAudit(tx, { requestId: request.material_issue_request_id, action: event.action, actorId: appUserId, detail: event.detail, at });
  }
}

