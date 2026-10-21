import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
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

/** 취소했거나 취소 요청 중인 입하의 초과분은 보이지 않는다 — 취소가 받은 수량을 되돌린다. */
const CANCEL_STATUSES = ['CANCELLED', 'CANCEL_REQUESTED'];

/**
 * 입하 초과분 잇기(장부 P-96). 사용자 결정(2026-10-21): 서버가 후보를 제안하고 사람이 확정한다 ·
 * 잇기 전에도 그 수량은 재고로 쓴다(LOT 은 줄 전체 수량이다).
 */
@Injectable()
export class InboundExcessService {
  constructor(private readonly prisma: PrismaService) {}

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

  private async find(excessId: bigint) {
    const row = await this.prisma.inbound_receipt_excess.findUnique({
      where: { inbound_receipt_excess_id: excessId },
      include: EXCESS_INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 초과분입니다.');
    return row;
  }
}
