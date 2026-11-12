import { Prisma } from '@prisma/client';

/** 계약 `InboundLotIqcSummary`. */
export interface InboundLotIqcView {
  requestId: number;
  requestNo: string | null;
  statusCode: string;
  overallJudgmentCode: string | null;
}

/** 계약 `InboundLot` — 입하 LOT 한 행. 마감 취소·최종 마감 칸은 S5·S12 가 채우기 전까지 false/null 이다. */
export interface InboundLotView {
  inboundLotId: number;
  inboundLotNo: string;
  plantId: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  uomCode: string;
  statusCode: string;
  receivingDate: string;
  inboundReceiptNo: string | null;
  lotCount: number;
  receivedQty: number;
  goodsReceivedQty: number;
  unallocatedQty: number;
  iqc: InboundLotIqcView | null;
  inspectionRequired: boolean;
  firstRegisteredAt: string | null;
  receivedClosedAt: string | null;
  closedAutomatically: boolean;
  finalizedAt: string | null;
  reopenable: boolean;
  reopenReasonCode: string | null;
  reopened: boolean;
  finalizable: boolean;
  erpSendModeCode: string;
  versionNo: number;
}

const INBOUND_LOT_SELECT = {
  inbound_lot_id: true, inbound_lot_no: true, plant_id: true, supplier_id: true, item_id: true, status_code: true,
  receiving_date: true, received_closed_at: true, closed_automatically: true, finalized_at: true,
  erp_send_mode_code: true, version_no: true,
  supplier: { select: { partner_code: true, partner_name: true } },
  item: { select: { item_code: true, item_name: true } },
  uom: { select: { uom_code: true } },
  inbound_receipt_line: {
    select: {
      received_qty: true, inspection_required: true,
      inbound_receipt: { select: { inbound_receipt_no: true } },
      inbound_receipt_po_allocation: { select: { allocated_qty: true } },
    },
  },
} satisfies Prisma.inbound_lotSelect;

type Db = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);

/** 입하 LOT 행들 — 순서는 `orderBy` 그대로. 집계(LOT 수·입고 합·IQC·첫 등록)는 한 번에 모아 읽는다. */
export async function loadInboundLotViews(
  db: Db,
  where: Prisma.inbound_lotWhereInput,
  page: { orderBy?: Prisma.inbound_lotOrderByWithRelationInput[]; skip?: number; take?: number } = {},
): Promise<InboundLotView[]> {
  const rows = await db.inbound_lot.findMany({ where, select: INBOUND_LOT_SELECT, ...page });
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.inbound_lot_id);
  const [counts, received, requests, firsts] = await Promise.all([
    db.lot.groupBy({ by: ['inbound_lot_id'], where: { inbound_lot_id: { in: ids } }, _count: { _all: true } }),
    db.$queryRaw<{ inbound_lot_id: bigint; qty: Prisma.Decimal }[]>`
      SELECT l.inbound_lot_id, sum(grl.receipt_qty) AS qty
        FROM logistics.goods_receipt_line grl
        JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = grl.goods_receipt_id
        JOIN trace.lot l ON l.lot_id = grl.lot_id
       WHERE l.inbound_lot_id IN (${Prisma.join(ids)}) AND gr.status_code <> 'CANCELLED'
       GROUP BY l.inbound_lot_id`,
    db.inspection_request.findMany({
      where: { inbound_lot_id: { in: ids }, inspection_type_code: 'IQC' },
      select: { inbound_lot_id: true, inspection_request_id: true, inspection_request_no: true, status_code: true, overall_judgment_code: true },
      orderBy: { inspection_request_id: 'asc' },
    }),
    db.inbound_lot_event.groupBy({
      by: ['inbound_lot_id'], where: { inbound_lot_id: { in: ids }, event_type_code: 'LOTS_REGISTERED' }, _min: { occurred_at: true },
    }),
  ]);
  const countOf = new Map(counts.map((row) => [row.inbound_lot_id, row._count._all]));
  const receivedOf = new Map(received.map((row) => [row.inbound_lot_id, Number(row.qty)]));
  const iqcOf = new Map(requests.map((row) => [row.inbound_lot_id, row]));
  const firstOf = new Map(firsts.map((row) => [row.inbound_lot_id, row._min.occurred_at]));
  return rows.map((row) => {
    const line = row.inbound_receipt_line;
    const allocated = line.inbound_receipt_po_allocation.reduce((sum, allocation) => sum.plus(allocation.allocated_qty), ZERO);
    const iqc = iqcOf.get(row.inbound_lot_id);
    return {
      inboundLotId: Number(row.inbound_lot_id), inboundLotNo: row.inbound_lot_no, plantId: Number(row.plant_id),
      supplierId: Number(row.supplier_id), supplierCode: row.supplier.partner_code, supplierName: row.supplier.partner_name,
      itemId: Number(row.item_id), itemCode: row.item.item_code, itemName: row.item.item_name, uomCode: row.uom.uom_code,
      statusCode: row.status_code, receivingDate: row.receiving_date.toISOString().slice(0, 10),
      inboundReceiptNo: line.inbound_receipt.inbound_receipt_no,
      lotCount: countOf.get(row.inbound_lot_id) ?? 0,
      receivedQty: Number(line.received_qty),
      goodsReceivedQty: receivedOf.get(row.inbound_lot_id) ?? 0,
      unallocatedQty: Number(line.received_qty.minus(allocated)),
      iqc: iqc === undefined ? null : {
        requestId: Number(iqc.inspection_request_id), requestNo: iqc.inspection_request_no,
        statusCode: iqc.status_code, overallJudgmentCode: iqc.overall_judgment_code,
      },
      inspectionRequired: line.inspection_required,
      firstRegisteredAt: firstOf.get(row.inbound_lot_id)?.toISOString() ?? null,
      receivedClosedAt: row.received_closed_at?.toISOString() ?? null,
      closedAutomatically: row.closed_automatically,
      finalizedAt: row.finalized_at?.toISOString() ?? null,
      reopenable: false, reopenReasonCode: null, reopened: false, finalizable: false,
      erpSendModeCode: row.erp_send_mode_code, versionNo: row.version_no,
    };
  });
}
