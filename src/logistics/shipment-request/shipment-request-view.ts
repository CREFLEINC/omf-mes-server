import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import type { OqcLotStatus } from '../../quality/inspection/oqc-lot-result';
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

/** ⭐ `inventory_reservation` 행이 곧 `picks[]` 다 — 담을 표가 따로 없다(§1-4-1). 창고·위치는 피킹 LOT 의 몫(`portions`)에 쓴다. */
export type ShipmentPickRow = Prisma.inventory_reservationGetPayload<{
  include: {
    lot: { select: { lot_no: true } };
    warehouse: { select: { warehouse_code: true; warehouse_name: true } };
    location: { select: { location_code: true } };
  };
}>;

/** 라인 id(문자열) → 그 라인에 걸린 예약 행. 호출자가 **한 방**으로 읽어 넘긴다. */
export type ShipmentPicksByLine = Map<string, ShipmentPickRow[]>;

/** 피킹 LOT 행(피처 010) — LOT 번호·작업자를 함께 읽는다. */
export type ShipmentRequestLotRow = Prisma.shipment_request_lotGetPayload<{
  include: {
    lot: { select: { lot_no: true; item_id: true } };
    picked_worker: { select: { worker_no: true; worker_name: true } };
  };
}>;

/** 라인 id(문자열) → 그 라인의 피킹 LOT 행(교체된 행 포함). */
export type ShipmentLotsByLine = Map<string, ShipmentRequestLotRow[]>;

/** 피킹 LOT 행 id → OQC 판정(살아 있는 행만 — `oqcLotStatusesOf`). */
export type OqcLotStatusByLot = Map<bigint, OqcLotStatus>;

/** 지시서 QR·POP 스캔 값의 접두 — 번호 `SR-…` 가 생산 현장 입고와 같아 유형을 붙인다(R-9). */
export const SHIPMENT_REQUEST_CODE_PREFIX = 'SHPREQ:';

export interface ShipmentLotPortionView {
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
  locationId: number | null;
  locationCode: string | null;
  qty: number;
}

export interface ShipmentRequestLotView {
  shipmentRequestLotId: number;
  lotId: number;
  lotNo: string;
  itemId: number;
  pickedQty: number;
  uomId: number;
  statusCode: string;
  managementCode: string | null;
  pickedAt: string;
  pickedWorker: { workerId: number; workerNo: string; workerName: string } | null;
  shipmentId: number | null;
  portions: ShipmentLotPortionView[];
  /** LOT OQC 판정 6종(FR-007). 교체된 행은 판정 대상이 아니라 null. */
  oqcLotStatus: OqcLotStatus | null;
}

export interface ShipmentPickingWarehouseView {
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
}

export interface ShipmentLinePickedLotView {
  lotId: number;
  lotNo?: string;
  pickedQty: number;
  uomId: number;
  pickedAt: string;
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
  /** 초과 = 피킹 − 목표(배정). 목표에 못 미치면 0. */
  overQty: number;
  lots: ShipmentRequestLotView[];
}

export interface ShipmentRequestView {
  shipmentRequestId: number;
  shipmentRequestNo: string;
  /** 지시서 QR 값 `SHPREQ:{no}`. */
  code: string;
  salesOrderId: number | null;
  fulfillmentPlantId: number | null;
  customerId: number;
  shipToPartnerId: number;
  requestedShipDate: string;
  statusCode: string;
  timeSlotCode: string | null;
  shippingInspectionStatusCode: ShippingInspectionStatusCode;
  shipmentProgressCode: ShipmentProgressCode;
  /** 살아 있는 피킹 LOT 이 있는 창고들 — 출하 지시서는 창고를 정하지 않는다(공장 단위 · R-2). */
  pickingWarehouses: ShipmentPickingWarehouseView[];
  lines?: ShipmentRequestLineView[];
  versionNo?: number;
}

