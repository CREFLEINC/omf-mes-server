import { Prisma } from '@prisma/client';

import { DefaultMap, OperationNeed, assignResources } from '../production-plan/resource-assign';

/** 계약 `AutoPlanReason` — 응답은 이 순서로 낸다. */
export const AUTO_PLAN_REASONS = [
  'BOM_MISSING',
  'ROUTING_MISSING',
  'ROUTING_AMBIGUOUS',
  'LINE_UNKNOWN',
  'PLAN_NOT_CONFIRMED',
  'QTY_REMAINING',
  'AUTO_PLAN_RERUN_NEEDED',
] as const;
export type AutoPlanReason = (typeof AUTO_PLAN_REASONS)[number];

export type AutoPlanStatus = 'DONE' | 'NEEDS_REVIEW';

/** 계약 `ProductionOrderAutoPlan`. */
export interface AutoPlanView {
  status: AutoPlanStatus;
  reasons: AutoPlanReason[];
}

export interface RoutingCandidate {
  routingId: bigint;
  isDefault: boolean;
}

export interface MasterChoice {
  bomId: bigint | null;
  routingId: bigint | null;
  reasons: AutoPlanReason[];
}

/**
 * W-02-02 가 계획 행에 미리 채우는 BOM·Routing 과 같은 규칙이다(`master-check-pane.tsx` 의
 * `automaticBomId`·`automaticRoutingId`) — 화면에서 사람이 고를 값과 자동 계획이 고른 값이 갈리지 않게.
 * BOM 은 기본 Rev 하나, Routing 은 쓸 수 있는 Rev 가 하나면 그것, 여럿이면 그중 기본 Rev 하나다.
 */
export function chooseMasters(defaultBomIds: readonly bigint[], usableRoutings: readonly RoutingCandidate[]): MasterChoice {
  const reasons: AutoPlanReason[] = [];
  const bomId = defaultBomIds.length === 1 ? defaultBomIds[0] : null;
  if (bomId === null) reasons.push('BOM_MISSING');

  let routingId: bigint | null = null;
  if (usableRoutings.length === 0) reasons.push('ROUTING_MISSING');
  else if (usableRoutings.length === 1) routingId = usableRoutings[0].routingId;
  else {
    const defaults = usableRoutings.filter((routing) => routing.isDefault);
    if (defaults.length === 1) routingId = defaults[0].routingId;
    else reasons.push('ROUTING_AMBIGUOUS');
  }
  return { bomId, routingId, reasons };
}

/**
 * 전개한 W/O 에 라인이 하나라도 서는가 — 계획 라인이 있거나, 기본 매핑으로 배정될 설비 중 라인에 속한 것이 있다.
 * 확정 전개(`expand.ts` 의 `lineOf`)와 같은 배정을 쓴다.
 */
export function expansionHasLine(planLineId: bigint | null, operations: readonly OperationNeed[], maps: readonly DefaultMap[]): boolean {
  if (planLineId !== null) return true;
  return [...assignResources([...operations], [...maps]).values()].some((resource) => resource.equipmentLineId !== null);
}

/**
 * 받을 때 자동 계획을 건너뛰는가 — 받은 상태가 아니거나, 오더의 날짜(납기, 없으면 계획 시작일)가 공장 현지 오늘보다 앞이다.
 * ERP W/O 는 납기 없이 계획 시작일만 온다 — 지난 오더를 몰아 받을 때 계획이 쏟아지지 않게 그 날짜로 본다.
 * 날짜는 모두 `YYYY-MM-DD` 라 문자열 비교가 날짜 비교다.
 */
export function skipOnReceipt(statusCode: string, dueDate: string | null, plannedStartDate: string | null, today: string): boolean {
  if (statusCode !== 'RECEIVED') return true;
  const date = dueDate ?? plannedStartDate;
  return date !== null && date < today;
}

/** 계획일 — ERP 계획 시작일이 오늘 이후면 그날, 없거나 지났으면 공장 현지 오늘. */
export function autoPlanDate(plannedStartDate: string | null, today: string): string {
  return plannedStartDate !== null && plannedStartDate >= today ? plannedStartDate : today;
}

export interface PlanFact {
  confirmed: boolean;
  plannedQty: Prisma.Decimal;
  /** 작성중 계획을 지금 확정하면 W/O 에 라인이 서는가. 확정 계획은 보지 않는다. */
  lineKnown: boolean;
}

/**
 * 확정 계획 수량이 오더 수량을 채우면 끝이다. 아니면 사람이 볼 이유를 낸다 — 계획이 없으면
 * 자동 계획을 막은 이유(`unplannedReasons`), 작성중 계획이 있으면 미확정과 그 원인, 확정분이 모자라면 잔량.
 * 자동 계획을 시도한 적이 없고 계획도 없으면 상태가 없다(null) — 그 기능 전에 받은 오더를 「확인 필요」로 쌓지 않는다.
 * 확인 필요는 이유가 늘 하나 이상이다 — 막던 기준정보가 그 뒤 갖춰졌으면 「다시 실행」(`AUTO_PLAN_RERUN_NEEDED`)이다.
 * ⛔ 상태(DONE·null) 판정을 바꾸면 SQL 판정 `AUTO_PLAN_DONE_SQL`·`AUTO_PLAN_UNTOUCHED_SQL`(production-order-worklist.ts)도 같이 고친다.
 */
export function autoPlanView(
  orderQty: Prisma.Decimal,
  plans: readonly PlanFact[],
  unplannedReasons: readonly AutoPlanReason[],
  attempted: boolean,
): AutoPlanView | null {
  if (!attempted && plans.length === 0) return null;
  const confirmedQty = plans
    .filter((plan) => plan.confirmed)
    .reduce((sum, plan) => sum.plus(plan.plannedQty), new Prisma.Decimal(0));
  if (confirmedQty.gte(orderQty)) return { status: 'DONE', reasons: [] };

  const reasons = new Set<AutoPlanReason>();
  if (plans.length === 0) unplannedReasons.forEach((reason) => reasons.add(reason));
  const drafts = plans.filter((plan) => !plan.confirmed);
  if (drafts.length > 0) reasons.add('PLAN_NOT_CONFIRMED');
  if (drafts.some((plan) => !plan.lineKnown)) reasons.add('LINE_UNKNOWN');
  if (confirmedQty.gt(0)) reasons.add('QTY_REMAINING');
  if (reasons.size === 0) reasons.add('AUTO_PLAN_RERUN_NEEDED');
  return { status: 'NEEDS_REVIEW', reasons: AUTO_PLAN_REASONS.filter((reason) => reasons.has(reason)) };
}
