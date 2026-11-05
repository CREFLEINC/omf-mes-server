import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { WorkOrderSupplement } from '../production-plan/expand';
import { PlanWindow, dayStartOf, dayWindow, localDate, shiftWindow, timeOfColumn } from '../production-plan/plan-window';
import { Proposal, ProposalBasis, ProposalPlan } from './proposal-builder';
import { assertWholeOrder } from './proposal-policy';
import { ProposalFacts } from './proposal-reader';
import { resourceFindings } from './resource-rules';
import { pairKey } from '../production-plan/resource-assign';

/** 계약 `ProductionPlanProposalConfirm` — 형식·필수·양수는 계약 가드가 이미 막았다. */
export interface ProposalConfirmBody {
  basis: ProposalBasis;
  plans: ProposalConfirmPlan[];
}

export interface ProposalConfirmPlan {
  proposalPlanKey: string;
  planDate: string;
  plannedQty: number;
  bomId: number;
  routingId: number;
  plannedLineId: number | null;
  remarks?: string;
  workOrders: ProposalConfirmWorkOrder[];
}

export interface ProposalConfirmWorkOrder {
  routingOperationId: number;
  productionLineId: number;
  plannedEquipmentId?: number | null;
  plannedMoldId?: number | null;
  responsibleWorkerId?: number | null;
  plannedShiftId?: number | null;
  defaultWipLocationId: number;
  defaultFgLocationId: number;
  defaultScrapLocationId: number;
}

/** 검증을 마친 계획 하나 — 저장에 그대로 쓴다. */
export interface ResolvedPlan {
  index: number;
  body: ProposalConfirmPlan;
  proposal: ProposalPlan;
  operationCount: number;
  supplements: Map<bigint, WorkOrderSupplement>;
}

/**
 * 확정 본문을 수기 등록·확정과 같은 규칙으로 검증한다 — 오류는 모아 한 번에 400(field 는 본문 경로).
 * 제안과 값이 달라도 된다(사람이 고칠 수 있다). 변경 감지는 호출자가 basis 로 이미 끝냈다.
 */
export async function resolveConfirm(
  client: Prisma.TransactionClient,
  proposal: Proposal,
  facts: ProposalFacts,
  body: ProposalConfirmBody,
): Promise<ResolvedPlan[]> {
  assertWholeOrder(proposal.plans.map((plan) => plan.key), body.plans.map((plan) => plan.proposalPlanKey));
  const { order } = proposal;
  const refs = await readReferences(client, body);
  const usable = new Set((facts.usableRoutings.get(pairKey(order.plant_id, order.item_id)) ?? []).map((row) => row.routing_id));
  const shifts = facts.shifts.get(order.plant_id) ?? [];
  const dayStart = dayStartOf(shifts.filter((shift) => shift.is_active).map((shift) => timeOfColumn(shift.start_time)));
  const today = localDate(new Date(), order.plant.timezone_code);
  const errors: ErrorItem[] = [];
  const error = (field: string, code: string, message: string): void => {
    errors.push({ scope: 'field', field, code, message });
  };

  const resolved = body.plans.map((plan, index): ResolvedPlan => {
    const path = `plans[${index}]`;
    const proposed = proposal.plans.find((candidate) => candidate.key === plan.proposalPlanKey) as ProposalPlan;
    // 자정을 넘겨 확정하면 검토 때의 계획일이 지났을 수 있다 — 지난 날로 W/O 를 만들지 않는다. 제안은 늘 오늘 이후로 낸다.
    if (plan.planDate < today) error(`${path}.planDate`, ERROR_CODE.RANGE, `계획일이 지났습니다 — 공장 현지 오늘(${today}) 이후로 고르세요.`);
    if (BigInt(plan.bomId) !== proposed.bom.id) {
      error(`${path}.bomId`, ERROR_CODE.BOM_NOT_DEFAULT, `품목의 ERP 기본 BOM 이 아닙니다 — 지금 기본은 ${proposed.bom.code} Rev ${proposed.bom.version} 입니다.`);
    }
    const routingId = BigInt(plan.routingId);
    if (!usable.has(routingId)) error(`${path}.routingId`, ERROR_CODE.INVALID, '확정되고 유효 기간 안인 이 품목의 Routing 만 쓸 수 있습니다.');
    if (plan.plannedLineId !== null && !lineUsable(refs.lines.get(BigInt(plan.plannedLineId)), order.plant_id)) {
      error(`${path}.plannedLineId`, 'LINE_PLANT_MISMATCH', '이 ERP W/O 공장의 사용 중인 라인이 아닙니다.');
    }
    const operationIds = (facts.operations.get(routingId) ?? []).map((operation) => operation.routing_operation_id);
    const sent = plan.workOrders.map((workOrder) => BigInt(workOrder.routingOperationId));
    if (usable.has(routingId) && !sameSet(operationIds, sent)) {
      error(`${path}.workOrders`, ERROR_CODE.INVALID, 'Routing 공정마다 W/O 하나씩 실어야 합니다 — 공정이 빠졌거나 겹쳤거나 다른 Routing 의 공정입니다.');
    }

    const supplements = new Map<bigint, WorkOrderSupplement>();
    plan.workOrders.forEach((workOrder, at) => {
      const field = (name: string): string => `${path}.workOrders[${at}].${name}`;
      const resources = {
        productionLineId: BigInt(workOrder.productionLineId),
        equipmentId: idOf(workOrder.plannedEquipmentId),
        moldId: idOf(workOrder.plannedMoldId),
        defaultWipLocationId: BigInt(workOrder.defaultWipLocationId),
        defaultFgLocationId: BigInt(workOrder.defaultFgLocationId),
        defaultScrapLocationId: BigInt(workOrder.defaultScrapLocationId),
      };
      // 제안이 사유를 내는 판정과 같은 것 — 「확정 가능」 제안을 그대로 보내면 여기서 막히지 않는다.
      for (const finding of resourceFindings(order.plant_id, resources, refs)) error(field(finding.field), finding.code, finding.message);
      const workerId = idOf(workOrder.responsibleWorkerId);
      if (workerId !== null) {
        const worker = refs.workers.get(workerId);
        if (worker === undefined || worker.plant_id !== order.plant_id || !worker.is_active) error(field('responsibleWorkerId'), ERROR_CODE.INVALID, '이 공장의 사용 중인 작업자가 아닙니다.');
      }
      const shiftId = idOf(workOrder.plannedShiftId);
      const shift = shiftId === null ? undefined : shifts.find((candidate) => candidate.shift_id === shiftId && candidate.is_active);
      if (shiftId !== null && shift === undefined) error(field('plannedShiftId'), ERROR_CODE.INVALID, '이 공장의 사용 중인 교대가 아닙니다.');
      const window: PlanWindow = shift === undefined
        ? dayWindow(plan.planDate, dayStart, order.plant.timezone_code)
        : shiftWindow(plan.planDate, { startTime: timeOfColumn(shift.start_time), endTime: timeOfColumn(shift.end_time) }, order.plant.timezone_code);
      supplements.set(BigInt(workOrder.routingOperationId), {
        ...resources,
        workerId,
        shiftId,
        window,
      });
    });
    return { index, body: plan, proposal: proposed, operationCount: operationIds.length, supplements };
  });

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return resolved;
}

