import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { PlanningCalendarDay } from '../../core/calendar/working-day';
import { calendarsOfPlans } from '../production-plan/plan-date-calendar';
import { precheckWithinOrder } from '../production-plan/plan-quantity';
import { Proposal, ProposalBasis, buildProposals, planDayIssues } from './proposal-builder';
import { ProposalConfirmBody, ResolvedPlan, draftRefsOf, judgeConfirm, quantityDelta } from './proposal-confirm-check';
import { TimeCorrection } from './plan-times';
import { splitChildConflict } from './draft-replace';
import { draftsChanged } from './plan-set-rules';
import { AUTO_WORK_ORDER_PLANT } from './proposal-policy';
import { ProposalFacts, readProposalFacts } from './proposal-reader';
import { ExistingDraftView, ProposalView, existingDraftView, proposalView } from './proposal-view';
import { RevalidationWarning, workOrderWarnings } from './proposal-warnings';

const BASIS_LABEL: Record<keyof ProposalBasis, string> = {
  productionOrder: 'ERP W/O 가 바뀌었습니다(수량·상태·계획 시작일).',
  plans: '이 ERP W/O 의 계획이 바뀌었습니다 — 다른 사람이나 다른 화면이 계획을 등록·수정·확정했습니다.',
  bom: '품목의 ERP 기본 BOM 이 바뀌었습니다.',
  routing: '품목의 Routing·공정이 바뀌었습니다.',
  resources: '자원 기준정보(기본 매핑·라인·설비·금형·교대)가 바뀌었습니다.',
  calendar: '시스템이 정한 계획일의 근무일 판정이 바뀌었습니다(작업 캘린더·공장 근무일 정책).',
};

export interface ProposalChange {
  basis: keyof ProposalBasis;
  message: string;
}

/**
 * 사람이 검토한 뒤 바뀐 것 — 확정은 이것이 비지 않으면 409 PROPOSAL_CHANGED, 재검증은 그대로 싣는다.
 * basis 의 칸과, 사람이 본 작성중 계획의 id·판(`draftsChanged`)이 지금과 다른 것(basis plans 로 낸다)이다.
 */
export function proposalChangesOf(proposal: Proposal, body: ProposalConfirmBody): ProposalChange[] {
  const changed = (Object.keys(BASIS_LABEL) as (keyof ProposalBasis)[]).filter((key) => proposal.basis[key] !== body.basis[key]);
  if (!changed.includes('plans') && draftsChanged(draftRefsOf(proposal), body)) changed.push('plans');
  return (Object.keys(BASIS_LABEL) as (keyof ProposalBasis)[])
    .filter((basis) => changed.includes(basis))
    .map((basis) => ({
      basis,
      message: basis === 'productionOrder' ? `${BASIS_LABEL[basis]} 지금 수량 ${proposal.order.order_qty.toString()}.` : BASIS_LABEL[basis],
    }));
}

/** 본문이 고른 바탕(이어서·새로)으로 다시 계산한 제안 — 확정과 재검증이 같은 식으로 읽는다. */
export async function proposalFor(client: Prisma.TransactionClient, orderId: bigint, body: ProposalConfirmBody, now: Date): Promise<{ facts: ProposalFacts; proposal: Proposal }> {
  const facts = await readProposalFacts(client, [orderId], now);
  const proposal = buildProposals(facts, now, body.existingDraftAction === 'CONTINUE' ? 'CONTINUE' : 'REPLACE').get(orderId);
  if (proposal === undefined) throw new NotFoundException('없는 ERP W/O 입니다.');
  return { facts, proposal };
}

/** 「새로 한다」면 지울 작성중 계획의 수량 — 수량 한도는 대체 «후» 기준이다. */
export function replacedQtyOf(proposal: Proposal, body: ProposalConfirmBody): Prisma.Decimal {
  if (body.existingDraftAction !== 'REPLACE') return new Prisma.Decimal(0);
  return proposal.drafts.reduce((sum, { row }) => sum.plus(row.planned_qty), new Prisma.Decimal(0));
}

