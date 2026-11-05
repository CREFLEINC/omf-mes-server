import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { dynamicShortages } from '../../core/material-issue/planned-stock';
import { zonedToUtc } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DERIVED_INCLUDE,
  DISPLAY_STATUSES,
  DerivedRow,
  DisplayStatus,
  derive,
  displayStatusWhere,
  lineDynamicShortages,
} from './material-issue-request-derived';
import {
  MaterialIssueRequestDetail,
  MaterialIssueRequestView,
  materialIssueRequestLineView,
  materialIssueRequestView,
} from './material-issue-request-view';
import { replenishmentFields, replenishmentGoodsIssues, replenishmentStatusWhere } from './replenishment-view';

export interface MaterialIssueRequestQuery {
  workOrderId?: unknown;
  statusCode?: string;
  requiredAtFrom?: string;
  requiredAtTo?: string;
  q?: string;
  page?: unknown;
  size?: unknown;
  // 피처 003 — W-02-11 출고 요청 현황.
  displayStatus?: unknown;
  issueWorkDateFrom?: string;
  issueWorkDateTo?: string;
  productionDateFrom?: string;
  productionDateTo?: string;
  plantId?: unknown;
  sourceWarehouseId?: unknown;
  productionPlanId?: unknown;
  hasShortage?: unknown;
  releaseFailed?: unknown;
  // 피처 004 — 창고 보충 요청은 W-02-12 에서만 본다. 유형을 주지 않으면 W/O 요청만(W-02-11 은 지금과 같은 목록).
  requestTypeCode?: string;
  replenishmentOriginCode?: string;
  destinationWarehouseId?: unknown;
  itemId?: unknown;
  replenishmentStatus?: unknown;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 공장을 주지 않은 생산일 조건은 현장(하노이) 날짜로 푼다 — 지금 공장은 모두 UTC+7(계약 설명). */
const SITE_TIMEZONE = 'Asia/Ho_Chi_Minh';

/**
 * 자재 출고요청 목록·상세(화면 `M-01-08`).
 * ⚠ 질의 칸의 타입은 계약 검증 가드가 이미 강제·변환했다(`contract-validator.ts`).
 */
@Injectable()
export class MaterialIssueRequestQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MaterialIssueRequestQuery): Promise<PagedResponse<MaterialIssueRequestView>> {
    const page = pageRequest({ page: int(query.page), size: int(query.size) });
    const where = await this.where(query);

