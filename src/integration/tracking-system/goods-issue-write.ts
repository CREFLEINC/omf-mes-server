import { Prisma } from '@prisma/client';

import { InventoryPostingService } from '../../core/inventory-posting';
import { GoodsIssueLineWriteInput, postIssue } from '../../logistics/goods-issue/issue-posting';

type Tx = Prisma.TransactionClient;

export interface TrackingIssueHeader {
  goodsIssueNo: string;
  issueTypeCode: string;
  sourceDocumentTypeCode: string;
  sourceDocumentId: bigint;
  warehouseId: bigint;
  occurredAt: Date;
  businessDate: string;
  remarks?: string;
}

export interface TrackingIssueLine {
  itemId: bigint;
  lotId: bigint;
  uomId: bigint;
  locationId: bigint;
  qty: Prisma.Decimal;
}

const POSTED = 'POSTED';

/** 연동이 만드는 출고 전표 — 만들면서 바로 전기한다. 도착지도 계정도 없다. 줄 번호는 받은 순서다. */
export async function postTrackingIssue(
  tx: Tx,
  posting: InventoryPostingService,
  header: TrackingIssueHeader,
  lines: TrackingIssueLine[],
): Promise<{ goodsIssueId: bigint; lines: GoodsIssueLineWriteInput[] }> {
  const { goods_issue_id: goodsIssueId } = await tx.goods_issue.create({
    data: {
      goods_issue_no: header.goodsIssueNo, issue_type_code: header.issueTypeCode, source_document_type_code: header.sourceDocumentTypeCode,
      source_document_id: header.sourceDocumentId, source_warehouse_id: header.warehouseId, issued_at: header.occurredAt, status_code: POSTED,
      ...(header.remarks === undefined ? {} : { remarks: header.remarks }),
    },
    select: { goods_issue_id: true },
  });
  const created = await tx.goods_issue_line.createManyAndReturn({
    data: lines.map((line, index) => ({
      goods_issue_id: goodsIssueId, line_no: index + 1, item_id: line.itemId, lot_id: line.lotId,
      issue_qty: line.qty, uom_id: line.uomId, source_location_id: line.locationId,
    })),
    select: { goods_issue_line_id: true, line_no: true },
  });
  const idOf = new Map(created.map((line) => [line.line_no, line.goods_issue_line_id]));
  const written = lines.map((line, index) => ({
    goodsIssueLineId: idOf.get(index + 1) as bigint, itemId: line.itemId, lotId: line.lotId,
    issueQty: line.qty, uomId: line.uomId, sourceLocationId: line.locationId,
  }));
  await postIssue(tx, posting, {
    header: {
      goodsIssueId, goodsIssueNo: header.goodsIssueNo, issueTypeCode: header.issueTypeCode, sourceDocumentTypeCode: header.sourceDocumentTypeCode,
      sourceDocumentId: header.sourceDocumentId, sourceWarehouseId: header.warehouseId, destinationTypeCode: null, destinationId: null,
    },
    lines: written, businessDate: header.businessDate, occurredAt: header.occurredAt,
  }, undefined);
  return { goodsIssueId, lines: written };
}
