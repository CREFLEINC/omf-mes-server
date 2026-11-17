import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { FgPlace, FgRule, LOCATION_FACT_SELECT } from '../../core/erp-warehouse/fg-location';
import { FgOverrideBody, judgeFgOverride } from './fg-override';
import { WorkOrderSupplement } from '../production-plan/expand';
import { PlanWindow, dayStartOf, dayWindow, localDate, shiftWindow, timeOfColumn } from '../production-plan/plan-window';
import { Proposal, ProposalBasis, ProposalPlan } from './proposal-builder';
import { DraftRef, ExistingDraftAction, draftActionOf, draftChoiceErrors, planSetErrors } from './plan-set-rules';
import { TimeCorrection, TimeSource, TimedOperation, judgeTime, precedenceWarnings } from './plan-times';
import type { RevalidationWarning } from './proposal-warnings';
import { ProposalFacts } from './proposal-reader';
import { resourceFindings } from './resource-rules';
import { pairKey } from '../production-plan/resource-assign';

/**
 * 계약 `ProductionPlanProposalConfirm`·`ProductionPlanProposalRevalidate` — 형식·양수는 계약 가드가 이미 막았다.
 * 재검증 본문은 생산 라인·기본 위치 셋이 비어도 받는다(판정이 REQUIRED 로 낸다). 확정 본문은 계약 가드가 막는다.
 */
export interface ProposalConfirmBody {
  basis: ProposalBasis;
  existingDraftAction?: ExistingDraftAction | null;
  replacedDrafts?: { productionPlanId: number; versionNo: number }[];
  plans: ProposalConfirmPlan[];
}

export interface ProposalConfirmPlan {
  proposalPlanKey: string;
  savedVersionNo?: number | null;
  splitFromPlanKey?: string | null;
  planDate: string;
  /** 날짜 출처 — 서버가 추측하지 않고 이 값을 저장한다. SYSTEM 은 시스템 날짜 그대로일 때만. */
  planDateSourceCode: 'SYSTEM' | 'USER';
  plannedQty: number;
  bomId: number;
  routingId: number;
  plannedLineId: number | null;
  remarks?: string;
  /** 완제품 입고 창고 수동 변경 — 없으면 SL_CD 규칙 그대로(`fg-override.ts`). */
  fgWarehouseOverride?: FgOverrideBody | null;
  workOrders: ProposalConfirmWorkOrder[];
}

export interface ProposalConfirmWorkOrder {
  routingOperationId: number;
  productionLineId?: number | null;
  plannedEquipmentId?: number | null;
  plannedMoldId?: number | null;
  responsibleWorkerId?: number | null;
  plannedShiftId?: number | null;
  plannedTimeSourceCode: TimeSource;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  defaultWipLocationId?: number | null;
  defaultFgLocationId?: number | null;
  defaultScrapLocationId?: number | null;
}

/** 검증을 마친 계획 하나 — 저장에 그대로 쓴다. */
export interface ResolvedPlan {
  index: number;
  body: ProposalConfirmPlan;
  proposal: ProposalPlan;
  operationCount: number;
  /** 생산 라인·기본 위치 셋이 다 찬 공정만 — 빈 칸이 있으면 오류가 있어 저장하지 않는다. */
  supplements: Map<bigint, WorkOrderSupplement>;
  /** 공정마다 저장할 계획 시각 — SYSTEM 은 계획일과 교대로 정했고 USER 는 본문 그대로다. */
  windows: Map<bigint, PlanWindow>;
  /** 사람이 ERP 와 다르게 고른 입고 창고 — 바꾸지 않았으면 null. */
  fgOverride: FgPlace | null;
}

export interface ConfirmJudgment {
  /** 계획 집합이 제안과 다르면 비어 있다 — 그때는 계획별 판정을 하지 않는다. */
  resolved: ResolvedPlan[];
  errors: ErrorItem[];
  /** 확정을 막지 않는 시각 경고(교대 밖·선후관계) — 확정은 보지 않는다. */
  warnings: RevalidationWarning[];
  /** SYSTEM 시각을 다시 계산해 본문과 달라진 칸 — 확정은 다시 계산한 값을 저장한다. */
  corrections: TimeCorrection[];
}

