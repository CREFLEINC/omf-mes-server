import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { IF_GOODS_RECEIPT, OutboxService } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { ALLOCATION_TARGET, allocationMessageKey, erpReceiptLinesOf } from '../goods-receipt/erp-receipt';
import { CLOSED_ORDER_STATUSES } from '../purchase-order/purchase-order-receipt';
import { allocationTargetError, roomOf, unallocatedQtyOf } from './inbound-allocation';
import {
  ALLOCATION_INCLUDE,
  AllocationCandidateView,
  InboundAllocationView,
  UNALLOCATED_LINE_INCLUDE,
  UnallocatedLineView,
  UnallocatedQuery,
  allocationView,
  candidateView,
  unallocatedLineView,
} from './inbound-allocation-view';

/** 400 이 짚을 칸 — 부르는 자리마다 다르다(배정 경로는 본문 칸, 입하 등록은 `lines.{i}.…`). */
export interface AllocationFields {
  target: string;
  qty: string;
}
const BODY_FIELDS: AllocationFields = { target: 'purchaseOrderLineId', qty: 'qty' };
/** 취소했거나 취소 요청 중인 입하 — 배정을 더하지도 빼지도 않는다. 취소가 받은 수량을 되돌린다. */
const CANCEL_STATUSES = ['CANCELLED', 'CANCEL_REQUESTED'];
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

export interface AllocationAddInput {
  inboundReceiptLineId: bigint;
  purchaseOrderLineId: bigint;
  qty: Prisma.Decimal;
  appUserId: number;
  fields?: AllocationFields;
}

const LINE_SELECT = {
  received_qty: true,
  item_id: true,
  uom_id: true,
  inbound_receipt: { select: { plant_id: true, supplier_id: true } },
  inbound_receipt_po_allocation: { select: { allocated_qty: true } },
} satisfies Prisma.inbound_receipt_lineSelect;

/**
 * 입하 줄 ↔ P/O 라인 배정 — 몫을 더하고 뺀다. 「주인 P/O + 초과분 잇기」(장부 P-100)를 대신한다.
 * ⭐ 부르는 쪽이 입하를 «먼저» 잠근 트랜잭션 안에서 부른다 — 잠금 순서는 입하 → 부모 P/O 다(치환·취소와 같다).
 *    여기서는 부모 P/O 만 잠근다.
 */
