import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/**
 * 계약 `ShipmentLotAllocation`·`match` 로 옮기는 자리(I-22 PR ⑦a).
 * ⛔ 널 정책(§1-4-0) — `handlingUnitId` 는 널을 «받는» 칸(항상 키가 있고 값이 `null` 일 수
 * 있다), `lotNo` 는 널을 «못 받는» 선택 칸(값이 없으면 키를 생략한다 · `omitEmpty`).
 * ⭐⭐ `match.reasonCode` 는 「참이면 `null`」이 «아니다» — 계약이 그렇게 적어 놓고 `enum` 에
 * `null` 을 안 넣었다(R-8). `matched=true` 면 `null` 을 싣지 않고 **키 자체를 생략**한다.
 */

export interface ShipmentAllocationRow {
  shipment_lot_allocation_id: bigint;
  shipment_id: bigint;
  shipment_line_id: bigint;
  item_id: bigint;
  item_code: string;
  lot_id: bigint;
  lot_no: string | null;
  handling_unit_id: bigint | null;
  warehouse_id: bigint;
  allocated_qty: Prisma.Decimal;
  uom_id: bigint;
}

export interface ShipmentLotAllocationView {
  shipmentLotAllocationId: number;
  shipmentId: number;
  shipmentLineId: number;
  itemId: number;
  itemCode: string;
  lotId: number;
  lotNo?: string;
  handlingUnitId: number | null;
  warehouseId: number;
  allocatedQty: number;
  uomId: number;
  oqcPassed: boolean;
  packedQty: number;
}

/**
 * `packedQty` — HU 가 한 개짜리 nullable FK 라 부분 포장이 표현되지 않는다. **0 또는 배정
 * 전량 둘뿐이다**(§5-3). `oqcPassed` 는 호출자가 `shipment-inspection.ts` 의 공용 함수로
 * 계산해 넘긴다(R-10) — 여기서 다시 판정하지 않는다.
 */
export function shipmentLotAllocationView(
  row: ShipmentAllocationRow,
  oqcPassed: boolean,
): ShipmentLotAllocationView {
  return omitEmpty({
    shipmentLotAllocationId: Number(row.shipment_lot_allocation_id),
    shipmentId: Number(row.shipment_id),
    shipmentLineId: Number(row.shipment_line_id),
    itemId: Number(row.item_id),
    itemCode: row.item_code,
    lotId: Number(row.lot_id),
    lotNo: row.lot_no ?? undefined,
    handlingUnitId: row.handling_unit_id === null ? null : Number(row.handling_unit_id),
    warehouseId: Number(row.warehouse_id),
    allocatedQty: Number(row.allocated_qty),
    uomId: Number(row.uom_id),
    oqcPassed,
    packedQty: row.handling_unit_id === null ? 0 : Number(row.allocated_qty),
  });
}

export type MatchReasonCode = 'LABEL_ITEM_MISMATCH' | 'LOT_NOT_ALLOCATED';

export interface ShipmentAllocationMatch {
  matched: boolean;
  reasonCode?: MatchReasonCode;
}

/** `matched=true` 면 `reasonCode` 를 생략한다(R-8) — `null` 을 실으면 ajv 가 깨진다. */
export function matchView(matched: boolean, reasonCode?: MatchReasonCode): ShipmentAllocationMatch {
  return omitEmpty({ matched, reasonCode });
}
