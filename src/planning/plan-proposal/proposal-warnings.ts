import { Prisma } from '@prisma/client';

import { RELEASED_WORK_ORDER_STATUSES } from '../../core/work-order';
import {
  RivalWindow,
  checkCalibration,
  checkDoubleBooked,
  checkMoldLife,
  checkQualification,
  localToday,
  validProcessQualification,
} from '../../production/work-order/validation';
import { ResolvedPlan } from './proposal-confirm-check';
import { OrderRow, ProposalFacts } from './proposal-reader';

/** 재검증 경고 하나 — field 는 본문 경로다. */
export interface RevalidationWarning {
  code: string;
  field: string;
  message: string;
}

interface Row {
  path: string;
  processId: bigint | null;
  equipmentId: bigint | null;
  moldId: bigint | null;
  workerId: bigint | null;
  window: { planned_start_at: Date; planned_end_at: Date };
}

/**
 * 본문이 고른 4M·시각으로 4M 점검의 WARN(교정 기한·금형 수명·작업자 자격·설비 시간 중복)을 다시 본다 — 판정은 4M 점검의 함수 그대로다.
 * 설비 시간 중복은 저장된 다른 MES W/O 와 «이 본문의 다른 공정 W/O» 를 함께 본다. 확정은 WARN 을 다시 보지 않는다.
 */
export async function workOrderWarnings(
  client: Prisma.TransactionClient,
  order: OrderRow,
  facts: ProposalFacts,
  resolved: readonly ResolvedPlan[],
  now: Date,
): Promise<RevalidationWarning[]> {
  const rows: Row[] = resolved.flatMap((plan) => {
    const operations = facts.operations.get(BigInt(plan.body.routingId)) ?? [];
    return plan.body.workOrders.map((workOrder, at): Row => {
      const operationId = BigInt(workOrder.routingOperationId);
      const window = plan.windows.get(operationId);
      if (window === undefined) throw new Error(`판정이 공정 W/O 를 빠뜨렸다: ${operationId}`);
      return {
        path: `plans[${plan.index}].workOrders[${at}]`,
        processId: operations.find((operation) => operation.routing_operation_id === operationId)?.process_id ?? null,
        equipmentId: idOf(workOrder.plannedEquipmentId),
        moldId: idOf(workOrder.plannedMoldId),
        workerId: idOf(workOrder.responsibleWorkerId),
        window: { planned_start_at: window.plannedStartAt, planned_end_at: window.plannedEndAt },
      };
    });
  });
  const today = localToday(now, order.plant.timezone_code);
  const equipmentIds = unique(rows.map((row) => row.equipmentId));
  const moldIds = unique(rows.map((row) => row.moldId));
  const pairs = rows.filter((row) => row.workerId !== null && row.processId !== null);
  const [equipments, molds, rivals, qualifications] = await Promise.all([
    equipmentIds.length === 0 ? [] : client.equipment.findMany({
      where: { equipment_id: { in: equipmentIds } },
      select: { equipment_id: true, status_code: true, is_active: true, calibration_required: true, calibration_due_date: true },
    }),
    moldIds.length === 0 ? [] : client.mold.findMany({
      where: { mold_id: { in: moldIds } },
      select: { mold_id: true, status_code: true, is_active: true, guaranteed_shot_count: true, current_shot_count: true },
    }),
    equipmentIds.length === 0 ? [] : client.work_order.findMany({
      where: { planned_equipment_id: { in: equipmentIds }, planned_start_at: { not: null }, planned_end_at: { not: null }, status_code: { notIn: RELEASED_WORK_ORDER_STATUSES } },
      select: { planned_equipment_id: true, planned_start_at: true, planned_end_at: true },
    }),
    pairs.length === 0 ? [] : client.worker_qualification.findMany({
      where: { OR: pairs.map((row) => ({ worker_id: row.workerId as bigint, ...validProcessQualification(row.processId as bigint, today) })) },
      select: { worker_id: true, process_id: true },
    }),
  ]);
  const equipmentFacts = new Map(equipments.map((row) => [row.equipment_id, row]));
  const moldFacts = new Map(molds.map((row) => [row.mold_id, row]));
  const qualified = new Set(qualifications.map((row) => `${row.worker_id}:${row.process_id}`));

  return rows.flatMap((row, index) => {
    const equipment = row.equipmentId === null ? [] : [row.equipmentId];
    const others: RivalWindow[] = rows
      .filter((other, at) => at !== index && other.equipmentId !== null)
      .map((other) => ({ planned_equipment_id: other.equipmentId, ...other.window }));
    const worker = row.workerId === null || row.processId === null ? [] : [row.workerId];
    const findings = [
      ...checkCalibration(equipment, equipmentFacts, today),
      ...checkMoldLife(row.moldId === null ? [] : [row.moldId], moldFacts),
      ...checkQualification(worker, qualified.has(`${row.workerId}:${row.processId}`) ? new Set(worker) : new Set()),
      ...checkDoubleBooked(equipment, row.window, [...rivals, ...others]),
    ];
    return findings.map((finding) => ({ code: finding.code, field: `${row.path}.${finding.field}`, message: finding.message }));
  });
}

const idOf = (value: number | null | undefined): bigint | null => (value === undefined || value === null ? null : BigInt(value));

function unique(ids: readonly (bigint | null)[]): bigint[] {
  return [...new Set(ids.filter((id): id is bigint => id !== null))];
}