@Injectable()
export class InboundAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * 미배정이 남은 줄 — 받은 수량 > 배정 합. 취소(요청) 입하는 뺀다. 무발주 줄(예외 유형)도 들어가며 행이 유형을
   * 싣는다 — 고객사급처럼 이을 일이 없는 줄은 화면이 `excludeExceptionTypeCode` 로 뺀다. 집계 비교는 Prisma `where` 로 못 적어 SQL 로 id 를 고른다.
   */
  async listUnallocated(query: UnallocatedQuery): Promise<PagedResponse<UnallocatedLineView>> {
    const page = pageRequest(query);
    const from = Prisma.sql`
      FROM logistics.inbound_receipt_line l
      JOIN logistics.inbound_receipt r ON r.inbound_receipt_id = l.inbound_receipt_id
      LEFT JOIN (SELECT inbound_receipt_line_id, SUM(allocated_qty) AS allocated
                   FROM logistics.inbound_receipt_po_allocation GROUP BY inbound_receipt_line_id) a
        ON a.inbound_receipt_line_id = l.inbound_receipt_line_id
     WHERE r.status_code NOT IN (${Prisma.join(CANCEL_STATUSES)})
       AND l.received_qty > COALESCE(a.allocated, 0)
       ${query.plantId === undefined ? Prisma.empty : Prisma.sql`AND r.plant_id = ${query.plantId}`}
       ${query.supplierId === undefined ? Prisma.empty : Prisma.sql`AND r.supplier_id = ${query.supplierId}`}
       ${query.itemId === undefined ? Prisma.empty : Prisma.sql`AND l.item_id = ${query.itemId}`}
       ${
         query.excludeExceptionTypeCodes === undefined
           ? Prisma.empty
           : Prisma.sql`AND (r.exception_type_code IS NULL OR r.exception_type_code NOT IN (${Prisma.join(query.excludeExceptionTypeCodes)}))`
       }`;
    const [ids, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<{ inbound_receipt_line_id: bigint }[]>`
        SELECT l.inbound_receipt_line_id ${from}
         ORDER BY l.inbound_receipt_line_id
         LIMIT ${page.take} OFFSET ${page.skip}`,
      this.prisma.$queryRaw<{ total: bigint }[]>`SELECT COUNT(*) AS total ${from}`,
    ]);
    const rows = await this.prisma.inbound_receipt_line.findMany({
      where: { inbound_receipt_line_id: { in: ids.map((row) => row.inbound_receipt_line_id) } },
      include: UNALLOCATED_LINE_INCLUDE,
      orderBy: { inbound_receipt_line_id: 'asc' },
    });
    return pagedResponse(rows.map(unallocatedLineView), Number(total), page);
  }

  /**
   * 같은 공장·공급사·품목·단위의 살아 있는 P/O 라인 중 미배정 수량을 다 받을 수 있는 것. 남은 수량이 미배정과 같은
   * 라인이 먼저, 그다음 최근 발주다. 줄 자신의 P/O 라인도 된다 — ERP 가 원래 P/O 수량을 늘려 준 경우다.
   */
  async candidates(inboundReceiptLineId: bigint): Promise<AllocationCandidateView[]> {
    const line = await this.prisma.inbound_receipt_line.findUnique({
      where: { inbound_receipt_line_id: inboundReceiptLineId },
      select: LINE_SELECT,
    });
    if (line === null) throw new NotFoundException('없는 입하 줄입니다.');
    const unallocated = unallocatedQtyOf(line.received_qty, line.inbound_receipt_po_allocation);
    if (unallocated.lessThanOrEqualTo(0)) return [];
    const rows = await this.prisma.purchase_order_line.findMany({
      where: {
        item_id: line.item_id,
        uom_id: line.uom_id,
        cancelled_at: null,
        purchase_order: {
          plant_id: line.inbound_receipt.plant_id,
          supplier_id: line.inbound_receipt.supplier_id,
          status_code: { notIn: CLOSED_ORDER_STATUSES },
        },
      },
      include: { purchase_order: true },
      orderBy: [{ purchase_order: { order_date: 'desc' } }, { purchase_order_line_id: 'desc' }],
    });
    const views = rows.filter((row) => roomOf(row).greaterThanOrEqualTo(unallocated)).map((row) => candidateView(row, unallocated));
    return [...views.filter((view) => view.exactMatch), ...views.filter((view) => !view.exactMatch)];
  }

  /** 배정 경로 — 입하를 잠그고(취소(요청)면 `STATE_LOCKED`) 몫을 더한다. */
  async addToLine(
    inboundReceiptLineId: bigint,
    purchaseOrderLineId: bigint,
    qty: Prisma.Decimal,
    appUserId: number,
  ): Promise<InboundAllocationView> {
    const id = await this.prisma.$transaction(async (tx) => {
      await lockReceiptOf(tx, inboundReceiptLineId);
      const created = await this.add(tx, { inboundReceiptLineId, purchaseOrderLineId, qty, appUserId });
      return created.inbound_receipt_po_allocation_id;
    }, TRANSACTION_OPTIONS);
    return allocationView(
      await this.prisma.inbound_receipt_po_allocation.findUniqueOrThrow({
        where: { inbound_receipt_po_allocation_id: id },
        include: ALLOCATION_INCLUDE,
      }),
    );
  }

  /** 배정 경로 — 입하를 잠그고 그 줄의 몫을 뺀다. 다른 줄의 배정 id 는 없는 것으로 본다(404). */
  async removeFromLine(inboundReceiptLineId: bigint, allocationId: bigint, appUserId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockReceiptOf(tx, inboundReceiptLineId);
      const row = await tx.inbound_receipt_po_allocation.findUnique({
        where: { inbound_receipt_po_allocation_id: allocationId },
        select: { inbound_receipt_line_id: true },
      });
      if (row === null || row.inbound_receipt_line_id !== inboundReceiptLineId) throw new NotFoundException('없는 배정입니다.');
      await this.remove(tx, allocationId, appUserId);
    }, TRANSACTION_OPTIONS);
  }

  /**
   * 몫을 더한다 — 그 P/O 라인의 `received_qty` 가 같이 오른다.
   * 줄이 이미 ERP 로 가는 입고에 들어갔고 대상이 ERP 발주면 이 몫의 구매입고를 지금 적재한다(입고 뒤 배정).
   * 입고 전에 더한 몫은 입고가 적재한다.
   */
  async add(tx: Prisma.TransactionClient, input: AllocationAddInput) {
    const fields = input.fields ?? BODY_FIELDS;
    if (input.qty.lessThanOrEqualTo(0)) throw one(field(fields.qty, ERROR_CODE.INVALID, '0 보다 커야 합니다.'));
    const line = await tx.inbound_receipt_line.findUnique({
      where: { inbound_receipt_line_id: input.inboundReceiptLineId },
      select: LINE_SELECT,
    });
    if (line === null) throw new NotFoundException('없는 입하 줄입니다.');

    const target = await lockOrderLine(tx, input.purchaseOrderLineId, fields.target);
    const mismatch = allocationTargetError(line, target, fields.target);
    if (mismatch !== null) throw one(mismatch);
    if (input.qty.greaterThan(unallocatedQtyOf(line.received_qty, line.inbound_receipt_po_allocation))) {
      throw one(field(fields.qty, ERROR_CODE.RANGE, '받은 수량 중 배정하지 않은 몫을 넘습니다.'));
    }
    // ⛔ `Decimal` 로 비교한다 — 입하 등록의 한도 검사와 같은 기준이다(발주 + 초과 허용치).
    if (input.qty.greaterThan(roomOf(target))) {
      throw one(field(fields.qty, ERROR_CODE.QTY_EXCEEDS_ORDERED, '발주 수량과 허용치를 넘습니다.'));
    }

    await tx.purchase_order_line.update({
      where: { purchase_order_line_id: input.purchaseOrderLineId },
      data: { received_qty: { increment: input.qty }, updated_by: BigInt(input.appUserId) },
    });
    const created = await tx.inbound_receipt_po_allocation.create({
      data: {
        inbound_receipt_line_id: input.inboundReceiptLineId,
        purchase_order_line_id: input.purchaseOrderLineId,
        allocated_qty: input.qty,
        created_by: BigInt(input.appUserId),
        updated_by: BigInt(input.appUserId),
      },
    });
    const sent = target.purchase_order.erp_purchase_order_no !== null;
    if (sent && (await erpReceiptLinesOf(tx, input.inboundReceiptLineId)).length > 0) {
      const id = created.inbound_receipt_po_allocation_id;
      await this.outbox.enqueue(tx, {
        interfaceCode: IF_GOODS_RECEIPT,
        messageKey: allocationMessageKey(id),
        targetTypeCode: ALLOCATION_TARGET,
        targetId: id,
        payload: { inboundReceiptPoAllocationId: Number(id) },
      });
    }
    return created;
  }

  /**
   * 몫을 뺀다 — 그 P/O 라인의 `received_qty` 를 되돌린다.
   * ERP 구매입고로 간 몫은 못 뺀다 — 줄이 ERP 로 가는 입고에 들어갔고 대상이 ERP 발주면, 입고 전 몫은 입고 메시지에,
   * 입고 뒤 몫은 자기 묶음(`ALLOC`)에 실렸다. 둘을 가르지 않고 같은 조건으로 잠근다.
   */
  async remove(tx: Prisma.TransactionClient, allocationId: bigint, appUserId: number): Promise<void> {
    const row = await tx.inbound_receipt_po_allocation.findUnique({
      where: { inbound_receipt_po_allocation_id: allocationId },
      select: { inbound_receipt_line_id: true, purchase_order_line_id: true, allocated_qty: true },
    });
    if (row === null) throw new NotFoundException('없는 배정입니다.');
    const target = await lockOrderLine(tx, row.purchase_order_line_id, 'inboundReceiptPoAllocationId');
    const sent =
      target.purchase_order.erp_purchase_order_no !== null &&
      (await erpReceiptLinesOf(tx, row.inbound_receipt_line_id)).length > 0;
    if (sent) throw one(field('inboundReceiptPoAllocationId', ERROR_CODE.STATE_LOCKED, 'ERP 구매입고로 보낸 배정입니다.'));
    await tx.purchase_order_line.update({
      where: { purchase_order_line_id: row.purchase_order_line_id },
      data: { received_qty: { decrement: row.allocated_qty }, updated_by: BigInt(appUserId) },
    });
    await tx.inbound_receipt_po_allocation.delete({ where: { inbound_receipt_po_allocation_id: allocationId } });
  }
}

