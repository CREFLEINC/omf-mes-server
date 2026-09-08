import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field, one } from "../../common/errors";
import { moldPmFacts } from "../../core/mold-pm";
import {
  LockedOrderEquipment,
  assertMaintenanceOrderAssignments,
} from "./order-create-assignment";
import { checkMaintenanceOrderCreate } from "./order-create-input";

type CheckedOrder = ReturnType<typeof checkMaintenanceOrderCreate>;
type CheckedTrigger = CheckedOrder["triggers"][number];
type Tx = Prisma.TransactionClient;

interface EquipmentTarget extends LockedOrderEquipment {
  status_code: string;
  is_active: boolean;
}

interface MoldTarget {
  mold_id: bigint;
  plant_id: bigint;
  timezone_code: string;
  status_code: string;
  is_active: boolean;
  pm_trigger_type_code: string;
  guaranteed_shot_count: bigint | null;
  current_shot_count: bigint;
  last_pm_date: Date | null;
  pm_cycle_interval: number | null;
  pm_cycle_unit_code: string | null;
}

interface SourceRow {
  source_id: bigint;
  equipment_id: bigint;
  state_code: string | null;
}

interface IndexedTrigger {
  trigger: CheckedTrigger;
  index: number;
}

/** 전달 tx 안에서 대상부터 잠그고 담당자·원천·부여·PM 사실을 확정한다. */
export async function resolveMaintenanceOrderReferences(
  tx: Tx,
  input: CheckedOrder,
  now = new Date(),
) {
  const target = await lockTarget(tx, input);
  assertTargetUsable(target);
  const assignee = await tx.app_user.findFirst({
    where: { app_user_id: input.assigneeUserId, is_active: true },
    select: { app_user_id: true },
  });
  if (assignee === null)
    throw invalid("assigneeUserId", "없는 사용 중 계정입니다.");

  if ("equipment_id" in target) {
    await assertMaintenanceOrderAssignments(tx, target, input.items);
    await assertEquipmentSources(tx, target.equipment_id, input.triggers);
    return {
      plantId: target.plant_id,
      equipmentId: target.equipment_id,
      moldId: null,
    };
  }
  await assertMoldPm(tx, target, input, now);
  return {
    plantId: target.plant_id,
    equipmentId: null,
    moldId: target.mold_id,
  };
}

async function lockTarget(
  tx: Tx,
  input: CheckedOrder,
): Promise<EquipmentTarget | MoldTarget> {
  if (input.targetTypeCode === "EQUIPMENT") {
    const rows = await tx.$queryRaw<EquipmentTarget[]>`
      SELECT equipment_id,plant_id,production_line_id,status_code,is_active
      FROM mdm.equipment WHERE equipment_id=${input.targetId}
      FOR NO KEY UPDATE`;
    if (!rows[0]) throw invalid("targetId", "없는 설비입니다.");
    return rows[0];
  }
  const rows = await tx.$queryRaw<MoldTarget[]>`
    SELECT m.mold_id,m.plant_id,p.timezone_code,m.status_code,m.is_active,
      m.pm_trigger_type_code,m.guaranteed_shot_count,m.current_shot_count,
      m.last_pm_date,m.pm_cycle_interval,m.pm_cycle_unit_code
    FROM mdm.mold m JOIN mdm.plant p ON p.plant_id=m.plant_id
    WHERE m.mold_id=${input.targetId} FOR NO KEY UPDATE OF m`;
  if (!rows[0]) throw invalid("targetId", "없는 툴입니다.");
  return rows[0];
}

function assertTargetUsable(target: EquipmentTarget | MoldTarget): void {
  if (target.status_code === "DISPOSED")
    throw one(
      field(
        "targetId",
        ERROR_CODE.STATE_LOCKED,
        "폐기한 대상에는 지시할 수 없습니다.",
      ),
    );
  if (!target.is_active)
    throw invalid("targetId", "사용 중지한 대상에는 지시할 수 없습니다.");
}

