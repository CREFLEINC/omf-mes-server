import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import type { OqcLotDecision, OqcLotStatus } from '../../quality/inspection/oqc-lot-result';
import { CompletionBlocker, CompletionBlockerCode, blockerSummary, completionBlockers } from './shipment-completion-rules';
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
    location: { select: { location_code: true; system_role_code: true } };
  };
}>;

/** 라인 id(문자열) → 그 라인에 걸린 예약 행. 호출자가 **한 방**으로 읽어 넘긴다. */
export type ShipmentPicksByLine = Map<string, ShipmentPickRow[]>;

/** 피킹 LOT 행(피처 010) — LOT 번호·작업자를 함께 읽는다. */
export type ShipmentRequestLotRow = Prisma.shipment_request_lotGetPayload<{
  include: {
    lot: { select: { lot_no: true; item_id: true } };
    picked_worker: { select: { worker_no: true; worker_name: true } };
    replaced_worker: { select: { worker_no: true; worker_name: true } };
    replace_inspection_result: { select: { inspection_result_no: true; inspection_round: true; inspected_at: true; overall_judgment_code: true } };
    replace_nonconformance: { select: { nonconformance_no: true } };
  };
}>;

/** 교체 근거(FR-015) — 불합격 결과·부적합·작업자·시각. */
export interface ShipmentLotReplacementView {
  inspectionResultId: number;
  resultNo: string;
  /** 근거 결과의 회차(의뢰 안 순번) — 화면의 「결과 #n」. */
  resultRound: number;
  resultAt: string;
  judgment: string | null;
  nonconformanceId: number | null;
  nonconformanceNo: string | null;
  replacedAt: string;
  worker: { workerId: number; workerNo: string; workerName: string } | null;
}

/** 라인 id(문자열) → 그 라인의 피킹 LOT 행(교체된 행 포함). */
export type ShipmentLotsByLine = Map<string, ShipmentRequestLotRow[]>;

/** 피킹 LOT 행 id → OQC 판정과 근거 결과(살아 있는 행만 — `oqcLotDecisionsOf`). */
export type OqcLotStatusByLot = Map<bigint, OqcLotDecision>;

/** 수주 라인 표시 값 — W-04-02 「수주 잔량」(「0 + 초과 n」)과 「SO · 라인」. */
export interface SalesOrderLineFact {
  salesOrderNo: string;
  lineNo: number;
  orderedQty: number;
  shippedQty: number;
  cancelled: boolean;
}

/** 표시용 이름·번호(시안 차이 보완) — 호출자가 한 방씩 읽어 넘긴다. 없으면 빈 값으로 싣는다. */
export interface ShipmentRequestDisplayFacts {
  salesOrderNos: Map<string, string>;
  salesOrderLines: Map<string, SalesOrderLineFact>;
  items: Map<string, { itemCode: string; itemName: string }>;
  uomCodes: Map<string, string>;
  /** 고객·납품처(거래처) — PDA 카드·POP 찾기·P-04-06 머리(피처 010 검증 1회차). */
  partners?: Map<string, ShipmentRequestPartnerView>;
  /** 지시서 사업부(피처 012 FR-007). */
  businessUnits?: Map<string, ShipmentRequestBusinessUnitView>;
  /** 줄 출고 창고와 그 공장(피처 012 FR-007). */
  warehouses?: Map<string, ShipmentRequestWarehouseView>;
  /** 지시서마다 출하(취소 포함, 최신순 · 피처 012 FR-019). */
  shipments?: Map<string, ShipmentRequestShipmentView[]>;
}

/** 지시서의 출하 한 건 — W-04-02 상세 「출하」 칸의 머리(내용은 `GET /logistics/shipments/{id}`) · 피처 012. */
export interface ShipmentRequestShipmentView {
  shipmentId: number;
  shipmentNo: string;
  statusCode: string;
  /** 010 출하 내역과 같은 송신 상태 6값. */
  erpSendStatus: string;
  /** 열린 취소 결재가 있다. */
  cancelRequestPending: boolean;
}

/** 지시서 사업부 표시 칸(피처 012). */
export interface ShipmentRequestBusinessUnitView {
  businessUnitId: number;
  businessUnitCode: string;
  businessUnitName: string;
}

/** 줄 출고 창고 표시 칸 — 공장 이름을 함께 싣는다(「완제품창고 A · 1공장」 · 피처 012). */
export interface ShipmentRequestWarehouseView {
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
  plantId: number;
  plantName: string;
}

/** 거래처 표시 칸 — 출하 내역(`Shipment.customer`)·완료 확인 값과 같은 모양. */
export interface ShipmentRequestPartnerView {
  partnerId: number;
  partnerCode: string;
  partnerName: string;
}

