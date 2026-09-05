import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PurchaseOrderDetail,
  PurchaseOrderLineView,
  PurchaseOrderView,
  purchaseOrderLineView,
  purchaseOrderView,
} from './purchase-order-view';

export interface PurchaseOrderQuery {
  supplierId?: number;
  plantId?: number;
  statusCode?: string;
  itemId?: number;
  orderDateFrom?: string;
  orderDateTo?: string;
  openOnly?: boolean;
  q?: string;
  page?: number;
  size?: number;
}

/** P/O 조회 3건. 화면은 `W-01-09`(목록)·`W-01-03`·`W-01-11`(상세) 이 소유한다. */
@Injectable()
export class PurchaseOrderService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PurchaseOrderQuery): Promise<PagedResponse<PurchaseOrderView>> {
    const page = pageRequest(query);
    const where: Prisma.purchase_orderWhereInput = {
      ...filter('supplier_id', query.supplierId),
      ...filter('plant_id', query.plantId),
      // `statusCode` 는 `type: string` 이다(enum 아니다) — 값 목록 검사를 하지 않는다.
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...itemWhere(query.itemId),
      ...orderDateWhere(query.orderDateFrom, query.orderDateTo),
      ...this.openWhere(query.openOnly),
      // 「발주번호 검색」(계약) — MES 채번 번호만 본다. erp_purchase_order_no 는 안 본다
      // (번호가 둘이라 하나를 고른다 — I-2.md R-8 ⓓ).
      ...(query.q === undefined
        ? {}
        : { purchase_order_no: { contains: query.q, mode: 'insensitive' } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.purchase_order.findMany({
        where,
        orderBy: [{ order_date: 'desc' }, { purchase_order_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.purchase_order.count({ where }),
    ]);
    return pagedResponse(rows.map(purchaseOrderView), total, page);
  }

  async get(purchaseOrderId: number): Promise<{ detail: PurchaseOrderDetail; versionNo: number }> {
    const row = await this.prisma.purchase_order.findUnique({
      where: { purchase_order_id: purchaseOrderId },
    });
    if (!row) throw new NotFoundException('없는 P/O 입니다.');
    return {
      detail: { purchaseOrder: purchaseOrderView(row), lines: await this.lines(purchaseOrderId) },
      versionNo: row.version_no,
    };
  }

  async lines(purchaseOrderId: number): Promise<PurchaseOrderLineView[]> {
    const rows = await this.prisma.purchase_order_line.findMany({
      where: { purchase_order_id: purchaseOrderId },
      orderBy: { line_no: 'asc' },
    });
    return rows.map(purchaseOrderLineView);
  }

  /**
   * 「아직 입하가 끝나지 않은 건만」(계약) — 받은 수량이 발주 수량에 못 미치는 라인이
   * 하나라도 있는 P/O. 같은 표 두 컬럼 비교는 Prisma 5.0 GA `fields` 참조로 관계 필터
   * 한 줄에 접는다(프리뷰 불필요). `tolerance_under_qty` 는 빼지 않는다(I-2.md §6-4).
   */
  private openWhere(openOnly: boolean | undefined): Prisma.purchase_orderWhereInput {
    if (!openOnly) return {};
    return {
      purchase_order_line: {
        some: { received_qty: { lt: this.prisma.purchase_order_line.fields.ordered_qty } },
      },
    };
  }
}

function itemWhere(itemId: number | undefined): Prisma.purchase_orderWhereInput {
  return itemId === undefined ? {} : { purchase_order_line: { some: { item_id: itemId } } };
}

/** `order_date` 는 `@db.Date` 다 — 타임존 캐스팅 없이 그대로 비교한다(CLAUDE.md). */
function orderDateWhere(from?: string, to?: string): Prisma.purchase_orderWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    order_date: {
      ...(from === undefined ? {} : { gte: new Date(`${from}T00:00:00.000Z`) }),
      ...(to === undefined ? {} : { lte: new Date(`${to}T00:00:00.000Z`) }),
    },
  };
}
