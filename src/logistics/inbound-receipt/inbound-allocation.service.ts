import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { IF_GOODS_RECEIPT, OutboxService } from '../../core/outbox';
import { ALLOCATION_TARGET, allocationMessageKey, erpReceiptLinesOf } from '../goods-receipt/erp-receipt';
import { allocationTargetError, unallocatedQtyOf } from './inbound-allocation';
import { roomOf } from './inbound-excess';

/** 400 이 짚을 칸 — 부르는 자리마다 다르다(배정 경로는 본문 칸, 입하 등록은 `lines.{i}.…`). */
export interface AllocationFields {
  target: string;
  qty: string;
}
const BODY_FIELDS: AllocationFields = { target: 'purchaseOrderLineId', qty: 'qty' };

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
  constructor(private readonly outbox: OutboxService) {}

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

  /** 몫을 뺀다 — 그 P/O 라인의 `received_qty` 를 되돌린다. ERP 구매입고로 보낼 일이 적재된 몫은 못 뺀다. */
  async remove(tx: Prisma.TransactionClient, allocationId: bigint, appUserId: number): Promise<void> {
    const row = await tx.inbound_receipt_po_allocation.findUnique({
      where: { inbound_receipt_po_allocation_id: allocationId },
      select: { purchase_order_line_id: true, allocated_qty: true },
    });
    if (row === null) throw new NotFoundException('없는 배정입니다.');
    if ((await tx.integration_message.count({ where: { message_key: allocationMessageKey(allocationId) } })) > 0) {
      throw one(field('inboundReceiptPoAllocationId', ERROR_CODE.STATE_LOCKED, 'ERP 구매입고로 보낸 배정입니다.'));
    }
    await lockOrderLine(tx, row.purchase_order_line_id, 'inboundReceiptPoAllocationId');
    await tx.purchase_order_line.update({
      where: { purchase_order_line_id: row.purchase_order_line_id },
      data: { received_qty: { decrement: row.allocated_qty }, updated_by: BigInt(appUserId) },
    });
    await tx.inbound_receipt_po_allocation.delete({ where: { inbound_receipt_po_allocation_id: allocationId } });
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
