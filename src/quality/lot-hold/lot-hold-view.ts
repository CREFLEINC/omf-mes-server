import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/** `lot_hold` + `lot` 조인 — 목록·상세 둘 다 `include: { lot: true }` 로 얻는다. */
export type LotHoldRow = Prisma.lot_holdGetPayload<{ include: { lot: true } }>;

/** 계약 `LotHold` 와 동형(required 5: lotHoldId·lotId·reasonCode·statusCode·heldAt · 프로퍼티 16). */
export interface LotHoldView {
  lotHoldId: number;
  lotId: number;
  lotNo: string;
  itemId: number;
  holdQty?: number;
  uomId?: number;
  reasonCode: string;
  releaseCondition?: string;
  statusCode: string;
  heldBy?: number;
  heldAt: string;
  releasedBy?: number;
  releasedAt?: string;
  releaseReasonCode?: string;
  remarks?: string;
  lotStatusCode?: string;
}

/**
 * ⭐⭐ **§1-4 · R-9** — `lotStatusCode` = 「이 보류가 걸었을 때 LOT 이 간 상태」(계약 `:4035`,
 * 등록 도착). 물리 칸은 `target_lot_status_code`(M-f). **마이그 «전»에 태어난 행은 NULL** 이라
 * **키를 생략**한다(선택 칸 · 널 금지 — `omitEmpty`. `lotStatusCode` 는 `LotHold.required` 밖 —
 * 실측 확인됨).
 *
 * R-9 판정(브리프 §4-3 갈래 ⓐ) — `src/trace/lot/lot-view.ts:135` 가 같은 계약 칸을 이미
 * `lot.status_code`(현재 상태)로 채우고 있었다. 여기(등록 시점에 고정된 `target_lot_status_code`)
 * 와 뜻이 다르다 — 그 보류가 걸린 뒤 LOT 이 다시 옮겨지면 `lot.status_code` 는 바뀌지만
 * 「걸었을 때 간 상태」는 안 바뀐다. 0단계 선례(M-f 마이그 주석 — `target_lot_status_code` 가
 * 곧 `LotHold.lotStatusCode` 라고 이미 못 박았다)와 이 계획 §0 R-9(「두 자리를 같은 뜻으로
 * 맞춘다」)를 따라 `lot-view.ts` 도 이 값으로 맞춘다(같은 커밋에서 수정 · 회귀 e2e 포함).
 */
export function lotHoldView(row: LotHoldRow): LotHoldView {
  return omitEmpty({
    lotHoldId: Number(row.lot_hold_id),
    lotId: Number(row.lot_id),
    lotNo: row.lot.lot_no,
    itemId: Number(row.lot.item_id),
    holdQty: row.hold_qty === null ? undefined : Number(row.hold_qty),
    uomId: id(row.uom_id),
    reasonCode: row.reason_code,
    releaseCondition: row.release_condition ?? undefined,
    statusCode: row.status_code,
    heldBy: id(row.held_by),
    heldAt: row.held_at.toISOString(),
    releasedBy: id(row.released_by),
    releasedAt: row.released_at?.toISOString() ?? undefined,
    releaseReasonCode: row.release_reason_code ?? undefined,
    remarks: row.remarks ?? undefined,
    lotStatusCode: row.target_lot_status_code ?? undefined,
  });
}

function id(value: bigint | null): number | undefined {
  return value === null ? undefined : Number(value);
}
