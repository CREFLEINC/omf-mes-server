import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  ContractException,
  ERROR_CODE,
  ErrorItem,
  field,
  one,
} from "../../common/errors";
import {
  MaintenanceInstant,
  parseMaintenanceInstant,
} from "../maintenance-instant";

export interface ToolUsageCreate {
  moldId: number;
  workOrderId: number;
  shotCount: number;
  collectionMethodCode: "DIRECT" | "CONVERTED";
  conversionBaseQty?: number | null;
  conversionRatio?: number | null;
  occurredAt: string;
}

export interface CheckedToolUsageCreate {
  moldId: bigint;
  workOrderId: bigint;
  shotCount: bigint;
  collectionMethodCode: ToolUsageCreate["collectionMethodCode"];
  conversionBaseQty: Prisma.Decimal | null;
  conversionRatio: Prisma.Decimal | null;
  occurredAt: MaintenanceInstant;
}

export function checkToolUsageCreate(
  input: ToolUsageCreate,
): CheckedToolUsageCreate {
  const moldId = id("moldId", input.moldId);
  const workOrderId = id("workOrderId", input.workOrderId);
  if (!Number.isSafeInteger(input.shotCount) || input.shotCount < 1) {
    throw one(
      field(
        "shotCount",
        ERROR_CODE.RANGE,
        "타발수는 1 이상의 안전한 정수여야 합니다.",
      ),
    );
  }
  if (
    input.collectionMethodCode !== "DIRECT" &&
    input.collectionMethodCode !== "CONVERTED"
  ) {
    throw one(
      field(
        "collectionMethodCode",
        ERROR_CODE.INVALID,
        "지원하지 않는 수집 방법입니다.",
      ),
    );
  }

  const occurredAt = parseMaintenanceInstant(input.occurredAt, "occurredAt");
  const pair = conversionPair(input);
  return {
    moldId,
    workOrderId,
    shotCount: BigInt(input.shotCount),
    collectionMethodCode: input.collectionMethodCode,
    ...pair,
    occurredAt,
  };
}

function conversionPair(input: ToolUsageCreate): {
  conversionBaseQty: Prisma.Decimal | null;
  conversionRatio: Prisma.Decimal | null;
} {
  const base = input.conversionBaseQty;
  const ratio = input.conversionRatio;
  if (input.collectionMethodCode === "DIRECT") {
    if (base != null || ratio != null) {
      throw one(
        field(
          base != null ? "conversionBaseQty" : "conversionRatio",
          ERROR_CODE.INVALID,
          "직접 입력에는 환산 근거를 보낼 수 없습니다.",
        ),
      );
    }
    return { conversionBaseQty: null, conversionRatio: null };
  }

  if (base == null && ratio == null) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field(
        "conversionBaseQty",
        ERROR_CODE.REQUIRED,
        "환산 기준 수량이 필요합니다.",
      ),
      field("conversionRatio", ERROR_CODE.REQUIRED, "환산 비율이 필요합니다."),
    ]);
  }
  if (base == null || ratio == null) {
    const missing = base == null ? "conversionBaseQty" : "conversionRatio";
    throw one(
      field(missing, ERROR_CODE.PAIR, "두 환산 근거를 함께 보내야 합니다."),
    );
  }
  const errors: ErrorItem[] = [];
  const conversionBaseQty = decimal("conversionBaseQty", base, errors);
  const conversionRatio = decimal("conversionRatio", ratio, errors);
  if (errors.length)
    throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return { conversionBaseQty, conversionRatio };
}

function decimal(
  name: string,
  value: number,
  errors: ErrorItem[],
): Prisma.Decimal {
  if (!Number.isFinite(value) || value <= 0) {
    errors.push(field(name, ERROR_CODE.RANGE, "양의 유한한 수여야 합니다."));
    return new Prisma.Decimal(1);
  }
  const result = new Prisma.Decimal(value);
  const integerDigits = result.trunc().abs().toFixed(0).length;
  if (
    result.decimalPlaces() > 6 ||
    integerDigits > 14 ||
    result.toNumber() !== value
  ) {
    errors.push(
      field(
        name,
        ERROR_CODE.RANGE,
        "정수 14자리와 소수 6자리 안에서 보존돼야 합니다.",
      ),
    );
  }
  return result;
}

function id(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value)) {
    throw one(field(name, ERROR_CODE.RANGE, "식별자 범위가 너무 큽니다."));
  }
  return BigInt(value);
}