export function shipmentRequestView(
  row: ShipmentRequestRow,
  picksByLine: ShipmentPicksByLine,
  inspections: OqcInspectionRow[],
  lotsByLine: ShipmentLotsByLine = new Map(),
  oqcStatuses: OqcLotStatusByLot = new Map(),
): ShipmentRequestView {
  const lines = row.shipment_request_line.map((line) => ({
    line,
    picks: picksByLine.get(String(line.shipment_request_line_id)) ?? [],
    lots: lotsByLine.get(String(line.shipment_request_line_id)) ?? [],
  }));
  const lineViews = lines.map(({ line, picks, lots }) => shipmentRequestLineView(line, picks, lots, oqcStatuses));

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

  // ⭐ 라인이 집은 LOT 집합이 곧 검사 대상 축이다(§5-2) — `picks[].lotId` 를 그대로 넘긴다.
  const inspectionLines: ShipmentInspectionLine[] = lines.map(({ line, picks }) => ({
    shipmentRequestId: row.shipment_request_id,
    shippingInspectionRequired: line.shipping_inspection_required,
    lotIds: picks.flatMap((pick) => (pick.lot_id === null ? [] : [pick.lot_id])),
  }));

  return omitEmpty({
    shipmentRequestId: Number(row.shipment_request_id),
    shipmentRequestNo: row.shipment_request_no,
    code: `${SHIPMENT_REQUEST_CODE_PREFIX}${row.shipment_request_no}`,
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
    pickingWarehouses: pickingWarehouses(lineViews),
    lines: lineViews,
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
  lots: ShipmentRequestLotRow[] = [],
  oqcStatuses: OqcLotStatusByLot = new Map(),
): ShipmentRequestLineView {
  const picked = pickedQtyOf(picks.map((pick) => ({ reservedQty: pick.reserved_qty, releasedQty: pick.released_qty })));
  const over = picked.minus(row.allocated_qty);
  return omitEmpty({
    shipmentRequestLineId: Number(row.shipment_request_line_id),
    lineNo: row.line_no,
    salesOrderLineId: row.sales_order_line_id === null ? null : Number(row.sales_order_line_id),
    itemId: Number(row.item_id),
    requestedQty: Number(row.requested_qty),
    allocatedQty: Number(row.allocated_qty),
    pickedQty: Number(picked),
    shippedQty: Number(row.shipped_qty),
    uomId: Number(row.uom_id),
    customerLotRequirement: row.customer_lot_requirement,
    shippingInspectionRequired: row.shipping_inspection_required,
    minimumRemainingShelfLifeDays: row.minimum_remaining_shelf_life_days,
    picks: picks.map(shipmentLinePickedLotView),
    overQty: over.greaterThan(0) ? Number(over) : 0,
    lots: lots.map((lot) => shipmentRequestLotView(lot, picks, oqcStatuses)),
  });
}

/**
 * 피킹 LOT 한 행. 창고·위치별 몫은 그 라인·LOT 의 예약 행(잔액 행마다 하나)에서 읽는다 — 살아 있는 행은
 * `reserved − released`, 교체된 행은 풀린 수량이라 `reserved` 를 그대로 보인다(이력).
 */
export function shipmentRequestLotView(
  row: ShipmentRequestLotRow,
  picks: ShipmentPickRow[],
  oqcStatuses: OqcLotStatusByLot = new Map(),
): ShipmentRequestLotView {
  const replaced = row.status_code === 'REPLACED';
  const portions = new Map<string, ShipmentLotPortionView>();
  for (const pick of picks) {
    if (pick.lot_id !== row.lot_id) continue;
    const qty = replaced ? Number(pick.reserved_qty) : Number(pick.reserved_qty) - Number(pick.released_qty);
    if (qty <= 0) continue;
    const key = `${String(pick.warehouse_id)}:${String(pick.location_id)}`;
    const seen = portions.get(key);
    if (seen !== undefined) { seen.qty += qty; continue; }
    portions.set(key, {
      warehouseId: Number(pick.warehouse_id),
      warehouseCode: pick.warehouse.warehouse_code,
      warehouseName: pick.warehouse.warehouse_name,
      locationId: pick.location_id === null ? null : Number(pick.location_id),
      locationCode: pick.location?.location_code ?? null,
      qty,
    });
  }
  return {
    shipmentRequestLotId: Number(row.shipment_request_lot_id),
    lotId: Number(row.lot_id),
    lotNo: row.lot.lot_no,
    itemId: Number(row.lot.item_id),
    pickedQty: Number(row.picked_qty),
    uomId: Number(row.uom_id),
    statusCode: row.status_code,
    managementCode: row.management_code,
    pickedAt: row.picked_at.toISOString(),
    pickedWorker: row.picked_worker === null || row.picked_worker_id === null
      ? null
      : { workerId: Number(row.picked_worker_id), workerNo: row.picked_worker.worker_no, workerName: row.picked_worker.worker_name },
    shipmentId: row.shipment_id === null ? null : Number(row.shipment_id),
    portions: [...portions.values()],
    oqcLotStatus: oqcStatuses.get(row.shipment_request_lot_id) ?? null,
  };
}

/** 교체되지 않은 피킹 LOT 의 몫이 있는 창고들(처음 나온 순서). */
function pickingWarehouses(lines: ShipmentRequestLineView[]): ShipmentPickingWarehouseView[] {
  const seen = new Map<number, ShipmentPickingWarehouseView>();
  for (const lot of lines.flatMap((line) => line.lots)) {
    if (lot.statusCode === 'REPLACED') continue;
    for (const portion of lot.portions) {
      if (!seen.has(portion.warehouseId)) {
        seen.set(portion.warehouseId, {
          warehouseId: portion.warehouseId, warehouseCode: portion.warehouseCode, warehouseName: portion.warehouseName,
        });
      }
    }
  }
  return [...seen.values()];
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
    uomId: Number(pick.uom_id),
    pickedAt: pick.created_at.toISOString(),
  });
}
