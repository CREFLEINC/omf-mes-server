import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PreIssuedLotSummaryView, WorkOrderProgressView, preIssuedLotsOf, progressOf } from './work-order-progress';
import {
  DISPLAY_JOIN,
  WorkOrderResourcePlanView,
  WorkOrderRow,
  WorkOrderView,
  workOrderResourcePlanView,
  workOrderView,
} from './work-order-view';

/**
 * 선발행 슬롯의 원천 유형 — `src/trace/lot/lot-rules.ts workOrderWhere()` 와 같은 문자열.
 * // ⑤a 에서 core/lot/lot-source 로 모은다(I-6 R-1)
 */
const WORK_ORDER_LOT_SOURCE = 'WORK_ORDER';

/** `integration_message.target_type_code` — ⑥ 마감이 아웃박스에 적재할 때 같은 값을 쓴다. */
const WORK_ORDER_TARGET_TYPE = 'WORK_ORDER';

/** 계약 상세 질의 둘뿐 — `withValidation` 은 «없다»(§7-6). 기본값은 가드가 안 채운다. */
export interface WorkOrderDetailQuery {
  withProgress?: boolean;
  withPreIssuedLots?: boolean;
}

/** 조회 2건 — 상세 GET · 4M 계획 배정 목록(PR ①). 집계 두 함수는 PR ② 목록이 재사용한다. */
@Injectable()
export class WorkOrderQueryService {
  constructor(private readonly prisma: PrismaService) {}

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
   * ⛔ `status_code` 로 거르지 않는다 — `PRODUCTION_RESULT_STATUS` 그룹이 폐기돼 거를 값이 없고,
   * 정정은 상쇄 행이라 합이 곧 반영값이다(계약 ⌜정정(상쇄) 실적이 반영된 값⌝ · §5-2).
   */
  private async progress(row: WorkOrderRow): Promise<WorkOrderProgressView> {
    const { _sum } = await this.prisma.production_result.aggregate({
      where: { work_order_id: row.work_order_id },
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
