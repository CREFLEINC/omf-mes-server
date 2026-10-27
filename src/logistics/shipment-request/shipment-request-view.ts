import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { toDateString } from '../../common/master';
import {
  OqcInspectionRow,
  ShipmentInspectionLine,
  ShippingInspectionStatusCode,
  shipmentInspectionStatus,
} from './shipment-inspection';
import {
  ShipmentProgressCode,
  pickedQtyOf,
  shipmentProgressCode,
  shipmentProgressTotals,
} from './shipment-progress';

/**
 * 계약 `ShipmentRequest`·`ShipmentRequestLine`·`ShipmentLinePickedLot` 로 옮기는 자리(I-22 PR ③b).
 *
 * ⭐⭐ 파생 축 둘은 **PR ③a 의 함수를 부른다** — 여기서 다시 판정하지 않는다. 같은 판정을 두 벌로
 * 적으면 경계 하나가 갈리는 순간 「목록이 거른 것」과 「행이 보이는 값」이 어긋난다(§5-1·§5-2).
 * ⛔ 널 정책이 칸마다 다르다(§1-4-0) — `salesOrderId`·`timeSlotCode`·라인의 셋은 `type:['x','null']`
 * 이라 **`null` 을 내리고**, `lines`·`versionNo`·`lotNo` 는 널을 «못 받는» 선택 칸이라 값이 없으면
 * **키를 생략**한다(`omitEmpty` · `picking-view.ts`·`goods-issue-view.ts` 는 반대쪽 선례다).
 */

/** 계약이 `x-no-code-key` 로 닫은 칸인데 물리는 NOT NULL 이다 — 저장값을 읽지 않는다(§1-4-1). */
const REGISTERED = 'REGISTERED';

export type ShipmentRequestRow = Prisma.shipment_requestGetPayload<{
  include: { shipment_request_line: true };
}>;
export type ShipmentRequestLineRow = Prisma.shipment_request_lineGetPayload<object>;

/** ⭐ `inventory_reservation` 행이 곧 `picks[]` 다 — 담을 표가 따로 없다(§1-4-1). */
export type ShipmentPickRow = Prisma.inventory_reservationGetPayload<{
  include: { lot: { select: { lot_no: true } } };
}>;

/** 라인 id(문자열) → 그 라인에 걸린 예약 행. 호출자가 **한 방**으로 읽어 넘긴다. */
export type ShipmentPicksByLine = Map<string, ShipmentPickRow[]>;

export interface ShipmentLinePickedLotView {
  lotId: number;
  lotNo?: string;
  pickedQty: number;
  /** 반납·출하 취소로 풀린 수량(장부 P-126). */
  releasedQty: number;
  uomId: number;
  pickedAt: string;
}

/** (지시 라인, LOT) → 살아 있는 출하 배분 합. 키는 `라인id:LOTid`. */
export type ShippedByLineLot = Map<string, Prisma.Decimal>;
/** (공장, LOT) → 잔액 피킹분 합. 키는 `공장id:LOTid` — 공장이 없는 지시는 `*:LOTid`(모든 공장 합). */
export type BalancePickedByLot = Map<string, Prisma.Decimal>;

/**
 * LOT 별 피킹·출하·반납 가능 — 반납 화면이 쓴다(장부 P-126). 반납 가능은 서버가 `:return-pick` 에서 받는 한도와 같다(피킹 − 출하).
 * 그중 잔액 피킹분이 남은 만큼(`fromPickedQty`)만 피킹 → 가용으로 옮기고 나머지는 예약만 푼다 — 잔액이 모자라 일부가 예약만 풀리면
 * `limitedByBalance` 가 참이다(다른 지시가 그 피킹분을 출하에 썼다).
 */
export interface ShipmentLinePickedLotSummaryView {
  lotId: number;
  lotNo?: string;
  pickedQty: number;
  shippedQty: number;
  returnableQty: number;
  fromPickedQty: number;
  limitedByBalance: boolean;
}

