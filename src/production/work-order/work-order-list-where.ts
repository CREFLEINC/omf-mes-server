import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';

/** 질의 23건 중 20건 → Prisma where(순수 함수). `releasable`ⓒ 는 DB 호출이 필요해 서비스가 좁힌다(§7-5). */
export interface WorkOrderListQuery {
  productionOrderId?: number;
  productionPlanId?: number;
  statusCode?: string;
  released?: boolean;
  held?: boolean;
  open?: boolean;
  releasable?: boolean;
  poMismatch?: boolean;
  successorOfWorkOrderId?: number;
  processId?: number;
  productionLineId?: number;
  plannedEquipmentId?: number;
  workOrderTypeCode?: string;
  plannedStartFrom?: string;
  plannedStartTo?: string;
  q?: string;
  sort?: string;
  withProgress?: boolean;
  page?: number;
  size?: number;
  withPreIssuedLots?: boolean;
  withSummary?: boolean;
  withValidation?: boolean;
}

/** `releasable` ⓐⓑ+유형 — ⓒ(4M 점검 BLOCK 0)만 DB 호출이 필요해 서비스가 후보를 좁힌다. */
export const RELEASABLE_ELIGIBLE_WHERE: Prisma.work_orderWhereInput = {
  released_at: null,
  work_order_resource_assignment: { some: {} },
  // ⭐ 계약 ⌜긴급 W/O 는 이 목록에 넣지 않는다⌝ — releasable=true·false 모두에서 뺀다.
  work_order_type_code: { not: 'EMERGENCY' },
};

/** `open` — 취소는 시각 칸이 없어 상태로 보탠다(§1-2 ⓐ #6). false 는 이 조건 전체의 부정이다. */
const OPEN_CONDITION: Prisma.work_orderWhereInput = {
  released_at: { not: null },
  completed_at: null,
  closed_at: null,
  NOT: { status_code: 'CANCELLED' },
};

/** 정렬 허용 키 넷 — 그 밖은 400 `INVALID`(공유계약 L-4). */
const SORT_FIELDS: Record<string, keyof Prisma.work_orderOrderByWithRelationInput> = {
  priorityNo: 'priority_no',
  plannedStartAt: 'planned_start_at',
  workOrderNo: 'work_order_no',
  statusCode: 'status_code',
};

/** `releasable` 자신은 뺀 나머지 전부 — 서비스가 후보 집합을 좁힌 뒤 `work_order_id` 필터를 얹는다. */
export function buildWorkOrderWhere(query: WorkOrderListQuery): Prisma.work_orderWhereInput {
  const clauses: Prisma.work_orderWhereInput[] = [
    eq('production_plan_id', query.productionPlanId),
    // ⚠ 직접 칸이 없다 — 계획을 경유해 잇는다(계약 ⌜서버가 계획을 경유해 잇는다⌝).
    query.productionOrderId === undefined ? {} : { production_plan: { production_order_id: query.productionOrderId } },
    eq('status_code', query.statusCode),
    // `false` 도 «비어 있다»의 여집합이다 — 미지정과 다르다.
    query.released === undefined ? {} : { released_at: query.released ? { not: null } : null },
    // ⛔ 중단 구간을 담을 표가 없어 상태 문자열로 근사한다 — 설계 미정(문의 035 · R-19).
    query.held === undefined ? {} : { status_code: query.held ? 'SUSPENDED' : { not: 'SUSPENDED' } },
    query.open === undefined ? {} : query.open ? OPEN_CONDITION : { NOT: OPEN_CONDITION },
    eq('po_mismatch', query.poMismatch),
    // `predecessor_work_order_id = value` 인 의존 행을 가진(=이 W/O 가 그 후속인) 것만.
    query.successorOfWorkOrderId === undefined
      ? {}
      : {
          work_order_dependency_work_order_dependency_successor_work_order_idTowork_order: {
            some: { predecessor_work_order_id: query.successorOfWorkOrderId },
          },
        },
    // ⚠ 직접 칸이 아니다 — routingOperationId → routing_operation.process_id 1단 조인.
    query.processId === undefined ? {} : { routing_operation: { process_id: query.processId } },
    eq('production_line_id', query.productionLineId),
    eq('planned_equipment_id', query.plannedEquipmentId),
    eq('work_order_type_code', query.workOrderTypeCode),
    plannedStartWhere(query.plannedStartFrom, query.plannedStartTo),
    // ⛔ P/O 번호는 이 축으로 검색되지 않는다(계약 자인) — `work_order_no` 만 본다.
    query.q === undefined ? {} : { work_order_no: { contains: query.q, mode: Prisma.QueryMode.insensitive } },
  ].filter((clause) => Object.keys(clause).length > 0);
  return clauses.length === 0 ? {} : { AND: clauses };
}

/** «계획 시작 시각» 반열림(From 이상·To 미만) — 비워도 400 이 아니다(계약 자인 · `plan.md` §5 규칙 11). */
function plannedStartWhere(from?: string, to?: string): Prisma.work_orderWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    planned_start_at: {
      ...(from === undefined ? {} : { gte: new Date(from) }),
      ...(to === undefined ? {} : { lt: new Date(to) }),
    },
  };
}

function eq(column: string, value: unknown): Prisma.work_orderWhereInput {
  return value === undefined ? {} : ({ [column]: value } as Prisma.work_orderWhereInput);
}

/** 허용 키 넷 밖·방향 밖은 400 `INVALID` 다. 동률은 PK asc 로 닫는다(I-3 `inbound-receipt-query.service.ts` 선례). */
export function buildOrderBy(sort?: string): Prisma.work_orderOrderByWithRelationInput[] {
  const [key, direction] = (sort ?? 'priorityNo,asc').split(',');
  const dbField = SORT_FIELDS[key];
  if (dbField === undefined || (direction !== undefined && direction !== 'asc' && direction !== 'desc')) {
    throw one(field('sort', ERROR_CODE.INVALID, `${Object.keys(SORT_FIELDS).join(' · ')} 중 하나이고 asc·desc 만 받는다.`));
  }
  return [{ [dbField]: direction === 'desc' ? 'desc' : 'asc' }, { work_order_id: 'asc' }];
}
