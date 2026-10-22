import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { OutboxService } from '../../core/outbox';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { enqueueLinkedExcesses, excessMessageKey } from '../goods-receipt/erp-receipt';
import { CLOSED_ORDER_STATUSES } from '../purchase-order/purchase-order-receipt';
import {
  EXCESS_INCLUDE,
  ExcessCandidateView,
  InboundExcessQuery,
  InboundExcessView,
  candidateView,
  excessView,
  roomOf,
} from './inbound-excess';

/** 취소했거나 취소 요청 중인 입하의 초과분은 잇지도 풀지도 않는다 — 취소가 받은 수량을 되돌린다. */
const CANCEL_STATUSES = ['CANCELLED', 'CANCEL_REQUESTED'];
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

/**
 * 입하 초과분 잇기(장부 P-100). 사용자 결정(2026-10-21): 서버가 후보를 제안하고 사람이 확정한다 ·
 * 잇기 전에도 그 수량은 재고로 쓴다(LOT 은 줄 전체 수량이다).
 */
@Injectable()
export class InboundExcessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async list(query: InboundExcessQuery): Promise<PagedResponse<InboundExcessView>> {
    const page = pageRequest(query);
    const where: Prisma.inbound_receipt_excessWhereInput = {
      purchase_order_line_id: query.linked ? { not: null } : null,
      inbound_receipt_line: {
        ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
        inbound_receipt: {
          status_code: { notIn: CANCEL_STATUSES },
          ...(query.plantId === undefined ? {} : { plant_id: query.plantId }),
          ...(query.supplierId === undefined ? {} : { supplier_id: query.supplierId }),
        },
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.inbound_receipt_excess.findMany({
        where,
        include: EXCESS_INCLUDE,
        orderBy: { inbound_receipt_excess_id: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inbound_receipt_excess.count({ where }),
    ]);
    return pagedResponse(rows.map(excessView), total, page);
  }

  /**
   * 같은 공장·공급사·품목·단위의 남은 P/O 라인 중 초과분을 다 받을 수 있는 것. 남은 수량이 초과분과 같은 라인이
   * 먼저, 그다음 최근 발주다. 초과분이 나온 줄 자신의 P/O 라인은 뺀다.
   */
  async candidates(excessId: bigint): Promise<ExcessCandidateView[]> {
    const excess = await this.find(excessId);
    const line = excess.inbound_receipt_line;
    const rows = await this.prisma.purchase_order_line.findMany({
      where: {
        item_id: line.item_id,
        uom_id: line.uom_id,
        cancelled_at: null,
        ...(line.purchase_order_line_id === null ? {} : { purchase_order_line_id: { not: line.purchase_order_line_id } }),
        purchase_order: {
          plant_id: line.inbound_receipt.plant_id,
          supplier_id: line.inbound_receipt.supplier_id,
          status_code: { notIn: CLOSED_ORDER_STATUSES },
        },
      },
      include: { purchase_order: true },
      orderBy: [{ purchase_order: { order_date: 'desc' } }, { purchase_order_line_id: 'desc' }],
    });
    const views = rows
      .filter((row) => roomOf(row).greaterThanOrEqualTo(excess.excess_qty))
      .map((row) => candidateView(row, excess.excess_qty));
    return [...views.filter((view) => view.exactMatch), ...views.filter((view) => !view.exactMatch)];
  }

  async link(excessId: bigint, purchaseOrderLineId: bigint, appUserId: number): Promise<InboundExcessView> {
    await this.prisma.$transaction(async (tx) => {
      const excess = await this.lockReceiptOf(tx, excessId);
      if (excess.purchase_order_line_id !== null) {
        throw one(field('inboundReceiptExcessId', ERROR_CODE.STATE_LOCKED, '이미 P/O 라인에 이어진 초과분입니다.'));
      }
      const target = await lockOrderLine(tx, purchaseOrderLineId);
      const line = excess.inbound_receipt_line;
      const mismatch =
        target.item_id !== line.item_id ||
        target.uom_id !== line.uom_id ||
        target.purchase_order.plant_id !== line.inbound_receipt.plant_id ||
        target.purchase_order.supplier_id !== line.inbound_receipt.supplier_id ||
        target.purchase_order_line_id === line.purchase_order_line_id;
      if (mismatch) {
        throw one(field('purchaseOrderLineId', ERROR_CODE.INVALID, '같은 공장·공급사·품목·단위의 다른 P/O 라인이어야 합니다.'));
      }
      if (target.cancelled_at !== null || CLOSED_ORDER_STATUSES.includes(target.purchase_order.status_code)) {
        throw one(field('purchaseOrderLineId', ERROR_CODE.INVALID, '취소했거나 닫힌 P/O 라인입니다.'));
      }
      // ⛔ `Decimal` 로 비교한다 — 입하 등록의 한도 검사와 같은 기준이다(발주 + 초과 허용치).
      if (excess.excess_qty.greaterThan(roomOf(target))) {
        throw one(field('purchaseOrderLineId', ERROR_CODE.QTY_EXCEEDS_ORDERED, '발주 수량과 허용치를 넘습니다.'));
      }
      await tx.purchase_order_line.update({
        where: { purchase_order_line_id: purchaseOrderLineId },
        data: { received_qty: { increment: excess.excess_qty }, updated_by: BigInt(appUserId) },
      });
      await tx.inbound_receipt_excess.update({
        where: { inbound_receipt_excess_id: excessId },
        data: {
          purchase_order_line_id: purchaseOrderLineId,
          linked_at: new Date(),
          linked_by: BigInt(appUserId),
          updated_by: BigInt(appUserId),
          version_no: { increment: 1 },
        },
      });
      // 이미 ERP 로 입고된 입하 줄이면 이은 초과분이 지금 구매입고로 간다(P-100 · 장부 P-104).
      await enqueueLinkedExcesses(tx, this.outbox, excess.inbound_receipt_line_id);
    }, TRANSACTION_OPTIONS);
    return excessView(await this.find(excessId));
  }

  /** 잘못 이었을 때 되돌린다. ERP 구매입고로 보낼 일이 적재된 초과분은 풀지 못한다(P-100 · 장부 P-104). */
  async unlink(excessId: bigint, appUserId: number): Promise<InboundExcessView> {
    await this.prisma.$transaction(async (tx) => {
      const excess = await this.lockReceiptOf(tx, excessId);
      if (excess.purchase_order_line_id === null) {
        throw one(field('inboundReceiptExcessId', ERROR_CODE.STATE_LOCKED, '이어진 P/O 라인이 없는 초과분입니다.'));
      }
      if ((await tx.integration_message.count({ where: { message_key: excessMessageKey(excessId) } })) > 0) {
        throw one(field('inboundReceiptExcessId', ERROR_CODE.STATE_LOCKED, 'ERP 구매입고로 보낸 초과분입니다.'));
      }
      await lockOrderLine(tx, excess.purchase_order_line_id);
      await tx.purchase_order_line.update({
        where: { purchase_order_line_id: excess.purchase_order_line_id },
        data: { received_qty: { decrement: excess.excess_qty }, updated_by: BigInt(appUserId) },
      });
      await tx.inbound_receipt_excess.update({
        where: { inbound_receipt_excess_id: excessId },
        data: {
          purchase_order_line_id: null,
          linked_at: null,
          linked_by: null,
          updated_by: BigInt(appUserId),
          version_no: { increment: 1 },
        },
      });
    }, TRANSACTION_OPTIONS);
    return excessView(await this.find(excessId));
  }

  private async find(excessId: bigint) {
    const row = await this.prisma.inbound_receipt_excess.findUnique({
      where: { inbound_receipt_excess_id: excessId },
      include: EXCESS_INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 초과분입니다.');
    return row;
  }

  /**
   * ⭐ 잠금 순서는 입하 → 부모 P/O 다 — 라인 치환(입하 버전 → P/O)·입하 취소(입하 → P/O)와 같다. 입하를 먼저 잡아야
   * 치환이 「이어진 초과분 없음」을 본 뒤 이 잇기가 끼어들어 이어진 초과분을 지우는 일이 없다.
   */
  private async lockReceiptOf(tx: Prisma.TransactionClient, excessId: bigint) {
    const owner = await tx.inbound_receipt_excess.findUnique({
      where: { inbound_receipt_excess_id: excessId },
      select: { inbound_receipt_line: { select: { inbound_receipt_id: true } } },
    });
    if (!owner) throw new NotFoundException('없는 초과분입니다.');
    const [receipt] = await tx.$queryRaw<{ status_code: string }[]>`
      SELECT status_code FROM logistics.inbound_receipt
       WHERE inbound_receipt_id = ${owner.inbound_receipt_line.inbound_receipt_id}
         FOR UPDATE`;
    if (CANCEL_STATUSES.includes(receipt.status_code)) {
      throw one(field('inboundReceiptExcessId', ERROR_CODE.STATE_LOCKED, '취소했거나 취소 요청 중인 입하입니다.'));
    }
    // 잠근 «뒤»에 다시 읽는다 — 그 전에 읽은 값은 다른 잇기·풀기가 바꿨을 수 있다.
    return tx.inbound_receipt_excess.findUniqueOrThrow({
      where: { inbound_receipt_excess_id: excessId },
      include: { inbound_receipt_line: { include: { inbound_receipt: true } } },
    });
  }
}

/** 부모 P/O 를 `FOR UPDATE` 로 잡고 라인을 다시 읽는다 — `received_qty` 를 쓰는 모든 경로의 불변식이다. */
async function lockOrderLine(tx: Prisma.TransactionClient, purchaseOrderLineId: bigint) {
  const owner = await tx.purchase_order_line.findUnique({
    where: { purchase_order_line_id: purchaseOrderLineId },
    select: { purchase_order_id: true },
  });
  if (!owner) throw new ContractException(HttpStatus.BAD_REQUEST, [field('purchaseOrderLineId', ERROR_CODE.INVALID, '없는 P/O 라인입니다.')]);
  await tx.$queryRaw`
    SELECT purchase_order_id FROM logistics.purchase_order
     WHERE purchase_order_id = ${owner.purchase_order_id}
       FOR UPDATE`;
  return tx.purchase_order_line.findUniqueOrThrow({
    where: { purchase_order_line_id: purchaseOrderLineId },
    include: { purchase_order: true },
  });
}