/** 확정 — 판정에 오류가 하나라도 있으면 모아 한 번에 400(field 는 본문 경로)이다. */
export async function resolveConfirm(
  client: Prisma.TransactionClient,
  proposal: Proposal,
  facts: ProposalFacts,
  body: ProposalConfirmBody,
  now: Date,
): Promise<ResolvedPlan[]> {
  const { resolved, errors } = await judgeConfirm(client, proposal, facts, body, now);
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return resolved;
}

/**
 * 확정 본문을 수기 등록·확정과 같은 규칙으로 판정한다 — 던지지 않고 오류를 모은다. 확정(`resolveConfirm`)과 재검증이 이 한 판정을 쓴다.
 * 제안과 값이 달라도 된다(사람이 고칠 수 있다). 변경 감지는 호출자가 basis·`draftsChanged` 로 한다. `now` 가 공장 현지 「오늘」을 정한다.
 * 기존 작성중 계획 선택·계획 구성(`plan-set-rules.ts`)이 틀리면 계획별 판정을 하지 않는다.
 */
export async function judgeConfirm(
  client: Prisma.TransactionClient,
  proposal: Proposal,
  facts: ProposalFacts,
  body: ProposalConfirmBody,
  now: Date,
): Promise<ConfirmJudgment> {
  const drafts = draftRefsOf(proposal);
  const choice = draftChoiceErrors(drafts, body);
  if (choice.length > 0) return { resolved: [], errors: choice, warnings: [], corrections: [] };
  const planSet = planSetErrors(proposal.plans.length > 0, drafts, draftActionOf(drafts, body), body);
  if (planSet.length > 0) return { resolved: [], errors: planSet, warnings: [], corrections: [] };
  const { order } = proposal;
  const refs = await readReferences(client, body);
  const usable = new Set((facts.usableRoutings.get(pairKey(order.plant_id, order.item_id)) ?? []).map((row) => row.routing_id));
  const shifts = facts.shifts.get(order.plant_id) ?? [];
  const dayStart = dayStartOf(shifts.filter((shift) => shift.is_active).map((shift) => timeOfColumn(shift.start_time)));
  const timezone = order.plant.timezone_code;
  const today = localDate(now, timezone);
  const errors: ErrorItem[] = [];
  const warnings: RevalidationWarning[] = [];
  const corrections: TimeCorrection[] = [];
  const error = (field: string, code: string, message: string): void => {
    errors.push({ scope: 'field', field, code, message });
  };

  const resolved = body.plans.flatMap((plan, index): ResolvedPlan[] => {
    const path = `plans[${index}]`;
    const proposed = proposedFor(proposal, plan.proposalPlanKey);
    if (proposed === undefined) {
      error(`${path}.proposalPlanKey`, ERROR_CODE.INVALID, '이 ERP W/O 에는 새 계획을 더할 수 없습니다 — 새 계획에 쓸 Routing 을 정하지 못했습니다.');
      return [];
    }
    // 자정을 넘겨 확정하면 검토 때의 계획일이 지났을 수 있다 — 지난 날로 W/O 를 만들지 않는다. 제안은 늘 오늘 이후로 낸다.
    if (plan.planDate < today) error(`${path}.planDate`, ERROR_CODE.RANGE, `계획일이 지났습니다 — 공장 현지 오늘(${today}) 이후로 고르세요.`);
    const systemDate = systemDateOf(proposal, proposed);
    if (plan.planDateSourceCode === 'SYSTEM' && plan.planDate !== systemDate) {
      error(`${path}.planDateSourceCode`, PLAN_DATE_SOURCE_MISMATCH, systemDate === null
        ? '이 계획에는 시스템이 정한 날짜가 없습니다 — 날짜 출처를 USER 로 보내세요.'
        : `시스템이 정한 날짜는 ${systemDate} 입니다 — 날짜를 바꿨으면 출처를 USER 로 보내세요.`);
    }
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

    const fgOverride = judgeFgOverride(path, plan.fgWarehouseOverride, proposal.fg, order.plant_id, refs.warehouses, error);
    const fgRule: FgRule = fgOverride === null ? proposal.fg : { kind: 'MANUAL_WAREHOUSE', warehouse: fgOverride };
    const supplements = new Map<bigint, WorkOrderSupplement>();
    const windows = new Map<bigint, PlanWindow>();
    const timed: TimedOperation[] = [];
    const day = dayWindow(plan.planDate, dayStart, timezone);
    plan.workOrders.forEach((workOrder, at) => {
      const field = (name: string): string => `${path}.workOrders[${at}].${name}`;
      // 재검증 본문은 빈 칸을 받는다 — 확정 본문은 계약 가드가 막는다. 빈 칸은 「고르세요」 하나로 내고 자원 판정의 같은 뜻 사유는 뺀다.
      const empty = REQUIRED_RESOURCES.filter((name) => workOrder[name] === null || workOrder[name] === undefined);
      for (const name of empty) error(field(name), ERROR_CODE.REQUIRED, REQUIRED_MESSAGE[name]);
      const resources = {
        productionLineId: idOf(workOrder.productionLineId),
        equipmentId: idOf(workOrder.plannedEquipmentId),
        moldId: idOf(workOrder.plannedMoldId),
        defaultWipLocationId: idOf(workOrder.defaultWipLocationId),
        defaultFgLocationId: idOf(workOrder.defaultFgLocationId),
        defaultScrapLocationId: idOf(workOrder.defaultScrapLocationId),
      };
      // 제안이 사유를 내는 판정과 같은 것 — 「확정 가능」 제안을 그대로 보내면 여기서 막히지 않는다.
      for (const finding of resourceFindings(order.plant_id, resources, refs, fgRule)) {
        if (!EMPTY_CODES.has(finding.code)) error(field(finding.field), finding.code, finding.message);
      }
      const workerId = idOf(workOrder.responsibleWorkerId);
      if (workerId !== null) {
        const worker = refs.workers.get(workerId);
        if (worker === undefined || worker.plant_id !== order.plant_id || !worker.is_active) error(field('responsibleWorkerId'), ERROR_CODE.INVALID, '이 공장의 사용 중인 작업자가 아닙니다.');
      }
      const shiftId = idOf(workOrder.plannedShiftId);
      const shift = shiftId === null ? undefined : shifts.find((candidate) => candidate.shift_id === shiftId && candidate.is_active);
      if (shiftId !== null && shift === undefined) error(field('plannedShiftId'), ERROR_CODE.INVALID, '이 공장의 사용 중인 교대가 아닙니다.');
      const shiftTimes = shift === undefined
        ? null
        : shiftWindow(plan.planDate, { startTime: timeOfColumn(shift.start_time), endTime: timeOfColumn(shift.end_time) }, timezone);
      const time = judgeTime(`${path}.workOrders[${at}]`, workOrder, { system: shiftTimes ?? day, day, shift: shiftTimes, planDate: plan.planDate, timezone });
      errors.push(...time.errors);
      warnings.push(...time.warnings);
      corrections.push(...time.corrections);
      const window = time.window;
      const operationId = BigInt(workOrder.routingOperationId);
      windows.set(operationId, window);
      timed.push({ path: `${path}.workOrders[${at}]`, routingOperationId: operationId, source: workOrder.plannedTimeSourceCode, window });
      const { productionLineId, defaultWipLocationId, defaultFgLocationId, defaultScrapLocationId } = resources;
      if (productionLineId !== null && defaultWipLocationId !== null && defaultFgLocationId !== null && defaultScrapLocationId !== null) {
        supplements.set(operationId, { ...resources, productionLineId, defaultWipLocationId, defaultFgLocationId, defaultScrapLocationId, workerId, shiftId, window });
      }
    });
    warnings.push(...precedenceWarnings(timed, facts.dependencies.get(routingId) ?? [], timezone));
    return [{ index, body: plan, proposal: proposed, operationCount: operationIds.length, supplements, windows, fgOverride }];
  });

  return { resolved, errors, warnings, corrections };
}

