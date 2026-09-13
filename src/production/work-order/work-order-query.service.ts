import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest } from '../../common/pagination';
import type { TerminalContext } from '../../auth/terminal-context';
import { WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { ValidationSummary, summarize, validateWorkOrder } from './validation';
import {
  RELEASABLE_ELIGIBLE_WHERE,
  WorkOrderListQuery,
  achievementOrderedIds,
  achievementSortDirection,
  buildOrderBy,
  buildWorkOrderWhere,
} from './work-order-list-where';
import {
  ACTIVE_RESULT_WHERE,
  PreIssuedLotSummaryView,
  ResultSums,
  WorkOrderProgressView,
  preIssuedLotsOf,
  preIssuedLotsOfMany,
  progressOf,
  progressOfMany,
} from './work-order-progress';
import { UNDETERMINABLE_DELAY_WHERE, WorkOrderListSummary, delayedWhere, workOrderListSummaryOf } from './work-order-summary';
import {
  DISPLAY_JOIN,
  WorkOrderResourcePlanView,
  WorkOrderRow,
  WorkOrderView,
  workOrderResourcePlanView,
  workOrderView,
} from './work-order-view';

/** 목록 행 — 상세와 «같은» 매퍼(`workOrderView`)를 쓰고 `validation` 만 `withValidation` 일 때 얹는다. */
export type WorkOrderListItem = Omit<WorkOrderView, 'validation'> & { validation?: ValidationSummary };

/** `integration_message.target_type_code` — ⑥ 마감이 아웃박스에 적재할 때 같은 값을 쓴다. */
const WORK_ORDER_TARGET_TYPE = 'WORK_ORDER';

/** 계약 상세 질의 둘뿐 — `withValidation` 은 «없다»(§7-6). 기본값은 가드가 안 채운다. */
export interface WorkOrderDetailQuery {
  withProgress?: boolean;
  withPreIssuedLots?: boolean;
}

/** 조회 3건 — 상세 GET(①) · 4M 계획 배정 목록(①) · 목록 GET(②, 질의 23). */
@Injectable()
export class WorkOrderQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** where 는 순수 함수가 짓고 `releasable`ⓒ 만 후보를 좁혀 뺀다(N+1 금지 · §7-5). */
  async list(query: WorkOrderListQuery, terminal?: TerminalContext): Promise<PagedResponse<WorkOrderListItem> & { summary?: WorkOrderListSummary }> {
    const page = pageRequest(query);
    const achievementDirection = achievementSortDirection(query);
    const orderBy = achievementDirection === null ? buildOrderBy(query.sort) : undefined;
    const terminalProcessIds = terminal?.terminalTypeCode === 'POP'
      ? (await this.prisma.terminal_process.findMany({
          where: { terminal_id: terminal.terminalId, can_start_work: true },
          select: { process_id: true },
        })).map((row) => row.process_id)
      : undefined;
    const scopedWhere: Prisma.work_orderWhereInput = terminal === undefined
      ? buildWorkOrderWhere(query)
      : { AND: [buildWorkOrderWhere(query), { production_line: { plant_id: terminal.plantId } },
          ...(terminalProcessIds === undefined ? []
            : [{ routing_operation: { process_id: { in: terminalProcessIds } } }]),
        ] };
    const where = await this.releasableWhere(scopedWhere, query.releasable);
    const now = new Date();

    // `withSummary` 는 목록·건수·요약을 «같은 트랜잭션»에서 낸다(계약).
    const { rows, total, summary } = await this.prisma.$transaction(async (tx) => {
      const achievement = achievementDirection === null ? null
        : await this.achievementPage(tx, where, achievementDirection, page.skip, page.take);
      const rows = achievement === null
        ? await tx.work_order.findMany({ where, orderBy, skip: page.skip, take: page.take, include: DISPLAY_JOIN })
        : achievement.rows;
      const total = achievement === null ? await tx.work_order.count({ where }) : achievement.total;
      const summary = query.withSummary === true ? await this.summaryOf(tx, where, total, now) : undefined;
      return { rows, total, summary };
    });
    const ids = rows.map((row) => row.work_order_id);

    const [progress, preIssuedLots, erpQueued, validation] = await Promise.all([
      query.withProgress === false ? undefined : this.progressMany(rows),
      query.withPreIssuedLots === true ? this.preIssuedLotsMany(ids) : undefined,
      this.erpQueuedMany(ids),
      query.withValidation === true ? this.validationMany(ids) : undefined,
    ]);

    const items: WorkOrderListItem[] = rows.map((row) => {
      const view = workOrderView(row, {
        progress: progress?.get(row.work_order_id),
        preIssuedLots: query.withPreIssuedLots === true ? (preIssuedLots?.get(row.work_order_id) ?? preIssuedLotsOf([], [])) : undefined,
        erpMessageQueued: erpQueued.has(row.work_order_id),
      });
      return query.withValidation === true ? { ...view, validation: validation?.get(row.work_order_id) } : view;
    });
    return { items, page: { page: page.page, size: page.size, total }, summary };
  }

  private async achievementPage(
    tx: Prisma.TransactionClient,
    where: Prisma.work_orderWhereInput,
    direction: 'asc' | 'desc',
    skip: number,
    take: number,
  ): Promise<{ rows: WorkOrderRow[]; total: number }> {
    // Prisma cannot order by a ratio of an aggregate and a parent column. Filter the complete
    // bounded-period population first, aggregate active result rows once, then slice the order.
    const candidates = await tx.work_order.findMany({
      where, select: { work_order_id: true, order_qty: true },
    });
    if (candidates.length === 0) return { rows: [], total: 0 };
    const groups = await tx.production_result.groupBy({
      by: ['work_order_id'],
      where: { work_order_id: { in: candidates.map((row) => row.work_order_id) }, ...ACTIVE_RESULT_WHERE },
      _sum: { good_qty: true },
    });
    const goodQtyByWorkOrder = new Map(groups.map((row) => [row.work_order_id, row._sum.good_qty]));
    const orderedIds = achievementOrderedIds(candidates, goodQtyByWorkOrder, direction);
    const pageIds = orderedIds.slice(skip, skip + take);
    if (pageIds.length === 0) return { rows: [], total: candidates.length };
    const fetched = await tx.work_order.findMany({
      where: { work_order_id: { in: pageIds } }, include: DISPLAY_JOIN,
    });
    const byId = new Map(fetched.map((row) => [row.work_order_id, row]));
    return { rows: pageIds.map((id) => {
      const row = byId.get(id);
      if (!row) throw new Error('달성률 정렬 중 작업지시가 조회되지 않았습니다.');
      return row;
    }), total: candidates.length };
  }

  /** ⓐⓑ+유형으로 좁힌 후보만 `validateWorkOrder`(③)를 부른다 — 페이지 밖도 봐야 「true 의 여집합」이 맞다(비용 · PR 본문). */
  private async releasableWhere(base: Prisma.work_orderWhereInput, releasable?: boolean): Promise<Prisma.work_orderWhereInput> {
    if (releasable === undefined) return base;

    const candidates = await this.prisma.work_order.findMany({
      where: { AND: [base, RELEASABLE_ELIGIBLE_WHERE] },
      select: { work_order_id: true },
    });
    const reports = await Promise.all(candidates.map((row) => validateWorkOrder(this.prisma, Number(row.work_order_id))));
    const passingIds = candidates.filter((_, i) => summarize(reports[i]).blockCount === 0).map((row) => row.work_order_id);

    // `releasable=false` 는 그 여집합이다 — 후보 밖(이미 배포됐거나 자원 미배정·긴급)도 포함한다.
    const idFilter = releasable ? { work_order_id: { in: passingIds } } : { work_order_id: { notIn: passingIds } };
    return { AND: [base, idFilter] };
  }

  private async summaryOf(
    tx: Prisma.TransactionClient,
    where: Prisma.work_orderWhereInput,
    totalCount: number,
    now: Date,
  ): Promise<WorkOrderListSummary> {
    const [statusCounts, orderQtyAgg, resultAgg, delayedCount, undeterminableDelayCount] = await Promise.all([
      tx.work_order.groupBy({ by: ['status_code'], where, _count: { work_order_id: true } }),
      tx.work_order.aggregate({ where, _sum: { order_qty: true } }),
      tx.production_result.aggregate({
        where: { work_order: where, ...ACTIVE_RESULT_WHERE },
        _sum: { good_qty: true, defect_qty: true, hold_qty: true, scrap_qty: true, rework_qty: true },
      }),
      tx.work_order.count({ where: { AND: [where, delayedWhere(now)] } }),
      tx.work_order.count({ where: { AND: [where, UNDETERMINABLE_DELAY_WHERE] } }),
    ]);
    return workOrderListSummaryOf({ totalCount, statusCounts, orderQtySum: orderQtyAgg._sum.order_qty, resultSums: resultAgg._sum, delayedCount, undeterminableDelayCount });
  }

  private async progressMany(rows: WorkOrderRow[]): Promise<Map<bigint, WorkOrderProgressView>> {
    const groups = await this.prisma.production_result.groupBy({
      by: ['work_order_id'],
      where: { work_order_id: { in: rows.map((row) => row.work_order_id) }, ...ACTIVE_RESULT_WHERE },
      _sum: { good_qty: true, defect_qty: true, hold_qty: true, scrap_qty: true, rework_qty: true },
    });
    const sums = new Map<bigint, ResultSums>(groups.map((group) => [group.work_order_id, group._sum]));
    const inputs = rows.map((row) => ({ workOrderId: row.work_order_id, orderQty: row.order_qty, plannedEndAt: row.planned_end_at, completedAt: row.completed_at }));
    return progressOfMany(inputs, sums, new Date());
  }

  /** ①의 단건 정의(`production_result_lot_allocation` 유무)와 «같은» 집계를 `GROUP BY source_id` 로 낸다. */
  private async preIssuedLotsMany(workOrderIds: bigint[]): Promise<Map<bigint, PreIssuedLotSummaryView>> {
    const slots = await this.prisma.lot.findMany({
      where: { source_type_code: WORK_ORDER_LOT_SOURCE, source_id: { in: workOrderIds } },
      select: { lot_id: true, source_id: true },
    });
    if (slots.length === 0) return new Map();

    const allocated = await this.prisma.production_result_lot_allocation.findMany({
      where: { lot_id: { in: slots.map((slot) => slot.lot_id) } },
      select: { lot_id: true },
      distinct: ['lot_id'],
    });
    return preIssuedLotsOfMany(slots.map((slot) => ({ workOrderId: slot.source_id, lotId: slot.lot_id })), allocated.map((row) => row.lot_id));
  }

  private async erpQueuedMany(workOrderIds: bigint[]): Promise<Set<bigint>> {
    const rows = await this.prisma.integration_message.findMany({
      where: { target_type_code: WORK_ORDER_TARGET_TYPE, target_id: { in: workOrderIds } },
      select: { target_id: true },
      distinct: ['target_id'],
    });
    return new Set(rows.map((row) => row.target_id));
  }

  /** 목록 `withValidation` — 페이지 안 행마다만 부른다(`releasable` 후보 집합과는 별개). */
  private async validationMany(workOrderIds: bigint[]): Promise<Map<bigint, ValidationSummary>> {
    const reports = await Promise.all(workOrderIds.map((id) => validateWorkOrder(this.prisma, Number(id))));
    return new Map(workOrderIds.map((id, i) => [id, summarize(reports[i])]));
  }

  /** 없으면 404 다(계약 선언). */
  async detail(workOrderId: number, query: WorkOrderDetailQuery): Promise<{ view: WorkOrderView; versionNo: number }> {
    const row = await this.prisma.work_order.findUnique({ where: { work_order_id: workOrderId }, include: DISPLAY_JOIN });
    if (!row) throw new NotFoundException('없는 작업지시입니다.');

    const [progress, preIssuedLots, erpMessageQueued] = await Promise.all([
      query.withProgress === false ? undefined : this.progress(row),
      query.withPreIssuedLots === true ? this.preIssuedLots(row.work_order_id) : undefined,
      this.erpQueued(row.work_order_id),
    ]);
    return { view: workOrderView(row, { progress, preIssuedLots, erpMessageQueued }), versionNo: row.version_no };
  }

  /** 404 는 계약 미선언이나 낸다 — 없는 W/O 의 빈 배열과 「배정이 없다」를 가른다(§7-3 · 선례). */
  async resourcePlans(workOrderId: number): Promise<WorkOrderResourcePlanView[]> {
    const exists = await this.prisma.work_order.findUnique({ where: { work_order_id: workOrderId }, select: { work_order_id: true } });
    if (!exists) throw new NotFoundException('없는 작업지시입니다.');

    const rows = await this.prisma.work_order_resource_assignment.findMany({
      where: { work_order_id: workOrderId },
      orderBy: { work_order_resource_assignment_id: 'asc' },
    });
    return rows.map(workOrderResourcePlanView);
  }

  /**
   * ⛔ `status_code` 로 거르지 않는다 — `PRODUCTION_RESULT_STATUS` 그룹이 폐기돼 거를 값이 없다.
   * 대신 정정된 원본을 합에서 «뺀다» — 정정본은 대체값이고 잎만 센다(`ACTIVE_RESULT_WHERE`).
   */
  private async progress(row: WorkOrderRow): Promise<WorkOrderProgressView> {
    const { _sum } = await this.prisma.production_result.aggregate({
      where: { work_order_id: row.work_order_id, ...ACTIVE_RESULT_WHERE },
      _sum: { good_qty: true, defect_qty: true, hold_qty: true, scrap_qty: true, rework_qty: true },
    });
    return progressOf({
      orderQty: row.order_qty,
      plannedEndAt: row.planned_end_at,
      completedAt: row.completed_at,
      sums: _sum,
      now: new Date(),
    });
  }

  private async preIssuedLots(workOrderId: bigint): Promise<PreIssuedLotSummaryView> {
    const where = { source_type_code: WORK_ORDER_LOT_SOURCE, source_id: workOrderId };
    const slots = await this.prisma.lot.findMany({ where, select: { lot_id: true } });
    const lotIds = slots.map((slot) => slot.lot_id);
    if (lotIds.length === 0) return preIssuedLotsOf([], []);

    const allocated = await this.prisma.production_result_lot_allocation.findMany({
      where: { lot_id: { in: lotIds } },
      select: { lot_id: true },
      distinct: ['lot_id'],
    });
    return preIssuedLotsOf(lotIds, allocated.map((row) => row.lot_id));
  }

  private async erpQueued(workOrderId: bigint): Promise<boolean> {
    const where = { target_type_code: WORK_ORDER_TARGET_TYPE, target_id: workOrderId };
    const queued = await this.prisma.integration_message.findFirst({ where, select: { integration_message_id: true } });
    return queued !== null;
  }
}
