import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { localDate } from '../../planning/production-plan/plan-window';
import { PurchaseOrderLineSchedule, purchaseOrderLineSchedule } from './purchase-order-line-schedule';

export interface PurchaseOrderLineQuery {
  expectedReceiptDateFrom?: string;
  expectedReceiptDateTo?: string;
  supplierId?: number;
  plantId?: number;
  itemId?: number;
  q?: string;
  /** 기본 true — 계약 사본이 `default: true` 로 적었지만 가드는 기본값을 채우지 않는다. */
  openOnly?: boolean;
  overdueOnly?: boolean;
  page?: number;
  size?: number;
}

/** 다 들어오지 않았어도 더 받지 않는 헤더 — P/O 목록 `openOnly` 와 같은 둘이다. */
const CLOSED_HEADER_STATUSES = ['CLOSED', 'CANCELLED'];

/**
 * 입하 예정 — P/O 라인 목록(장부 P-77 · 화면 `W-01-09`). ASN 이 들어오는 길이 없어
 * 「들어올 것」을 아직 다 들어오지 않은 P/O 라인으로 본다(#741).
 */
@Injectable()
export class PurchaseOrderLineQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: PurchaseOrderLineQuery,
    now: Date = new Date(),
  ): Promise<PagedResponse<PurchaseOrderLineSchedule>> {
    const page = pageRequest(query);
    const where = await this.where(query, now);

    const [rows, total] = await Promise.all([
      this.prisma.purchase_order_line.findMany({
        where,
        include: { purchase_order: true },
        // 납기 오름차순(없는 것은 뒤) → 발주번호 → 라인번호. 발주번호가 유일하고 라인번호가
        // 그 안에서 유일해 이 셋으로 순서가 하나로 정해진다.
        orderBy: [
          { purchase_order: { expected_receipt_date: { sort: 'asc', nulls: 'last' } } },
          { purchase_order: { purchase_order_no: 'asc' } },
          { line_no: 'asc' },
        ],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.purchase_order_line.count({ where }),
    ]);
    return pagedResponse(rows.map(purchaseOrderLineSchedule), total, page);
  }

  private async where(
    query: PurchaseOrderLineQuery,
    now: Date,
  ): Promise<Prisma.purchase_order_lineWhereInput> {
    // 헤더 관계 필터가 여럿이라(헤더 칸·미완·지연) 스프레드로 합치면 뒤가 앞을 덮는다 — AND 로 합친다.
    const conditions: Prisma.purchase_order_lineWhereInput[] = [];

    const header: Prisma.purchase_orderWhereInput = {
      ...filter('supplier_id', query.supplierId),
      ...filter('plant_id', query.plantId),
      ...expectedReceiptDateWhere(query.expectedReceiptDateFrom, query.expectedReceiptDateTo),
      // 번호가 둘이라(MES 채번·ERP) 둘 다 본다 — P/O 목록 `q` 는 MES 번호만 본다(I-2.md R-8 ⓓ).
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { purchase_order_no: { contains: query.q, mode: 'insensitive' } },
              { erp_purchase_order_no: { contains: query.q, mode: 'insensitive' } },
            ],
          }),
    };
    if (Object.keys(header).length > 0) conditions.push({ purchase_order: header });
    if (query.itemId !== undefined) conditions.push({ item_id: query.itemId });

    // 지연은 「다 들어오지 않은 것」 중의 지연이다 — openOnly=false 여도 미완 조건을 건다.
    if (query.openOnly !== false || query.overdueOnly === true) conditions.push(this.openWhere());
    if (query.overdueOnly === true) conditions.push(await this.overdueWhere(query.plantId, now));

    return conditions.length === 0 ? {} : { AND: conditions };
  }

  /** 누적 입하 < 발주 · 라인 ERP 취소 아님 · 헤더 종료·취소 아님. 같은 표 두 컬럼 비교는 `fields` 참조. */
  private openWhere(): Prisma.purchase_order_lineWhereInput {
    return {
      received_qty: { lt: this.prisma.purchase_order_line.fields.ordered_qty },
      cancelled_at: null,
      purchase_order: { status_code: { notIn: CLOSED_HEADER_STATUSES } },
    };
  }

  /**
   * 입고 예정일 < 그 P/O 공장의 현지 오늘. 공장마다 오늘이 다를 수 있어 공장별로 OR 를 짓는다
   * (`expected_receipt_date` 는 `@db.Date` — 타임존 캐스팅 없이 그대로 비교한다 · CLAUDE.md).
   * 예정일이 없는 P/O 는 지연이 아니다.
   */
  private async overdueWhere(
    plantId: number | undefined,
    now: Date,
  ): Promise<Prisma.purchase_order_lineWhereInput> {
    const plants = await this.prisma.plant.findMany({
      where: plantId === undefined ? {} : { plant_id: plantId },
      select: { plant_id: true, timezone_code: true },
    });
    return {
      purchase_order: {
        OR: plants.map((plant) => ({
          plant_id: plant.plant_id,
          expected_receipt_date: {
            lt: new Date(`${localDate(now, plant.timezone_code)}T00:00:00.000Z`),
          },
        })),
      },
    };
  }
}

/** 형식(YYYY-MM-DD·없는 날)은 계약 가드가 `format: date` 로 먼저 400 `INVALID` 로 막는다. */
function expectedReceiptDateWhere(from?: string, to?: string): Prisma.purchase_orderWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    expected_receipt_date: {
      ...(from === undefined ? {} : { gte: new Date(`${from}T00:00:00.000Z`) }),
      ...(to === undefined ? {} : { lte: new Date(`${to}T00:00:00.000Z`) }),
    },
  };
}