const NO_DISPLAY: ShipmentRequestDisplayFacts = { salesOrderNos: new Map(), salesOrderLines: new Map(), items: new Map(), uomCodes: new Map() };

/** OQC 판정을 정한 결과 — PDA 불합격 줄의 「OQC 결과 n · 시각」. */
export interface ShipmentLotOqcResultView {
  inspectionResultId: number;
  resultNo: string;
  round: number;
  resultAt: string;
}

/** 출하 완료 관문의 바깥 사실 — 지시서별 살아 있는 POP 완료 출하, 취소된 수주 라인 id. */
export interface CompletionFacts {
  completed: Map<string, CompletedShipmentView>;
  cancelledSalesOrderLines: Set<string>;
}

export interface CompletedShipmentView {
  shipmentId: number;
  shipmentNo: string;
  completedAt: string;
  /** 완료한 POP 단말 — W-04-02 상세·P-04-07 결과·이미 완료(시안 「POP-출하-01 · 김작업(W-0102)」). */
  completedTerminal: { terminalId: number; terminalCode: string } | null;
  completedWorker: { workerId: number; workerNo: string; workerName: string } | null;
}

export interface LotJudgmentSummaryView {
  notInspected: number;
  accepted: number;
  rejected: number;
  held: number;
}

/** 지시서 QR·POP 스캔 값의 접두 — 번호 `SR-…` 가 생산 현장 입고와 같아 유형을 붙인다(R-9). */
export const SHIPMENT_REQUEST_CODE_PREFIX = 'SHPREQ:';

export interface ShipmentLotPortionView {
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
  locationId: number | null;
  locationCode: string | null;
  /** 위치의 시스템 역할 — `PUTAWAY_STAGING` 이면 적치 대기 자리(화면 「적치 대기」). 보통 자리는 null. */
  locationSystemRoleCode: string | null;
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
  /** 판정을 정한 결과(합격·불합격·보류) — 미검사·검사 불필요·생략·교체된 행은 null. */
  oqcResult: ShipmentLotOqcResultView | null;
  /** 교체된 행(REPLACED)만 — 그 밖은 null. */
  replacement: ShipmentLotReplacementView | null;
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
  itemCode: string;
  itemName: string;
  requestedQty: number;
  allocatedQty: number;
  pickedQty: number;
  shippedQty: number;
  uomId: number;
  uomCode: string;
  /** 수주 라인(수주·출하 수량) — 수주 없는 라인은 null. */
  salesOrderLine: (SalesOrderLineFact & { salesOrderLineId: number }) | null;
  customerLotRequirement: string | null;
  shippingInspectionRequired: boolean;
  minimumRemainingShelfLifeDays: number | null;
  /** 출고 창고 — null 은 배포 전 줄(「창고 미지정」, 지시서 공장의 불량 외 창고에서 피킹 · 피처 012). */
  warehouse: ShipmentRequestWarehouseView | null;
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
  /** 수주 번호 — 수주 없는 지시서는 null. */
  salesOrderNo: string | null;
  fulfillmentPlantId: number | null;
  /** 지시서 사업부 — 사업부 없는 공장의 옛 지시서는 null(「사업부 미지정」 · 피처 012). */
  businessUnitId: number | null;
  businessUnit: ShipmentRequestBusinessUnitView | null;
  /** 줄 출고 창고 요약 — 줄 순서대로 겹치지 않게. 창고 없는 옛 줄은 담지 않는다(피처 012). */
  warehouses: ShipmentRequestWarehouseView[];
  /** 대표 출하의 ERP 송신 상태 — 출하가 없으면 null(피처 012 FR-018 · 완료 전 화면은 이 칸을 그리지 않는다). */
  erpSendStatus: string | null;
  /** 출하(취소 포함, 최신순 · 피처 012 FR-019). */
  shipments: ShipmentRequestShipmentView[];
  customerId: number;
  shipToPartnerId: number;
  /** 고객·납품처 이름 — 거래처가 없으면 null. */
  customer: ShipmentRequestPartnerView | null;
  shipTo: ShipmentRequestPartnerView | null;
  requestedShipDate: string;
  statusCode: string;
  timeSlotCode: string | null;
  shippingInspectionStatusCode: ShippingInspectionStatusCode;
  shipmentProgressCode: ShipmentProgressCode;
  /** 살아 있는 피킹 LOT 이 있는 창고들 — 출하 지시서는 창고를 정하지 않는다(공장 단위 · R-2). */
  pickingWarehouses: ShipmentPickingWarehouseView[];
  /** OQC 불합격으로 교체한 LOT 수(FR-015 · 「LOT 교체 n」). */
  replacementCount: number;
  /** 출하 완료를 막는 이유(FR-016) — 비면 완료 대기. */
  completionBlockers: CompletionBlocker[];
  /** 목록의 「막힘 n」 — 이유 코드별 수. */
  blockerSummary: Partial<Record<CompletionBlockerCode, number>>;
  /** 살아 있는 피킹 LOT 의 OQC 판정 수. */
  lotJudgmentSummary: LotJudgmentSummaryView;
  /** POP 에서 완료한 출하(취소 아님) — 없으면 null. */
  completedShipment: CompletedShipmentView | null;
  lines?: ShipmentRequestLineView[];
  versionNo?: number;
}

