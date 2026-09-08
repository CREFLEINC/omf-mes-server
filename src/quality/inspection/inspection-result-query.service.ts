import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, PageRequest, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { CalibrationExpiredFilter, CalibrationIndex } from './calibration';
import { INSPECTION_RESULT_JOIN, InspectionResultRow, InspectionResultView, inspectionResultView } from './inspection-result-view';
import { assertScopedOrPeriod, buildInspectionResultOrderBy, finalRoundOf } from './inspection-rules';

/**
 * 조회 2건(I-19 PR ②b) — 목록(재검 사슬)·상세. 집계·측정치 4건은 별도 컨트롤러다(R-18).
 * ⭐ **#298 m-1 상환(PR ⑤b)** — `calibrationExpired` 를 «조용히 무시»하던 자리다. 판정
 * (`calibration.ts` · R-13)이 이 PR 에서 서면서 목록에도 실제로 필터가 걸린다. ⚠ ⑤a 까지는
 * 「질의 칸을 선언 안 했으니 무시가 아니다」로 적었는데 **사실이 아니었다** — 계약 검증기는
 * 선언 안 한 질의를 막지 않고, 애초에 계약이 선언한 칸이라 서버가 안 읽으면 그냥 무시였다.
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
  calibrationExpired?: CalibrationExpiredFilter;
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
    // 교정 만료 필터가 올 때만 장비 마스터를 읽는다 — 안 쓰는 질의에 두 번의 조회를 더하지 않는다.
    const calibration = query.calibrationExpired === undefined ? undefined : await CalibrationIndex.load(this.prisma);
    const where = buildInspectionResultWhere(query, calibration?.resultScope(query.calibrationExpired));
    const orderBy = buildInspectionResultOrderBy(query.sort);

    return query.finalRoundOnly === true
      ? this.listFinalRoundOnly(where, orderBy, page)
      : this.listWithChain(where, orderBy, page);
  }

  /** 없으면 404(계약 선언). ETag = `version_no` — 11건 중 이 자리 하나뿐이다. */
  async detail(inspectionResultId: number): Promise<{ view: InspectionResultView; versionNo: number }> {
    const row = await this.prisma.inspection_result.findUnique({ where: { inspection_result_id: inspectionResultId }, include: INSPECTION_RESULT_JOIN });
    if (!row) throw new NotFoundException('없는 검사 결과입니다.');
    return { view: inspectionResultView(row), versionNo: row.version_no };
  }

  /** ⭐ 재검 사슬 페이지(계약 `:753`) — 뿌리만 세고 자르되 사슬 전체를 동거시킨다(§4-2). */
  private async listWithChain(
    where: Prisma.inspection_resultWhereInput,
    orderBy: Prisma.inspection_resultOrderByWithRelationInput[],
    page: PageRequest,
  ): Promise<PagedResponse<InspectionResultView>> {
    const rootWhere: Prisma.inspection_resultWhereInput = { AND: [where, { previous_result_id: null }] };
    const [total, rootRows] = await Promise.all([
      this.prisma.inspection_result.count({ where: rootWhere }),
      this.prisma.inspection_result.findMany({ where: rootWhere, orderBy, skip: page.skip, take: page.take, include: INSPECTION_RESULT_JOIN }),
    ]);
    const meta = { page: page.page, size: page.size, total };
    if (rootRows.length === 0) return { items: [], page: meta };

    const chains = await this.fetchChains(rootRows);
    const items = rootRows.flatMap((root) => chains.get(root.inspection_result_id.toString()) ?? [root]).map(inspectionResultView);
    return { items, page: meta };
  }

  /**
   * ⭐ 리뷰 Major 2 — `uq_inspection_round(의뢰,회차)` 는 「의뢰 하나 = 사슬 하나」를 보장하지
   * 않는다(뿌리가 둘일 수 있고, `previous_result_id` 를 같은 의뢰로 묶는 FK·CHECK 가 0건이라
   * 자식이 다른 의뢰에 있을 수도 있다 — `inspection_request_id` 로 뭉치던 옛 방식은 조용한
   * 중복·소실을 냈다). ⇒ `previous_result_id` 만 신뢰해 뿌리마다 **독립** BFS 로 켠다.
   */
  private async fetchChains(roots: InspectionResultRow[]): Promise<Map<string, InspectionResultRow[]>> {
    const chains = new Map<string, InspectionResultRow[]>(roots.map((r) => [r.inspection_result_id.toString(), [r]]));
    const ownerOf = new Map<string, string>(roots.map((r) => [r.inspection_result_id.toString(), r.inspection_result_id.toString()]));
    let frontier = roots.map((r) => r.inspection_result_id);

    // ⭐ #298 m-6 — 옛 깊이 상한 20 은 «조용히» 잘랐다(경고·로그·표식 0). 상한을 없앤다:
    // `previous_result_id` 는 칸 하나라 부모가 최대 하나이고, 뿌리는 그 칸이 NULL 인 행이다.
    // ⇒ 뿌리에서 내려가는 그래프는 «숲»이라 같은 행을 두 번 밟지 않고 반드시 끝난다. 순환은
    // 만들 수 있어도(사슬 안에서 서로를 가리키는 두 행) 그 순환에는 뿌리가 없어 **여기서 도달
    // 불가**다 — 상한이 막던 것은 무한 루프가 아니라 «긴 재검 사슬»뿐이었다.
    while (frontier.length > 0) {
      const children = await this.prisma.inspection_result.findMany({ where: { previous_result_id: { in: frontier } }, orderBy: { inspection_round: 'asc' }, include: INSPECTION_RESULT_JOIN });
      if (children.length === 0) break;
      frontier = [];
      for (const child of children) {
        const parentKey = child.previous_result_id?.toString(); // in 절이 null 은 안 돌려주지만 타입은 방어적으로 본다
        const ownerKey = parentKey === undefined ? undefined : ownerOf.get(parentKey);
        const bucket = ownerKey === undefined ? undefined : chains.get(ownerKey);
        if (ownerKey === undefined || bucket === undefined) continue; // 방어적 — 프론티어 밖 값은 안 온다
        bucket.push(child);
        ownerOf.set(child.inspection_result_id.toString(), ownerKey);
        frontier.push(child.inspection_result_id);
      }
    }
    // ⭐ 리뷰 m-7 — BFS 는 «깊이» 순이지 «회차» 순이 아니다. 한 부모에 자식이 둘(분기)이면
    // 얕은 형제가 깊은 조카보다 회차가 커도 먼저 담긴다(예: root1→A2→B5 형제, A→C3 자식이면
    // [1,2,5,3]으로 담긴다). §4-2 「사슬 안은 회차 순」을 지키려면 다 모은 뒤 정렬해야 한다.
    for (const bucket of chains.values()) bucket.sort((a, b) => a.inspection_round - b.inspection_round);
    return chains;
  }

  /** `finalRoundOnly=true` — 의뢰별 최대 회차 1건씩(§4-2 의 그룹 정의 그대로 · #298 m-3). */
  private async listFinalRoundOnly(
    where: Prisma.inspection_resultWhereInput,
    orderBy: Prisma.inspection_resultOrderByWithRelationInput[],
    page: PageRequest,
  ): Promise<PagedResponse<InspectionResultView>> {
    const finalIds = finalRoundOf(await this.prisma.inspection_result.findMany({ where, select: FINAL_ROUND_SELECT })).map(
      (row) => row.inspection_result_id,
    );
    const meta = { page: page.page, size: page.size, total: finalIds.length };
    if (finalIds.length === 0) return { items: [], page: meta };

    const rows = await this.prisma.inspection_result.findMany({ where: { inspection_result_id: { in: finalIds } }, orderBy, skip: page.skip, take: page.take, include: INSPECTION_RESULT_JOIN });
    return { items: rows.map(inspectionResultView), page: meta };
  }
}

/** 최종 회차를 접는 데 필요한 칸 셋. 뷰 조인 없이 좁게 읽어야 스코프가 넓어도 견딘다. */
export const FINAL_ROUND_SELECT = { inspection_result_id: true, inspection_request_id: true, inspection_round: true } as const;

/** 목록·집계 3건이 **같은 필터 축**(§1-2)을 쓴다 — 두 벌로 짜면 조용히 갈린다. */
export function buildInspectionResultWhere(
  query: InspectionResultListQuery,
  calibrationScope: Prisma.inspection_resultWhereInput = {},
): Prisma.inspection_resultWhereInput {
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
    ...calibrationScope,
  };
}

/** §2-3 판정 — ⓑ W/O 축을 먼저, 비면 ⓐ 기준 축. 둘 다 없으면 이 필터는 아무 행도 안 잡는다. */
function processWhere(processId: number | undefined): Prisma.inspection_requestWhereInput {
  if (processId === undefined) return {};
  return {
    OR: [{ work_order: { routing_operation: { process_id: processId } } }, { inspection_plan_version: { inspection_plan: { process_id: processId } } }],
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
