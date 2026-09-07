import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, PageRequest, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { INSPECTION_RESULT_JOIN, InspectionResultRow, InspectionResultView, inspectionResultView } from './inspection-result-view';
import { assertScopedOrPeriod, buildInspectionResultOrderBy } from './inspection-rules';

/**
 * 조회 2건(I-19 PR ②b) — 목록(재검 사슬)·상세. 집계 3건·`/measurements`는 별도 컨트롤러인
 * PR ⑤ 몫이다(R-18). ⚠ `calibrationExpired` 는 계약에 있지만 판정 로직(`calibration.ts`)이
 * PR ⑤ 에서 서므로 여기서 안 받는다 — 근거 없이 필터만 열면 조용히 도출하는 쪽이 된다.
 */
export interface InspectionResultListQuery {
  inspectionRequestId?: number;
  inspectionTypeCode?: string;
  overallJudgmentCode?: string;
  statusCode?: string;
  processId?: number;
  itemId?: number;
  inspectedFrom?: string;
  inspectedTo?: string;
  finalRoundOnly?: boolean;
  sort?: string;
  page?: number;
  size?: number;
}

@Injectable()
export class InspectionResultQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** ⭐ R-12 — `finalRoundOnly` 기본값은 계약에 없다. 목록은 `false`(사슬 동거)가 기본, 집계(⑤)만 `true`. */
  async list(query: InspectionResultListQuery): Promise<PagedResponse<InspectionResultView>> {
    assertScopedOrPeriod(query);
    const page = pageRequest(query);
    const where = buildWhere(query);
    const orderBy = buildInspectionResultOrderBy(query.sort);

    return query.finalRoundOnly === true
      ? this.listFinalRoundOnly(where, orderBy, page)
      : this.listWithChain(where, orderBy, page);
  }

  /** 없으면 404(계약 선언). ETag = `version_no` — 11건 중 이 자리 하나뿐이다. */
  async detail(inspectionResultId: number): Promise<{ view: InspectionResultView; versionNo: number }> {
    const row = await this.prisma.inspection_result.findUnique({
      where: { inspection_result_id: inspectionResultId },
      include: INSPECTION_RESULT_JOIN,
    });
    if (!row) throw new NotFoundException('없는 검사 결과입니다.');
    return { view: inspectionResultView(row), versionNo: row.version_no };
  }

  /** ⭐ 재검 사슬 페이지(계약 `:753`) — 뿌리만 세고 자르되 사슬 전체를 동거시킨다. `uq_inspection_round(의뢰,회차)` 로 재귀 CTE 없이 푼다(§4-2). */
  private async listWithChain(
    where: Prisma.inspection_resultWhereInput,
    orderBy: Prisma.inspection_resultOrderByWithRelationInput[],
    page: PageRequest,
  ): Promise<PagedResponse<InspectionResultView>> {
    const rootWhere: Prisma.inspection_resultWhereInput = { AND: [where, { previous_result_id: null }] };
    const [total, rootRows] = await Promise.all([
      this.prisma.inspection_result.count({ where: rootWhere }),
      this.prisma.inspection_result.findMany({
        where: rootWhere,
        orderBy,
        skip: page.skip,
        take: page.take,
        select: { inspection_result_id: true, inspection_request_id: true },
      }),
    ]);
    const meta = { page: page.page, size: page.size, total };
    if (rootRows.length === 0) return { items: [], page: meta };

    const requestIds = rootRows.map((row) => row.inspection_request_id);
    const chainRows = await this.prisma.inspection_result.findMany({
      where: { inspection_request_id: { in: requestIds } },
      orderBy: { inspection_round: 'asc' },
      include: INSPECTION_RESULT_JOIN,
    });
    const byRequest = new Map<string, InspectionResultRow[]>();
    for (const row of chainRows) {
      const key = row.inspection_request_id.toString();
      byRequest.set(key, [...(byRequest.get(key) ?? []), row]);
    }
    const items = rootRows
      .flatMap((row) => byRequest.get(row.inspection_request_id.toString()) ?? [])
      .map(inspectionResultView);
    return { items, page: meta };
  }

  /** `finalRoundOnly=true` — 의뢰별 최대 회차 1건씩(그룹핑으로 정의를 못박는다 · §4-2). */
  private async listFinalRoundOnly(
    where: Prisma.inspection_resultWhereInput,
    orderBy: Prisma.inspection_resultOrderByWithRelationInput[],
    page: PageRequest,
  ): Promise<PagedResponse<InspectionResultView>> {
    const groups = await this.prisma.inspection_result.groupBy({
      by: ['inspection_request_id'],
      where,
      _max: { inspection_round: true },
    });
    const meta = { page: page.page, size: page.size, total: groups.length };
    if (groups.length === 0) return { items: [], page: meta };

    const finalWhere: Prisma.inspection_resultWhereInput = {
      OR: groups.map((group) => ({
        inspection_request_id: group.inspection_request_id,
        inspection_round: group._max.inspection_round ?? 0,
      })),
    };
    const rows = await this.prisma.inspection_result.findMany({
      where: finalWhere,
      orderBy,
      skip: page.skip,
      take: page.take,
      include: INSPECTION_RESULT_JOIN,
    });
    return { items: rows.map(inspectionResultView), page: meta };
  }
}

function buildWhere(query: InspectionResultListQuery): Prisma.inspection_resultWhereInput {
  const requestWhere: Prisma.inspection_requestWhereInput = {
    ...(query.inspectionTypeCode === undefined ? {} : { inspection_type_code: query.inspectionTypeCode }),
    ...filter('item_id', query.itemId),
    ...processWhere(query.processId),
  };
  return {
    ...filter('inspection_request_id', query.inspectionRequestId),
    ...(query.overallJudgmentCode === undefined ? {} : { overall_judgment_code: query.overallJudgmentCode }),
    ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
    ...inspectedAtWhere(query.inspectedFrom, query.inspectedTo),
    ...(Object.keys(requestWhere).length === 0 ? {} : { inspection_request: requestWhere }),
  };
}

/** §2-3 판정 — ⓑ W/O 축을 먼저, 비면 ⓐ 기준 축. 둘 다 없으면 이 필터는 아무 행도 안 잡는다. */
function processWhere(processId: number | undefined): Prisma.inspection_requestWhereInput {
  if (processId === undefined) return {};
  return {
    OR: [
      { work_order: { routing_operation: { process_id: processId } } },
      { inspection_plan_version: { inspection_plan: { process_id: processId } } },
    ],
  };
}

function inspectedAtWhere(from?: string, to?: string): Prisma.inspection_resultWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    inspected_at: {
      ...(from === undefined ? {} : { gte: new Date(from) }),
      ...(to === undefined ? {} : { lte: new Date(to) }),
    },
  };
}
