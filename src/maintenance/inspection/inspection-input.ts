import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field, one } from "../../common/errors";

export interface InspectionLineCreate {
  inspectionItemId: number;
  resultCode: "PASS" | "FAIL";
  measuredValue?: number | null;
  remarks?: string | null;
}

export interface InspectionCreate {
  equipmentId: number;
  inspectionTypeCode: string;
  inspectedAt: string;
  remarks?: string | null;
  lines: InspectionLineCreate[];
}

export interface CheckedInspectionLine extends InspectionLineCreate {
  numericValue: Prisma.Decimal | null;
}

export function checkInspectionInput(input: InspectionCreate): {
  overallResultCode: "PASS" | "FAIL";
  lines: CheckedInspectionLine[];
} {
  if (input.lines.length === 0) {
    throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
      field(
        "lines",
        ERROR_CODE.LINE_REQUIRED,
        "점검 항목이 한 건 이상 필요합니다.",
      ),
    ]);
  }
  const seen = new Set<number>();
  const lines = input.lines.map((line, index) => {
    if (seen.has(line.inspectionItemId)) {
      throw one(
        field(
          `lines[${index}].inspectionItemId`,
          ERROR_CODE.INVALID,
          "같은 점검 항목을 두 번 보낼 수 없습니다.",
        ),
      );
    }
    seen.add(line.inspectionItemId);
    return { ...line, numericValue: decimalValue(line.measuredValue, index) };
  });
  const overallResultCode = lines.some((line) => line.resultCode === "FAIL")
    ? "FAIL"
    : "PASS";
  if (overallResultCode === "FAIL" && !input.remarks?.trim()) {
    throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
      field(
        "remarks",
        ERROR_CODE.REQUIRED,
        "불합격 점검은 전체 비고가 필요합니다.",
      ),
    ]);
  }
  return { overallResultCode, lines };
}

function decimalValue(
  value: number | null | undefined,
  index: number,
): Prisma.Decimal | null {
  if (value == null) return null;
  const decimal = new Prisma.Decimal(value);
  if (
    !Number.isFinite(value) ||
    decimal.decimalPlaces() > 6 ||
    decimal.abs().gte("100000000000000")
  ) {
    throw one(
      field(
        `lines[${index}].measuredValue`,
        ERROR_CODE.RANGE,
        "측정값은 정수 14자리와 소수 6자리 안에서 정확히 저장할 수 있어야 합니다.",
      ),
    );
  }
  return decimal;
}
