import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundProgressService } from './inbound-progress.service';
import { INBOUND_STAGE_GROUPS, InboundStageGroup, stageGroupOf } from './inbound-stage';
import {
  CLOSED_ORDER_STATUSES,
  OrderReceiptSummary,
  expectedDateWhere,
  openLineWhere,
  orderReceiptSummary,
  overdueOrderWhere,
} from './purchase-order-receipt';
import {
  PurchaseOrderDetail,
  PurchaseOrderLineView,
  PurchaseOrderView,
  purchaseOrderLineView,
  purchaseOrderView,
} from './purchase-order-view';

export interface PurchaseOrderQuery {
  supplierId?: number;
  /** 공급사 코드·이름 부분 일치. */
  supplierQ?: string;
  plantId?: number;
  statusCode?: string;
  itemId?: number;
  orderDateFrom?: string;
  orderDateTo?: string;
  expectedReceiptDateFrom?: string;
  expectedReceiptDateTo?: string;
  openOnly?: boolean;
  /** 납기가 공장 현지 오늘보다 앞인데 남은 P/O 만. `openOnly` 조건을 함께 건다. */
  overdueOnly?: boolean;
  q?: string;
  /** 그 묶음의 LOT 이 하나라도 있는 발주만(장부 P-110). 건수 경로는 이 조건을 보지 않는다. */
  inboundStage?: InboundStageGroup;
  page?: number;
  size?: number;
}

/** 발주 하나의 LOT 묶음별 수 — 0 인 묶음은 싣지 않는다. 완료·취소 LOT 은 세지 않는다. */
export type InboundStageCounts = Partial<Record<InboundStageGroup, number>>;

/**
 * 목록 한 행 — 헤더에 공급사와 라인 묶음 값을 더한다. 입하 예정 화면(W-01-09)의 왼쪽 표가 쓴다.
 * `matchedLineCount` 는 `itemId` 로 찾았을 때 그 품목 라인 수다(없으면 null).
 */
export type PurchaseOrderListItem = PurchaseOrderView &
  OrderReceiptSummary & {
    supplierCode: string;
    supplierName: string;
    matchedLineCount: number | null;
    inboundStageCounts: InboundStageCounts;
  };

