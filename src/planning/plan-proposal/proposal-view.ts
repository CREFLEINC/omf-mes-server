import { toDateString } from '../../common/master';
import { Proposal, ProposalPlan, ProposalWorkOrder } from './proposal-builder';

/** 계약 `ProductionPlanProposal` 매퍼. 「키가 없다」로 적힌 칸만 빼고 null 은 그대로 낸다(계약이 required + nullable 로 적었다). */
export type ProposalView = ReturnType<typeof proposalView>;

export function proposalView(proposal: Proposal) {
  const { order, quantities } = proposal;
  return {
    productionOrderId: Number(order.production_order_id),
    productionOrderNo: order.production_order_no,
    ...(order.erp_order_no === null ? {} : { erpOrderNo: order.erp_order_no }),
    plantId: Number(order.plant_id),
    itemId: Number(order.item_id),
    uomId: Number(order.uom_id),
    kind: proposal.kind,
    status: proposal.status,
    reasons: proposal.reasons,
    orderQty: order.order_qty.toNumber(),
    confirmedPlanQty: quantities.confirmedQty.toNumber(),
    draftPlanQty: quantities.draftQty.toNumber(),
    remainingQty: quantities.remainingQty.toNumber(),
    erpStorage: erpStorageView(proposal.fg),
    plans: proposal.plans.map(planView),
    issues: proposal.issues,
    basis: proposal.basis,
  };
}

/** 계약 `ProductionPlanProposalErpStorage` — 연결하지 못한 칸은 null 이고 `reasonCode` 가 까닭이다. */
function erpStorageView(fg: Proposal['fg']) {
  const place = (value: { id: bigint; code: string; name: string }) => ({ id: Number(value.id), code: value.code, name: value.name });
  return {
    erpStorageLocationCode: fg.kind === 'NO_STORAGE_CODE' ? null : fg.erpCode,
    warehouse: fg.kind === 'ERP_STORAGE_LOCATION' ? place(fg.warehouse) : null,
    location: fg.kind === 'ERP_STORAGE_LOCATION' ? place(fg.location) : null,
    reasonCode: fg.kind === 'LINK_FAILED' ? fg.reason : null,
  };
}

function planView(plan: ProposalPlan) {
  const saved = plan.saved;
  return {
    proposalPlanKey: plan.key,
    planSource: plan.source,
    ...(saved === undefined ? {} : { productionPlanId: Number(saved.production_plan_id), planNo: saved.plan_no }),
    planDate: plan.planDate,
    proposedQty: plan.proposedQty.toNumber(),
    uomId: Number(plan.uomId),
    bomId: Number(plan.bom.id),
    bomCode: plan.bom.code,
    bomVersion: plan.bom.version,
    routingId: Number(plan.routing.id),
    routingCode: plan.routing.code,
    routingVersion: plan.routing.version,
    plannedLineId: id(plan.plannedLineId),
    ...(saved === undefined
      ? {}
      : {
          saved: {
            versionNo: saved.version_no,
            planDate: toDateString(saved.plan_date) as string,
            plannedQty: saved.planned_qty.toNumber(),
            bomId: Number(saved.bom_id),
            routingId: Number(saved.routing_id),
            plannedLineId: id(saved.planned_line_id),
          },
        }),
    workOrders: plan.workOrders.map(workOrderView),
    issues: plan.issues,
  };
}

function workOrderView(workOrder: ProposalWorkOrder) {
  const { operation } = workOrder;
  return {
    routingOperationId: Number(operation.routing_operation_id),
    operationSeq: operation.operation_seq,
    operationName: operation.operation_name,
    processId: Number(operation.process_id),
    processCode: operation.process.process_code,
    processName: operation.process.process_name,
    proposedQty: workOrder.proposedQty.toNumber(),
    predecessors: workOrder.predecessors.map((predecessor) => ({
      routingOperationId: Number(predecessor.routingOperationId),
      dependencyTypeCode: predecessor.dependencyTypeCode,
    })),
    plannedStartAt: workOrder.window.plannedStartAt.toISOString(),
    plannedEndAt: workOrder.window.plannedEndAt.toISOString(),
    equipmentRequired: operation.equipment_required,
    moldRequired: operation.mold_required,
    productionLineId: id(workOrder.productionLineId),
    plannedEquipmentId: id(workOrder.equipmentId),
    plannedMoldId: id(workOrder.moldId),
    // 작업자·교대는 제안하지 않는다 — 사람이 고르면 확정 본문에 싣는다.
    responsibleWorkerId: null,
    plannedShiftId: null,
    defaultWipLocationId: id(workOrder.defaultWipLocationId),
    defaultFgLocationId: id(workOrder.defaultFgLocationId),
    defaultFgLocationSource: workOrder.defaultFgLocationSource,
    defaultScrapLocationId: id(workOrder.defaultScrapLocationId),
    issues: workOrder.issues,
  };
}

const id = (value: bigint | null): number | null => (value === null ? null : Number(value));
