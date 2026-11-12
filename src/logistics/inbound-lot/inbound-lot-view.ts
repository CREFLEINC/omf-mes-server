import { Prisma } from '@prisma/client';

import { FinalizeBlocker, LotProgress, finalizeFactsOf } from './inbound-lot-finalizable';
import { onlyOpenReceiptBlocks, reopenStatesOf } from './inbound-lot-reopenable';

/** 계약 `InboundLotIqcSummary`. */
export interface InboundLotIqcView {
  requestId: number;
  requestNo: string | null;
  statusCode: string;
  overallJudgmentCode: string | null;
}

/** 계약 `InboundLotPoAllocation`. */
export interface InboundLotPoAllocationView {
  purchaseOrderLineId: number;
  purchaseOrderNo: string;
  lineNo: number;
  orderDate: string;
  erpPurchaseOrderNo: string | null;
  qty: number;
  excessQty: number;
}

/** 계약 `InboundLot` — 입하 LOT 한 행. */
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
  poAllocations: InboundLotPoAllocationView[];
  unallocatedQty: number;
  iqc: InboundLotIqcView | null;
  inspectionRequired: boolean;
  firstRegisteredAt: string | null;
  receivedClosedAt: string | null;
  closedAutomatically: boolean;
  finalizedAt: string | null;
  finalizedByName: string | null;
  reopenable: boolean;
  reopenReasonCode: string | null;
  reopenBlockerCode: 'OPEN_RECEIPT_EXISTS' | null;
  openInboundLotNo: string | null;
  reopened: boolean;
  finalizable: boolean;
  finalizeBlockers: FinalizeBlocker[];
  lotProgress: LotProgress;
  erpSendModeCode: string;
  versionNo: number;
}

