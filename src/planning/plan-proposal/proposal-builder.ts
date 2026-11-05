import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';
import { checkCalibration, checkDoubleBooked, checkMoldLife, utcToday } from '../../production/work-order/validation';
import { defaultBomOf } from '../production-plan/master-choice';
import { PlanWindow, dayStartOf, dayWindow, localDate, timeOfColumn } from '../production-plan/plan-window';
import { PlanQuantities, isPlanCancelled, planQuantities, sumPlanQty } from '../production-plan/plan-quantity';
import { OperationNeed, assignResources, pairKey } from '../production-plan/resource-assign';
import {
  ProposalIssue,
  ProposalKind,
  ProposalReason,
  ProposalStatus,
  basisHash,
  blockIssue,
  draftPlanKey,
  masterIssue,
  newPlanKey,
  plansToPropose,
  proposedPlanDate,
  reasonsOf,
  statusOf,
  warnIssue,
} from './proposal-policy';
import { LineRow, OperationRow, OrderRow, PlanRow, ProposalFacts, routingFor } from './proposal-reader';

export interface ProposalWorkOrder {
  operation: OperationRow;
  predecessors: { routingOperationId: bigint; dependencyTypeCode: string }[];
  proposedQty: Prisma.Decimal;
  window: PlanWindow;
  productionLineId: bigint | null;
  equipmentId: bigint | null;
  moldId: bigint | null;
  defaultWipLocationId: bigint | null;
  defaultFgLocationId: bigint | null;
  defaultScrapLocationId: bigint | null;
  issues: ProposalIssue[];
}

export interface ProposalPlan {
  key: string;
  source: 'NEW' | 'EXISTING_DRAFT';
  saved?: PlanRow;
  planDate: string;
  proposedQty: Prisma.Decimal;
  uomId: bigint;
  bom: { id: bigint; code: string; version: number };
  routing: { id: bigint; code: string; version: number };
  plannedLineId: bigint | null;
  workOrders: ProposalWorkOrder[];
  issues: ProposalIssue[];
}

export interface ProposalBasis {
  productionOrder: string;
  plans: string;
  bom: string;
  routing: string;
  resources: string;
}

export interface Proposal {
  order: OrderRow;
  kind: ProposalKind;
  status: ProposalStatus;
  reasons: ProposalReason[];
  quantities: PlanQuantities;
  plans: ProposalPlan[];
  issues: ProposalIssue[];
  basis: ProposalBasis;
}

const CONFIRMED = 'CONFIRMED';
const CANCELLED = 'CANCELLED';

/** 읽은 사실에서 ERP W/O 마다 제안을 만든다 — 쓰지 않는다. `now` 는 계획일·교정 기한의 「오늘」이다. */
export function buildProposals(facts: ProposalFacts, now: Date): Map<bigint, Proposal> {
  return new Map(facts.orders.map((order) => [order.production_order_id, buildOne(facts, order, now)]));
}