export const ORDER_CANCELLED_ERROR: ErrorItem = { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '취소된 ERP W/O 는 계획하지 않습니다.' };
export const AUTO_WORK_ORDER_PLANT_ERROR: ErrorItem = {
  scope: 'screen',
  code: AUTO_WORK_ORDER_PLANT,
  message: 'OA 자동 W/O 공장의 ERP W/O 는 자동 W/O 실행기가 계획·확정합니다. 이 화면에서 확정하지 않습니다.',
};

/** 계약 `ProductionPlanProposalRevalidation`. */
export interface ProposalRevalidation {
  productionOrderId: number;
  confirmable: boolean;
  alreadyProcessed: boolean;
  basis: ProposalBasis;
  proposalChanges: ProposalChange[];
  currentProposal?: ProposalView;
  existingDrafts: ExistingDraftView[];
  errors: ErrorItem[];
  warnings: RevalidationWarning[];
  corrections: TimeCorrection[];
  plans: ReturnType<typeof planView>[];
}

/**
 * 저장하지 않고 확정과 같은 판정(`judgeConfirm`·수량 합계)을 돌린다 — 잠그지 않고, 번호·멱등 기록·계획·W/O 를 건드리지 않는다.
 * 확정이 400 으로 낼 것은 errors, 409 로 낼 것은 proposalChanges 다. 확정과 달리 하나에서 멈추지 않고 모두 낸다.
 */
export async function revalidateProposal(client: Prisma.TransactionClient, orderId: bigint, body: ProposalConfirmBody, now: Date = new Date()): Promise<ProposalRevalidation> {
  const { facts, proposal } = await proposalFor(client, orderId, body, now);
  const proposalChanges = proposalChangesOf(proposal, body);
  const head = {
    productionOrderId: Number(orderId),
    basis: proposal.basis,
    proposalChanges,
    ...(proposalChanges.length === 0 ? {} : { currentProposal: proposalView(proposal) }),
    existingDrafts: proposal.drafts.map(existingDraftView),
  };
  const nothing = { confirmable: false, warnings: [], corrections: [], plans: [] };
  if (proposal.order.status_code === 'CANCELLED') return { ...head, ...nothing, alreadyProcessed: false, errors: [ORDER_CANCELLED_ERROR] };
  if (proposal.kind === 'AUTO_WORK_ORDER') return { ...head, ...nothing, alreadyProcessed: false, errors: [AUTO_WORK_ORDER_PLANT_ERROR] };
  if (proposal.kind === 'KEEP_CONFIRMED') return { ...head, ...nothing, alreadyProcessed: true, errors: [] };

  const { resolved, errors, warnings: timeWarnings, corrections } = await judgeConfirm(client, proposal, facts, body, now);
  const pinned = splitChildConflict(proposal, body.existingDraftAction);
  if (pinned !== null) errors.unshift({ scope: 'screen', code: 'INVALID_STATE', message: pinned });
  if (resolved.length > 0) errors.push(...(await quantityErrors(client, orderId, resolved, replacedQtyOf(proposal, body))));
  const days = await calendarsOfPlans(client, resolved.map((plan) => ({
    production_order_id: orderId,
    planned_line_id: plan.body.plannedLineId === null ? null : BigInt(plan.body.plannedLineId),
    plan_date: new Date(`${plan.body.planDate}T00:00:00.000Z`),
  })));
  const warnings = [
    ...resolved.flatMap((plan, at) => planDayIssues(plan.body.planDate, days[at]).map((issue) => ({ code: issue.code, field: `plans[${plan.index}].planDate`, message: issue.message }))),
    ...timeWarnings,
    ...(await workOrderWarnings(client, proposal.order, facts, resolved, now)),
  ];
  return {
    ...head,
    confirmable: errors.length === 0 && proposalChanges.length === 0,
    alreadyProcessed: false,
    errors,
    warnings,
    corrections,
    plans: resolved.map((plan, at) => planView(facts, plan, days[at])),
  };
}

