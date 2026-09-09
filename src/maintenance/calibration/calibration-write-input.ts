import { HttpStatus } from "@nestjs/common";

import { ContractException, ERROR_CODE, field, one } from "../../common/errors";

export const CALIBRATION_HISTORY_GROUP = "CALIBRATION_HISTORY_TYPE";
export const CALIBRATION_RESULT_GROUP = "CALIBRATION_RESULT";
export const CALIBRATION_AGENCY_GROUP = "CALIBRATION_AGENCY_TYPE";

const MASTER_PASS_RESULTS = new Set(["PASS", "ADJUSTED"]);
const MASTER_FAIL_RESULTS = new Set(["FAIL"]);

export interface CalibrationCreate {
  equipmentId: number;
  historyTypeCode: string;
  performedOn: string;
  resultCode: string;
  certificateNo?: string | null;
  agencyTypeCode?: string | null;
  agencyName?: string | null;
  nextDueOn?: string | null;
  toleranceNote?: string | null;
  performedByUserId?: number | null;
  remarks?: string | null;
  blocksUse?: boolean;
}

export interface CheckedCalibrationCreate {
  equipmentId: bigint;
  historyTypeCode: string;
  performedOn: string;
  resultCode: string;
  certificateNo: string | null;
  agencyTypeCode: string | null;
  agencyName: string | null;
  nextDueOn: string | null;
  toleranceNote: string | null;
  performedByUserId: bigint | null;
  remarks: string | null;
  blocksUse: boolean;
}

export type CalibrationMasterEffect = "UPDATE_MASTER" | "HISTORY_ONLY";

export function checkCalibrationCreate(input: CalibrationCreate): CheckedCalibrationCreate {
  const equipmentId = id("equipmentId", input.equipmentId);
  const performedByUserId =
    input.performedByUserId == null
      ? null
      : id("performedByUserId", input.performedByUserId);
  checkLength("historyTypeCode", input.historyTypeCode, 50);
  checkLength("resultCode", input.resultCode, 50);
  checkLength("certificateNo", input.certificateNo, 100);
  checkLength("agencyTypeCode", input.agencyTypeCode, 50);
  checkLength("agencyName", input.agencyName, 200);

  const agencyTypeCode = input.agencyTypeCode ?? null;
  const agencyName = input.agencyName ?? null;
  if (input.nextDueOn !== null && input.nextDueOn !== undefined) {
    if (input.nextDueOn < input.performedOn) {
      throw one(
        field("nextDueOn", ERROR_CODE.RANGE, "차기 기한은 수행일보다 빠를 수 없습니다."),
      );
    }
  }
  if (input.historyTypeCode !== "CALIBRATION" && agencyTypeCode !== null) {
    throw one(
      field(
        "agencyTypeCode",
        ERROR_CODE.INVALID,
        "검교정 유형이 아닌 이력에는 기관 구분을 보낼 수 없습니다.",
      ),
    );
  }
  if (input.historyTypeCode === "CALIBRATION" && agencyTypeCode === "EXTERNAL") {
    if (!agencyName?.trim()) {
      throw one(
        field("agencyName", ERROR_CODE.REQUIRED, "외부 검교정 기관 이름이 필요합니다."),
      );
    }
    if (performedByUserId !== null) {
      throw one(
        field(
          "performedByUserId",
          ERROR_CODE.PAIR,
          "외부 검교정에는 내부 수행자를 함께 보낼 수 없습니다.",
        ),
      );
    }
  }

  return {
    equipmentId,
    historyTypeCode: input.historyTypeCode,
    performedOn: input.performedOn,
    resultCode: input.resultCode,
    certificateNo: input.certificateNo ?? null,
    agencyTypeCode,
    agencyName,
    nextDueOn: input.nextDueOn ?? null,
    toleranceNote: input.toleranceNote ?? null,
    performedByUserId,
    remarks: input.remarks ?? null,
    blocksUse: input.blocksUse ?? false,
  };
}

export function calibrationMasterEffect(
  input: CheckedCalibrationCreate,
): CalibrationMasterEffect {
  if (input.historyTypeCode !== "CALIBRATION") return "HISTORY_ONLY";
  if (MASTER_PASS_RESULTS.has(input.resultCode)) return "UPDATE_MASTER";
  if (MASTER_FAIL_RESULTS.has(input.resultCode)) return "HISTORY_ONLY";
  throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
    field(
      "resultCode",
      ERROR_CODE.STATE_LOCKED,
      "검교정 확장 결과의 설비 마스터 갱신 의미가 정해지지 않았습니다.",
    ),
  ]);
}

function id(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value)) {
    throw one(field(name, ERROR_CODE.RANGE, "식별자 범위가 너무 큽니다."));
  }
  return BigInt(value);
}

function checkLength(name: string, value: string | null | undefined, max: number): void {
  if (value !== null && value !== undefined && value.length > max) {
    throw one(field(name, ERROR_CODE.RANGE, `${max}자 이하여야 합니다.`));
  }
}
