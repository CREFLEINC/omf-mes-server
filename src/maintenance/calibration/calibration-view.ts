import { maintenanceInstantFromEpoch } from "../maintenance-instant";

export interface CalibrationProjection {
  equipment_calibration_id: bigint;
  equipment_id: bigint;
  equipment_code: string;
  history_type_code: string | null;
  performed_on: string;
  result_code: string;
  certificate_no: string | null;
  agency_type_code: string | null;
  agency_name: string | null;
  next_due_on: string | null;
  tolerance_note: string | null;
  recorded_by: bigint | null;
  calibrated_by: bigint | null;
  remarks: string | null;
  blocks_use: boolean;
  cleared_epoch_microseconds: string | null;
}

export interface CalibrationView {
  calibrationId: number;
  equipmentId: number;
  equipmentCode: string;
  historyTypeCode: string;
  performedOn: string;
  resultCode: string;
  certificateNo: string | null;
  agencyTypeCode: string | null;
  agencyName: string | null;
  nextDueOn: string | null;
  toleranceNote: string | null;
  recordedByUserId?: number;
  performedByUserId: number | null;
  remarks: string | null;
  blocksUse: boolean;
  clearedAt: string | null;
}

export function calibrationView(row: CalibrationProjection): CalibrationView {
  const view: CalibrationView = {
    calibrationId: safeInt(row.equipment_calibration_id, "calibrationId"),
    equipmentId: safeInt(row.equipment_id, "equipmentId"),
    equipmentCode: row.equipment_code,
    historyTypeCode: required(row.history_type_code, "historyTypeCode"),
    performedOn: row.performed_on,
    resultCode: row.result_code,
    certificateNo: row.certificate_no,
    agencyTypeCode: row.agency_type_code,
    agencyName: row.agency_name,
    nextDueOn: row.next_due_on,
    toleranceNote: row.tolerance_note,
    performedByUserId:
      row.calibrated_by === null ? null : safeInt(row.calibrated_by, "performedByUserId"),
    remarks: row.remarks,
    blocksUse: row.blocks_use,
    clearedAt:
      row.cleared_epoch_microseconds === null
        ? null
        : maintenanceInstantFromEpoch(row.cleared_epoch_microseconds).utcIso,
  };
  if (row.recorded_by !== null) {
    view.recordedByUserId = safeInt(row.recorded_by, "recordedByUserId");
  }
  return view;
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`Missing required calibration field: ${name}`);
  return value;
}

function safeInt(value: bigint, name: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error(`Calibration integer exceeds safe range: ${name}`);
  }
  return converted;
}