export function shipmentRequestView(
  row: ShipmentRequestRow,
  picksByLine: ShipmentPicksByLine,
  inspections: OqcInspectionRow[],
  lotsByLine: ShipmentLotsByLine = new Map(),
  oqcStatuses: OqcLotStatusByLot = new Map(),
  facts: CompletionFacts = { completed: new Map(), cancelledSalesOrderLines: new Set() },
  display: ShipmentRequestDisplayFacts = NO_DISPLAY,
): ShipmentRequestView {
  const lines = row.shipment_request_line.map((line) => ({
    line,
    picks: picksByLine.get(String(line.shipment_request_line_id)) ?? [],
    lots: lotsByLine.get(String(line.shipment_request_line_id)) ?? [],
  }));
  const lineViews = lines.map(({ line, picks, lots }) => shipmentRequestLineView(line, picks, lots, oqcStatuses, display));
  const completedShipment = facts.completed.get(String(row.shipment_request_id)) ?? null;
  const liveLots = lineViews.flatMap((line) => line.lots).filter((lot) => lot.statusCode === 'PICKED');
  const blockers = completionBlockers({
    completed: completedShipment !== null,
    lines: lines.map(({ line }, index) => ({
      lineNo: line.line_no, allocatedQty: Number(line.allocated_qty), pickedQty: lineViews[index].pickedQty,
      ...(lineViews[index].warehouse == null ? {} : { warehouseName: lineViews[index].warehouse?.warehouseName }),
      salesOrderLineCancelled: line.sales_order_line_id !== null && facts.cancelledSalesOrderLines.has(String(line.sales_order_line_id)),
    })),
    lots: liveLots.map((lot) => ({ lotNo: lot.lotNo, oqcLotStatus: lot.oqcLotStatus })),
  });
  // 「검사」 칸 요약은 출하한 LOT(`SHIPPED`)도 센다 — 교체된 LOT 만 뺀다(omf-all-around#344).
  // 막는 이유는 위처럼 피킹 중(`PICKED`)만 본다(출하 완료 뒤에는 막는 이유가 없다).
  const judgedLots = lineViews.flatMap((line) => line.lots).filter((lot) => lot.statusCode !== 'REPLACED');
  const judged = (status: OqcLotStatus) => judgedLots.filter((lot) => lot.oqcLotStatus === status).length;

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
    salesOrderNo: row.sales_order_id === null ? null : display.salesOrderNos.get(String(row.sales_order_id)) ?? null,
    fulfillmentPlantId:
      row.fulfillment_plant_id === null ? null : Number(row.fulfillment_plant_id),
    businessUnitId: row.business_unit_id === null ? null : Number(row.business_unit_id),
    businessUnit: row.business_unit_id === null ? null : display.businessUnits?.get(String(row.business_unit_id)) ?? null,
    warehouses: uniqueWarehouses(lineViews),
    erpSendStatus: representativeShipment(display.shipments?.get(String(row.shipment_request_id)) ?? [])?.erpSendStatus ?? null,
    shipments: display.shipments?.get(String(row.shipment_request_id)) ?? [],
    customerId: Number(row.customer_id),
    shipToPartnerId: Number(row.ship_to_partner_id),
    customer: display.partners?.get(String(row.customer_id)) ?? null,
    shipTo: display.partners?.get(String(row.ship_to_partner_id)) ?? null,
    requestedShipDate: toDateString(row.requested_ship_date) as string,
    statusCode: REGISTERED,
    timeSlotCode: row.ship_time_slot_code,
    shippingInspectionStatusCode: shipmentInspectionStatus(inspectionLines, inspections),
    shipmentProgressCode: shipmentProgressCode(totals),
    pickingWarehouses: pickingWarehouses(lineViews),
    replacementCount: lineViews.reduce((count, line) => count + line.lots.filter((lot) => lot.statusCode === 'REPLACED').length, 0),
    completionBlockers: blockers,
    blockerSummary: blockerSummary(blockers),
    lotJudgmentSummary: { notInspected: judged('NOT_INSPECTED'), accepted: judged('ACCEPTED'), rejected: judged('REJECTED'), held: judged('HELD') },
    completedShipment,
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
  display: ShipmentRequestDisplayFacts = NO_DISPLAY,
): ShipmentRequestLineView {
  const item = display.items.get(String(row.item_id));
  const orderLine = row.sales_order_line_id === null ? undefined : display.salesOrderLines.get(String(row.sales_order_line_id));
  const picked = pickedQtyOf(picks.map((pick) => ({ reservedQty: pick.reserved_qty, releasedQty: pick.released_qty })));
  const over = picked.minus(row.allocated_qty);
  return omitEmpty({
    shipmentRequestLineId: Number(row.shipment_request_line_id),
    lineNo: row.line_no,
    salesOrderLineId: row.sales_order_line_id === null ? null : Number(row.sales_order_line_id),
    itemId: Number(row.item_id),
    itemCode: item?.itemCode ?? '',
    itemName: item?.itemName ?? '',
    requestedQty: Number(row.requested_qty),
    allocatedQty: Number(row.allocated_qty),
    pickedQty: Number(picked),
    shippedQty: Number(row.shipped_qty),
    uomId: Number(row.uom_id),
    uomCode: display.uomCodes.get(String(row.uom_id)) ?? '',
    salesOrderLine: orderLine === undefined || row.sales_order_line_id === null
      ? null
      : { salesOrderLineId: Number(row.sales_order_line_id), ...orderLine },
    customerLotRequirement: row.customer_lot_requirement,
    shippingInspectionRequired: row.shipping_inspection_required,
    minimumRemainingShelfLifeDays: row.minimum_remaining_shelf_life_days,
    warehouse: row.warehouse_id === null ? null : display.warehouses?.get(String(row.warehouse_id)) ?? null,
    picks: picks.map(shipmentLinePickedLotView),
    overQty: over.greaterThan(0) ? Number(over) : 0,
    lots: lots.map((lot) => shipmentRequestLotView(lot, picks, oqcStatuses)),
  });
}

