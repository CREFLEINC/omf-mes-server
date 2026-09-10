import { HttpStatus, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { assertUpdated } from "../../common/optimistic-lock";
import type { MaintenanceInstant } from "../maintenance-instant";

export type DowntimeTx = Prisma.TransactionClient;
export interface DowntimeCreate {
  equipmentId: number;
  reasonCode: string;
  startedAt: string;
  endedAt?: string | null;
  breakdownId?: number | null;
  remarks?: string | null;
}
export interface DowntimeUpdate {
  reasonCode?: string;
  endedAt?: string | null;
  breakdownId?: number | null;
  remarks?: string | null;
}
export interface LockedDowntime {
  downtime_id: bigint;
  equipment_id: bigint;
  version_no: number;
  started_epoch_us: string;
  ended_epoch_us: string | null;
}

type BreakdownRow = { equipment_id: bigint; status_code: string };

function invalid(name: string, message: string): ContractException {
  return new ContractException(400, [field(name, ERROR_CODE.INVALID, message)]);
}

function locked(
  status: number,
  name: string,
  message: string,
): ContractException {
  return new ContractException(status, [
    field(name, ERROR_CODE.STATE_LOCKED, message),
  ]);
}

export async function assertDowntimeReason(
  tx: DowntimeTx,
  reasonCode: string,
): Promise<void> {
  const reason = await tx.code_value.findFirst({
    where: {
      code: reasonCode,
      is_active: true,
      code_group: { group_code: "DOWNTIME_REASON", is_active: true },
    },
    select: { code_value_id: true },
  });
  if (reason === null)
    throw invalid("reasonCode", "사용할 수 없는 비가동 사유입니다.");
}

/** 없는 open 행의 틈 대신 설비 한 행을 잠가 같은 설비의 쓰기를 직렬화한다. */
export async function lockDowntimeEquipment(
  tx: DowntimeTx,
  equipmentId: number | bigint,
): Promise<bigint> {
  const rows = await tx.$queryRaw<{ equipment_id: bigint }[]>`
    SELECT equipment_id FROM mdm.equipment
    WHERE equipment_id=${BigInt(equipmentId)} FOR UPDATE`;
  if (!rows[0]) throw invalid("equipmentId", "없는 설비입니다.");
  return rows[0].equipment_id;
}

export async function lockDowntimeForUpdate(
  tx: DowntimeTx,
  downtimeId: number,
): Promise<LockedDowntime> {
  const targets = await tx.$queryRaw<{ equipment_id: bigint }[]>`
    SELECT equipment_id FROM maintenance.equipment_downtime
    WHERE equipment_downtime_id=${BigInt(downtimeId)}`;
  if (!targets[0]) throw new NotFoundException("없는 비가동 기록입니다.");
  await lockDowntimeEquipment(tx, targets[0].equipment_id);
  const rows = await tx.$queryRaw<LockedDowntime[]>`
    SELECT equipment_downtime_id AS downtime_id,equipment_id,version_no,
      (extract(epoch FROM started_at)*1000000)::bigint::text AS started_epoch_us,
      CASE WHEN ended_at IS NULL THEN NULL ELSE
        (extract(epoch FROM ended_at)*1000000)::bigint::text END AS ended_epoch_us
    FROM maintenance.equipment_downtime
    WHERE equipment_downtime_id=${BigInt(downtimeId)} FOR UPDATE`;
  if (!rows[0]) throw new NotFoundException("없는 비가동 기록입니다.");
  return rows[0];
}

export function assertDowntimeVersion(
  row: LockedDowntime,
  version: number,
): void {
  if (row.version_no !== version) assertUpdated(0, "user");
}

export function assertDowntimeWindow(
  started: MaintenanceInstant,
  ended: MaintenanceInstant | null,
): void {
  if (ended === null || ended.epochMicroseconds >= started.epochMicroseconds)
    return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field("startedAt", ERROR_CODE.PAIR, "종료 시각보다 늦을 수 없습니다."),
    field("endedAt", ERROR_CODE.PAIR, "시작 시각보다 이를 수 없습니다."),
  ]);
}

export async function assertNoOpenDowntime(
  tx: DowntimeTx,
  equipmentId: bigint,
): Promise<void> {
  const rows = await tx.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found FROM maintenance.equipment_downtime
    WHERE equipment_id=${equipmentId} AND ended_at IS NULL LIMIT 1`;
  if (rows.length)
    throw locked(
      HttpStatus.UNPROCESSABLE_ENTITY,
      "equipmentId",
      "이미 진행 중인 비가동이 있습니다.",
    );
}

export async function assertDowntimeBreakdown(
  tx: DowntimeTx,
  breakdownId: number | null | undefined,
  equipmentId: bigint,
  operation: "create" | "update",
): Promise<void> {
  if (breakdownId == null) return;
  const rows = await tx.$queryRaw<BreakdownRow[]>`
    SELECT equipment_id,status_code FROM maintenance.breakdown
    WHERE breakdown_id=${BigInt(breakdownId)} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw invalid("breakdownId", "없는 고장 기록입니다.");
  if (row.equipment_id !== equipmentId) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field("equipmentId", ERROR_CODE.PAIR, "고장과 같은 설비여야 합니다."),
      field("breakdownId", ERROR_CODE.PAIR, "선택 설비의 고장이 아닙니다."),
    ]);
  }
  if (row.status_code !== "RECEIVED" && row.status_code !== "HANDLING") {
    const status =
      operation === "create"
        ? HttpStatus.UNPROCESSABLE_ENTITY
        : HttpStatus.BAD_REQUEST;
    throw locked(status, "breakdownId", "열린 고장만 새로 연결할 수 있습니다.");
  }
}

export function assertDowntimeNotReopened(
  row: LockedDowntime,
  endedAt: string | null | undefined,
): void {
  if (endedAt !== null || row.ended_epoch_us === null) return;
  throw locked(400, "endedAt", "종료된 비가동은 다시 열 수 없습니다.");
}