/**
 * 이번 확정이 계획 수량 합계에 더하는 양 — 새 계획은 수량, 작성중 계획은 저장값과의 차.
 * 오류 칸은 화면이 고칠 줄이다 — 수량을 늘린 첫 줄, 없으면 수량을 바꾼(줄였지만 아직 넘는) 첫 줄, 그것도 없으면 마지막 줄.
 */
export function quantityDelta(plans: readonly ResolvedPlan[]): { delta: Prisma.Decimal; field: string } {
  const changes = plans.map((plan) => ({ index: plan.index, change: new Prisma.Decimal(plan.body.plannedQty).minus(plan.proposal.saved?.planned_qty ?? 0) }));
  const delta = changes.reduce((sum, { change }) => sum.plus(change), new Prisma.Decimal(0));
  const target =
    changes.find(({ change }) => change.gt(0)) ?? changes.find(({ change }) => !change.isZero()) ?? changes[changes.length - 1];
  return { delta, field: `plans[${target.index}].plannedQty` };
}

async function readReferences(client: Prisma.TransactionClient, body: ProposalConfirmBody) {
  const workOrders = body.plans.flatMap((plan) => plan.workOrders);
  const lineIds = ids([...body.plans.map((plan) => plan.plannedLineId), ...workOrders.map((workOrder) => workOrder.productionLineId)]);
  const equipmentIds = ids(workOrders.map((workOrder) => workOrder.plannedEquipmentId));
  const moldIds = ids(workOrders.map((workOrder) => workOrder.plannedMoldId));
  const workerIds = ids(workOrders.map((workOrder) => workOrder.responsibleWorkerId));
  const locationIds = ids(workOrders.flatMap((workOrder) => [workOrder.defaultWipLocationId, workOrder.defaultFgLocationId, workOrder.defaultScrapLocationId]));
  const [lines, equipments, molds, workers, locations] = await Promise.all([
    client.production_line.findMany({ where: { production_line_id: { in: lineIds } }, select: { production_line_id: true, plant_id: true, is_active: true } }),
    client.equipment.findMany({ where: { equipment_id: { in: equipmentIds } }, select: { equipment_id: true, plant_id: true, status_code: true, is_active: true, production_line_id: true } }),
    client.mold.findMany({ where: { mold_id: { in: moldIds } }, select: { mold_id: true, plant_id: true, status_code: true, is_active: true } }),
    client.worker.findMany({ where: { worker_id: { in: workerIds } }, select: { worker_id: true, plant_id: true, is_active: true } }),
    client.location.findMany({
      where: { location_id: { in: locationIds } },
      select: { location_id: true, is_active: true, warehouse: { select: { plant_id: true, warehouse_type_code: true, is_active: true } } },
    }),
  ]);
  return {
    lines: new Map(lines.map((row) => [row.production_line_id, row])),
    equipments: new Map(equipments.map((row) => [row.equipment_id, row])),
    molds: new Map(molds.map((row) => [row.mold_id, row])),
    workers: new Map(workers.map((row) => [row.worker_id, row])),
    locations: new Map(locations.map((row) => [row.location_id, row])),
  };
}

const lineUsable = (line: { plant_id: bigint; is_active: boolean } | undefined, plantId: bigint): boolean =>
  line !== undefined && line.plant_id === plantId && line.is_active;

function sameSet(expected: readonly bigint[], sent: readonly bigint[]): boolean {
  if (expected.length !== sent.length || new Set(sent).size !== sent.length) return false;
  const wanted = new Set(expected);
  return sent.every((id) => wanted.has(id));
}

const idOf = (value: number | null | undefined): bigint | null => (value === undefined || value === null ? null : BigInt(value));

function ids(values: readonly (number | null | undefined)[]): bigint[] {
  return [...new Set(values.filter((value): value is number => value !== undefined && value !== null))].map((value) => BigInt(value));
}