    const [rows, total] = await Promise.all([
      this.prisma.material_issue_request.findMany({
        where,
        include: DERIVED_INCLUDE,
        // 계약 침묵 — PK 역순이다(§8-1 · PK 가 유일해 페이지 경계가 흔들리지 않는다).
        orderBy: { material_issue_request_id: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.material_issue_request.count({ where }),
    ]);
    return pagedResponse(await this.views(rows), total, page);
  }

  /** 행마다 파생 값과 창고 보충 칸(피처 004) — 동적 부족·출고 전표는 한 쪽을 한 번에 읽는다. */
  private async views(rows: DerivedRow[]): Promise<MaterialIssueRequestView[]> {
    const dynamic = await lineDynamicShortages(this.prisma, rows);
    const issues = await replenishmentGoodsIssues(this.prisma, replenishmentIds(rows));
    return rows.map((row) => ({
      ...materialIssueRequestView(row, derive(row, dynamic)),
      ...replenishmentFields(row, issues.get(row.material_issue_request_id), false),
    }));
  }

  private async where(query: MaterialIssueRequestQuery): Promise<Prisma.material_issue_requestWhereInput> {
    const workOrderId = int(query.workOrderId);
    const plantId = int(query.plantId);
    const sourceWarehouseId = int(query.sourceWarehouseId);
    const productionPlanId = int(query.productionPlanId);
    const destinationWarehouseId = int(query.destinationWarehouseId);
    const itemId = int(query.itemId);
    const and: Prisma.material_issue_requestWhereInput[] = [];
    const replenishmentStatus = replenishmentStatusWhere(query.replenishmentStatus);
    if (replenishmentStatus !== undefined) and.push(replenishmentStatus);
    // 공장 = 출발 창고의 공장. 출발 창고가 없는 옛 요청만 W/O 공장으로 거른다(피처 004 research R-2).
    if (plantId !== undefined) {
      and.push({
        OR: [
          { source_warehouse: { plant_id: plantId } },
          { source_warehouse_id: null, work_order: { production_plan: { production_order: { plant_id: plantId } } } },
        ],
      });
    }
    const statuses = displayStatuses(query.displayStatus);
    if (statuses.length > 0) and.push(displayStatusWhere(statuses));
    if (bool(query.releaseFailed)) and.push({ status_code: 'WAITING', release_error_text: { not: null } });
    if (bool(query.hasShortage)) {
      const ids = (await dynamicShortages(this.prisma, plantId === undefined ? {} : { plantId: BigInt(plantId) }))
        .flatMap((s) => s.lines.map((line) => line.requestId));
      and.push({ OR: [{ material_issue_request_line: { some: { shortage_qty: { gt: 0 } } } }, { material_issue_request_id: { in: ids } }] });
    }
    const workOrder: Prisma.work_orderWhereInput = {
      ...(productionPlanId === undefined ? {} : { production_plan_id: productionPlanId }),
      ...(await this.productionDateWhere(query, plantId)),
    };
    return {
      request_type_code: query.requestTypeCode ?? 'WORK_ORDER',
      ...(query.replenishmentOriginCode === undefined ? {} : { replenishment_origin_code: query.replenishmentOriginCode }),
      ...(destinationWarehouseId === undefined ? {} : { location: { warehouse_id: destinationWarehouseId } }),
      ...(itemId === undefined ? {} : { material_issue_request_line: { some: { item_id: itemId } } }),
      ...(workOrderId === undefined ? {} : { work_order_id: workOrderId }),
      // ⛔ 4값 대조를 걸지 않는다 — 필터에 값 목록을 걸면 값이 늘 때 조회가 400 을 낸다(§8-2).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...requiredAtWhere(query.requiredAtFrom, query.requiredAtTo),
      ...(query.q === undefined
        ? {}
        : { issue_request_no: { contains: query.q, mode: 'insensitive' } }),
      ...(sourceWarehouseId === undefined ? {} : { source_warehouse_id: sourceWarehouseId }),
      ...dateRange('issue_work_date', query.issueWorkDateFrom, query.issueWorkDateTo),
      ...(Object.keys(workOrder).length === 0 ? {} : { work_order: workOrder }),
      ...(and.length === 0 ? {} : { AND: and }),
    };
  }

  /** 생산일 = W/O 계획 시작의 공장 현지 날짜 — 그 날의 현지 00:00 ~ 다음 날 00:00 순간 구간으로 바꾼다(캐스팅 없이). */
  private async productionDateWhere(query: MaterialIssueRequestQuery, plantId: number | undefined): Promise<Prisma.work_orderWhereInput> {
    if (query.productionDateFrom === undefined && query.productionDateTo === undefined) return {};
    const plant = plantId === undefined ? null : await this.prisma.plant.findUnique({ where: { plant_id: plantId }, select: { timezone_code: true } });
    const timezone = plant?.timezone_code ?? SITE_TIMEZONE;
    const next = (date: string) => new Date(new Date(`${date}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
    return {
      planned_start_at: {
        ...(query.productionDateFrom === undefined ? {} : { gte: zonedToUtc(query.productionDateFrom, '00:00:00', timezone) }),
        ...(query.productionDateTo === undefined ? {} : { lt: zonedToUtc(next(query.productionDateTo), '00:00:00', timezone) }),
      },
    };
  }

  /** 발행 응답의 `requests` — 만든 요청들을 목록과 같은 모양으로(한 질의). */
  async headers(ids: number[]): Promise<MaterialIssueRequestView[]> {
    const rows = await this.prisma.material_issue_request.findMany({
      where: { material_issue_request_id: { in: ids } },
      include: DERIVED_INCLUDE,
      orderBy: { material_issue_request_id: 'asc' },
    });
    return this.views(rows);
  }

  /** 없으면 404 다(계약 선언 · 출고 상세 선례). */
  async get(materialIssueRequestId: number): Promise<MaterialIssueRequestDetail> {
    const row = await this.prisma.material_issue_request.findUnique({
      where: { material_issue_request_id: materialIssueRequestId },
      include: DERIVED_INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 출고 요청입니다.');
    const lines = await this.prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: materialIssueRequestId },
      orderBy: { line_no: 'asc' },
    });
    const derived = derive(row, await lineDynamicShortages(this.prisma, [row]));
    const issues = await replenishmentGoodsIssues(this.prisma, replenishmentIds([row]));
    return {
      materialIssueRequest: { ...materialIssueRequestView(row, derived), ...replenishmentFields(row, issues.get(row.material_issue_request_id), true) },
      lines: lines.map((line) => materialIssueRequestLineView(line, derived.lines.get(line.material_issue_request_line_id))),
    };
  }
}

/** `required_at` 도 질의도 `date-time` 이다 — 하루 경계를 풀 공장 축이 없으니 받은 시각을
 *  그대로 쓴다(CLAUDE.md 날짜 타임존 캐스팅 금지). */
function requiredAtWhere(from?: string, to?: string): Prisma.material_issue_requestWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    required_at: {
      ...(from === undefined ? {} : { gte: new Date(from) }),
      ...(to === undefined ? {} : { lte: new Date(to) }),
    },
  };
}

function int(value: unknown): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}

function dateRange(column: 'issue_work_date', from?: string, to?: string): Prisma.material_issue_requestWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    [column]: {
      ...(from === undefined ? {} : { gte: new Date(`${from}T00:00:00Z`) }),
      ...(to === undefined ? {} : { lte: new Date(`${to}T00:00:00Z`) }),
    },
  };
}

/** 계약은 쉼표로 이은 배열이다 — 가드가 배열로 바꿔 두지만 문자열로 와도 받는다. */
function displayStatuses(value: unknown): DisplayStatus[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const unknown = raw.filter((code) => !(DISPLAY_STATUSES as readonly string[]).includes(String(code)));
  if (unknown.length > 0) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [field('displayStatus', ERROR_CODE.INVALID, `표시 상태는 ${DISPLAY_STATUSES.join(' · ')} 중에서 고릅니다.`)]);
  }
  return raw as DisplayStatus[];
}

function replenishmentIds(rows: readonly DerivedRow[]): bigint[] {
  return rows.filter((row) => row.request_type_code === 'REPLENISHMENT').map((row) => row.material_issue_request_id);
}

function bool(value: unknown): boolean {
  return value === true || value === 'true';
}
