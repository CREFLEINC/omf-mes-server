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

/**
 * 입하 예정 = 아직 다 들어오지 않은 구매발주 라인(장부 P-78 · #741). ASN 이 들어오는 길이 없어
 * 관리웹 W-01-09 가 이 목록을 본다. 정렬은 납기 → 발주번호 → 라인번호다(납기 없는 발주는 뒤).
 */
@Injectable()
export class PurchaseOrderLineListService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PurchaseOrderLineListQuery, now = new Date()): Promise<PagedResponse<PurchaseOrderLineListItem>> {
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
    return pagedResponse(rows.map(lineListItem), total, page);
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
