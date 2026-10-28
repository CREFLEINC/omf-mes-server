import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesOrderView, salesOrderView } from './sales-order-view';

export interface SalesOrderQuery {
  customerId?: number;
  statusCode?: string;
  orderDateFrom?: string;
  orderDateTo?: string;
  unassignedOnly?: boolean;
  /** 계약 밖 질의(장부 P-132) — 가드가 거르지 않아 서버가 값을 가른다. */
  progress?: string;
  q?: string;
  page?: number;
  size?: number;
}

/** 라인을 늘 함께 싣는다 — 목록도 그렇다(I-22 R-9 · `W-04-01` §3 ① 의 「3라인」). */
const WITH_LINES = {
  sales_order_line: { orderBy: { line_no: 'asc' } },
} satisfies Prisma.sales_orderInclude;

/**
 * 고객사 출하지시서 조회 2건. 화면 `W-04-01`(목록·상세)이 소유한다.
 *
 * ⛔ 이 리소스는 수신본이라 등록·수정 경로가 없다 — 멱등·If-Match·ETag·403 이 전부 0건이다
 * (계약 실측 · I-22 §1-1). `runIdempotent`·`runVersioned`·`setEtag` 를 부르지 않는다.
 */
@Injectable()
export class SalesOrderQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: SalesOrderQuery): Promise<PagedResponse<SalesOrderView>> {
    const page = pageRequest(query);
    const where: Prisma.sales_orderWhereInput = {
      ...filter('customer_id', query.customerId),
      // `statusCode` 는 `x-no-code-key` 로 닫힌 칸이라 값 목록이 없다 — 문자 그대로 건다.
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...orderDateWhere(query.orderDateFrom, query.orderDateTo),
      ...unassignedWhere(query.unassignedOnly),
      ...this.progressWhere(query.progress),
      // 계약이 「지시서 번호 검색」으로 좁혔다 — `erp_sales_order_no` 는 안 본다.
      ...(query.q === undefined
        ? {}
        : { sales_order_no: { contains: query.q, mode: 'insensitive' } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.sales_order.findMany({
        where,
        include: WITH_LINES,
        // 계약이 정렬에 침묵하고 `sort` 파라미터도 없다 — PK 단일 키라 페이지 경계가
        // 안 흔들린다(2차 키가 필요 없는 유일한 모양).
        orderBy: { sales_order_id: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.sales_order.count({ where }),
    ]);
    return pagedResponse(rows.map(salesOrderView), total, page);
  }

  async get(salesOrderId: number): Promise<SalesOrderView> {
    const row = await this.prisma.sales_order.findUnique({
      where: { sales_order_id: salesOrderId },
      include: WITH_LINES,
    });
    if (!row) throw new NotFoundException('없는 출하지시서입니다.');
    return salesOrderView(row);
  }

  /**
   * OPEN = 출하가 남은 수주 · COMPLETED = 그 나머지(전량 출하 + 취소). 둘을 합치면 전체다.
   * DB where 로 거른다 — 메모리에서 거르면 `page.total` 과 쪽 나누기가 어긋난다.
   */
  private progressWhere(progress: string | undefined): Prisma.sales_orderWhereInput {
    if (progress === undefined) return {};
    // ⛔ 틀린 값을 무시하지 않는다 — 걸러지지 않은 전체가 한쪽만 거른 것처럼 보인다.
    if (progress !== 'OPEN' && progress !== 'COMPLETED') {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'field', field: 'progress', code: ERROR_CODE.INVALID, message: 'progress 는 OPEN 또는 COMPLETED 여야 합니다.' },
      ]);
    }
    const open: Prisma.sales_orderWhereInput = {
      status_code: { not: 'CANCELLED' },
      sales_order_line: {
        some: { cancelled_at: null, shipped_qty: { lt: this.prisma.sales_order_line.fields.ordered_qty } },
      },
    };
    return progress === 'OPEN' ? open : { NOT: open };
  }
}

/**
 * 「아직 편성되지 않은 것만」(계약) — A13 이 세운 `shipment_request.sales_order_id` 가
 * 이 지시서를 가리키는 작업지시가 하나도 없는 행.
 *
 * ⛔ **`NOT IN` 으로 쓰지 않는다.** 그 칸이 nullable 이라 널이 한 행만 있어도 SQL 3값
 * 논리로 결과가 통째로 빈다(README §6-3 ⑷ · e2e S-9). Prisma 의 `none` 은
 * `NOT EXISTS(… AND t0.sales_order_id IS NOT NULL)` 로 편다 — 확인했다.
 *
 * `unassignedOnly=false` 는 필터를 «안 건다» — 계약이 한 방향만 적었다.
 */
function unassignedWhere(unassignedOnly: boolean | undefined): Prisma.sales_orderWhereInput {
  return unassignedOnly === true ? { shipment_request: { none: {} } } : {};
}

/** `order_date` 는 `@db.Date` 다 — 타임존 캐스팅 없이 날짜끼리 비교한다(CLAUDE.md). */
function orderDateWhere(from?: string, to?: string): Prisma.sales_orderWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    order_date: {
      // 경계를 포함한다 — 같은 날을 주면 그 날 것이 걸린다(e2e S-5·S-6).
      ...(from === undefined ? {} : { gte: new Date(`${from}T00:00:00.000Z`) }),
      ...(to === undefined ? {} : { lte: new Date(`${to}T00:00:00.000Z`) }),
    },
  };
}