export interface ShipmentRequestLineView {
  shipmentRequestLineId: number;
  lineNo: number;
  salesOrderLineId: number | null;
  itemId: number;
  requestedQty: number;
  allocatedQty: number;
  pickedQty: number;
  shippedQty: number;
  uomId: number;
  customerLotRequirement: string | null;
  shippingInspectionRequired: boolean;
  minimumRemainingShelfLifeDays: number | null;
  picks: ShipmentLinePickedLotView[];
  pickedLots: ShipmentLinePickedLotSummaryView[];
}

export interface ShipmentRequestView {
  shipmentRequestId: number;
  shipmentRequestNo: string;
  salesOrderId: number | null;
  fulfillmentPlantId: number | null;
  customerId: number;
  shipToPartnerId: number;
  requestedShipDate: string;
  statusCode: string;
  timeSlotCode: string | null;
  shippingInspectionStatusCode: ShippingInspectionStatusCode;
  shipmentProgressCode: ShipmentProgressCode;
  lines?: ShipmentRequestLineView[];
  versionNo?: number;
}

export function shipmentRequestView(
  row: ShipmentRequestRow,
  picksByLine: ShipmentPicksByLine,
  inspections: OqcInspectionRow[],
  shipped: ShippedByLineLot = new Map(),
  balancePicked?: BalancePickedByLot,
): ShipmentRequestView {
  const lines = row.shipment_request_line.map((line) => ({
    line,
    picks: picksByLine.get(String(line.shipment_request_line_id)) ?? [],
  }));

  const totals = shipmentProgressTotals(
    lines.map(({ line, picks }) => ({
      requestedQty: line.requested_qty,
      allocatedQty: line.allocated_qty,
      shippedQty: line.shipped_qty,
      reservations: picks.map((pick) => ({
        reservedQty: pick.reserved_qty,
        releasedQty: pick.released_qty,
      })),
    })),
  );

  // ⭐ 라인이 집은 LOT 집합이 곧 검사 대상 축이다(§5-2). 다 반납·해제돼 남은 피킹이 0 인 예약은 뺀다(장부 P-126 —
  //    반납한 LOT 이 검사 대상에 남지 않게 · `oqcPickedLots` 와 같은 기준).
  const inspectionLines: ShipmentInspectionLine[] = lines.map(({ line, picks }) => ({
    shipmentRequestId: row.shipment_request_id,
    shippingInspectionRequired: line.shipping_inspection_required,
    lotIds: picks.flatMap((pick) => (pick.lot_id === null || !pick.reserved_qty.greaterThan(pick.released_qty) ? [] : [pick.lot_id])),
  }));

  return omitEmpty({
    shipmentRequestId: Number(row.shipment_request_id),
    shipmentRequestNo: row.shipment_request_no,
    salesOrderId: row.sales_order_id === null ? null : Number(row.sales_order_id),
    fulfillmentPlantId:
      row.fulfillment_plant_id === null ? null : Number(row.fulfillment_plant_id),
    customerId: Number(row.customer_id),
    shipToPartnerId: Number(row.ship_to_partner_id),
    requestedShipDate: toDateString(row.requested_ship_date) as string,
    statusCode: REGISTERED,
    timeSlotCode: row.ship_time_slot_code,
    shippingInspectionStatusCode: shipmentInspectionStatus(inspectionLines, inspections),
    shipmentProgressCode: shipmentProgressCode(totals),
    lines: lines.map(({ line, picks }) => shipmentRequestLineView(line, picks, shipped, balancePicked, row.fulfillment_plant_id)),
    versionNo: row.version_no,
  });
}

/**
 * ⛔ `pickedQty` 는 저장 칸이 아니라 **예약 롤업**이다 — `shipment_request_line.picked_qty` 를
 * 만들면 두 벌 장부가 된다(§1-4-1 · R-3). 식은 ③a 의 `pickedQtyOf` 하나뿐이다.
 */