/** P/O 조회 3건 + 단계 칩의 수(장부 P-110). 화면은 `W-01-09`(목록·단계 칩)·`W-01-03`·`W-01-11`(상세)이 소유한다. */
@Injectable()
export class PurchaseOrderQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inboundProgress: InboundProgressService,
  ) {}

  async list(query: PurchaseOrderQuery, now = new Date()): Promise<PagedResponse<PurchaseOrderListItem>> {
    const page = pageRequest(query);
    let where = await this.listWhere(query, now);
    // 단계 칩 — 조건에 맞는 발주의 LOT 을 모두 판정해야 쪽·총계가 맞는다. 그 판정을 행의 묶음 수에도 쓴다.
    let counts: Map<bigint, InboundStageCounts> | undefined;
    if (query.inboundStage !== undefined) {
      const stage = query.inboundStage;
      counts = await this.stageCountsByOrder(await this.orderIds(where));
      where = { purchase_order_id: { in: [...counts].filter(([, count]) => (count[stage] ?? 0) > 0).map(([id]) => id) } };
    }

    const [rows, total] = await Promise.all([
      this.prisma.purchase_order.findMany({
        where,
        orderBy: [{ order_date: 'desc' }, { purchase_order_id: 'desc' }],
        include: {
          partner: { select: { partner_code: true, partner_name: true } },
          purchase_order_line: {
            select: {
              item_id: true,
              uom_id: true,
              ordered_qty: true,
              received_qty: true,
              cancelled_at: true,
              uom: { select: { uom_code: true } },
            },
          },
        },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.purchase_order.count({ where }),
    ]);
    counts ??= await this.stageCountsByOrder(rows.map((row) => row.purchase_order_id));
    const itemId = query.itemId === undefined ? null : BigInt(query.itemId);
    const items = rows.map(({ partner, purchase_order_line: lines, ...row }) => ({
      ...purchaseOrderView(row),
      supplierCode: partner.partner_code,
      supplierName: partner.partner_name,
      ...orderReceiptSummary(row.status_code, lines),
      matchedLineCount: itemId === null ? null : lines.filter((line) => line.item_id === itemId).length,
      inboundStageCounts: counts?.get(row.purchase_order_id) ?? {},
    }));
    return pagedResponse(items, total, page);
  }

  /** 단계 칩의 수 — 목록과 같은 조건 전체의 LOT 묶음별 수(쪽·`inboundStage` 는 보지 않는다 · 장부 P-110). */
  async inboundStageCounts(query: PurchaseOrderQuery, now = new Date()): Promise<Record<InboundStageGroup, number>> {
    const counts = await this.stageCountsByOrder(await this.orderIds(await this.listWhere(query, now)));
    const totals = Object.fromEntries(INBOUND_STAGE_GROUPS.map((group) => [group, 0])) as Record<InboundStageGroup, number>;
    for (const count of counts.values()) {
      for (const group of INBOUND_STAGE_GROUPS) totals[group] += count[group] ?? 0;
    }
    return totals;
  }

  private async orderIds(where: Prisma.purchase_orderWhereInput): Promise<bigint[]> {
    const rows = await this.prisma.purchase_order.findMany({ where, select: { purchase_order_id: true } });
    return rows.map((row) => row.purchase_order_id);
  }

  /** 발주마다 LOT 묶음별 수 — 판정은 LOT 줄(`inbound-progress.service.ts`)과 같다. */
  private async stageCountsByOrder(orderIds: bigint[]): Promise<Map<bigint, InboundStageCounts>> {
    const counts = new Map<bigint, InboundStageCounts>(orderIds.map((id) => [id, {}]));
    for (const { purchaseOrderId, progress } of await this.inboundProgress.lotsOf(orderIds)) {
      const group = stageGroupOf(progress.stageCode);
      const count = counts.get(purchaseOrderId);
      if (group === null || count === undefined) continue;
      count[group] = (count[group] ?? 0) + 1;
    }
    return counts;
  }

  private async listWhere(query: PurchaseOrderQuery, now: Date): Promise<Prisma.purchase_orderWhereInput> {
    const open = query.openOnly === true || query.overdueOnly === true;
    // itemId·openOnly·overdueOnly·supplierQ 는 관계·OR 필터라 스프레드로 합치면 뒤가 앞을 덮는다 — AND 로 합친다.
    const lineFilters = [
      itemWhere(query.itemId),
      this.openWhere(open),
      supplierWhere(query.supplierQ),
      query.overdueOnly ? { OR: await overdueOrderWhere(this.prisma, query.plantId, now) } : {},
    ].filter((c) => Object.keys(c).length > 0);
    return {
      ...filter('supplier_id', query.supplierId),
      ...filter('plant_id', query.plantId),
      // `statusCode` 는 `type: string` 이다(enum 아니다) — 값 목록 검사를 하지 않는다.
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...orderDateWhere(query.orderDateFrom, query.orderDateTo),
      ...expectedDateWhere(query.expectedReceiptDateFrom, query.expectedReceiptDateTo),
      ...(lineFilters.length === 0 ? {} : { AND: lineFilters }),
      // 「발주번호 검색」(계약) — MES 채번 번호만 본다. erp_purchase_order_no 는 안 본다
      // (번호가 둘이라 하나를 고른다 — I-2.md R-8 ⓓ).
      ...(query.q === undefined
        ? {}
        : { purchase_order_no: { contains: query.q, mode: 'insensitive' } }),
    };
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

  /** `tx` 를 받는다 — 라인 치환이 «자기 트랜잭션 안에서» 응답을 조립한다(#192 Minor-2). */
  async lines(
    purchaseOrderId: number,
    tx?: Prisma.TransactionClient,
  ): Promise<PurchaseOrderLineView[]> {
    const rows = await (tx ?? this.prisma).purchase_order_line.findMany({
      where: { purchase_order_id: purchaseOrderId },
      orderBy: { line_no: 'asc' },
    });
    return rows.map(purchaseOrderLineView);
  }

  /**
   * 「아직 입하가 끝나지 않은 건만」(계약) — 종료/취소되지 않았고 받은 수량이
   * 발주 수량에 못 미치는 «취소되지 않은» 라인이 하나라도 있는 P/O(입하 예정 라인 목록과 같은 기준 · P-78). CLOSED 헤더의 잔량이
   * 남아 있더라도 모바일의 미마감 선택 목록에는 들어가지 않는다.
   * 같은 표 두 컬럼 비교는 Prisma `fields` 참조로 관계 필터에 접는다.
   */
  private openWhere(open: boolean): Prisma.purchase_orderWhereInput {
    if (!open) return {};
    return {
      status_code: { notIn: CLOSED_ORDER_STATUSES },
      // ERP 가 취소한 라인은 입하할 수 없다(장부 P-73) — 남은 수량이 있어도 「열린」 라인이 아니다.
      purchase_order_line: { some: openLineWhere(this.prisma) },
    };
  }
}

function itemWhere(itemId: number | undefined): Prisma.purchase_orderWhereInput {
  return itemId === undefined ? {} : { purchase_order_line: { some: { item_id: itemId } } };
}

function supplierWhere(supplierQ: string | undefined): Prisma.purchase_orderWhereInput {
  const q = supplierQ?.trim();
  if (!q) return {};
  return {
    partner: {
      OR: [
        { partner_code: { contains: q, mode: 'insensitive' } },
        { partner_name: { contains: q, mode: 'insensitive' } },
      ],
    },
  };
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
