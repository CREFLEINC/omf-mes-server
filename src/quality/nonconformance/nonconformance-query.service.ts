import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { SourceCode, nonconformanceSourceWhere } from './nonconformance-source';
import { NONCONFORMANCE_INCLUDE, NonconformanceView, assertOpenedPeriodRequired, nonconformanceView, openedAtWhere } from './nonconformance-view';

/** `GET /quality/nonconformances` 질의 10칸(§1-2) — `openedFrom`/`openedTo` 는 «페어」가 아니라 «둘 다 필수」다(§1 2단계 기준 2). */
export interface NonconformanceFilters {
  statusCode?: string;
  sourceCode?: SourceCode;
  warehouseId?: number;
  itemId?: number;
  lotId?: number;
  severityCode?: string;
  openedFrom?: string;
  openedTo?: string;
}

export interface NonconformanceListQuery extends NonconformanceFilters {
  page?: number;
  size?: number;
}

/**
 * `nonconformance` 목록 조회 — 원시 SQL 이 아니라 Prisma 관계 필터로 EXISTS 를 낸다.
 * `lot` 이 `inventory_balance`·`goods_receipt_line` 로 가는 역관계를 이미 갖고 있어(스키마
 * 실측) `lot-status-query.ts` 식 raw SQL 없이도 EXISTS/NOT EXISTS 가 그대로 나온다(CLAUDE.md
 * — 사용처 하나뿐인 추상화를 선제로 두지 않는다).
 */
@Injectable()
export class NonconformanceQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: NonconformanceListQuery): Promise<PagedResponse<NonconformanceView>> {
    assertOpenedPeriodRequired(query);
    const page = pageRequest(query);
    const where = whereOf(query);

    const [rows, total] = await Promise.all([
      this.prisma.nonconformance.findMany({
        where,
        include: NONCONFORMANCE_INCLUDE,
        // 계약이 이 오퍼레이션에 `sort` 질의를 안 줬다(§4-2) — 기본 고정 + 2차 정렬 키로
        // 동률을 깬다(I-20 R-10 계열 — `nonconformance_id` 는 물리로 유일함이 보장된다).
        orderBy: [{ opened_at: 'desc' }, { nonconformance_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.nonconformance.count({ where }),
    ]);
    return pagedResponse(rows.map(nonconformanceView), total, page);
  }

  /**
   * 상세(I-21 PR ①b) — 매퍼는 목록과 «공유»한다(`nonconformanceView` · 계약이 두 스키마를
   * 한 스키마로 묶었다 · R-25). ETag = **이 행 자신의** `nonconformance.version_no`
   * (계약 `:request-disposition` 이 아니라 `…/{id}/disposition-decisions` 의 If-Match 원천 —
   * §0 판정 #5). 다른 계약 파일(`quality-03품질.json`)이 그 값을 다시 쓰는 «원천 검사기가 못
   * 보는» 자리라 여기 주석에 남긴다.
   */
  async get(nonconformanceId: number): Promise<{ view: NonconformanceView; versionNo: number }> {
    const row = await this.prisma.nonconformance.findUnique({
      where: { nonconformance_id: BigInt(nonconformanceId) },
      include: NONCONFORMANCE_INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 부적합입니다.');
    return { view: nonconformanceView(row), versionNo: row.version_no };
  }
}

/**
 * ⭐ 필터마다 «독립된» `AND` 절로 둔다. `lotId`·`warehouseId`·`sourceCode` 셋 다
 * `nonconformance_lot` 관계를 겨눈다고 한 객체 리터럴에 스프레드로 합치면 **나중 키가 앞을
 * 덮어써 조건이 조용히 사라진다**(JS 객체 리터럴 중복 키 규칙). 배열 `AND` 로 묶으면 그
 * 함정이 없고, 계획서의 「각각 별도 EXISTS」(§1-2)와도 그대로 맞는다.
 */
function whereOf(filters: NonconformanceFilters): Prisma.nonconformanceWhereInput {
  const and: Prisma.nonconformanceWhereInput[] = [
    // 컨트롤러 진입 전 `assertOpenedPeriodRequired` 가 이미 둘 다 있음을 보장한다.
    openedAtWhere(filters.openedFrom as string, filters.openedTo as string),
  ];
  if (filters.statusCode !== undefined) and.push({ status_code: filters.statusCode });
  // ⛔ `severityCode` 는 시드 값으로 닫지 않는다(§1-2 · api m-3) — 계약이 「고객이 늘릴 수
  //   있다」라 적었고 조회 400 이 미선언이다. 안 걸리는 값은 그대로 빈 목록이 된다.
  if (filters.severityCode !== undefined) and.push({ severity_code: filters.severityCode });
  if (filters.itemId !== undefined) and.push({ item_id: BigInt(filters.itemId) });
  // ⭐ nullable 관계를 «등치」가 아니라 EXISTS 로 건다(I-20 R-23) — LOT 이 여럿이면 등치는 못 쓴다.
  if (filters.lotId !== undefined) and.push({ nonconformance_lot: { some: { lot_id: BigInt(filters.lotId) } } });
  if (filters.warehouseId !== undefined) {
    and.push({
      nonconformance_lot: {
        some: { lot: { inventory_balance: { some: { warehouse_id: BigInt(filters.warehouseId) } } } },
      },
    });
  }
  if (filters.sourceCode !== undefined) and.push(nonconformanceSourceWhere(filters.sourceCode));
  return { AND: and };
}