async function assertEquipmentSources(
  tx: Tx,
  equipmentId: bigint,
  triggers: CheckedTrigger[],
): Promise<void> {
  const indexed = triggers.map((trigger, index) => ({ trigger, index }));
  const breakdowns = indexed.filter(
    ({ trigger }) => trigger.triggerTypeCode === "BREAKDOWN",
  );
  const inspections = indexed.filter(
    ({ trigger }) => trigger.triggerTypeCode === "INSPECTION_NG",
  );
  const breakdownRows = await lockSources(tx, "BREAKDOWN", breakdowns);
  const inspectionRows = await lockSources(tx, "INSPECTION_NG", inspections);
  assertSources(breakdowns, breakdownRows, equipmentId, [
    "RECEIVED",
    "HANDLING",
  ]);
  assertSources(inspections, inspectionRows, equipmentId, ["FAIL"]);

  const sourced = [...breakdowns, ...inspections];
  if (!sourced.length) return;
  const linked = await tx.maintenance_order_trigger.findMany({
    where: {
      OR: sourced.map(({ trigger }) => ({
        trigger_type_code: trigger.triggerTypeCode,
        source_id: trigger.sourceId,
      })),
    },
    select: { trigger_type_code: true, source_id: true },
  });
  const keys = new Set(
    linked.map((row) => `${row.trigger_type_code}:${row.source_id}`),
  );
  sourced.forEach(({ trigger, index }) => {
    if (keys.has(`${trigger.triggerTypeCode}:${trigger.sourceId}`))
      throw unprocessable(
        `triggers[${index}].sourceId`,
        "이미 다른 보전 지시에 연결된 원천입니다.",
      );
  });
}

async function lockSources(
  tx: Tx,
  type: "BREAKDOWN" | "INSPECTION_NG",
  triggers: IndexedTrigger[],
): Promise<SourceRow[]> {
  const ids = triggers
    .map(({ trigger }) => trigger.sourceId as bigint)
    .sort(bigintOrder);
  if (!ids.length) return [];
  if (type === "BREAKDOWN")
    return tx.$queryRaw<SourceRow[]>(Prisma.sql`
      SELECT breakdown_id AS source_id,equipment_id,status_code AS state_code
      FROM maintenance.breakdown WHERE breakdown_id IN (${Prisma.join(ids)})
      ORDER BY breakdown_id FOR SHARE`);
  return tx.$queryRaw<SourceRow[]>(Prisma.sql`
    SELECT equipment_inspection_id AS source_id,equipment_id,judgment_code AS state_code
    FROM maintenance.equipment_inspection
    WHERE equipment_inspection_id IN (${Prisma.join(ids)})
    ORDER BY equipment_inspection_id FOR SHARE`);
}

function assertSources(
  triggers: IndexedTrigger[],
  rows: SourceRow[],
  equipmentId: bigint,
  states: string[],
): void {
  const byId = new Map(rows.map((row) => [row.source_id.toString(), row]));
  triggers.forEach(({ trigger, index }) => {
    const row = byId.get(trigger.sourceId?.toString() ?? "");
    if (
      !row ||
      row.equipment_id !== equipmentId ||
      !states.includes(row.state_code ?? "")
    ) {
      throw invalid(
        `triggers[${index}].sourceId`,
        "대상과 상태가 맞는 현재 촉발 원천이 아닙니다.",
      );
    }
  });
}

async function assertMoldPm(
  tx: Tx,
  mold: MoldTarget,
  input: CheckedOrder,
  now: Date,
): Promise<void> {
  const facts = moldPmFacts({
    triggerTypeCode: mold.pm_trigger_type_code,
    guaranteedShotCount: mold.guaranteed_shot_count,
    currentShotCount: mold.current_shot_count,
    lastPmDate: mold.last_pm_date,
    cycleInterval: mold.pm_cycle_interval,
    cycleUnitCode: mold.pm_cycle_unit_code,
    today: localToday(now, mold.timezone_code),
  });
  if (!facts.pmDue)
    throw unprocessable("targetId", "현재 예방보전 도래 대상이 아닙니다.");
  const trigger = input.triggers[0];
  assertSnapshot("pmDueAxisCode", trigger.pmDueAxisCode, facts.pmDueAxisCode);
  assertSnapshot(
    "shotCountAtDue",
    trigger.shotCountAtDue,
    facts.shotCountAtDue,
  );
  assertSnapshot(
    "guaranteedShotCountAtDue",
    trigger.guaranteedShotCountAtDue,
    facts.guaranteedShotCountAtDue,
  );
  const open = await tx.maintenance_order.count({
    where: {
      mold_id: mold.mold_id,
      status_code: { notIn: ["DONE", "CANCELLED"] },
    },
  });
  if (open)
    throw unprocessable("targetId", "이미 열린 금형 예방보전 지시가 있습니다.");
}

function assertSnapshot(
  name: string,
  provided: bigint | string | null | undefined,
  current: bigint | string | null,
): void {
  if (provided !== undefined && provided !== current)
    throw unprocessable(
      `triggers[0].${name}`,
      "현재 예방보전 사실과 다른 스냅샷입니다.",
    );
}

function localToday(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function invalid(name: string, message: string): ContractException {
  return one(field(name, ERROR_CODE.INVALID, message));
}

function unprocessable(name: string, message: string): ContractException {
  return new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
    field(name, ERROR_CODE.INVALID, message),
  ]);
}

function bigintOrder(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
