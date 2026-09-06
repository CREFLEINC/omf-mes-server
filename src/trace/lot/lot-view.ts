import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';
import { LotRow } from '../../core/lot';

/**
 * 계약 `Lot`·`LotExternalIdentifier`·`LotHold` 로 옮기는 자리.
 *
 * ⚠ 계약에 있으나 **지금 채울 수 없는 칸**이 셋이다 — 전부 `required` 가 아니라 뺀다.
 *   `progress` (실적 파생 · production 미구현) · `bomSnapshot` (스냅샷 칸이 물리에 없다) ·
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
  lotStatusCode: string;
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

/** 보류 줄은 LOT 의 번호·품목·판정을 함께 보인다 — 화면이 마스터를 다시 부르지 않게. */
export function holdView(row: Prisma.lot_holdGetPayload<object>, lot: LotRow): HoldView {
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
    lotStatusCode: lot.status_code,
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
