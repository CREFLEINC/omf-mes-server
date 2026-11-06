import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';
import { FgResolution, FgSource, fgLocationOf } from '../../core/erp-warehouse/fg-location';
import { checkCalibration, checkDoubleBooked, checkMoldLife, localToday } from '../../production/work-order/validation';
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
import { OperationRow, OrderRow, PlanRow, ProposalFacts, fgOf, routingFor } from './proposal-reader';
import { resourceFindings } from './resource-rules';

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
  /** 완제품 위치가 어디서 왔는가 — W/O 마다 다른 것은 라인 기본값뿐이라 이 칸만 W/O 에 둔다. */
  defaultFgLocationSource: FgSource;
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
  /** ERP W/O 의 입고 창고(`SL_CD`) 판정 — 공정 W/O 의 완제품 위치가 이것을 따른다. */
  fg: FgResolution;
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
    return { order, kind, status: statusOf(kind, order.status_code === CANCELLED, reasons), reasons, quantities, plans, issues, basis, fg: fgOf(facts, order) };
  };

  if (order.status_code === CANCELLED) {
    return result('NOT_PROPOSABLE', [], [blockIssue('ORDER_CANCELLED', '취소된 ERP W/O 는 계획하지 않습니다.')]);
  }
  if (confirmedQty.gte(order.order_qty)) {
    // 확정분으로 이미 채웠는데 작성중 계획이 남았다 — 확정하면 넘친다. 이 화면에서는 풀 수 없고 계획 화면에서 줄이거나 지운다.
    const leftover = qtyFacts.some((fact) => !fact.confirmed)
      ? [blockIssue('DRAFT_PLAN_EXCEEDS_ORDER', `확정 계획이 이미 ERP W/O 수량을 채웠는데 작성중 계획(${draftQty.toString()})이 남아 있습니다. 계획 화면에서 작성중 계획을 줄이거나 삭제하세요.`)]
      : [];
    return result('KEEP_CONFIRMED', [], leftover);
  }

  const choice = plansToPropose(qtyFacts.filter((fact) => !fact.confirmed).map((fact) => fact.plan), order.order_qty, confirmedQty);
  const bomRows = facts.boms.get(order.item_id) ?? [];
  const bomId = defaultBomOf(bomRows.map((bom) => bom.bom_id));
  const masterIssues: ProposalIssue[] = bomId === null ? [masterIssue('BOM_DEFAULT_REQUIRED')] : [];
  const today = localDate(now, order.plant.timezone_code);
  const targets = choice.kind === 'NEW_PLAN'
    ? [{ key: newPlanKey(0), saved: undefined, planDate: proposedPlanDate(toDateString(order.planned_start_date), today), qty: choice.qty, lineId: null }]
    // 작성중 계획의 계획일이 지났으면 오늘로 낸다 — 확정은 지난 계획일을 받지 않는다(저장값은 saved 에 남는다).
    : choice.drafts.map((plan) => ({ key: draftPlanKey(plan.production_plan_id), saved: plan, planDate: laterOf(toDateString(plan.plan_date) as string, today), qty: plan.planned_qty, lineId: plan.planned_line_id }));

  const routed = targets.map((target) => ({ target, routing: routingFor(facts, order, target.saved?.routing_id ?? null) }));
  for (const { routing } of routed) {
    if (routing.reason !== undefined) masterIssues.push(masterIssue(routing.reason));
    else if ((facts.operations.get(routing.routingId as bigint) ?? []).length === 0) masterIssues.push(masterIssue('ROUTING_OPERATION_REQUIRED'));
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
  const today = localToday(now, order.plant.timezone_code);
  const fg = fgOf(facts, order);

  return operations.map((operation) => {
    const resource = resources.get(operation.routing_operation_id);
    const lineId = planLineId ?? resource?.equipmentLineId ?? null;
    const line = lineId === null ? undefined : facts.lines.get(lineId);
    const fgPick = fgLocationOf(fg, line?.default_fg_location_id ?? null);
    const values = {
      productionLineId: lineId,
      equipmentId: resource?.equipmentId ?? null,
      moldId: resource?.moldId ?? null,
      defaultWipLocationId: line?.default_wip_location_id ?? null,
      defaultFgLocationId: fgPick.locationId,
      defaultScrapLocationId: line?.default_scrap_location_id ?? null,
    };
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
      ...values,
      defaultFgLocationSource: fgPick.source,
      issues: [
        ...resourceFindings(order.plant_id, values, facts, fg).map((finding) => blockIssue(finding.code, finding.message, finding.field)),
        ...findings.map((finding) => warnIssue(finding.code, finding.message, finding.field)),
      ],
    };
  });
}