export function shipmentRequestLineView(
  row: ShipmentRequestLineRow,
  picks: ShipmentPickRow[],
  shipped: ShippedByLineLot = new Map(),
  balancePicked?: BalancePickedByLot,
  plantId: bigint | null = null,
): ShipmentRequestLineView {
  return omitEmpty({
    shipmentRequestLineId: Number(row.shipment_request_line_id),
    lineNo: row.line_no,
    salesOrderLineId: row.sales_order_line_id === null ? null : Number(row.sales_order_line_id),
    itemId: Number(row.item_id),
    requestedQty: Number(row.requested_qty),
    allocatedQty: Number(row.allocated_qty),
    pickedQty: Number(
      pickedQtyOf(picks.map((pick) => ({ reservedQty: pick.reserved_qty, releasedQty: pick.released_qty }))),
    ),
    shippedQty: Number(row.shipped_qty),
    uomId: Number(row.uom_id),
    customerLotRequirement: row.customer_lot_requirement,
    shippingInspectionRequired: row.shipping_inspection_required,
    minimumRemainingShelfLifeDays: row.minimum_remaining_shelf_life_days,
    picks: picks.map(shipmentLinePickedLotView),
    pickedLots: pickedLotsOf(row.shipment_request_line_id, picks, shipped, balancePicked, plantId),
  });
}

function pickedLotsOf(
  lineId: bigint, picks: ShipmentPickRow[], shipped: ShippedByLineLot, balancePicked: BalancePickedByLot | undefined, plantId: bigint | null,
): ShipmentLinePickedLotSummaryView[] {
  const byLot = new Map<string, { lotId: number; lotNo?: string; picked: Prisma.Decimal }>();
  for (const pick of picks) {
    const key = String(pick.lot_id);
    const lot = byLot.get(key) ?? { lotId: Number(pick.lot_id), lotNo: pick.lot?.lot_no, picked: new Prisma.Decimal(0) };
    lot.picked = lot.picked.plus(pick.reserved_qty).minus(pick.released_qty);
    byLot.set(key, lot);
  }
  // 다 반납해 남은 피킹이 0 인 LOT 은 보이지 않는다.
  return [...byLot.entries()].filter(([, lot]) => lot.picked.greaterThan(0)).map(([lotKey, lot]) => {
    const out = shipped.get(`${lineId}:${lotKey}`) ?? new Prisma.Decimal(0);
    const unshipped = Prisma.Decimal.max(lot.picked.minus(out), 0);
    const held = balancePicked?.get(`${plantId ?? '*'}:${lotKey}`);
    const fromPicked = held === undefined ? unshipped : Prisma.Decimal.min(unshipped, held);
    return omitEmpty({
      lotId: lot.lotId, lotNo: lot.lotNo, pickedQty: lot.picked.toNumber(), shippedQty: out.toNumber(),
      returnableQty: unshipped.toNumber(), fromPickedQty: fromPicked.toNumber(), limitedByBalance: fromPicked.lessThan(unshipped),
    });
  });
}

/**
 * 예약 한 줄 ↔ `ShipmentLinePickedLot` required 넷이 1:1 이다 —
 * `lot_id`·`reserved_qty`·`uom_id`·`created_at`.
 * ⚠ `lot_id` 는 물리가 nullable 이지만 이 축(`SHIPMENT_REQUEST_LINE`)의 예약은 `:pick` 이 **LOT 을
 *   집어** 만든 것이라 늘 있다. ⛔ 그렇다고 널 행을 걸러 내지 마라 — 걸러 내면 `pickedQty` 롤업과
 *   `Σ picks[].pickedQty` 가 갈린다(e2e D-25 가 이 결정을 잠근다).
 * ⚠ 그때 `lotId` 가 **0** 이 되는 것은 「오늘의 동작」일 뿐 확정된 답이 아니다 — 계약 required
 *   `lotId` 에 어느 LOT 도 아닌 0 이 실린다. 답은 통합자가 설계 문의로 정한다.
 */
function shipmentLinePickedLotView(pick: ShipmentPickRow): ShipmentLinePickedLotView {
  return omitEmpty({
    lotId: Number(pick.lot_id),
    lotNo: pick.lot?.lot_no,
    pickedQty: Number(pick.reserved_qty),
    releasedQty: Number(pick.released_qty),
    uomId: Number(pick.uom_id),
    pickedAt: pick.created_at.toISOString(),
  });
}