export const PLAN_DATE_SOURCE_MISMATCH = 'PLAN_DATE_SOURCE_MISMATCH';

/**
 * 그 계획의 시스템 날짜 — 제안이 시스템 날짜로 낸 계획은 그 날(휴일 보정 뒤), 사람이 고른 날짜의 작성중 계획과 나누거나 더한 새 계획은
 * 새 계획 제안의 시스템 날짜다. 새 계획을 세울 수 없으면 없다.
 */
export function systemDateOf(proposal: Proposal, proposed: ProposalPlan): string | null {
  if (proposed.planDateSourceCode === 'SYSTEM') return proposed.planDate;
  return proposal.newPlanTemplate?.planDate ?? null;
}

/** 제안에 있는 키는 그 계획, 사람이 나누거나 더한 new-N 은 새 계획의 기준(시스템 날짜·기본 BOM·Routing). */
function proposedFor(proposal: Proposal, key: string): ProposalPlan | undefined {
  const proposed = proposal.plans.find((candidate) => candidate.key === key);
  if (proposed !== undefined) return proposed;
  return proposal.newPlanTemplate === null ? undefined : { ...proposal.newPlanTemplate, key };
}

export const draftRefsOf = (proposal: Proposal): DraftRef[] =>
  proposal.drafts.map(({ row }) => ({ productionPlanId: row.production_plan_id, versionNo: row.version_no, planNo: row.plan_no }));

