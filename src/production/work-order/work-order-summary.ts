import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/**
 * 계약 `WorkOrderListSummary`(§1-4 ⓐ · 10칸) 매퍼 — DB 를 모르는 순수 함수(서비스가 한 트랜잭션
 * 에서 모은 집계를 넘긴다). ⭐ 여덟 카운트는 0 도 «값»으로 낸다 — `statusCounts` 의 0건 상태 키
 * 생략과 `achievementRate` 분모 0 생략만 예외다(R-21).
 */
type QtySums = Record<'good_qty' | 'defect_qty' | 'hold_qty' | 'scrap_qty' | 'rework_qty', Prisma.Decimal | null>;

export interface WorkOrderListSummaryInput {
  totalCount: number;
  statusCounts: { status_code: string; _count: { work_order_id: number } }[];
  orderQtySum: Prisma.Decimal | null;
  resultSums: QtySums;
  delayedCount: number;
  undeterminableDelayCount: number;
}

export type WorkOrderListSummary = ReturnType<typeof workOrderListSummaryOf>;

export function workOrderListSummaryOf(input: WorkOrderListSummaryInput) {
  const statusCounts: Record<string, number> = {};
  for (const group of input.statusCounts) statusCounts[group.status_code] = group._count.work_order_id;

  const goodQty = qty(input.resultSums.good_qty);
  const orderQty = qty(input.orderQtySum);
  return omitEmpty({
    totalCount: input.totalCount,
    statusCounts,
    goodQty: goodQty.toNumber(),
    defectQty: qty(input.resultSums.defect_qty).toNumber(),
    holdQty: qty(input.resultSums.hold_qty).toNumber(),
    scrapQty: qty(input.resultSums.scrap_qty).toNumber(),
    reworkQty: qty(input.resultSums.rework_qty).toNumber(),
    // 분모 0(필터에 걸린 W/O 가 없거나 전부 order_qty 미상)은 나눗셈을 지어내지 않는다.
    achievementRate: orderQty.isZero() ? undefined : goodQty.dividedBy(orderQty).toNumber(),
    delayedCount: input.delayedCount,
    undeterminableDelayCount: input.undeterminableDelayCount,
  });
}

const qty = (sum: Prisma.Decimal | null): Prisma.Decimal => sum ?? new Prisma.Decimal(0);

/** `delayedCount` 축 — 계획 종료 시각이 지났고 아직 완료되지 않은 것. */
export const delayedWhere = (now: Date): Prisma.work_orderWhereInput => ({ planned_end_at: { not: null, lt: now }, completed_at: null });

/** `undeterminableDelayCount` 축 — `delayedWhere` 와 서로 접지 않는다(`planned_end_at` 유무로 갈린다). */
export const UNDETERMINABLE_DELAY_WHERE: Prisma.work_orderWhereInput = { planned_end_at: null, completed_at: null };
