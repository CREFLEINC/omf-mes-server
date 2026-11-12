import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LINE_LIST_INCLUDE,
  PurchaseOrderLineListItem,
  PurchaseOrderLineListQuery,
  lineListItem,
} from './purchase-order-line-list';
import { CLOSED_ORDER_STATUSES, expectedDateWhere, openLineWhere, overdueOrderWhere } from './purchase-order-receipt';

/** 계약 `PurchaseOrderLineListItem.receivingInboundLots[]`. */
export interface ReceivingInboundLotView {
  inboundLotId: number;
  inboundLotNo: string;
  receivedQty: number;
}

export interface PurchaseOrderLineListRow extends PurchaseOrderLineListItem {
  receivingInboundLots: ReceivingInboundLotView[];
}

const comboKey = (plantId: bigint, supplierId: bigint, itemId: bigint): string => `${String(plantId)}:${String(supplierId)}:${String(itemId)}`;

/**
 * 입하 예정 = 아직 다 들어오지 않은 구매발주 라인(장부 P-78 · #741). ASN 이 들어오는 길이 없어
 * 관리웹 W-01-09 가 이 목록을 본다. 정렬은 납기 → 발주번호 → 라인번호다(납기 없는 발주는 뒤).
 */
@Injectable()
export class PurchaseOrderLineListService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PurchaseOrderLineListQuery, now = new Date()): Promise<PagedResponse<PurchaseOrderLineListRow>> {
    const page = pageRequest(query);
    const where = await this.where(query, now);
    const [rows, total] = await Promise.all([
      this.prisma.purchase_order_line.findMany({
        where,
        include: LINE_LIST_INCLUDE,
        orderBy: [
          { purchase_order: { expected_receipt_date: { sort: 'asc', nulls: 'last' } } },
          { purchase_order: { purchase_order_no: 'asc' } },
          { line_no: 'asc' },
          { purchase_order_line_id: 'asc' },
        ],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.purchase_order_line.count({ where }),
    ]);
    const receiving = await this.receivingInboundLots(rows.map((row) => ({
      plant_id: row.purchase_order.plant_id, supplier_id: row.purchase_order.supplier_id, item_id: row.item_id,
    })));
    return pagedResponse(rows.map((row) => ({
      ...lineListItem(row),
      receivingInboundLots: receiving.get(comboKey(row.purchase_order.plant_id, row.purchase_order.supplier_id, row.item_id)) ?? [],
    })), total, page);
  }

  /**
   * 같은 공장·공급사·품목의 입하 중(RECEIVING) 입하 LOT — 마감 전에는 P/O 배정이 없어 W-01-09 가 「입하 중」을 그릴 근거가 이것뿐이다.
   * 조합마다 열린 것은 하나뿐이다(`uq_inbound_lot_open`).
   */
  private async receivingInboundLots(
    combos: { plant_id: bigint; supplier_id: bigint; item_id: bigint }[],
  ): Promise<Map<string, ReceivingInboundLotView[]>> {
    if (combos.length === 0) return new Map();
    const rows = await this.prisma.inbound_lot.findMany({
      where: { status_code: 'RECEIVING', OR: combos },
      select: { inbound_lot_id: true, inbound_lot_no: true, plant_id: true, supplier_id: true, item_id: true,
        inbound_receipt_line: { select: { received_qty: true } } },
      orderBy: { inbound_lot_id: 'asc' },
    });
    const byCombo = new Map<string, ReceivingInboundLotView[]>();
    for (const row of rows) {
      const key = comboKey(row.plant_id, row.supplier_id, row.item_id);
      byCombo.set(key, [...(byCombo.get(key) ?? []), {
        inboundLotId: Number(row.inbound_lot_id), inboundLotNo: row.inbound_lot_no, receivedQty: Number(row.inbound_receipt_line.received_qty),
      }]);
    }
    return byCombo;
  }

  async where(query: PurchaseOrderLineListQuery, now: Date): Promise<Prisma.purchase_order_lineWhereInput> {
    const open = query.openOnly || query.overdueOnly;
    const order: Prisma.purchase_orderWhereInput = {
      ...(query.supplierId === undefined ? {} : { supplier_id: query.supplierId }),
      ...(query.plantId === undefined ? {} : { plant_id: query.plantId }),
      ...expectedDateWhere(query.expectedReceiptDateFrom, query.expectedReceiptDateTo),
      ...(open ? { status_code: { notIn: CLOSED_ORDER_STATUSES } } : {}),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { purchase_order_no: { contains: query.q, mode: 'insensitive' } },
              { erp_purchase_order_no: { contains: query.q, mode: 'insensitive' } },
            ],
          }),
    };
    const and: Prisma.purchase_order_lineWhereInput[] = [{ purchase_order: { is: order } }];
    if (query.overdueOnly) {
      const overdue = await overdueOrderWhere(this.prisma, query.plantId, now);
      and.push({ OR: overdue.map((is) => ({ purchase_order: { is } })) });
    }

    return {
      ...(query.purchaseOrderId === undefined ? {} : { purchase_order_id: query.purchaseOrderId }),
      ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
      ...(open ? openLineWhere(this.prisma) : {}),
      AND: and,
    };
  }
}
