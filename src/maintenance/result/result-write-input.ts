import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field, one } from "../../common/errors";
import {
  MaintenanceInstant,
  parseMaintenanceInstant,
} from "../maintenance-instant";

export type MaintenanceResultTargetType = "EQUIPMENT" | "MOLD";

export interface MaintenanceResultLineInput {
  orderItemId?: number | null;
  partName?: string | null;
  resultCode: string;
  remarks?: string | null;
}

export interface MaintenanceResultPartInput {
  sparePartId: number;
  partName?: string;
  usedQty: number;
  goodsIssueId?: number | null;
}

export interface MaintenanceResultCreate {
  maintenanceOrderId?: number | null;
  breakdownId?: number | null;
  targetTypeCode: MaintenanceResultTargetType;
  targetId: number;
  startedAt: string;
  finishedAt?: string | null;
  resultNote: string;
  performedByUserId?: number | null;
  isOutsourced?: boolean;
  outsourceVendorName?: string | null;
  resetCounter?: boolean;
  shotCountAfterReset?: number | null;
  closed?: boolean;
  lines?: MaintenanceResultLineInput[];
  parts?: MaintenanceResultPartInput[];
}

export interface MaintenanceResultUpdate {
  finishedAt?: string | null;
  resultNote?: string;
  closed?: boolean;
  lines?: MaintenanceResultLineInput[];
  parts?: MaintenanceResultPartInput[];
}

export interface CheckedMaintenanceResultUpdate {
  finishedAt?: MaintenanceInstant | null;
  resultNote?: string;
  lines?: CheckedMaintenanceResultCreate["lines"];
  parts?: CheckedMaintenanceResultCreate["parts"];
}

export interface CheckedMaintenanceResultCreate {
  maintenanceOrderId: bigint | null;
  breakdownId: bigint | null;
  targetTypeCode: MaintenanceResultTargetType;
  targetId: bigint;
  startedAt: MaintenanceInstant;
  finishedAt: MaintenanceInstant | null;
  resultNote: string;
  performedByUserId: bigint | null;
  isOutsourced: boolean;
  outsourceVendorName: string | null;
  lines: Array<{
    orderItemId: bigint | null;
    partName: string | null;
    resultCode: string;
    remarks: string | null;
  }>;
  parts: Array<{
    sparePartId: bigint;
    partName: string | null;
    usedQty: Prisma.Decimal;
    goodsIssueId: bigint | null;
  }>;
}

export function checkMaintenanceResultCreate(
  body: MaintenanceResultCreate,
): CheckedMaintenanceResultCreate {
  rejectUnresolvedOptions(body);
  const startedAt = parseMaintenanceInstant(body.startedAt, "startedAt");
  const finishedAt =
    body.finishedAt == null
      ? null
      : parseMaintenanceInstant(body.finishedAt, "finishedAt");
  if (finishedAt && finishedAt.epochMicroseconds < startedAt.epochMicroseconds)
    fail(
      "finishedAt",
      ERROR_CODE.RANGE,
      "종료 시각은 시작 시각보다 빠를 수 없습니다.",
    );
  if (!body.resultNote?.trim())
    fail("resultNote", ERROR_CODE.REQUIRED, "실적 내용이 필요합니다.");

  const isOutsourced = body.isOutsourced === true;
  const performedByUserId =
    body.performedByUserId == null
      ? null
      : id("performedByUserId", body.performedByUserId);
  const outsourceVendorName = body.outsourceVendorName ?? null;
  if (isOutsourced && performedByUserId !== null)
    fail(
      "performedByUserId",
      ERROR_CODE.PAIR,
      "외주 실적에는 내부 수행자를 함께 보낼 수 없습니다.",
    );
  if (isOutsourced && !outsourceVendorName?.trim())
    fail(
      "outsourceVendorName",
      ERROR_CODE.REQUIRED,
      "외주처 이름이 필요합니다.",
    );
  if (!isOutsourced && performedByUserId === null)
    fail("performedByUserId", ERROR_CODE.REQUIRED, "내부 수행자가 필요합니다.");
  if (!isOutsourced && outsourceVendorName !== null)
    fail(
      "outsourceVendorName",
      ERROR_CODE.PAIR,
      "내부 실적에는 외주처 이름을 보낼 수 없습니다.",
    );

  return {
    maintenanceOrderId: nullableId(
      "maintenanceOrderId",
      body.maintenanceOrderId,
    ),
    breakdownId: nullableId("breakdownId", body.breakdownId),
    targetTypeCode: body.targetTypeCode,
    targetId: id("targetId", body.targetId),
    startedAt,
    finishedAt,
    resultNote: body.resultNote,
    performedByUserId,
    isOutsourced,
    outsourceVendorName,
    lines: lines(body.lines ?? []),
    parts: parts(body.parts ?? []),
  };
}