/** 확정의 미리 검사(`precheckWithinOrder`)를 그대로 부르고 그 400 을 오류로 받는다 — 같은 문장·같은 칸. */
async function quantityErrors(client: Prisma.TransactionClient, orderId: bigint, resolved: readonly ResolvedPlan[], replacedQty: Prisma.Decimal): Promise<ErrorItem[]> {
  const { delta, field } = quantityDelta(resolved, replacedQty);
  try {
    await precheckWithinOrder(client, orderId, delta, field, true);
    return [];
  } catch (error) {
    if (error instanceof ContractException) return error.errors;
    throw error;
  }
}

/** 확정하면 저장될 계획 — 사람이 보낸 값은 그대로, 서버가 정하는 칸(공정 수량·선후관계·계획 시각)만 계산해 채운다. */
function planView(facts: ProposalFacts, plan: ResolvedPlan, day: PlanningCalendarDay) {
  const { body, proposal } = plan;
  const routingId = BigInt(body.routingId);
  const operations = new Map((facts.operations.get(routingId) ?? []).map((operation) => [operation.routing_operation_id, operation]));
  const dependencies = facts.dependencies.get(routingId) ?? [];
  return {
    proposalPlanKey: body.proposalPlanKey,
    splitFromPlanKey: body.splitFromPlanKey ?? null,
    planSource: proposal.source,
    ...(proposal.saved === undefined ? {} : { productionPlanId: Number(proposal.saved.production_plan_id) }),
    planDate: body.planDate,
    planDateSourceCode: body.planDateSourceCode,
    planDateCalendar: day,
    plannedQty: body.plannedQty,
    bomId: body.bomId,
    routingId: body.routingId,
    plannedLineId: body.plannedLineId,
    remarks: body.remarks ?? null,
    workOrders: body.workOrders.map((workOrder) => {
      const operationId = BigInt(workOrder.routingOperationId);
      const operation = operations.get(operationId);
      const window = plan.windows.get(operationId);
      const equipmentRequired = operation?.equipment_required ?? false;
      const moldRequired = operation?.mold_required ?? false;
      const equipmentId = workOrder.plannedEquipmentId ?? null;
      const moldId = workOrder.plannedMoldId ?? null;
      return {
        routingOperationId: workOrder.routingOperationId,
        operationSeq: operation?.operation_seq ?? null,
        orderQty: body.plannedQty,
        predecessors: dependencies
          .filter((dependency) => dependency.successor_operation_id === operationId)
          .map((dependency) => ({ routingOperationId: Number(dependency.predecessor_operation_id), dependencyTypeCode: dependency.dependency_type_code })),
        plannedStartAt: window?.plannedStartAt.toISOString() ?? null,
        plannedEndAt: window?.plannedEndAt.toISOString() ?? null,
        plannedTimeSourceCode: workOrder.plannedTimeSourceCode,
        plannedShiftId: workOrder.plannedShiftId ?? null,
        productionLineId: workOrder.productionLineId ?? null,
        plannedEquipmentId: equipmentId,
        plannedMoldId: moldId,
        responsibleWorkerId: workOrder.responsibleWorkerId ?? null,
        defaultWipLocationId: workOrder.defaultWipLocationId ?? null,
        defaultFgLocationId: workOrder.defaultFgLocationId ?? null,
        defaultScrapLocationId: workOrder.defaultScrapLocationId ?? null,
        equipmentRequired,
        moldRequired,
        // 확정·배포가 막지 않는 빈 칸이다 — 공정이 요구하는데 비었음을 알린다.
        missingFields: [...(equipmentRequired && equipmentId === null ? ['plannedEquipmentId'] : []), ...(moldRequired && moldId === null ? ['plannedMoldId'] : [])],
      };
    }),
  };
}
