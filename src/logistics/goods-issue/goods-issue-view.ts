import { Prisma } from '@prisma/client';

/**
 * 계약 `GoodsIssue`·`GoodsIssueLine` 으로 옮기는 자리. PR ③④⑤ 가 그대로 재사용한다.
 *
 * ⛔ 널이어도 **키를 생략하지 않는다** — `approvalRequestId`·`destinationTypeCode`·
 * `destinationId`·`reasonCode`·`replacementExpected`·`remarks`·`pickingLineId`·
 * `inventoryTransactionLineId` 전부(GR `sourceDocumentTypeCode` 와 다른 판정 — 이 칸들은
 * `type` 에 `null` 이 이미 있어 계약을 통과한다).
 */

export type GoodsIssueRow = Prisma.goods_issueGetPayload<object>;
export type GoodsIssueLineRow = Prisma.goods_issue_lineGetPayload<object>;

export interface GoodsIssueView {
  goodsIssueId: number;
  goodsIssueNo: string;
  issueTypeCode: string;
  sourceDocumentTypeCode: string;
  sourceDocumentId: number;
  sourceWarehouseId: number;
  destinationTypeCode: string | null;
  destinationId: number | null;
  issuedAt: string;
  statusCode: string;
  reasonCode: string | null;
  replacementExpected: boolean | null;
  approvalRequestId: number | null;
  erpMessageQueued: boolean;
  remarks: string | null;
}

export interface GoodsIssueLineView {
  goodsIssueLineId: number;
  goodsIssueId: number;
  lineNo: number;
  pickingLineId: number | null;
  itemId: number;
  lotId: number;
  issueQty: number;
  uomId: number;
  sourceLocationId: number;
  inventoryTransactionLineId: number | null;
}

export interface GoodsIssueDetail {
  goodsIssue: GoodsIssueView;
  lines: GoodsIssueLineView[];
}

export function goodsIssueView(row: GoodsIssueRow): GoodsIssueView {
  return {
    goodsIssueId: Number(row.goods_issue_id),
    goodsIssueNo: row.goods_issue_no,
    issueTypeCode: row.issue_type_code,
    sourceDocumentTypeCode: row.source_document_type_code,
    sourceDocumentId: Number(row.source_document_id),
    sourceWarehouseId: Number(row.source_warehouse_id),
    destinationTypeCode: row.destination_type_code,
    destinationId: id(row.destination_id),
    issuedAt: row.issued_at.toISOString(),
    statusCode: row.status_code,
    reasonCode: row.reason_code,
    replacementExpected: row.replacement_expected,
    approvalRequestId: id(row.approval_request_id),
    // 담을 칸이 없다(I-4.md §8-3 ⓕ) — `sendToErp` 도 받아서 버린다.
    erpMessageQueued: false,
    remarks: row.remarks,
  };
}

export function goodsIssueLineView(row: GoodsIssueLineRow): GoodsIssueLineView {
  return {
    goodsIssueLineId: Number(row.goods_issue_line_id),
    goodsIssueId: Number(row.goods_issue_id),
    lineNo: row.line_no,
    pickingLineId: id(row.picking_line_id),
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    issueQty: Number(row.issue_qty),
    uomId: Number(row.uom_id),
    sourceLocationId: Number(row.source_location_id),
    inventoryTransactionLineId: id(row.inventory_transaction_line_id),
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
