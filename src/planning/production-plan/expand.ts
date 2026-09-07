import { Prisma } from '@prisma/client';

import { WORK_ORDER_DEFAULT_PRIORITY, WORK_ORDER_DEFAULT_TYPE, WORK_ORDER_INITIAL_STATUS } from '../../core/work-order';

/** 트랜잭션을 열기 «전»에 읽어 둔 전개 재료(§3-1 ①~③). */
export interface PlanToExpand {
  productionPlanId: number;
  statusCode: string;
  itemId: bigint;
  plannedQty: Prisma.Decimal;
  uomId: bigint;
  operationIds: bigint[];
  dependencies: { predecessor_operation_id: bigint; successor_operation_id: bigint; dependency_type_code: string }[];
}

/** 마스터(`routing_operation_dependency`)에 칸이 없다 — 기본값을 명시한다(§3-4). */
const REQUIRED_QTY_RULE = 'AVAILABLE_GOOD_QTY';

/**
 * 공정 N → W/O N 벌. ⛔ `production_line_id`·기본 위치 셋은 **비운다** — 계약이 「생성 후
 * `W-02-03`·`W-02-04` 의 PUT 으로 채운다」라 적었다(R-5). `operation_settings_snapshot` 도
 * 안 쓴다 — `:release` 가 뜬다(I-6).
 */
export function workOrderRows(plan: PlanToExpand, workOrderNos: string[], appUserId: number | undefined): Prisma.work_orderCreateManyInput[] {
  return plan.operationIds.map((routingOperationId, index) => ({
    work_order_no: workOrderNos[index],
    production_plan_id: BigInt(plan.productionPlanId),
    routing_operation_id: routingOperationId,
    item_id: plan.itemId,
    order_qty: plan.plannedQty,
    uom_id: plan.uomId,
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
