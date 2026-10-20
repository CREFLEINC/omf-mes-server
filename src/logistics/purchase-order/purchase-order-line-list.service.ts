import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { localToday } from '../../app/dashboard/dashboard-scope';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CLOSED_ORDER_STATUSES,
  PurchaseOrderLineListItem,
  PurchaseOrderLineListQuery,
  dateOnly,
  lineListItem,
} from './purchase-order-line-list';

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
        include: { purchase_order: true },
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
    if (query.overdueOnly) and.push({ OR: await this.overdueWhere(query.plantId, now) });

    return {
      ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
      ...(open
        ? { cancelled_at: null, received_qty: { lt: this.prisma.purchase_order_line.fields.ordered_qty } }
        : {}),
      AND: and,
    };
  }

  /**
   * 「납기가 지났다」 = 납기 < 그 공장의 현지 오늘. 공장마다 시간대가 달라 공장별 조건을 OR 로 묶는다.
   * 공장이 하나도 없으면 빈 OR 이라 아무것도 걸리지 않는다.
   */
  private async overdueWhere(plantId: bigint | undefined, now: Date): Promise<Prisma.purchase_order_lineWhereInput[]> {
    const plants = await this.prisma.plant.findMany({
      where: plantId === undefined ? {} : { plant_id: plantId },
      select: { plant_id: true, timezone_code: true },
    });
    return plants.map((plant) => ({
      purchase_order: {
        is: {
          plant_id: plant.plant_id,
          expected_receipt_date: { lt: dateOnly(localToday(now, plant.timezone_code)) },
        },
      },
    }));
  }
}

function expectedDateWhere(from?: string, to?: string): Prisma.purchase_orderWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    expected_receipt_date: {
      ...(from === undefined ? {} : { gte: dateOnly(from) }),
      ...(to === undefined ? {} : { lte: dateOnly(to) }),
    },
  };
}
