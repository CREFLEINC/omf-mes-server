import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { ShipmentLotAllocationView } from '../shipment-allocation/shipment-allocation-view';

/**
 * 계약 `Shipment` 로 옮기는 자리 — 프로퍼티 **19 · required 6**.
 *
 * ⛔ **널 정책이 칸마다 다르다.** 계약이 `type:['string','null']` 로 적은 넷
 * (`loadedAt`·`shippedAt`·`erpDeliveryNo`·`expediteReason`)은 **`null` 을 내리고**, 널을 «못 받는»
 * 선택 칸(`vehicleNo`·`driverName`·`sealNo`·`transportDocumentNo`·`loadingWorkerId`·`carrierId`·
 * `remarks`·`lines`·`versionNo`)은 값이 없으면 **키를 생략**한다(`omitEmpty`). 뒤엉키면 화면이
 * 「빈 값」과 「모르는 값」을 구별하지 못한다(I-22 `shipment-request-view.ts` 와 같은 처리).
 *
 * ⭐⭐ **`lines` 는 목록에서 «키째» 빠진다** — `required` 에 없고 상세 설명만 「라인과 LOT 배분을
 * 함께 내린다」라 적었다. 그 부재는 HTTP 로 반증되지 않아(README §6-3 ⑹) `shipment-view.spec.ts`
 * 가 `not.toHaveProperty('lines')` 로 잠근다.
 */
export type ShipmentRow = Prisma.shipmentGetPayload<object>;

export interface ShipmentView {
  shipmentId: number;
  shipmentNo: string;
  shipmentRequestId: number;
  warehouseId: number;
  vehicleNo?: string;
  driverName?: string;
  sealNo?: string;
  transportDocumentNo?: string;
  loadingWorkerId?: number;
  carrierId?: number;
  loadedAt: string | null;
  shippedAt: string | null;
  statusCode: string;
  erpDeliveryNo: string | null;
  remarks?: string;
  expedited: boolean;
  expediteReason: string | null;
  versionNo?: number;
}

/** 계약 `ShipmentLine` — 프로퍼티 8 · required 6. */
export interface ShipmentLineView {
  shipmentLineId: number;
  lineNo: number;
  shipmentRequestLineId: number;
  itemId: number;
  shippedQty: number;
  uomId: number;
  /** ⚠ 계약이 「비어도 된다」라 적은 널 «받는» 칸이다 — 키를 지우지 않는다(§3-5). */
  goodsIssueLineId: number | null;
  allocations: ShipmentLotAllocationView[];
}

/** 상세는 목록과 달리 `lines` 를 «싣는다» — 계약 「라인과 LOT 배분을 함께 내린다」. */
export interface ShipmentDetailView extends ShipmentView {
  lines: ShipmentLineView[];
}

export type ShipmentLineRow = Prisma.shipment_lineGetPayload<object>;

export function shipmentLineView(
  row: ShipmentLineRow,
  allocations: ShipmentLotAllocationView[],
): ShipmentLineView {
  return {
    shipmentLineId: Number(row.shipment_line_id),
    lineNo: row.line_no,
    shipmentRequestLineId: Number(row.shipment_request_line_id),
    itemId: Number(row.item_id),
    shippedQty: Number(row.shipped_qty),
    uomId: Number(row.uom_id),
    goodsIssueLineId:
      row.goods_issue_line_id === null ? null : Number(row.goods_issue_line_id),
    allocations,
  };
}

/**
 * ⭐ 목록 뷰에 `lines` 를 얹는다 — **뷰를 두 벌로 적지 않는다.** 헤더 19칸이 갈리면 목록과
 * 상세가 같은 출하를 다르게 그린다.
 */
export function shipmentDetailView(
  row: ShipmentRow,
  lines: ShipmentLineView[],
): ShipmentDetailView {
  return { ...shipmentView(row), lines };
}

/** `null` 을 «키 없음»으로 접는다 — 위 널 정책의 뒤쪽 갈래에 쓴다. */
const skip = <T>(value: T | null): T | undefined => value ?? undefined;

export function shipmentView(row: ShipmentRow): ShipmentView {
  return omitEmpty({
    shipmentId: Number(row.shipment_id),
    shipmentNo: row.shipment_no,
    shipmentRequestId: Number(row.shipment_request_id),
    warehouseId: Number(row.warehouse_id),
    vehicleNo: skip(row.vehicle_no),
    driverName: skip(row.driver_name),
    sealNo: skip(row.seal_no),
    transportDocumentNo: skip(row.transport_document_no),
    loadingWorkerId: row.loading_worker_id === null ? undefined : Number(row.loading_worker_id),
    carrierId: row.carrier_id === null ? undefined : Number(row.carrier_id),
    // ⛔ 이 넷은 `?? undefined` 로 접지 마라 — 계약이 널을 «받는» 칸이라 키를 지우면 화면이
    //    「아직 안 나갔다」를 「모른다」로 읽는다.
    loadedAt: row.loaded_at === null ? null : row.loaded_at.toISOString(),
    shippedAt: row.shipped_at === null ? null : row.shipped_at.toISOString(),
    statusCode: row.status_code,
    erpDeliveryNo: row.erp_delivery_no,
    remarks: skip(row.remarks),
    expedited: row.expedited,
    expediteReason: row.expedite_reason,
    versionNo: row.version_no,
  });
}
