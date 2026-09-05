import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
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

export interface ApprovalRouteCreateInput {
  approvalTypeCode: string;
  businessUnitId?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
}

/** PUT — 보내지 않은 칸은 비운다(계약 `ApprovalRouteUpdate`). `approvalTypeCode`·`isActive` 는 없다. */
export interface ApprovalRouteUpdateInput {
  businessUnitId?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
}

/** 치환 요청 한 단계. `stepNo` 는 배열 순서로 다시 매기므로 안 받는다(계약). */
export interface ApprovalRouteStepInput {
  approverTypeCode: string;
  approverUserId?: number | null;
  approverRoleId?: number | null;
  approverDepartmentId?: number | null;
}

type RouteRow = Prisma.approval_routeGetPayload<object>;

/**
 * 결재선 정의 CRUD + 결재 단계 치환 + 활성 전이. 화면은 `W-06-15`(결재선 정의)가 소유한다.
 *
 * ⛔ 결재선 «선택»(우선순위·모호성 판정)은 코어 `ApprovalService.selectRoute` 다 — 여기
 * 서비스는 마스터를 고치기만 한다.
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

  /** 「같은 (approvalTypeCode, businessUnitId) 로 활성 결재선이 있으면 400」(계약). */
  async create(input: ApprovalRouteCreateInput): Promise<ApprovalRouteResult> {
    const businessUnitId = input.businessUnitId ?? null;
    assertValueRange(input);
    await this.assertActiveRouteFree(input.approvalTypeCode, businessUnitId);

    const row = await this.prisma.approval_route.create({
      data: {
        approval_type_code: input.approvalTypeCode,
        business_unit_id: businessUnitId,
        min_value: input.minValue ?? null,
        max_value: input.maxValue ?? null,
      },
    });
    return { route: toApprovalRoute(row, { stepCount: 0, inProgressCount: 0 }), versionNo: row.version_no };
  }

  /**
   * `approvalTypeCode`·`isActive` 는 본문이 받지 않는다(계약 `ApprovalRouteUpdate`).
   * PUT 이므로 보내지 않은 `businessUnitId`·`minValue`·`maxValue` 는 null 로 비운다.
   */
  async update(
    routeId: number,
    version: number,
    input: ApprovalRouteUpdateInput,
  ): Promise<ApprovalRouteResult> {
    assertValueRange(input);
    const current = await this.loadRoute(routeId);
    if (current.is_active) {
      await this.assertActiveRouteFree(current.approval_type_code, input.businessUnitId ?? null, routeId);
    }
    const updated = await this.prisma.approval_route.updateMany({
      where: { approval_route_id: routeId, version_no: version },
      data: {
        business_unit_id: input.businessUnitId ?? null,
        min_value: input.minValue ?? null,
        max_value: input.maxValue ?? null,
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(routeId, updated.count);
    return this.get(routeId);
  }

  /**
   * 「중지한 결재선을 되살린다」(계약). 검사 순서: 404 → 409(If-Match 를 업무 규칙보다
   * 먼저 본다 — 낡은 화면이 재로드부터 하게 한다. `core/approval` `decide()`·`update()`
   * 는 400 을 먼저 보는 반대 순서라 선례가 아니다) → LINE_REQUIRED(단계 0개면 되살려도
   * 상신이 거부된다) →
   * UNIQUE_VIOLATION(자기 자신은 `excludeRouteId` 로 제외 — 이미 활성인 것을 다시
   * :activate 해도 충돌하지 않는다).
   */
  async activate(routeId: number, version: number): Promise<ApprovalRouteResult> {
    const current = await this.loadRoute(routeId);
    if (current.version_no !== version) assertUpdated(0);

    const stepCount = await this.prisma.approval_route_step.count({ where: { approval_route_id: routeId } });
    if (stepCount === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.LINE_REQUIRED,
          message: '결재 단계가 없는 결재선은 다시 사용할 수 없습니다.',
        },
      ]);
    }
    const businessUnitId = current.business_unit_id === null ? null : Number(current.business_unit_id);
    await this.assertActiveRouteFree(current.approval_type_code, businessUnitId, routeId);

    const updated = await this.prisma.approval_route.updateMany({
      where: { approval_route_id: routeId, version_no: version },
      data: { is_active: true, version_no: { increment: 1 } },
    });
    assertUpdated(updated.count);
    return this.get(routeId);
  }

  /**
   * 「사용 중지」(계약) — 물리 삭제는 없다(B-4). 진행 중인 요청은 그대로 진행된다
   * (공유계약 J-9) — 거부 조건이 없다(400 갈래 없음). 이미 비활성이어도 200 이다.
   */
  async deactivate(routeId: number, version: number): Promise<ApprovalRouteResult> {
    await this.loadRoute(routeId);
    const updated = await this.prisma.approval_route.updateMany({
      where: { approval_route_id: routeId, version_no: version },
      data: { is_active: false, version_no: { increment: 1 } },
    });
    assertUpdated(updated.count);
    return this.get(routeId);
  }

  async listSteps(routeId: number): Promise<ApprovalRouteStepView[]> {
    await this.loadRoute(routeId);
    return this.loadStepViews(routeId);
  }

  /**
   * 단계 전체 치환 — 한 트랜잭션에서 삭제 후 재생성한다(계약 「행 단위 저장이 원리적으로
   * 불가능하다」 — `uq_approval_route_step` 이 중간 상태를 막는다). If-Match 토큰은
   * **부모** `approval_route.version_no` 다(`approval_route_step` 에는 없다) — 선례
   * `item-detail.service.ts withBumpedItem` 그대로.
   */
  async replaceSteps(
    routeId: number,
    version: number,
    steps: ApprovalRouteStepInput[],
  ): Promise<{ items: ApprovalRouteStepView[]; versionNo: number }> {
    this.assertSteps(steps);

    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.approval_route.updateMany({
        where: { approval_route_id: routeId, version_no: version },
        data: { version_no: { increment: 1 } },
      });
      if (bumped.count === 0) {
        const exists = await tx.approval_route.findUnique({
          where: { approval_route_id: routeId },
          select: { approval_route_id: true },
        });
        if (!exists) throw new NotFoundException('없는 결재선입니다.');
        assertUpdated(0);
      }

      await tx.approval_route_step.deleteMany({ where: { approval_route_id: routeId } });
      if (steps.length > 0) {
        await tx.approval_route_step.createMany({
          data: steps.map((step, index) => ({
            approval_route_id: routeId,
            step_no: index + 1,
            approver_type_code: step.approverTypeCode,
            approver_user_id: step.approverUserId ?? null,
            // 1차는 USER 전용이라 나머지 두 칸은 담지 않는다 — `ck_approval_route_step_target`
            // 이 셋 중 하나만 허용하므로 함께 오면 CHECK 위반(500)이 된다.
            approver_role_id: null,
            approver_department_id: null,
          })),
        });
      }
    });

    return { items: await this.loadStepViews(routeId), versionNo: version + 1 };
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

  /** 1차는 `USER` 만 지원한다(계약). 유형과 `approverUserId` 의 짝만 여기서 본다. */
  private assertSteps(steps: ApprovalRouteStepInput[]): void {
    const errors: ErrorItem[] = [];
    steps.forEach((step, index) => {
      if (step.approverTypeCode !== 'USER') {
        errors.push({
          scope: 'field',
          field: `steps[${index}].approverTypeCode`,
          code: ERROR_CODE.APPROVER_TYPE_NOT_SUPPORTED,
          message: 'USER 외의 결재자 유형은 1차 범위에서 지원하지 않습니다.',
        });
        return;
      }
      if (step.approverUserId == null) {
        errors.push({
          scope: 'field',
          field: `steps[${index}].approverUserId`,
          code: ERROR_CODE.REQUIRED,
          message: 'approverTypeCode=USER 는 approverUserId 가 필요합니다.',
        });
      }
    });
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  /**
   * `selectRoute`(코어)의 선택 규칙(지정본이 공통본을 이긴다)과 다르다 — 여기는 등록이
   * 막을 «엄격 일치» 판이다(같은 사업부 축에 이미 활성이 있는지만 본다, I-1.md §3-5).
   * `uq_approval_route_active` 는 그물이다.
   */
  private async assertActiveRouteFree(
    approvalTypeCode: string,
    businessUnitId: number | null,
    excludeRouteId?: number,
  ): Promise<void> {
    const clash = await this.prisma.approval_route.findFirst({
      where: {
        approval_type_code: approvalTypeCode,
        business_unit_id: businessUnitId,
        is_active: true,
        ...(excludeRouteId === undefined ? {} : { NOT: { approval_route_id: excludeRouteId } }),
      },
      select: { approval_route_id: true },
    });
    if (!clash) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'approvalTypeCode',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['approvalTypeCode', 'businessUnitId'],
        message: '같은 승인 유형·사업부로 이미 활성인 결재선이 있습니다.',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(routeId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.approval_route.findUnique({
      where: { approval_route_id: routeId },
      select: { approval_route_id: true },
    });
    if (!exists) throw new NotFoundException('없는 결재선입니다.');
    assertUpdated(0);
  }
}

/** `ck_approval_route_range` — 둘 다 있을 때만 max >= min. CHECK 위반은 500 이라 먼저 막는다. */
function assertValueRange(input: { minValue?: number | null; maxValue?: number | null }): void {
  if (input.minValue == null || input.maxValue == null || input.maxValue >= input.minValue) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field: 'maxValue', code: ERROR_CODE.PAIR, message: '상한은 하한보다 작을 수 없습니다.' },
  ]);
}
