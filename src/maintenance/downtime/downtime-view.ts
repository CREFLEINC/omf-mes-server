import { maintenanceInstantFromEpoch } from "../maintenance-instant";

export interface DowntimeRow {
  downtime_id: bigint;
  equipment_id: bigint;
  equipment_code: string;
  reason_code: string | null;
  reason_name: string | null;
  started_epoch_us: string;
  ended_epoch_us: string | null;
  breakdown_id: bigint | null;
  recorded_by_worker_no: string | null;
  remarks: string | null;
  version_no: number;
}

export interface DowntimeView {
  downtimeId: number;
  equipmentId: number;
  equipmentCode: string;
  reasonCode: string;
  reasonName?: string;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  breakdownId: number | null;
  workSessionId: null;
  recordedByWorkerNo: string;
  remarks: string | null;
}

function id(value: bigint, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error(`Invalid stored ${name}`);
  return result;
}

function requiredText(value: string | null, name: string, max: number): string {
  if (value === null || value.trim() === "" || value.length > max) {
    throw new Error(`Invalid stored ${name}`);
  }
  return value;
}

function duration(start: bigint, end: bigint | null): number | null {
  if (end === null) return null;
  const elapsed = end - start;
  if (elapsed < 0n) throw new Error("Invalid stored downtime range");
  if (elapsed % 60_000_000n !== 0n) return null;
  const minutes = Number(elapsed / 60_000_000n);
  if (!Number.isSafeInteger(minutes))
    throw new Error("Downtime duration exceeds safe range");
  return minutes;
}

export function downtimeView(row: DowntimeRow): DowntimeView {
  const started = maintenanceInstantFromEpoch(row.started_epoch_us);
  const ended =
    row.ended_epoch_us === null
      ? null
      : maintenanceInstantFromEpoch(row.ended_epoch_us);
  const reasonCode = requiredText(row.reason_code, "downtime reason code", 50);
  const recordedBy = requiredText(
    row.recorded_by_worker_no,
    "downtime worker number",
    50,
  );
  const reasonName =
    row.reason_name === null
      ? undefined
      : requiredText(row.reason_name, "downtime reason name", 200);
  return {
    downtimeId: id(row.downtime_id, "downtime id"),
    equipmentId: id(row.equipment_id, "downtime equipment id"),
    equipmentCode: requiredText(
      row.equipment_code,
      "downtime equipment code",
      50,
    ),
    reasonCode,
    ...(reasonName === undefined ? {} : { reasonName }),
    startedAt: started.utcIso,
    endedAt: ended?.utcIso ?? null,
    durationMinutes: duration(
      started.epochMicroseconds,
      ended?.epochMicroseconds ?? null,
    ),
    breakdownId:
      row.breakdown_id === null
        ? null
        : id(row.breakdown_id, "downtime breakdown id"),
    workSessionId: null,
    recordedByWorkerNo: recordedBy,
    remarks: row.remarks,
  };
}