/**
 * 변경 감지 값. 판(`version_no`)을 올리지 않는 칸도 잡게 기준의 «내용»을 해시한다. 다른 W/O 의 배정처럼 수시로 바뀌는 것은 넣지 않는다.
 * ⛔ 작성중 계획의 판은 반드시 넣는다 — 확정이 If-Match 없이 이 값으로 저장 충돌을 막는다.
 */
function basisOf(facts: ProposalFacts, order: OrderRow, saved: readonly PlanRow[]): ProposalBasis {
  const routings = facts.usableRoutings.get(pairKey(order.plant_id, order.item_id)) ?? [];
  const routingIds = new Set([...routings.map((row) => row.routing_id), ...saved.filter((plan) => plan.status_code !== CONFIRMED).map((plan) => plan.routing_id)]);
  const maps = facts.maps.get(pairKey(order.plant_id, order.item_id)) ?? [];
  const equipmentIds = new Set(maps.map((row) => row.map.equipmentId).filter((id) => id !== null));
  const lineIds = new Set([
    ...saved.filter((plan) => plan.status_code !== CONFIRMED).map((plan) => plan.planned_line_id),
    ...maps.map((row) => row.map.equipmentLineId),
  ].filter((id) => id !== null));
  const fg = fgOf(facts, order);
  const locationIds = new Set([
    ...[...lineIds].flatMap((id) => {
      const line = facts.lines.get(id);
      return line === undefined ? [] : [line.default_wip_location_id, line.default_fg_location_id, line.default_scrap_location_id];
    }),
    fg.kind === 'ERP_STORAGE_LOCATION' ? fg.location.id : null,
  ].filter((id) => id !== null));
  return {
    productionOrder: basisHash([order.version_no, order.order_qty, order.status_code, order.plant_id, order.item_id, order.uom_id, order.planned_start_date, order.erp_storage_location_code]),
    // 확정 계획의 W/O 는 「모두 취소됐는가」만 수량에 든다 — 진행 중 상태 변화로 409 가 나지 않게.
    plans: basisHash(saved.map((plan) => [plan.production_plan_id, plan.version_no, plan.status_code, isPlanCancelled(plan.work_order.map((workOrder) => workOrder.status_code))])),
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
      // 결정된 창고·위치와 그 활성 여부. 창고가 꺼지거나 만들어지면 판정(kind·reason)이 바뀌고, 이름은 넣지 않는다.
      fg.kind === 'ERP_STORAGE_LOCATION' ? [fg.kind, fg.erpCode, fg.warehouse.id, fg.location.id, fg.location.isActive]
        : fg.kind === 'LINK_FAILED' ? [fg.kind, fg.erpCode, fg.reason] : [fg.kind],
      maps.map((row) => [row.item_resource_map_id, row.version_no, row.map]),
      // 설비·금형은 판정에 드는 칸만 — 교정 기한·타수와 그것이 올리는 판은 WARN 에만 쓰고 넣지 않는다(수시로 바뀐다).
      [...equipmentIds].sort(compare).map((id) => {
        const row = facts.equipments.get(id);
        return row === undefined ? null : [id, row.plant_id, row.status_code, row.is_active, row.production_line_id];
      }),
      maps.map((row) => row.map.moldId).filter((id) => id !== null).sort(compare).map((id) => {
        const row = facts.molds.get(id);
        return row === undefined ? null : [id, row.plant_id, row.status_code, row.is_active];
      }),
      [...lineIds].sort(compare).map((id) => facts.lines.get(id)),
      [...facts.locations.values()].filter((row) => locationIds.has(row.location_id)),
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

/** `YYYY-MM-DD` 라 문자열 비교가 날짜 비교다. */
const laterOf = (date: string, today: string): string => (date < today ? today : date);
