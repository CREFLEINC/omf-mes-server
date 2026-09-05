import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalRouteView, ApprovalRouteStepView, toApprovalRoute, toApprovalRouteStep } from './approval.mapper';

export interface ApprovalRouteQuery {
  approvalTypeCode?: string;
  businessUnitId?: number;
  activeOnly?: boolean;
  q?: string;
  page?: number;
  size?: number;
}

export interface ApprovalRouteResult {
  route: ApprovalRouteView;
  versionNo: number;
}

type RouteRow = Prisma.approval_routeGetPayload<object>;

/**
 * 결재선 정의 조회 3건(목록·상세·단계 목록). 화면은 `W-06-15`(결재선 정의)가 소유한다.
 *
 * ⛔ 등록·수정·단계 치환(쓰기 3건)은 이 서비스에 **덧붙는다**(뒤 PR, A6 마이그레이션과
 * 함께) — 아직 자리를 미리 비워 두지 않는다. 결재선 «선택»(우선순위·모호성 판정)은
 * 코어 `ApprovalService.selectRoute` 다 — 여기는 마스터를 읽기만 한다.
 */
@Injectable()
export class ApprovalRouteService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ApprovalRouteQuery): Promise<PagedResponse<ApprovalRouteView>> {
    const page = pageRequest(query);
    const where = this.listWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.approval_route.findMany({
        where,
        orderBy: { approval_route_id: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.approval_route.count({ where }),
    ]);
    const { stepCountByRoute, inProgressByType } = await this.loadCounts(rows);
    const items = rows.map((row) =>
      toApprovalRoute(row, {
        stepCount: stepCountByRoute.get(row.approval_route_id) ?? 0,
        inProgressCount: inProgressByType.get(row.approval_type_code) ?? 0,
      }),
    );
    return pagedResponse(items, total, page);
  }

  async get(routeId: number): Promise<ApprovalRouteResult> {
    const row = await this.loadRoute(routeId);
    const [stepCount, inProgressCount] = await Promise.all([
      this.prisma.approval_route_step.count({ where: { approval_route_id: routeId } }),
      // ⚠ 셀 연결 칸이 없다 — 유형 축 근사다(설계 미정 — 문의 018). I-1.md §2-3.
      this.prisma.approval_request.count({
        where: { approval_type_code: row.approval_type_code, status_code: 'PENDING' },
      }),
    ]);
    return { route: toApprovalRoute(row, { stepCount, inProgressCount }), versionNo: row.version_no };
  }

  async listSteps(routeId: number): Promise<ApprovalRouteStepView[]> {
    await this.loadRoute(routeId);
    return this.loadStepViews(routeId);
  }

  private listWhere(query: ApprovalRouteQuery): Prisma.approval_routeWhereInput {
    const conditions: Prisma.approval_routeWhereInput[] = [];
    if (query.approvalTypeCode !== undefined) {
      conditions.push({ approval_type_code: query.approvalTypeCode });
    }
    if (query.businessUnitId !== undefined) {
      conditions.push({ business_unit_id: query.businessUnitId });
    }
    if (query.activeOnly) conditions.push({ is_active: true });
    // 「승인 유형 검색」(계약) — 표시명 원천이 없어 유형 코드로 찾는다(설계 미정 — 문의 021).
    if (query.q) {
      conditions.push({ approval_type_code: { contains: query.q, mode: 'insensitive' } });
    }
    return conditions.length > 0 ? { AND: conditions } : {};
  }

  /** `stepCount`·`inProgressCount` 는 파생 — 목록 한 쪽마다 한 번씩 묶어 센다(N+1 회피). */
  private async loadCounts(
    rows: RouteRow[],
  ): Promise<{ stepCountByRoute: Map<bigint, number>; inProgressByType: Map<string, number> }> {
    if (rows.length === 0) return { stepCountByRoute: new Map(), inProgressByType: new Map() };

    const routeIds = rows.map((row) => row.approval_route_id);
    const types = [...new Set(rows.map((row) => row.approval_type_code))];
    const [stepGroups, requestGroups] = await Promise.all([
      this.prisma.approval_route_step.groupBy({
        by: ['approval_route_id'],
        where: { approval_route_id: { in: routeIds } },
        _count: { approval_route_step_id: true },
      }),
      // ⚠ 셀 연결 칸이 없다 — 유형 축 근사다(설계 미정 — 문의 018). I-1.md §2-3.
      this.prisma.approval_request.groupBy({
        by: ['approval_type_code'],
        where: { approval_type_code: { in: types }, status_code: 'PENDING' },
        _count: { approval_request_id: true },
      }),
    ]);
    return {
      stepCountByRoute: new Map(
        stepGroups.map((g) => [g.approval_route_id, g._count.approval_route_step_id]),
      ),
      inProgressByType: new Map(
        requestGroups.map((g) => [g.approval_type_code, g._count.approval_request_id]),
      ),
    };
  }

  private async loadStepViews(routeId: number): Promise<ApprovalRouteStepView[]> {
    const rows = await this.prisma.approval_route_step.findMany({
      where: { approval_route_id: routeId },
      orderBy: { step_no: 'asc' },
      include: { app_user: { include: { department: true } } },
    });
    return rows.map(toApprovalRouteStep);
  }

  private async loadRoute(routeId: number): Promise<RouteRow> {
    const row = await this.prisma.approval_route.findUnique({ where: { approval_route_id: routeId } });
    if (!row) throw new NotFoundException('없는 결재선입니다.');
    return row;
  }
}
