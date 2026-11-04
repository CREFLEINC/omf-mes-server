import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { weeklyWorkingDays } from '../../app/policy/working-days';
import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { availableQty, lockPairs, pairKey, plannedLines } from '../../core/material-issue/planned-stock';
import { MaterialIssueReleaser } from '../../core/material-issue/release-request';
import {
  REQUEST_AUDIT_TARGET,
  closePickings,
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

export interface HistoryItem {
  occurredAt: string;
  actionCode: string;
  performedBy: number | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

const OPEN = ['WAITING', 'REGISTERED'];
const ZERO = new Prisma.Decimal(0);

type Locked = Prisma.material_issue_requestGetPayload<{
  include: { material_issue_request_line: true; source_warehouse: { select: { plant: { select: { plant_id: true; timezone_code: true } } } } };
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
        action: 'CANCEL',
        actorId: appUserId,
        before: { statusCode: request.status_code },
        after: { statusCode: 'CANCELLED' },
        reason: body.reason ?? null,
        at: now,
      });
    });
    return this.queries.get(id);
  }

  async history(id: number): Promise<{ items: HistoryItem[] }> {
    const exists = await this.prisma.material_issue_request.count({ where: { material_issue_request_id: id } });
    if (exists === 0) throw new NotFoundException('없는 자재 출고요청입니다.');
    const rows = await this.prisma.audit_event.findMany({
      where: { target_type_code: REQUEST_AUDIT_TARGET, target_id: BigInt(id) },
      orderBy: [{ occurred_at: 'desc' }, { audit_event_id: 'desc' }],
    });
    return {
      items: rows.map((row) => {
        const { action, ...after } = (row.after_value ?? {}) as Record<string, unknown>;
        return {
          occurredAt: row.occurred_at.toISOString(),
          actionCode: typeof action === 'string' ? action : row.event_type_code,
          performedBy: row.performed_by === null ? null : Number(row.performed_by),
          before: (row.before_value as Record<string, unknown> | null) ?? null,
          after: Object.keys(after).length === 0 ? null : after,
          reason: row.reason,
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
    if (row === null) throw new NotFoundException('없는 자재 출고요청입니다.');
    if (row.source_warehouse === null) throw locked('생산 창고 규칙으로 만든 요청만 고치거나 취소할 수 있습니다.');
    const { plant_id: plantId, timezone_code: timezone } = row.source_warehouse.plant;
    return { plantId, timezone, today: localDate(new Date(), timezone) };
  }

  private async lock(tx: Prisma.TransactionClient, id: number, versionNo: number): Promise<Locked> {
    await tx.$queryRaw`SELECT 1 FROM logistics.material_issue_request WHERE material_issue_request_id = ${id} FOR UPDATE`;
    const request = await tx.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: id },
      include: {
        material_issue_request_line: { orderBy: { line_no: 'asc' } },
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

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const line of request.material_issue_request_line) {
      const qty = wanted.get(line.material_issue_request_line_id);
      if (qty === undefined || qty.eq(line.requested_qty)) continue;
      await tx.material_issue_request_line.update({ where: { material_issue_request_line_id: line.material_issue_request_line_id }, data: { requested_qty: qty } });
      before[`line${line.line_no}RequestedQty`] = line.requested_qty.toNumber();
      after[`line${line.line_no}RequestedQty`] = qty.toNumber();
    }
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
    await this.touch(tx, request, {}, appUserId);
    await recordRequestAudit(tx, { requestId: request.material_issue_request_id, action: 'UPDATE', actorId: appUserId, before, after });
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
    if (source !== request.source_warehouse_id) await this.assertWarehouse(tx, source, head.plantId);
    const destination = body.destinationLocationId === undefined ? request.destination_location_id : BigInt(body.destinationLocationId);
    if (destination !== request.destination_location_id && (await tx.location.count({ where: { location_id: destination } })) === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('destinationLocationId', ERROR_CODE.INVALID, '없는 위치입니다.')]);
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const wanted = this.wantedQty(request, body);
    if (wanted.size > 0 || source !== request.source_warehouse_id) {
      await this.recap(tx, request, source, wanted, before, after);
    }
    if (request.status_code === 'REGISTERED') await closePickings(tx, this.documentState, request.material_issue_request_id, appUserId);
    note(before, after, 'issueWorkDate', dateOf(request.issue_work_date), workDate);
    note(before, after, 'sourceWarehouseId', Number(request.source_warehouse_id), Number(source));
    note(before, after, 'destinationLocationId', Number(request.destination_location_id), Number(destination));

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
    await recordRequestAudit(tx, { requestId: request.material_issue_request_id, action: 'UPDATE', actorId: appUserId, before, after });
    if (releaseNow) {
      await this.releaser.release(tx, request.material_issue_request_id, pickingOrderNo, appUserId);
    } else if (backToWaiting) {
      await recordRequestAudit(tx, { requestId: request.material_issue_request_id, action: 'POSTPONE', actorId: appUserId, after: { statusCode: 'WAITING' } });
    }
  }

  /** 새 소요(줄마다 요청 + 부족)를 출발 창고의 쓸 수 있는 양(다른 요청의 예정을 뺀 가용)까지만 담는다. */
  private async recap(
    tx: Prisma.TransactionClient,
    request: Locked,
    source: bigint,
    wanted: Map<bigint, Prisma.Decimal>,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    const lines = request.material_issue_request_line;
    const itemIds = [...new Set(lines.map((line) => line.item_id))];
    await lockPairs(tx, itemIds.map((itemId) => ({ warehouseId: source, itemId })));
    const [available, others] = await Promise.all([
      availableQty(tx, [source], itemIds),
      plannedLines(tx, { warehouseIds: [source], itemIds }),
    ]);
    const free = new Map<bigint, Prisma.Decimal>();
    for (const itemId of itemIds) {
      const planned = others
        .filter((line) => line.itemId === itemId && line.requestId !== request.material_issue_request_id)
        .reduce((sum, line) => sum.plus(line.plannedQty), ZERO);
      free.set(itemId, Prisma.Decimal.max((available.get(pairKey(source, itemId)) ?? ZERO).minus(planned), ZERO));
    }
    for (const line of lines) {
      const need = wanted.get(line.material_issue_request_line_id) ?? line.requested_qty.plus(line.shortage_qty);
      const left = free.get(line.item_id) ?? ZERO;
      const requested = Prisma.Decimal.min(need, left);
      free.set(line.item_id, left.minus(requested));
      const shortage = need.minus(requested);
      if (requested.eq(line.requested_qty) && shortage.eq(line.shortage_qty)) continue;
      await tx.material_issue_request_line.update({
        where: { material_issue_request_line_id: line.material_issue_request_line_id },
        data: { requested_qty: requested, shortage_qty: shortage },
      });
      before[`line${line.line_no}RequestedQty`] = line.requested_qty.toNumber();
      after[`line${line.line_no}RequestedQty`] = requested.toNumber();
      if (!shortage.eq(line.shortage_qty)) {
        before[`line${line.line_no}ShortageQty`] = line.shortage_qty.toNumber();
        after[`line${line.line_no}ShortageQty`] = shortage.toNumber();
      }
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

  private async assertWarehouse(tx: Prisma.TransactionClient, warehouseId: bigint, plantId: bigint): Promise<void> {
    const found = await tx.warehouse.count({ where: { warehouse_id: warehouseId, plant_id: plantId, is_active: true } });
    if (found === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('sourceWarehouseId', ERROR_CODE.INVALID, '이 공장의 사용 중인 창고가 아닙니다.')]);
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

function note(before: Record<string, unknown>, after: Record<string, unknown>, key: string, from: unknown, to: unknown): void {
  if (from === to) return;
  before[key] = from;
  after[key] = to;
}

