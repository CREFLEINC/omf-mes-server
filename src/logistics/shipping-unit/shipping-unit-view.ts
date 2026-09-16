/** 출하 단위는 열렸거나 마감됐거나 둘뿐이다. 편도다 — 되돌리는 경로를 두지 않는다. */
export const SHIPPING_UNIT_OPEN = 'OPEN';
export const SHIPPING_UNIT_CLOSED = 'CLOSED';

export interface PartnerRef {
  partnerId: number;
  partnerCode: string;
  partnerName: string;
}

export interface ShippingUnitView {
  shippingUnitId: number;
  shippingUnitNo: string;
  shippingUnitTypeCode: string;
  statusCode: string;
  shipmentId: number;
  shipmentNo: string;
  customer: PartnerRef;
  shipTo: PartnerRef;
  boxCount: number;
  closedAt?: string;
  createdAt: string;
  versionNo: number;
}

export interface ShippingUnitBoxContentView {
  itemId: number;
  itemCode: string;
  itemName: string;
  lotId: number;
  lotNo: string;
  qty: number;
  uomId: number;
  uomCode: string;
}

export interface ShippingUnitBoxView {
  handlingUnitId: number;
  handlingUnitNo: string;
  seq: number;
  contents: ShippingUnitBoxContentView[];
}

export interface ShippingUnitItemTotalView {
  itemId: number;
  itemCode: string;
  itemName: string;
  qty: number;
  uomId: number;
  uomCode: string;
}

export interface ShippingUnitDetailView extends ShippingUnitView {
  boxes: ShippingUnitBoxView[];
  itemTotals: ShippingUnitItemTotalView[];
}

/** 상세 조회가 읽어 오는 행 모양(Prisma include 결과). */
export interface ShippingUnitRow {
  shipping_unit_id: bigint;
  shipping_unit_no: string;
  shipping_unit_type_code: string;
  status_code: string;
  shipment_id: bigint;
  closed_at: Date | null;
  created_at: Date;
  version_no: number;
  shipment: {
    shipment_no: string;
    shipment_request: {
      partner_shipment_request_customer_idTopartner: PartnerRow;
      partner_shipment_request_ship_to_partner_idTopartner: PartnerRow;
    };
  };
}

interface PartnerRow {
  partner_id: bigint;
  partner_code: string;
  partner_name: string;
}

function partnerRef(row: PartnerRow): PartnerRef {
  return {
    partnerId: Number(row.partner_id),
    partnerCode: row.partner_code,
    partnerName: row.partner_name,
  };
}

export function shippingUnitView(row: ShippingUnitRow, boxCount: number): ShippingUnitView {
  const request = row.shipment.shipment_request;
  return {
    shippingUnitId: Number(row.shipping_unit_id),
    shippingUnitNo: row.shipping_unit_no,
    shippingUnitTypeCode: row.shipping_unit_type_code,
    statusCode: row.status_code,
    shipmentId: Number(row.shipment_id),
    shipmentNo: row.shipment.shipment_no,
    // ⭐ 고객·납품처는 출하 전표 → 출하작업지시 → 거래처로 «서버가» 조인해 내린다. 단말은
    //   `shipment-requests` 를 못 읽고(MOBILE 전용), 그 값이 납품 라벨의 머리 두 줄이다.
    //   ⛔ FK 사슬이 전부 NOT NULL 이라 끊길 수 없다 — null 갈래를 두지 않는다.
    customer: partnerRef(request.partner_shipment_request_customer_idTopartner),
    shipTo: partnerRef(request.partner_shipment_request_ship_to_partner_idTopartner),
    boxCount,
    // 미마감이면 키 자체를 빼지 않고 생략한다(계약이 nullable 로 열어 둔 칸이다).
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at.toISOString() }),
    createdAt: row.created_at.toISOString(),
    versionNo: row.version_no,
  };
}

/** Prisma `Decimal` 이 그대로 새면 JSON 이 문자열을 싣는다 — 숫자로 접는다. */
export function qtyNumber(value: { toString(): string }): number {
  return Number(value.toString());
}