const INBOUND_LOT_SELECT = {
  inbound_lot_id: true, inbound_lot_no: true, plant_id: true, supplier_id: true, item_id: true, status_code: true,
  receiving_date: true, received_closed_at: true, closed_automatically: true, finalized_at: true, finalized_by: true,
  erp_send_mode_code: true, version_no: true,
  supplier: { select: { partner_code: true, partner_name: true } },
  item: { select: { item_code: true, item_name: true } },
  uom: { select: { uom_code: true } },
  inbound_receipt_line: {
    select: {
      received_qty: true, inspection_required: true,
      inbound_receipt: { select: { inbound_receipt_no: true } },
      inbound_receipt_po_allocation: {
        select: {
          purchase_order_line_id: true, allocated_qty: true,
          purchase_order_line: {
            select: { line_no: true, ordered_qty: true, received_qty: true, purchase_order: { select: { purchase_order_no: true, order_date: true, erp_purchase_order_no: true } } },
          },
        },
      },
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
  const finalizers = [...new Set(rows.flatMap((row) => (row.finalized_by === null ? [] : [row.finalized_by])))];
  const [counts, received, requests, firsts, reopenedEvents, reopenStates, finalizeFacts, users] = await Promise.all([
    db.lot.groupBy({ by: ['inbound_lot_id'], where: { inbound_lot_id: { in: ids } }, _count: { _all: true } }),
    db.$queryRaw<{ inbound_lot_id: bigint; qty: Prisma.Decimal }[]>`
      SELECT l.inbound_lot_id, sum(grl.receipt_qty) AS qty
        FROM logistics.goods_receipt_line grl
        JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = grl.goods_receipt_id
        JOIN trace.lot l ON l.lot_id = grl.lot_id
       WHERE l.inbound_lot_id IN (${Prisma.join(ids)}) AND gr.status_code <> 'CANCELLED'
       GROUP BY l.inbound_lot_id`,
    db.inspection_request.findMany({
      // 입하 LOT 의 «현재» 요청 — 마감 취소로 CANCELLED 가 된 옛 요청은 뺀다.
      where: { inbound_lot_id: { in: ids }, inspection_type_code: 'IQC', status_code: { not: 'CANCELLED' } },
      select: { inbound_lot_id: true, inspection_request_id: true, inspection_request_no: true, status_code: true, overall_judgment_code: true },
      orderBy: { inspection_request_id: 'asc' },
    }),
    db.inbound_lot_event.groupBy({
      by: ['inbound_lot_id'], where: { inbound_lot_id: { in: ids }, event_type_code: 'LOTS_REGISTERED' }, _min: { occurred_at: true },
    }),
    db.inbound_lot_event.findMany({
      where: { inbound_lot_id: { in: ids }, event_type_code: 'RECEIPT_REOPENED' }, select: { inbound_lot_id: true }, distinct: ['inbound_lot_id'],
    }),
    reopenStatesOf(db, ids),
    finalizeFactsOf(db, ids),
    finalizers.length === 0 ? [] : db.app_user.findMany({ where: { app_user_id: { in: finalizers } }, select: { app_user_id: true, user_name: true } }),
  ]);
  const userName = new Map(users.map((user) => [user.app_user_id, user.user_name]));
  const reopened = new Set(reopenedEvents.map((row) => row.inbound_lot_id));
  const countOf = new Map(counts.map((row) => [row.inbound_lot_id, row._count._all]));
  const receivedOf = new Map(received.map((row) => [row.inbound_lot_id, Number(row.qty)]));
  const iqcOf = new Map(requests.map((row) => [row.inbound_lot_id, row]));
  const firstOf = new Map(firsts.map((row) => [row.inbound_lot_id, row._min.occurred_at]));
  return rows.map((row) => {
    const line = row.inbound_receipt_line;
    const allocated = line.inbound_receipt_po_allocation.reduce((sum, allocation) => sum.plus(allocation.allocated_qty), ZERO);
    const iqc = iqcOf.get(row.inbound_lot_id);
    const reopen = reopenStates.get(row.inbound_lot_id);
    const openBlocked = reopen !== undefined && onlyOpenReceiptBlocks(reopen.blockers);
    const finalize = finalizeFacts.get(row.inbound_lot_id)?.state;
    return {
      inboundLotId: Number(row.inbound_lot_id), inboundLotNo: row.inbound_lot_no, plantId: Number(row.plant_id),
      supplierId: Number(row.supplier_id), supplierCode: row.supplier.partner_code, supplierName: row.supplier.partner_name,
      itemId: Number(row.item_id), itemCode: row.item.item_code, itemName: row.item.item_name, uomCode: row.uom.uom_code,
      statusCode: row.status_code, receivingDate: row.receiving_date.toISOString().slice(0, 10),
      inboundReceiptNo: line.inbound_receipt.inbound_receipt_no,
      lotCount: countOf.get(row.inbound_lot_id) ?? 0,
      receivedQty: Number(line.received_qty),
      goodsReceivedQty: receivedOf.get(row.inbound_lot_id) ?? 0,
      poAllocations: line.inbound_receipt_po_allocation.map(allocationView).sort(byOrderAge),
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
      finalizedByName: row.finalized_by === null ? null : (userName.get(row.finalized_by) ?? null),
      reopenable: reopen !== undefined && reopen.blockers.length === 0, reopenReasonCode: reopen?.reasonCode ?? null,
      reopenBlockerCode: openBlocked ? 'OPEN_RECEIPT_EXISTS' : null, openInboundLotNo: openBlocked ? reopen.openInboundLotNo : null,
      reopened: reopened.has(row.inbound_lot_id), finalizable: finalize?.finalizable ?? false,
      finalizeBlockers: finalize?.blockers ?? [], lotProgress: finalize?.progress ?? NO_PROGRESS,
      erpSendModeCode: row.erp_send_mode_code, versionNo: row.version_no,
    };
  });
}

type AllocationRow = Prisma.inbound_lotGetPayload<{ select: typeof INBOUND_LOT_SELECT }>['inbound_receipt_line']['inbound_receipt_po_allocation'][number];

const NO_PROGRESS: LotProgress = { received: 0, inIqc: 0, inDisposition: 0, disposed: 0, returned: 0 };

/** 초과 = 이 배정 − 그 라인 잔량(발주 − 이 입하 LOT 몫을 뺀 받은 양), 음수면 0(W-01-16 「(초과 n)」). */
function allocationView(row: AllocationRow): InboundLotPoAllocationView {
  const order = row.purchase_order_line.purchase_order;
  const line = row.purchase_order_line;
  const room = Prisma.Decimal.max(ZERO, line.ordered_qty.minus(line.received_qty.minus(row.allocated_qty)));
  return {
    purchaseOrderLineId: Number(row.purchase_order_line_id), purchaseOrderNo: order.purchase_order_no,
    lineNo: row.purchase_order_line.line_no, orderDate: order.order_date.toISOString().slice(0, 10),
    erpPurchaseOrderNo: order.erp_purchase_order_no, qty: Number(row.allocated_qty),
    excessQty: Number(Prisma.Decimal.max(ZERO, row.allocated_qty.minus(room))),
  };
}

/** 자동 배정 순서(발주일·P/O 번호·라인 번호)로 보인다. */
function byOrderAge(left: InboundLotPoAllocationView, right: InboundLotPoAllocationView): number {
  return left.orderDate.localeCompare(right.orderDate) || left.purchaseOrderNo.localeCompare(right.purchaseOrderNo) || left.lineNo - right.lineNo;
}
