import { LotHoldService } from './lot-hold.service';
import { Tx } from './lot-registry.service';

/**
 * PQC 합격이 생산LOT 을 정상으로 올릴 때(C4)·검사 없는 W/O 실적(C21)의 공통 규칙(omf-all-around#105 리뷰).
 *
 * ⭐ C14 — 합격이어도 불합격 수가 합격판정개수를 넘으면 W/O 생산LOT 전체를 검사 대기로 돌린다. 그 판정 «뒤»에 같은
 *    결과로 정상 전환을 하면 C14 를 바로 덮어쓴다 — 그래서 넘은 결과는 정상 전환의 근거가 되지 못한다.
 *    기준값이 비면(기준 없음) 넘지 않은 것이다(`spreadC14` 와 같은 판정).
 */
export function pqcAcceptanceExceeded(rejectedQty: number, acceptanceNumber: number | null | undefined): boolean {
  return acceptanceNumber !== null && acceptanceNumber !== undefined && rejectedQty > acceptanceNumber;
}

/**
 * 정상으로 올려도 되는 LOT — **다른 열린 보류가 없는** 것만(IQC 확정·생략 실행의 `openAfter > 0` 규율과 같다).
 * ⭐⭐ R-5 — 보류 재계수는 LOT 잠금 «안»이어야 한다. 잠근 뒤 센다.
 */
export async function lotsFreeOfOpenHolds(
  tx: Tx,
  holds: LotHoldService,
  lotIds: bigint[],
): Promise<bigint[]> {
  if (lotIds.length === 0) return [];
  await holds.lockLotsWithin(tx, lotIds);
  const open = await tx.lot_hold.findMany({
    where: { lot_id: { in: lotIds }, released_at: null },
    select: { lot_id: true },
  });
  const held = new Set(open.map((row) => row.lot_id));
  return lotIds.filter((lotId) => !held.has(lotId));
}