function buildOne(facts: ProposalFacts, order: OrderRow, now: Date): Proposal {
  const saved = facts.plans.get(order.production_order_id) ?? [];
  const qtyFacts = saved.map((plan) => ({
    plan,
    confirmed: plan.status_code === CONFIRMED,
    cancelled: isPlanCancelled(plan.work_order.map((workOrder) => workOrder.status_code)),
    plannedQty: plan.planned_qty,
  }));
  const { confirmedQty, draftQty } = sumPlanQty(qtyFacts);
  const quantities = planQuantities(order.order_qty, confirmedQty, draftQty);
  const basis = basisOf(facts, order, saved);
  const result = (kind: ProposalKind, plans: ProposalPlan[], issues: ProposalIssue[]): Proposal => {
    const reasons = reasonsOf([...issues, ...plans.flatMap((plan) => [...plan.issues, ...plan.workOrders.flatMap((workOrder) => workOrder.issues)])]);
    return { order, kind, status: statusOf(kind, order.status_code === CANCELLED, reasons), reasons, quantities, plans, issues, basis };
  };

  if (order.status_code === CANCELLED) {
    return result('NOT_PROPOSABLE', [], [blockIssue('ORDER_CANCELLED', '취소된 ERP W/O 는 계획하지 않습니다.')]);
  }
  if (confirmedQty.gte(order.order_qty)) return result('KEEP_CONFIRMED', [], []);

  const choice = plansToPropose(qtyFacts.filter((fact) => !fact.confirmed).map((fact) => fact.plan), order.order_qty, confirmedQty);
  const bomRows = facts.boms.get(order.item_id) ?? [];
  const bomId = defaultBomOf(bomRows.map((bom) => bom.bom_id));
  const masterIssues: ProposalIssue[] = bomId === null ? [masterIssue('BOM_DEFAULT_REQUIRED')] : [];
  const today = localDate(now, order.plant.timezone_code);
  const targets = choice.kind === 'NEW_PLAN'
    ? [{ key: newPlanKey(0), saved: undefined, planDate: proposedPlanDate(toDateString(order.planned_start_date), today), qty: choice.qty, lineId: null }]
    : choice.drafts.map((plan) => ({ key: draftPlanKey(plan.production_plan_id), saved: plan, planDate: toDateString(plan.plan_date) as string, qty: plan.planned_qty, lineId: plan.planned_line_id }));

  const routed = targets.map((target) => ({ target, routing: routingFor(facts, order.item_id, target.saved?.routing_id ?? null) }));
  for (const { routing } of routed) {
    if (routing.reason !== undefined) masterIssues.push(masterIssue(routing.reason));
    else if ((facts.operations.get(routing.routingId as bigint) ?? []).length === 0) {
      masterIssues.push(blockIssue('ROUTING_OPERATION_REQUIRED', '고른 Routing 에 공정이 한 줄도 없습니다. 기준정보에서 공정을 등록하세요.'));
    }
  }
  if (masterIssues.length > 0) return result('NOT_PROPOSABLE', [], dedupe(masterIssues));

  const bom = bomRows[0];
  const plans = routed.map(({ target, routing }): ProposalPlan => {
    const routingRow = facts.routings.get(routing.routingId as bigint);
    const workOrders = workOrdersOf(facts, order, routing.routingId as bigint, target.planDate, target.qty, target.lineId, now);
    const issues = quantities.remainingQty.lt(0)
      ? [blockIssue('PLAN_QTY_EXCEEDS_ORDER', `작성중 계획을 더하면 ERP W/O 수량을 넘습니다 — 잔량 ${quantities.remainingQty.toString()}. 계획 수량을 줄이세요.`, 'plannedQty')]
      : [];
    return {
      key: target.key,
      source: target.saved === undefined ? 'NEW' : 'EXISTING_DRAFT',
      ...(target.saved === undefined ? {} : { saved: target.saved }),
      planDate: target.planDate,
      proposedQty: target.qty,
      uomId: order.uom_id,
      bom: { id: bom.bom_id, code: bom.bom_code, version: bom.bom_version },
      routing: { id: routing.routingId as bigint, code: routingRow?.routing_code ?? '', version: routingRow?.routing_version ?? 0 },
      plannedLineId: target.lineId,
      workOrders,
      issues,
    };
  });
  return result(choice.kind, plans, []);
}

/** 공정마다 W/O 제안 — 라인·설비·금형은 확정 전개(`expand.ts`)와 같은 배정, 창은 근무일 하루(교대는 제안하지 않는다). */
function workOrdersOf(
  facts: ProposalFacts,
  order: OrderRow,
  routingId: bigint,
  planDate: string,
  qty: Prisma.Decimal,
  planLineId: bigint | null,
  now: Date,
): ProposalWorkOrder[] {
  const operations = facts.operations.get(routingId) ?? [];
  const needs: OperationNeed[] = operations.map((operation) => ({
    routingOperationId: operation.routing_operation_id,
    processId: operation.process_id,
    equipmentRequired: operation.equipment_required,
    moldRequired: operation.mold_required,
  }));
  const maps = (facts.maps.get(pairKey(order.plant_id, order.item_id)) ?? []).map((row) => row.map);
  const resources = assignResources(needs, maps);
  const activeStarts = (facts.shifts.get(order.plant_id) ?? []).filter((shift) => shift.is_active).map((shift) => timeOfColumn(shift.start_time));
  const window = dayWindow(planDate, dayStartOf(activeStarts), order.plant.timezone_code);
  const dependencies = facts.dependencies.get(routingId) ?? [];
  const today = utcToday(now);

  return operations.map((operation) => {
    const resource = resources.get(operation.routing_operation_id);
    const lineId = planLineId ?? resource?.equipmentLineId ?? null;
    const line = lineId === null ? undefined : facts.lines.get(lineId);
    const equipmentIds = resource?.equipmentId == null ? [] : [resource.equipmentId];
    const moldIds = resource?.moldId == null ? [] : [resource.moldId];
    const findings = [
      ...checkCalibration(equipmentIds, facts.equipments, today),
      ...checkMoldLife(moldIds, facts.molds),
      ...checkDoubleBooked(equipmentIds, { planned_start_at: window.plannedStartAt, planned_end_at: window.plannedEndAt }, facts.rivals),
    ];
    return {
      operation,
      predecessors: dependencies
        .filter((dependency) => dependency.successor_operation_id === operation.routing_operation_id)
        .map((dependency) => ({ routingOperationId: dependency.predecessor_operation_id, dependencyTypeCode: dependency.dependency_type_code })),
      proposedQty: qty,
      window,
      productionLineId: lineId,
      equipmentId: resource?.equipmentId ?? null,
      moldId: resource?.moldId ?? null,
      defaultWipLocationId: line?.default_wip_location_id ?? null,
      defaultFgLocationId: line?.default_fg_location_id ?? null,
      defaultScrapLocationId: line?.default_scrap_location_id ?? null,
      issues: [...lineIssues(order, lineId, line), ...findings.map((finding) => warnIssue(finding.code, finding.message, finding.field))],
    };
  });
}

