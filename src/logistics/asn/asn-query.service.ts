import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AsnDetail, AsnLineView, AsnView, asnLineView, asnView } from './asn-view';

export interface AsnQuery {
  expectedArrivalDateFrom?: string;
  expectedArrivalDateTo?: string;
  supplierId?: number;
  plantId?: number;
  statusCode?: string;
  itemId?: number;
  q?: string;
  page?: number;
  size?: number;
}

const LINE_INCLUDE = { purchase_order_line: true } as const;

/** ASN 조회 3건. 화면은 `W-01-09` 가 소유한다. 등록·수정·삭제는 없다(ERP 수신본 — I-3.md §2-1). */
@Injectable()
export class AsnQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AsnQuery): Promise<PagedResponse<AsnView>> {
    const page = pageRequest(query);
    const where: Prisma.asnWhereInput = {
      ...filter('supplier_id', query.supplierId),
      ...filter('plant_id', query.plantId),
      // `statusCode` 는 `x-no-code-key` — 값 목록 검사를 하지 않는다.
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...expectedArrivalDateWhere(query.expectedArrivalDateFrom, query.expectedArrivalDateTo),
      ...(query.itemId === undefined ? {} : { asn_line: { some: { item_id: query.itemId } } }),
      // 「입하예정번호·거래명세서번호 검색」(계약) — 둘 다 본다.
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { asn_no: { contains: query.q, mode: 'insensitive' } },
              { delivery_note_no: { contains: query.q, mode: 'insensitive' } },
            ],
          }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.asn.findMany({
        where,
        // 계약이 적은 유일한 정렬 — 도착 예정일 오름차순, tie-break 는 PK.
        orderBy: [{ expected_arrival_date: 'asc' }, { asn_id: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.asn.count({ where }),
    ]);
    return pagedResponse(rows.map(asnView), total, page);
  }

  /** 없으면 404 다(계약 선언). */
  async get(asnId: number): Promise<AsnDetail | undefined> {
    const row = await this.prisma.asn.findUnique({ where: { asn_id: asnId } });
    if (!row) return undefined;
    return { asn: asnView(row), lines: await this.lines(asnId) };
  }

  /** 없는 ASN 이면 빈 배열이다 — 계약이 이 경로에 404 를 선언하지 않았다(P/O `lines()` 선례). */
  async lines(asnId: number): Promise<AsnLineView[]> {
    const rows = await this.prisma.asn_line.findMany({
      where: { asn_id: asnId },
      orderBy: { line_no: 'asc' },
      include: LINE_INCLUDE,
    });
    return rows.map(asnLineView);
  }
}

/** `expected_arrival_date` 는 `@db.Date` 다 — 타임존 캐스팅 없이 그대로 비교한다(CLAUDE.md). */
function expectedArrivalDateWhere(from?: string, to?: string): Prisma.asnWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    expected_arrival_date: {
      ...(from === undefined ? {} : { gte: new Date(`${from}T00:00:00.000Z`) }),
      ...(to === undefined ? {} : { lte: new Date(`${to}T00:00:00.000Z`) }),
    },
  };
}