/**
 * 줄의 입하를 `FOR UPDATE` 로 잡는다 — 취소(요청) 중이면 `STATE_LOCKED`. ⭐ 잠금 순서는 입하 → 부모 P/O 다
 * (치환·취소·초과분 잇기와 같다). 입하를 먼저 잡아야 치환이 「배정 없음」을 본 뒤 배정이 끼어드는 일이 없다.
 */
async function lockReceiptOf(tx: Prisma.TransactionClient, inboundReceiptLineId: bigint): Promise<void> {
  const owner = await tx.inbound_receipt_line.findUnique({
    where: { inbound_receipt_line_id: inboundReceiptLineId },
    select: { inbound_receipt_id: true },
  });
  if (owner === null) throw new NotFoundException('없는 입하 줄입니다.');
  const [receipt] = await tx.$queryRaw<{ status_code: string }[]>`
    SELECT status_code FROM logistics.inbound_receipt
     WHERE inbound_receipt_id = ${owner.inbound_receipt_id}
       FOR UPDATE`;
  if (CANCEL_STATUSES.includes(receipt.status_code)) {
    throw one(field('inboundReceiptLineId', ERROR_CODE.STATE_LOCKED, '취소했거나 취소 요청 중인 입하입니다.'));
  }
}

/** 부모 P/O 를 `FOR UPDATE` 로 잡고 라인을 다시 읽는다 — `received_qty` 를 쓰는 모든 경로의 불변식이다. */
export async function lockOrderLine(tx: Prisma.TransactionClient, purchaseOrderLineId: bigint, at: string) {
  const owner = await tx.purchase_order_line.findUnique({
    where: { purchase_order_line_id: purchaseOrderLineId },
    select: { purchase_order_id: true },
  });
  if (owner === null) throw one(field(at, ERROR_CODE.INVALID, '없는 P/O 라인입니다.'));
  await tx.$queryRaw`
    SELECT purchase_order_id FROM logistics.purchase_order
     WHERE purchase_order_id = ${owner.purchase_order_id}
       FOR UPDATE`;
  return tx.purchase_order_line.findUniqueOrThrow({
    where: { purchase_order_line_id: purchaseOrderLineId },
    include: { purchase_order: true },
  });
}
