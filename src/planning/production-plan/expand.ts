import { Prisma } from '@prisma/client';

import { WORK_ORDER_DEFAULT_PRIORITY, WORK_ORDER_DEFAULT_TYPE, WORK_ORDER_INITIAL_STATUS } from '../../core/work-order';
import { PlanWindow } from './plan-window';

/** 트랜잭션을 열기 «전»에 읽어 둔 전개 재료(§3-1 ①~③). */
export interface PlanToExpand {
  productionPlanId: number;
  statusCode: string;
  itemId: bigint;
  plannedQty: Prisma.Decimal;
  uomId: bigint;
  operationIds: bigint[];
  /** 계획일의 근무일 하루 — 전개분 전부가 같은 창을 갖는다. */
  window: PlanWindow;
  /** 계획의 라인과 그 라인의 기본 위치 셋. 계획에 라인이 없으면 넷 다 비운다. */
  line: PlanLine;
  dependencies: { predecessor_operation_id: bigint; successor_operation_id: bigint; dependency_type_code: string }[];
}

export interface PlanLine {
  productionLineId: bigint | null;
  defaultWipLocationId: bigint | null;
  defaultFgLocationId: bigint | null;
  defaultScrapLocationId: bigint | null;
}

/** 마스터(`routing_operation_dependency`)에 칸이 없다 — 기본값을 명시한다(§3-4). */
const REQUIRED_QTY_RULE = 'AVAILABLE_GOOD_QTY';

/**
 * 공정 N → W/O N 벌. 라인·기본 위치 셋은 계획의 라인과 그 라인 기본값으로 미리 채운다 — 계약은
 * 「생성 후 `W-02-03`·`W-02-04` 의 PUT 으로 채운다」였다(R-5 · 장부 P-40). 비어 있으면 4M 에서 고른다.
 * `operation_settings_snapshot` 은 안 쓴다 — `:release` 가 뜬다(I-6).
 */
export function workOrderRows(plan: PlanToExpand, workOrderNos: string[], appUserId: number | undefined): Prisma.work_orderCreateManyInput[] {
  return plan.operationIds.map((routingOperationId, index) => ({
    work_order_no: workOrderNos[index],
    production_plan_id: BigInt(plan.productionPlanId),
    routing_operation_id: routingOperationId,
    item_id: plan.itemId,
    order_qty: plan.plannedQty,
    uom_id: plan.uomId,
    planned_start_at: plan.window.plannedStartAt,
    planned_end_at: plan.window.plannedEndAt,
    production_line_id: plan.line.productionLineId,
    default_wip_location_id: plan.line.defaultWipLocationId,
    default_fg_location_id: plan.line.defaultFgLocationId,
    default_scrap_location_id: plan.line.defaultScrapLocationId,
    work_order_type_code: WORK_ORDER_DEFAULT_TYPE,
    priority_no: WORK_ORDER_DEFAULT_PRIORITY,
    status_code: WORK_ORDER_INITIAL_STATUS,
    created_by: appUserId ?? null,
    updated_by: appUserId ?? null,
  }));
}

/**
 * 공정 의존 M 쌍을 W/O 의존으로 옮긴다. ⛔ `createManyAndReturn` 의 반환 «순서»에 기대지
 * 않는다 — 공정 id 로 짝짓는다(R-7 · 한 확정에 공정 id 는 유일하다).
 */
export function dependencyRows(plan: PlanToExpand, workOrderIdOf: Map<bigint, bigint>, appUserId: number | undefined): Prisma.work_order_dependencyCreateManyInput[] {
  return plan.dependencies.map((dependency) => ({
    predecessor_work_order_id: workOrderIdOf.get(dependency.predecessor_operation_id) as bigint,
    successor_work_order_id: workOrderIdOf.get(dependency.successor_operation_id) as bigint,
    dependency_type_code: dependency.dependency_type_code,
    required_qty_rule_code: REQUIRED_QTY_RULE,
    created_by: appUserId ?? null,
  }));
}
