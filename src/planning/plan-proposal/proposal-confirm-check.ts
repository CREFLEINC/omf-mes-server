import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { unusable } from '../../core/work-order';
import { WorkOrderSupplement } from '../production-plan/expand';
import { PlanWindow, dayStartOf, dayWindow, shiftWindow, timeOfColumn } from '../production-plan/plan-window';
import { Proposal, ProposalBasis, ProposalPlan } from './proposal-builder';
import { assertWholeOrder } from './proposal-policy';
import { ProposalFacts } from './proposal-reader';

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

/** 자재창고 위치는 W/O 기본 위치로 두지 않는다 — 라인 기본 위치와 같은 규칙(`equipment-group.service.ts`). */
const MATERIAL_WAREHOUSE = 'MATERIAL';

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
  const usable = new Set((facts.usableRoutings.get(order.item_id) ?? []).map((row) => row.routing_id));
  const shifts = facts.shifts.get(order.plant_id) ?? [];
  const dayStart = dayStartOf(shifts.filter((shift) => shift.is_active).map((shift) => timeOfColumn(shift.start_time)));
  const errors: ErrorItem[] = [];
  const error = (field: string, code: string, message: string): void => {
    errors.push({ scope: 'field', field, code, message });
  };

  const resolved = body.plans.map((plan, index): ResolvedPlan => {
    const path = `plans[${index}]`;
    const proposed = proposal.plans.find((candidate) => candidate.key === plan.proposalPlanKey) as ProposalPlan;
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
      const lineId = BigInt(workOrder.productionLineId);
      if (!lineUsable(refs.lines.get(lineId), order.plant_id)) error(field('productionLineId'), 'LINE_PLANT_MISMATCH', '이 ERP W/O 공장의 사용 중인 라인이 아닙니다.');
      const equipmentId = idOf(workOrder.plannedEquipmentId);
      if (equipmentId !== null) {
        const equipment = refs.equipments.get(equipmentId);
        if (equipment === undefined || equipment.plant_id !== order.plant_id) error(field('plannedEquipmentId'), ERROR_CODE.INVALID, '이 공장의 설비가 아닙니다.');
        else if (unusable(equipment)) error(field('plannedEquipmentId'), 'EQUIPMENT_NOT_IN_SERVICE', '가동 상태가 아닌 설비입니다.');
        else if (equipment.production_line_id !== null && equipment.production_line_id !== lineId) error(field('plannedEquipmentId'), ERROR_CODE.INVALID, '고른 라인에 속한 설비가 아닙니다.');
      }
      const moldId = idOf(workOrder.plannedMoldId);
      if (moldId !== null) {
        const mold = refs.molds.get(moldId);
        if (mold === undefined || mold.plant_id !== order.plant_id) error(field('plannedMoldId'), ERROR_CODE.INVALID, '이 공장의 금형이 아닙니다.');
        else if (unusable(mold)) error(field('plannedMoldId'), 'MOLD_NOT_IN_SERVICE', '가동 상태가 아닌 금형입니다.');
      }
      const workerId = idOf(workOrder.responsibleWorkerId);
      if (workerId !== null) {
        const worker = refs.workers.get(workerId);
        if (worker === undefined || worker.plant_id !== order.plant_id || !worker.is_active) error(field('responsibleWorkerId'), ERROR_CODE.INVALID, '이 공장의 사용 중인 작업자가 아닙니다.');
      }
      const shiftId = idOf(workOrder.plannedShiftId);
      const shift = shiftId === null ? undefined : shifts.find((candidate) => candidate.shift_id === shiftId && candidate.is_active);
      if (shiftId !== null && shift === undefined) error(field('plannedShiftId'), ERROR_CODE.INVALID, '이 공장의 사용 중인 교대가 아닙니다.');
      for (const name of ['defaultWipLocationId', 'defaultFgLocationId', 'defaultScrapLocationId'] as const) {
        const location = refs.locations.get(BigInt(workOrder[name]));
        if (location === undefined || location.warehouse.plant_id !== order.plant_id || location.warehouse.warehouse_type_code === MATERIAL_WAREHOUSE || !location.is_active || !location.warehouse.is_active) {
          error(field(name), ERROR_CODE.INVALID, '이 공장의, 자재창고가 아닌 사용 중인 위치여야 합니다.');
        }
      }
      const window: PlanWindow = shift === undefined
        ? dayWindow(plan.planDate, dayStart, order.plant.timezone_code)
        : shiftWindow(plan.planDate, { startTime: timeOfColumn(shift.start_time), endTime: timeOfColumn(shift.end_time), crossesMidnight: shift.crosses_midnight }, order.plant.timezone_code);
      if (window.plannedEndAt < window.plannedStartAt) error(field('plannedShiftId'), ERROR_CODE.INVALID, '교대 종료가 시작보다 앞섭니다. 교대 기준정보를 확인하세요.');
      supplements.set(BigInt(workOrder.routingOperationId), {
        productionLineId: lineId,
        equipmentId,
        moldId,
        workerId,
        shiftId,
        defaultWipLocationId: BigInt(workOrder.defaultWipLocationId),
        defaultFgLocationId: BigInt(workOrder.defaultFgLocationId),
        defaultScrapLocationId: BigInt(workOrder.defaultScrapLocationId),
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
 * 오류 칸은 수량이 늘어난 첫 계획이다(없으면 첫 계획) — 화면이 줄일 칸을 가리킨다.
 */
export function quantityDelta(plans: readonly ResolvedPlan[]): { delta: Prisma.Decimal; field: string } {
  let delta = new Prisma.Decimal(0);
  let field: string | undefined;
  for (const plan of plans) {
    const change = new Prisma.Decimal(plan.body.plannedQty).minus(plan.proposal.saved?.planned_qty ?? 0);
    delta = delta.plus(change);
    if (field === undefined && change.gt(0)) field = `plans[${plan.index}].plannedQty`;
  }
  return { delta, field: field ?? 'plans[0].plannedQty' };
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
