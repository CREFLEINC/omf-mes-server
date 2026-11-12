import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { CLOSED_ORDER_STATUSES } from '../purchase-order/purchase-order-receipt';
import { recordInboundLotEvent } from './inbound-lot-event';
import { assertVersion, inboundLotFinalized } from './inbound-lot-finalizable';
import { InboundLotDetailView, InboundLotQueryService } from './inbound-lot-query.service';

/** 계약 `InboundLotPoAllocationReplace`. */
export interface InboundLotPoAllocationReplace {
  versionNo: number;
  allocations: { purchaseOrderLineId: number; qty: number }[];
}

/** 계약 `InboundLotAllocationCandidate`. */
export interface InboundLotAllocationCandidateView {
  purchaseOrderLineId: number;
  purchaseOrderId: number;
  purchaseOrderNo: string;
  lineNo: number;
  orderDate: string;
  erpPurchaseOrderNo: string | null;
  orderedQty: number;
  receivedQty: number;
  toleranceQty: number;
  thisLotQty: number;
  maxQty: number;
  openedAfterReceiptClose: boolean;
}

interface LockedInboundLot {
  inbound_lot_id: bigint;
  plant_id: bigint;
  supplier_id: bigint;
  item_id: bigint;
  uom_id: bigint;
  status_code: string;
  erp_send_mode_code: string;
  version_no: number;
  inbound_receipt_line_id: bigint;
  received_closed_at: Date | null;
}

interface Candidate {
  purchaseOrderLineId: bigint;
  purchaseOrderId: bigint;
  purchaseOrderNo: string;
  lineNo: number;
  orderDate: string;
  erpPurchaseOrderNo: string | null;
  orderedQty: Prisma.Decimal;
  receivedQty: Prisma.Decimal;
  toleranceQty: Prisma.Decimal;
  thisLotQty: Prisma.Decimal;
  createdAt: Date;
}

const RECEIVED = 'RECEIVED';
const FINALIZED = 'FINALIZED';
const NEW_FLOW = 'ON_FINALIZE';
const ZERO = new Prisma.Decimal(0);
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

/** 라인 한도 = 발주 + 초과 허용치 − (받은 양 − 이 입하 LOT 몫) — 자동 배정·지금 입하의 넘침 한도와 같은 기준(R-22·R-23). */
function maxQtyOf(candidate: Candidate): Prisma.Decimal {
  return candidate.orderedQty.plus(candidate.toleranceQty).minus(candidate.receivedQty.minus(candidate.thisLotQty));
}

/**
 * W-01-16 P/O 배정 후보·수정(R-23). 후보 = 같은 공장·공급사·품목·단위의 미마감 P/O 라인(R-22 의 1) + 이 입하 LOT 에 이미 배정된 라인.
 * 수정은 배정 전체 교체 — 입하 LOT 을 잠근 뒤 부모 P/O 를 오름차순으로 잠그고, 차이만큼 받은 양을 옮긴다. 재고·LOT·입고는 그대로다.
 */
