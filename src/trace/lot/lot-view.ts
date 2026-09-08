import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';
import { LotRow } from '../../core/lot';
import { LotProgressView } from './lot-progress';

/**
 * 계약 `Lot`·`LotExternalIdentifier`·`LotHold` 로 옮기는 자리.
 *
 * ⚠ 계약에 있으나 **지금 채울 수 없는 칸**이 둘이다 — 둘 다 `required` 가 아니라 뺀다.
 *   `bomSnapshot` (스냅샷 칸이 물리에 없다) ·
 *   `receiptDispositionCode` (**물리에 컬럼 자체가 없다** · 되돌림 §Z-5)
 */

export type { LotRow };

export interface LotView {
  lotId: number;
  lotNo: string;
  itemId: number;
  lotTypeCode: string;
  plantId: number;
  initialQty: number;
  uomId: number;
  manufacturedAt: string | null;
  expiryDate: string | null;
  sourceTypeCode: string;
  sourceId: number;
  statusCode: string;
  lifecycleStatusCode: string | null;
  parentLotId: number | null;
  completedAt: string | null;
  remarks: string | null;
  held: boolean;
  /** ⚠ `withProgress=true` 로 «부른 조회»만 채운다 — 계약이 ⌜목록에서는 LOT 마다 세게 되므로
   *  기본은 끈다⌝ 라 적었고, 끈 요청에는 키 자체가 없다. `lotView()` 는 이 칸을 만들지 않고
   *  부르는 쪽(`lot.service.ts`)이 얹는다. */
  progress?: LotProgressView;
}

export interface ExternalIdentifierView {
  lotExternalIdentifierId: number;
  lotId: number;
  identifierTypeCode: string;
  externalIdentifier: string;
  partnerId: number | null;
  /**
   * ⛔ 값이 없으면 **칸째 뺀다.** `type` 에 `null` 이 있는데 `enum` 에는 없어 `null` 이
   * 계약 스스로를 통과하지 못한다 — 전 계약에 같은 모양이 16곳이다(되돌림 §Y-1 · 문의 5번).
   */
  externalSystemCode?: string;
}

export interface HoldView {
  lotHoldId: number;
  lotId: number;
  lotNo: string;
  itemId: number;
  holdQty: number | null;
  uomId: number | null;
  reasonCode: string;
  releaseCondition: string | null;
  statusCode: string;
  heldBy: number | null;
  heldAt: string;
  releasedBy: number | null;
  releasedAt: string | null;
  releaseReasonCode: string | null;
  remarks: string | null;
  /** ⛔ 널 금지 — 마이그 «전»에 태어난 행은 NULL 이라 키 자체를 뺀다(아래 `holdView` 참고). */
  lotStatusCode?: string;
}

export interface LotDetail {
  lot: LotView;
  externalIdentifiers: ExternalIdentifierView[];
  holds: HoldView[];
}

export function lotView(row: LotRow): LotView {
  return {
    lotId: Number(row.lot_id),
    lotNo: row.lot_no,
    itemId: Number(row.item_id),
    lotTypeCode: row.lot_type_code,
    plantId: Number(row.plant_id),
    initialQty: Number(row.initial_qty),
    uomId: Number(row.uom_id),
    manufacturedAt: row.manufactured_at?.toISOString() ?? null,
    expiryDate: toDateString(row.expiry_date),
    sourceTypeCode: row.source_type_code,
    sourceId: Number(row.source_id),
    statusCode: row.status_code,
    lifecycleStatusCode: row.lifecycle_status_code,
    parentLotId: id(row.parent_lot_id),
    completedAt: row.completed_at?.toISOString() ?? null,
    remarks: row.remarks,
    // 「해제되지 않은」 보류가 하나라도 있으면 잡혀 있다.
    held: row.lot_hold.some((hold) => hold.released_at === null),
  };
}

export function identifierView(
  row: Prisma.lot_external_identifierGetPayload<object>,
): ExternalIdentifierView {
  return {
    lotExternalIdentifierId: Number(row.lot_external_identifier_id),
    lotId: Number(row.lot_id),
    identifierTypeCode: row.identifier_type_code,
    externalIdentifier: row.external_identifier,
    partnerId: id(row.partner_id),
    ...(row.external_system_code === null
      ? {}
      : { externalSystemCode: row.external_system_code }),
  };
}

/**
 * 보류 줄은 LOT 의 번호·품목·판정을 함께 보인다 — 화면이 마스터를 다시 부르지 않게.
 *
 * ⭐⭐ **R-9 판정(I-20 §0 #1 · PR ②a 와 같은 커밋)** — `lotStatusCode` 는 이전에 `lot.status_code`
 * (LOT 의 «지금» 상태)로 채웠다. 계약 `LotHold.lotStatusCode` 의 뜻은 「이 보류가 «걸었을 때»
 * LOT 이 간 상태」(`:4035`, 등록 도착)라 다른 사실이다 — 보류가 걸린 뒤 LOT 이 다시 옮겨지면
 * `lot.status_code` 는 바뀌지만 「걸었을 때 간 상태」는 안 바뀐다. `GET /quality/lot-holds/{id}`
 * (같은 계약 칸)는 물리 칸 `lot_hold.target_lot_status_code`(M-f)로 채운다 — 두 자리를
 * 같은 뜻으로 맞추려면 여기도 그 칸을 써야 한다.
 * ⚠ **마이그 전에 태어난 행은 그 칸이 NULL** 이다(백필 0) — `core/lot/lot-registry.service.ts`
 * 가 아직(PR ③ 전) 그 칸을 안 채워, «오늘 새로 만든» 보류도 포함해 전부 여기 해당한다. 예전에는
 * `lot.status_code` 값이 항상 실려 있었지만, 지금은 그 행들이 **키 생략**으로 후퇴한다. 계약
 * 위반은 아니다(`lotStatusCode` 는 `LotHold.required` 밖 — 실측 확인됨). 실측 전에는
 * `test/trace-lot.e2e-spec.ts` 가 이 칸의 값을 어디서도 단언하지 않았다 — 이번 커밋이 회귀
 * 테스트를 새로 더했다(같은 파일 「R-9」 표시 · 키 생략과 등록 시점 값 고정을 함께 잠근다).
 * // 결정 — 통보 079(근거·대안 비교는 I-20 PR ②a 본문)
 */
export function holdView(row: Prisma.lot_holdGetPayload<object>, lot: LotRow): HoldView {
  const target = row.target_lot_status_code;
  return {
    lotHoldId: Number(row.lot_hold_id),
    lotId: Number(row.lot_id),
    lotNo: lot.lot_no,
    itemId: Number(lot.item_id),
    holdQty: row.hold_qty === null ? null : Number(row.hold_qty),
    uomId: id(row.uom_id),
    reasonCode: row.reason_code,
    releaseCondition: row.release_condition,
    statusCode: row.status_code,
    heldBy: id(row.held_by),
    heldAt: row.held_at.toISOString(),
    releasedBy: id(row.released_by),
    releasedAt: row.released_at?.toISOString() ?? null,
    releaseReasonCode: row.release_reason_code,
    remarks: row.remarks,
    ...(target === null || target === undefined ? {} : { lotStatusCode: target }),
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
