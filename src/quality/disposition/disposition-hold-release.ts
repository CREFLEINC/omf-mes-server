import { INSPECTION_HOLD_REASON, LotHoldService, Tx } from '../../core/lot';

/** 처분으로 정상이 된 LOT 의 수입검사 대기 보류 해제 사유(시드 `LOT_HOLD_RELEASE_REASON` · 장부 P-63). */
export const DISPOSITION_RELEASE_REASON = 'DISPOSITION_NORMAL';

/**
 * 처분 '정상'(C19)·선별 양품분(C23)으로 정상이 된 LOT 의 «수입검사 대기» 보류를 닫는다
 * (omf-all-around#106·#108 통합 · 2026-10-16 결정 — 「불합격 → 처분 → 정상/양품이면 입고 가능」).
 *
 * ⭐ IQC 불합격은 보류를 «닫지 않는다»(C6 · W-01-01 §5-1) — 그래서 처분이 LOT 을 정상으로 올려도 보류가 열린 채
 *    남아 피킹·투입이 막혔다. 수입검사 보류만 닫는다 — 의심자재 등 다른 사유의 보류는 그 자리(W-03-02) 몫이다.
 * ⛔ 재작업(C17)은 닫지 않는다 — 검사 대기로 돌아가 재검 합격 확정이 기존 규칙으로 닫는다. 폐기(C18)도 그대로다.
 */
export async function releaseInspectionHoldsWithin(
  tx: Tx,
  holds: LotHoldService,
  lotIds: bigint[],
  actor: { by: bigint; at: Date },
): Promise<void> {
  if (lotIds.length === 0) return;
  const locked = await holds.lockLotsWithin(tx, lotIds);
  for (const lotId of lotIds) {
    await holds.releaseWithin(
      tx,
      locked,
      { lotId, reasonCode: INSPECTION_HOLD_REASON },
      { releaseReasonCode: DISPOSITION_RELEASE_REASON },
      actor,
    );
  }
}