const REQUIRED_RESOURCES = ['productionLineId', 'defaultWipLocationId', 'defaultFgLocationId', 'defaultScrapLocationId'] as const;
const REQUIRED_MESSAGE: Record<(typeof REQUIRED_RESOURCES)[number], string> = {
  productionLineId: '생산 라인이 비었습니다. 라인을 고르세요.',
  defaultWipLocationId: 'WIP 위치가 비었습니다. 위치를 고르세요.',
  defaultFgLocationId: '완제품 위치가 비었습니다. 위치를 고르세요.',
  defaultScrapLocationId: '스크랩 위치가 비었습니다. 위치를 고르세요.',
};
const EMPTY_CODES: ReadonlySet<string> = new Set(['WORK_ORDER_LINE_REQUIRED', 'WORK_ORDER_LOCATION_REQUIRED']);

/**
 * 이번 확정이 계획 수량 합계에 더하는 양 — 새 계획은 수량, 작성중 계획은 저장값과의 차, 새로 해서 지우는 작성중 계획(`replacedQty`)은 뺀다.
 * 오류 칸은 화면이 고칠 줄이다 — 수량을 늘린 첫 줄, 없으면 수량을 바꾼(줄였지만 아직 넘는) 첫 줄, 그것도 없으면 마지막 줄.
 */
export function quantityDelta(plans: readonly ResolvedPlan[], replacedQty: Prisma.Decimal = new Prisma.Decimal(0)): { delta: Prisma.Decimal; field: string } {
  const changes = plans.map((plan) => ({ index: plan.index, change: new Prisma.Decimal(plan.body.plannedQty).minus(plan.proposal.saved?.planned_qty ?? 0) }));
  const delta = changes.reduce((sum, { change }) => sum.plus(change), new Prisma.Decimal(0)).minus(replacedQty);
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
  const warehouseIds = ids(body.plans.map((plan) => plan.fgWarehouseOverride?.warehouseId));
  const [lines, equipments, molds, workers, locations, warehouses] = await Promise.all([
    client.production_line.findMany({ where: { production_line_id: { in: lineIds } }, select: { production_line_id: true, plant_id: true, is_active: true } }),
    client.equipment.findMany({ where: { equipment_id: { in: equipmentIds } }, select: { equipment_id: true, plant_id: true, status_code: true, is_active: true, production_line_id: true } }),
    client.mold.findMany({ where: { mold_id: { in: moldIds } }, select: { mold_id: true, plant_id: true, status_code: true, is_active: true } }),
    client.worker.findMany({ where: { worker_id: { in: workerIds } }, select: { worker_id: true, plant_id: true, is_active: true } }),
    client.location.findMany({
      where: { location_id: { in: locationIds } },
      select: LOCATION_FACT_SELECT,
    }),
    client.warehouse.findMany({
      where: { warehouse_id: { in: warehouseIds } },
      select: { warehouse_id: true, warehouse_code: true, warehouse_name: true, plant_id: true, is_active: true, warehouse_type_code: true, is_defect: true, is_external: true },
    }),
  ]);
  return {
    lines: new Map(lines.map((row) => [row.production_line_id, row])),
    equipments: new Map(equipments.map((row) => [row.equipment_id, row])),
    molds: new Map(molds.map((row) => [row.mold_id, row])),
    workers: new Map(workers.map((row) => [row.worker_id, row])),
    locations: new Map(locations.map((row) => [row.location_id, row])),
    warehouses: new Map(warehouses.map((row) => [row.warehouse_id, row])),
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