@Injectable()
export class InboundLotAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: InboundLotQueryService,
  ) {}

  async candidates(inboundLotId: number): Promise<InboundLotAllocationCandidateView[]> {
    const head = await this.prisma.inbound_lot.findUnique({
      where: { inbound_lot_id: BigInt(inboundLotId) },
      select: {
        inbound_lot_id: true, plant_id: true, supplier_id: true, item_id: true, uom_id: true, status_code: true, erp_send_mode_code: true,
        version_no: true, inbound_receipt_line_id: true, received_closed_at: true,
      },
    });
    if (head === null) throw new NotFoundException('없는 입하 LOT 입니다.');
    return (await candidatesOf(this.prisma, head)).map((row) => ({
      purchaseOrderLineId: Number(row.purchaseOrderLineId), purchaseOrderId: Number(row.purchaseOrderId), purchaseOrderNo: row.purchaseOrderNo,
      lineNo: row.lineNo, orderDate: row.orderDate, erpPurchaseOrderNo: row.erpPurchaseOrderNo,
      orderedQty: Number(row.orderedQty), receivedQty: Number(row.receivedQty), toleranceQty: Number(row.toleranceQty),
      thisLotQty: Number(row.thisLotQty), maxQty: Number(maxQtyOf(row)),
      openedAfterReceiptClose: head.received_closed_at !== null && row.createdAt > head.received_closed_at,
    }));
  }

  async replace(inboundLotId: number, body: InboundLotPoAllocationReplace, appUserId: number): Promise<InboundLotDetailView> {
    const id = BigInt(inboundLotId);
    await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<LockedInboundLot[]>`
        SELECT inbound_lot_id, plant_id, supplier_id, item_id, uom_id, status_code, erp_send_mode_code, version_no,
               inbound_receipt_line_id, received_closed_at
          FROM trace.inbound_lot WHERE inbound_lot_id = ${id} FOR UPDATE`;
      if (locked === undefined) throw new NotFoundException('없는 입하 LOT 입니다.');
      // 판 번호가 먼저다 — 동시 수정·최종 마감의 뒤쪽은 상태와 상관없이 「다시 불러오기」다(R23-1).
      assertVersion(locked.version_no, body.versionNo);
      assertEditable(locked);
      const line = await tx.inbound_receipt_line.findUniqueOrThrow({
        where: { inbound_receipt_line_id: locked.inbound_receipt_line_id }, select: { received_qty: true },
      });
      // 후보를 읽기 «전»에 부모 P/O 를 잠근다(`received_qty` 를 쓰는 모든 경로의 불변식 — 마감 `lockCandidates` 와 같다).
      await lockParents(tx, locked);
      const candidates = await candidatesOf(tx, locked);
      const next = validate(body.allocations, candidates, line.received_qty);
      const by = BigInt(appUserId);
      const before = candidates.filter((row) => row.thisLotQty.greaterThan(0));
      for (const candidate of candidates) {
        const delta = (next.get(candidate.purchaseOrderLineId) ?? ZERO).minus(candidate.thisLotQty);
        if (delta.isZero()) continue;
        await tx.purchase_order_line.update({
          where: { purchase_order_line_id: candidate.purchaseOrderLineId }, data: { received_qty: { increment: delta }, updated_by: by },
        });
      }
      await tx.inbound_receipt_po_allocation.deleteMany({ where: { inbound_receipt_line_id: locked.inbound_receipt_line_id } });
      for (const [purchaseOrderLineId, qty] of next) {
        await tx.inbound_receipt_po_allocation.create({
          data: { inbound_receipt_line_id: locked.inbound_receipt_line_id, purchase_order_line_id: purchaseOrderLineId, allocated_qty: qty,
            created_by: by, updated_by: by },
        });
      }
      await tx.inbound_lot.update({ where: { inbound_lot_id: id }, data: { version_no: { increment: 1 }, updated_by: by } });
      await recordInboundLotEvent(tx, id, 'ALLOCATION_EDITED', { appUserId }, {
        before: before.map((row) => ({ purchaseOrderLineId: String(row.purchaseOrderLineId), qty: row.thisLotQty.toString() })),
        after: [...next].map(([purchaseOrderLineId, qty]) => ({ purchaseOrderLineId: String(purchaseOrderLineId), qty: qty.toString() })),
      }, new Date());
    }, TRANSACTION_OPTIONS);
    return this.queries.get(inboundLotId);
  }
}

/** 배정 수정 대상 — `RECEIVED`·`ON_FINALIZE` 만(R-23). */
function assertEditable(locked: LockedInboundLot): void {
  if (locked.status_code === FINALIZED) throw inboundLotFinalized();
  if (locked.erp_send_mode_code !== NEW_FLOW) {
    throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: 'LEGACY_INBOUND_LOT', message: '이전 데이터 입하 LOT 은 W-01-16 에서 배정을 고치지 않습니다.' }]);
  }
  if (locked.status_code !== RECEIVED) {
    throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '입하 마감된 입하 LOT 만 배정을 고칠 수 있습니다.' }]);
  }
}