/** 대표 출하 — 취소 안 된 출하 중 가장 최근, 모두 취소면 가장 최근. `REQUEST_ERP_SEND_STATUS_SQL` 과 같은 순서다. */
function representativeShipment(shipments: ShipmentRequestShipmentView[]): ShipmentRequestShipmentView | undefined {
  return shipments.find((shipment) => shipment.statusCode !== 'CANCELLED') ?? shipments[0];
}

function uniqueWarehouses(lines: ShipmentRequestLineView[]): ShipmentRequestWarehouseView[] {
  const seen = new Map<number, ShipmentRequestWarehouseView>();
  for (const line of lines) if (line.warehouse !== null && !seen.has(line.warehouse.warehouseId)) seen.set(line.warehouse.warehouseId, line.warehouse);
  return [...seen.values()];
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
  const decision = oqcStatuses.get(row.shipment_request_lot_id);
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
      locationSystemRoleCode: pick.location?.system_role_code ?? null,
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
    oqcLotStatus: decision?.status ?? null,
    oqcResult: decision?.result == null ? null : {
      inspectionResultId: Number(decision.result.inspectionResultId), resultNo: decision.result.resultNo,
      round: decision.result.round, resultAt: decision.result.inspectedAt.toISOString(),
    },
    replacement: replacementView(row),
  };
}

function replacementView(row: ShipmentRequestLotRow): ShipmentLotReplacementView | null {
  const result = row.replace_inspection_result;
  if (row.status_code !== 'REPLACED' || result === null || row.replace_inspection_result_id === null || row.replaced_at === null) return null;
  return {
    inspectionResultId: Number(row.replace_inspection_result_id),
    resultNo: result.inspection_result_no,
    resultRound: result.inspection_round,
    resultAt: result.inspected_at.toISOString(),
    judgment: result.overall_judgment_code,
    nonconformanceId: row.replace_nonconformance_id === null ? null : Number(row.replace_nonconformance_id),
    nonconformanceNo: row.replace_nonconformance?.nonconformance_no ?? null,
    replacedAt: row.replaced_at.toISOString(),
    worker: row.replaced_worker === null || row.replaced_worker_id === null
      ? null
      : { workerId: Number(row.replaced_worker_id), workerNo: row.replaced_worker.worker_no, workerName: row.replaced_worker.worker_name },
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
