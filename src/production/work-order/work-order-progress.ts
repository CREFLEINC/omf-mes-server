import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { judgeCompletion } from './completion';

/**
 * 계약 `WorkOrderProgress`(required 3 · 칸 9) · `PreIssuedLotSummary`(required 3) 집계 —
 * 상세(PR ①)와 목록(PR ②)이 같은 함수를 쓴다. DB 를 모른다: 질의 서비스가 한 번의 집계로
 * 받아 온 합계를 넣는다(N+1 금지).
 */

/** `production_result` 다섯 칸의 합 — Prisma `_sum` 을 그대로 받는다. 행이 0건이면 널이다. */
export interface ResultSums {
  good_qty: Prisma.Decimal | null;
  defect_qty: Prisma.Decimal | null;
  hold_qty: Prisma.Decimal | null;
  scrap_qty: Prisma.Decimal | null;
  rework_qty: Prisma.Decimal | null;
}

export const NO_RESULTS: ResultSums = { good_qty: null, defect_qty: null, hold_qty: null, scrap_qty: null, rework_qty: null };

export interface ProgressInput {
  orderQty: Prisma.Decimal;
  plannedEndAt: Date | null;
  completedAt: Date | null;
  sums: ResultSums;
  now: Date;
}

export type WorkOrderProgressView = ReturnType<typeof progressOf>;

export function progressOf(input: ProgressInput) {
  const { orderQty, sums } = input;
  const goodQty = qty(sums.good_qty);
  return omitEmpty({
    // 다섯 수량은 합이 없어도(실적 0건) 0 을 «값»으로 낸다 — 키를 생략하지 않는다.
    goodQty: goodQty.toNumber(),
    defectQty: qty(sums.defect_qty).toNumber(),
    holdQty: qty(sums.hold_qty).toNumber(),
    scrapQty: qty(sums.scrap_qty).toNumber(),
    reworkQty: qty(sums.rework_qty).toNumber(),
    // 분모 0 은 `work_order_order_qty_check` 로 실제론 없다 — 그래도 나눗셈을 지어내지 않는다.
    achievementRate: orderQty.isZero() ? undefined : goodQty.dividedBy(orderQty).toNumber(),
    varianceQty: orderQty.minus(goodQty).toNumber(),
    completionJudgmentCode: judgeCompletion(goodQty, orderQty),
    // ⛔ `UNDETERMINABLE` 을 `ON_TIME` 으로 접지 않는다 — 계약이 명시로 금했다.
    delayStatusCode: delayStatusOf(input),
  });
}

function delayStatusOf(input: ProgressInput): 'ON_TIME' | 'DELAYED' | 'UNDETERMINABLE' {
  if (input.plannedEndAt === null) return 'UNDETERMINABLE';
  if (input.plannedEndAt.getTime() < input.now.getTime() && input.completedAt === null) return 'DELAYED';
  return 'ON_TIME';
}

const qty = (sum: Prisma.Decimal | null): Prisma.Decimal => sum ?? new Prisma.Decimal(0);

export type PreIssuedLotSummaryView = ReturnType<typeof preIssuedLotsOf>;

/**
 * 「실적이 붙은 슬롯」은 `production_result_lot_allocation` 에 그 LOT 행이 있는가로 센다 —
 * 슬롯 자신의 상태 칸이 아니다. 셋 다 required 라 슬롯 0 이면 `{0, 0, 0}` 이다.
 */
export function preIssuedLotsOf(slotLotIds: bigint[], allocatedLotIds: bigint[]) {
  const allocated = new Set(allocatedLotIds.map(String));
  const withResultCount = slotLotIds.filter((lotId) => allocated.has(String(lotId))).length;
  return { slotCount: slotLotIds.length, withResultCount, withoutResultCount: slotLotIds.length - withResultCount };
}