/** 새 배정(라인 → 수량). 후보·`0 < qty ≤ maxQty`·같은 라인 한 번·합 ≤ 입하 수량 — 어긋나면 400. */
function validate(
  allocations: InboundLotPoAllocationReplace['allocations'], candidates: Candidate[], receivedQty: Prisma.Decimal,
): Map<bigint, Prisma.Decimal> {
  const byLine = new Map(candidates.map((row) => [row.purchaseOrderLineId, row]));
  const next = new Map<bigint, Prisma.Decimal>();
  const errors: ErrorItem[] = [];
  let details: Record<string, number> | undefined;
  let total = ZERO;
  for (const [index, allocation] of allocations.entries()) {
    const lineId = BigInt(allocation.purchaseOrderLineId);
    const qty = new Prisma.Decimal(allocation.qty);
    const at = `allocations[${String(index)}]`;
    const candidate = byLine.get(lineId);
    if (next.has(lineId)) {
      errors.push(field(`${at}.purchaseOrderLineId`, ERROR_CODE.INVALID, '같은 P/O 라인이 두 번 있습니다.'));
    } else if (candidate === undefined) {
      errors.push(field(`${at}.purchaseOrderLineId`, ERROR_CODE.INVALID, '같은 공장·공급사·품목의 미마감 P/O 라인이 아닙니다.'));
    } else if (qty.lessThanOrEqualTo(0) || qty.greaterThan(maxQtyOf(candidate))) {
      const maxQty = Number(maxQtyOf(candidate));
      errors.push(field(`${at}.qty`, ERROR_CODE.RANGE, `0 보다 크고 이 라인의 한도(${String(maxQty)}) 이하여야 합니다.`));
      details ??= { purchaseOrderLineId: Number(lineId), maxQty };
    }
    next.set(lineId, qty);
    total = total.plus(qty);
  }
  if (errors.length === 0 && total.greaterThan(receivedQty)) {
    errors.push(field('allocations', ERROR_CODE.RANGE, `배정 합(${total.toString()})이 입하 수량(${receivedQty.toString()})을 넘습니다.`));
    details = { receivedQty: Number(receivedQty), allocatedQty: Number(total) };
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors, details === undefined ? undefined : { details });
  return next;
}

async function lockParents(tx: Prisma.TransactionClient, locked: LockedInboundLot): Promise<void> {
  await tx.$queryRaw`
    SELECT po.purchase_order_id
      FROM logistics.purchase_order po
     WHERE (po.plant_id = ${locked.plant_id} AND po.supplier_id = ${locked.supplier_id}
            AND po.status_code NOT IN (${Prisma.join(CLOSED_ORDER_STATUSES)})
            AND EXISTS (SELECT 1 FROM logistics.purchase_order_line l
                         WHERE l.purchase_order_id = po.purchase_order_id AND l.item_id = ${locked.item_id}
                           AND l.uom_id = ${locked.uom_id} AND l.cancelled_at IS NULL))
        OR po.purchase_order_id IN (SELECT l.purchase_order_id
                                      FROM logistics.inbound_receipt_po_allocation a
                                      JOIN logistics.purchase_order_line l ON l.purchase_order_line_id = a.purchase_order_line_id
                                     WHERE a.inbound_receipt_line_id = ${locked.inbound_receipt_line_id})
     ORDER BY po.purchase_order_id
       FOR UPDATE`;
}

/** 후보 라인(발주일·P/O 번호·라인 번호 순) — 미마감 라인 + 이 입하 LOT 에 이미 배정된 라인(마감된 P/O 여도). */
async function candidatesOf(
  db: Prisma.TransactionClient,
  head: Pick<LockedInboundLot, 'plant_id' | 'supplier_id' | 'item_id' | 'uom_id' | 'inbound_receipt_line_id'>,
): Promise<Candidate[]> {
  const rows = await db.purchase_order_line.findMany({
    where: {
      OR: [
        {
          item_id: head.item_id, uom_id: head.uom_id, cancelled_at: null,
          purchase_order: { plant_id: head.plant_id, supplier_id: head.supplier_id, status_code: { notIn: CLOSED_ORDER_STATUSES } },
        },
        { inbound_receipt_po_allocation: { some: { inbound_receipt_line_id: head.inbound_receipt_line_id } } },
      ],
    },
    select: {
      purchase_order_line_id: true, purchase_order_id: true, line_no: true, ordered_qty: true, received_qty: true, tolerance_over_qty: true,
      created_at: true,
      purchase_order: { select: { purchase_order_no: true, order_date: true, erp_purchase_order_no: true } },
      inbound_receipt_po_allocation: { where: { inbound_receipt_line_id: head.inbound_receipt_line_id }, select: { allocated_qty: true } },
    },
  });
  return rows.map((row) => ({
    purchaseOrderLineId: row.purchase_order_line_id, purchaseOrderId: row.purchase_order_id, purchaseOrderNo: row.purchase_order.purchase_order_no,
    lineNo: row.line_no, orderDate: row.purchase_order.order_date.toISOString().slice(0, 10), erpPurchaseOrderNo: row.purchase_order.erp_purchase_order_no,
    orderedQty: row.ordered_qty, receivedQty: row.received_qty, toleranceQty: row.tolerance_over_qty, createdAt: row.created_at,
    thisLotQty: row.inbound_receipt_po_allocation.reduce((sum, allocation) => sum.plus(allocation.allocated_qty), ZERO),
  })).sort((left, right) => left.orderDate.localeCompare(right.orderDate)
    || left.purchaseOrderNo.localeCompare(right.purchaseOrderNo) || left.lineNo - right.lineNo);
}