export function checkMaintenanceResultUpdate(
  body: MaintenanceResultUpdate,
  startedEpochMicroseconds: bigint,
): CheckedMaintenanceResultUpdate {
  if (body.closed === true)
    throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
      field(
        "closed",
        ERROR_CODE.INVALID,
        "결과코드의 마감 의미가 확정되기 전에는 실적을 마감할 수 없습니다.",
      ),
    ]);
  let finishedAt: MaintenanceInstant | null | undefined;
  if (Object.hasOwn(body, "finishedAt")) {
    finishedAt =
      body.finishedAt == null
        ? null
        : parseMaintenanceInstant(body.finishedAt, "finishedAt");
    if (finishedAt && finishedAt.epochMicroseconds < startedEpochMicroseconds)
      fail(
        "finishedAt",
        ERROR_CODE.RANGE,
        "종료 시각은 시작 시각보다 빠를 수 없습니다.",
      );
  }
  if (body.resultNote !== undefined && !body.resultNote.trim())
    fail("resultNote", ERROR_CODE.REQUIRED, "실적 내용이 필요합니다.");
  return {
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(body.resultNote === undefined ? {} : { resultNote: body.resultNote }),
    ...(body.lines === undefined ? {} : { lines: lines(body.lines) }),
    ...(body.parts === undefined ? {} : { parts: parts(body.parts) }),
  };
}

function rejectUnresolvedOptions(body: MaintenanceResultCreate): void {
  if (body.resetCounter === true)
    throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
      field(
        "resetCounter",
        ERROR_CODE.INVALID,
        "예방보전 시행일 기준이 확정되기 전에는 누계를 초기화할 수 없습니다.",
      ),
    ]);
  if (body.closed === true)
    throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
      field(
        "closed",
        ERROR_CODE.INVALID,
        "결과코드의 마감 의미가 확정되기 전에는 실적을 마감할 수 없습니다.",
      ),
    ]);
  if (body.shotCountAfterReset != null)
    fail(
      "shotCountAfterReset",
      ERROR_CODE.INVALID,
      "누계를 초기화하지 않는 실적에는 초기화 후 값을 보낼 수 없습니다.",
    );
}

function lines(input: MaintenanceResultLineInput[]) {
  const seen = new Set<bigint>();
  return input.map((line, index) => {
    const at = `lines[${index}]`;
    if (!line.resultCode?.trim())
      fail(`${at}.resultCode`, ERROR_CODE.REQUIRED, "결과코드가 필요합니다.");
    const orderItemId = nullableId(`${at}.orderItemId`, line.orderItemId);
    if (orderItemId !== null && seen.has(orderItemId))
      fail(
        `${at}.orderItemId`,
        ERROR_CODE.UNIQUE_VIOLATION,
        "같은 지시 항목을 두 번 보낼 수 없습니다.",
      );
    if (orderItemId !== null) seen.add(orderItemId);
    return {
      orderItemId,
      partName: line.partName ?? null,
      resultCode: line.resultCode,
      remarks: line.remarks ?? null,
    };
  });
}

function parts(input: MaintenanceResultPartInput[]) {
  return input.map((part, index) => ({
    sparePartId: id(`parts[${index}].sparePartId`, part.sparePartId),
    partName: part.partName ?? null,
    usedQty: quantity(`parts[${index}].usedQty`, part.usedQty),
    goodsIssueId: nullableId(`parts[${index}].goodsIssueId`, part.goodsIssueId),
  }));
}

function id(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0)
    fail(name, ERROR_CODE.RANGE, "안전한 양의 정수 ID여야 합니다.");
  return BigInt(value);
}

function nullableId(
  name: string,
  value: number | null | undefined,
): bigint | null {
  return value == null ? null : id(name, value);
}

function quantity(name: string, value: number): Prisma.Decimal {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(name, ERROR_CODE.RANGE, "유한한 양수여야 합니다.");
  const decimal = new Prisma.Decimal(value.toString());
  if (
    decimal.lte(0) ||
    decimal.decimalPlaces() > 6 ||
    decimal.gte("100000000000000")
  )
    fail(
      name,
      ERROR_CODE.RANGE,
      "수량은 numeric(20,6)에 손실 없이 저장되는 양수여야 합니다.",
    );
  return decimal;
}

function fail(name: string, code: string, message: string): never {
  throw one(field(name, code, message));
}
