import { Prisma } from '@prisma/client';

/**
 * LOT 단위 생산 진척 — 순수 판정.
 *
 * ⭐ `POST /trace/lots/{lotId}:complete` 의 미달 판정과 `GET /trace/lots/{lotId}?withProgress=true`
 * 가 **같은 함수**를 부른다. 계약 `LotProgress` 가 ⌜서버가 계산해 내린다 — 화면이 각자
 * 계산하면 완료 화면과 라벨 화면의 값이 갈린다(공유계약 L-2)⌝ 라 적었고, 완료 화면이
 * 「미달」이라 그린 LOT 이 서버에선 정상으로 통과하면 그 문장이 깨진다.
 *
 * ⛔ `production/work-order/completion.ts` 의 `judgeCompletion` 을 **import 하지 않는다** —
 * 모양은 같아도 **축이 다르다**(저쪽 분모는 W/O 지시 수량, 이쪽은 이 LOT 의 `initial_qty`).
 * 도메인 간 호출 금지(`server-architecture.md:67`)라 같은 모양을 이 도메인에도 둔다.
 * ⛔ 누적은 `Σ production_result_lot_allocation.allocated_qty` 이지 `production_result.good_qty`
 * 의 합이 «아니다» — 그건 W/O 축이다(I-7.md §3-3).
 */
export type LotCompletionJudgment = 'UNDER' | 'NORMAL' | 'OVER';

export interface LotProgressView {
  goodQty: number;
  /**
   * ⚠ 계약은 required 로 적었으나 **분모가 0 이면 키를 생략한다** — 나눌 수 없는 값을
   * 지어내지 않는다(공유계약 F-6). 선발행 슬롯의 계획 수량은 늘 양수라 실제로는 안 난다.
   */
  achievementRate?: number;
  varianceQty: number;
  completionJudgmentCode: LotCompletionJudgment;
}

export function lotProgress(initialQty: Prisma.Decimal, allocatedSum: Prisma.Decimal): LotProgressView {
  return {
    goodQty: allocatedSum.toNumber(),
    ...(initialQty.isZero() ? {} : { achievementRate: allocatedSum.dividedBy(initialQty).toNumber() }),
    varianceQty: allocatedSum.minus(initialQty).toNumber(),
    // ⛔ 정확 비교다 — `:close` 와 달리 이 축에는 허용 폭을 줄 정책 키가 없다.
    completionJudgmentCode: allocatedSum.lessThan(initialQty)
      ? 'UNDER'
      : allocatedSum.greaterThan(initialQty)
        ? 'OVER'
        : 'NORMAL',
  };
}
