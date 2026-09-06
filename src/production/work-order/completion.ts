import { Prisma } from '@prisma/client';

/**
 * 마감 3분류 판정. 조회(`WorkOrderProgress.completionJudgmentCode`)와 마감(PR ⑥ `:close` 본문
 * 검증)이 **같은 함수**를 쓴다 — 계약 ⌜조회와 마감이 다른 값을 내면 안 된다⌝.
 */
export type CompletionJudgment = 'UNDER' | 'NORMAL' | 'OVER';

/**
 * 「정상」의 폭. `app.operation_policy` 에 미달 경계용 policy_code 가 없어 읽을 키가 없다 —
 * 없는 키를 지어 읽는 것이 조용한 도출이므로 상수 한 자리에 보이게 둔다.
 * // 설계 미정 — 기존 미결 W-02-05 §8-1
 */
export const CLOSE_TOLERANCE = 0;

export function judgeCompletion(goodSum: Prisma.Decimal, orderQty: Prisma.Decimal): CompletionJudgment {
  const tolerance = new Prisma.Decimal(CLOSE_TOLERANCE);
  if (goodSum.lessThan(orderQty.minus(tolerance))) return 'UNDER';
  return goodSum.greaterThan(orderQty.plus(tolerance)) ? 'OVER' : 'NORMAL';
}
