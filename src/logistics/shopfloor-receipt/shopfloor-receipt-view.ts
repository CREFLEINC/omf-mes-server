import { Prisma } from '@prisma/client';

/**
 * 계약 `ShopfloorReceipt`·`ShopfloorReceiptLine` 으로 옮기는 자리. PR ②(`POST` 되읽기)가
 * 그대로 재사용한다(I-9.md §11-1 — 스택 이유).
 *
 * ⛔ 널이어도 **키를 생략하지 않는다** — `receivedBy`·`varianceReasonCode` 는 계약 `type` 에
 * `null` 이 이미 있다(`goods-issue-view.ts:77` 선례 · I-8.md R-20).
 *
 * `SHOPFLOOR_RECEIPT_LINE_INCLUDE` 는 **라인** 조회용(라벨 3칸 조인) ·
 * `SHOPFLOOR_RECEIPT_INCLUDE` 는 **헤더**에 붙는 중첩 include(목록·상세·`POST` 되읽기가 같은
 * 상수를 쓴다) — `PICKING_LINE_INCLUDE`(`picking-view.ts:15-19`)와 이름이 갈리는 이유는
 * 저쪽은 라인 조회 자체가 대상이고 이쪽은 헤더가 라인을 몰아 싣기 때문이다(I-9.md R-13).
 */

export const SHOPFLOOR_RECEIPT_LINE_INCLUDE = {
  item: { select: { item_code: true, item_name: true } },
  lot: { select: { lot_no: true } },
} as const;

export const SHOPFLOOR_RECEIPT_INCLUDE = {
  shopfloor_receipt_line: {
    orderBy: { shopfloor_receipt_line_id: 'asc' },
    include: SHOPFLOOR_RECEIPT_LINE_INCLUDE,
  },
} as const;

export type ShopfloorReceiptRow = Prisma.shopfloor_receiptGetPayload<{
  include: typeof SHOPFLOOR_RECEIPT_INCLUDE;
}>;
export type ShopfloorReceiptLineRow = Prisma.shopfloor_receipt_lineGetPayload<{
  include: typeof SHOPFLOOR_RECEIPT_LINE_INCLUDE;
}>;

export interface ShopfloorReceiptView {
  shopfloorReceiptId: number;
  shopfloorReceiptNo: string;
  goodsIssueId: number;
  workOrderId: number;
  destinationLocationId: number;
  receivedAt: string;
  receivedBy: number | null;
  statusCode: string;
  lines: ShopfloorReceiptLineView[];
}

export interface ShopfloorReceiptLineView {
  shopfloorReceiptLineId: number;
  shopfloorReceiptId: number;
  goodsIssueLineId: number;
  itemId: number;
  lotId: number;
  itemCode: string;
  itemName: string;
  lotNo: string;
  issuedQty: number;
  receivedQty: number;
  varianceQty: number;
  uomId: number;
  varianceReasonCode: string | null;
}

export interface ShopfloorReceiptDetail {
  shopfloorReceipt: ShopfloorReceiptView;
  lines: ShopfloorReceiptLineView[];
}

/** 목록도 상세도 이 하나로 낸다 — `lines` 를 계약 description 대로 항상 채운다(1+N 회피). */
export function shopfloorReceiptView(row: ShopfloorReceiptRow): ShopfloorReceiptView {
  return {
    shopfloorReceiptId: Number(row.shopfloor_receipt_id),
    shopfloorReceiptNo: row.shopfloor_receipt_no,
    goodsIssueId: Number(row.goods_issue_id),
    workOrderId: Number(row.work_order_id),
    destinationLocationId: Number(row.destination_location_id),
    receivedAt: row.received_at.toISOString(),
    receivedBy: row.received_by === null ? null : Number(row.received_by),
    statusCode: row.status_code,
    lines: row.shopfloor_receipt_line.map(shopfloorReceiptLineView),
  };
}

export function shopfloorReceiptLineView(row: ShopfloorReceiptLineRow): ShopfloorReceiptLineView {
  return {
    shopfloorReceiptLineId: Number(row.shopfloor_receipt_line_id),
    shopfloorReceiptId: Number(row.shopfloor_receipt_id),
    goodsIssueLineId: Number(row.goods_issue_line_id),
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    lotNo: row.lot.lot_no,
    issuedQty: Number(row.issued_qty),
    receivedQty: Number(row.received_qty),
    // Prisma 타입은 `Decimal?`(GENERATED 컬럼이라 널 허용으로 낸다) 이지만 DB 에서는
    // `issued_qty`·`received_qty` 가 둘 다 NOT NULL 이라 STORED 파생값이 절대 널이 아니다.
    // 도달 불가 — 값을 도출하는 것이 아니라 널 가드일 뿐이다(I-9.md §4-4).
    varianceQty: row.variance_qty === null ? 0 : Number(row.variance_qty),
    uomId: Number(row.uom_id),
    varianceReasonCode: row.variance_reason_code,
  };
}