/** 배포 전제 검사(`release-plan.ts`)와 목록 판정이 막는 것과 같다 — 라인 없음 · 다른 공장 라인 · 기본 위치 빔. */
function lineIssues(order: OrderRow, lineId: bigint | null, line: LineRow | undefined): ProposalIssue[] {
  if (lineId === null || line === undefined) {
    return [blockIssue('WORK_ORDER_LINE_REQUIRED', '생산 라인이 정해지지 않습니다. 라인을 고르세요.', 'productionLineId')];
  }
  const issues: ProposalIssue[] = [];
  if (line.plant_id !== order.plant_id || !line.is_active) {
    issues.push(blockIssue('LINE_PLANT_MISMATCH', '이 ERP W/O 공장의 사용 중인 라인이 아닙니다. 라인을 다시 고르세요.', 'productionLineId'));
  }
  const locations: [string, bigint | null][] = [
    ['defaultWipLocationId', line.default_wip_location_id],
    ['defaultFgLocationId', line.default_fg_location_id],
    ['defaultScrapLocationId', line.default_scrap_location_id],
  ];
  for (const [field, value] of locations) {
    if (value === null) issues.push(blockIssue('WORK_ORDER_LOCATION_REQUIRED', '라인에 기본 위치가 없습니다. 위치를 고르세요.', field));
  }
  return issues;
}

/**
 * 변경 감지 값. 판(`version_no`)을 올리지 않는 칸도 잡게 기준의 «내용»을 해시한다. 다른 W/O 의 배정처럼 수시로 바뀌는 것은 넣지 않는다.
 * ⛔ 작성중 계획의 판은 반드시 넣는다 — 확정이 If-Match 없이 이 값으로 저장 충돌을 막는다.
 */
function basisOf(facts: ProposalFacts, order: OrderRow, saved: readonly PlanRow[]): ProposalBasis {
  const routings = facts.usableRoutings.get(order.item_id) ?? [];
  const routingIds = new Set([...routings.map((row) => row.routing_id), ...saved.filter((plan) => plan.status_code !== CONFIRMED).map((plan) => plan.routing_id)]);
  const maps = facts.maps.get(pairKey(order.plant_id, order.item_id)) ?? [];
  const equipmentIds = new Set(maps.map((row) => row.map.equipmentId).filter((id) => id !== null));
  const lineIds = new Set([
    ...saved.filter((plan) => plan.status_code !== CONFIRMED).map((plan) => plan.planned_line_id),
    ...maps.map((row) => row.map.equipmentLineId),
  ].filter((id) => id !== null));
  return {
    productionOrder: basisHash([order.version_no, order.order_qty, order.status_code, order.plant_id, order.item_id, order.uom_id, order.planned_start_date]),
    plans: basisHash(saved.map((plan) => [plan.production_plan_id, plan.version_no, plan.status_code, plan.work_order.map((workOrder) => workOrder.status_code)])),
    bom: basisHash((facts.boms.get(order.item_id) ?? []).map((bom) => [bom.bom_id, bom.bom_version, bom.version_no])),
    routing: basisHash([
      routings.map((row) => [row.routing_id, row.is_default, row.status_code, row.effective_from, row.effective_to, row.version_no]),
      [...routingIds].sort(compare).map((id) => [
        id,
        (facts.operations.get(id) ?? []).map((row) => [row.routing_operation_id, row.operation_seq, row.process_id, row.equipment_required, row.mold_required, row.version_no]),
        (facts.dependencies.get(id) ?? []).map((row) => [row.predecessor_operation_id, row.successor_operation_id, row.dependency_type_code]),
      ]),
    ]),
    resources: basisHash([
      order.plant.timezone_code,
      maps.map((row) => [row.item_resource_map_id, row.version_no, row.map]),
      [...equipmentIds].sort(compare).map((id) => facts.equipments.get(id)),
      maps.map((row) => row.map.moldId).filter((id) => id !== null).sort(compare).map((id) => facts.molds.get(id)),
      [...lineIds].sort(compare).map((id) => facts.lines.get(id)),
      facts.shifts.get(order.plant_id) ?? [],
    ]),
  };
}

/** 같은 Routing 을 쓰는 작성중 계획이 여럿이면 같은 기준정보 사유가 거듭 생긴다. */
function dedupe(issues: readonly ProposalIssue[]): ProposalIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => (seen.has(issue.code) ? false : (seen.add(issue.code), true)));
}

const compare = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
