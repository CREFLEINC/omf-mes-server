import { Prisma } from "@prisma/client";

import { maintenanceInstantFromEpoch } from "../maintenance-instant";

export interface ToolUsageProjection {
  tool_usage_id: bigint;
  mold_id: bigint;
  mold_code: string;
  work_order_id: bigint | null;
  shot_count: bigint | null;
  collection_method_code: string | null;
  conversion_base_qty: Prisma.Decimal | null;
  conversion_ratio: Prisma.Decimal | null;
  occurred_epoch_microseconds: string | null;
  worker_no: string | null;
}

export interface ToolUsageView {
  toolUsageId: number;
  moldId: number;
  moldCode: string;
  workOrderId: number;
  shotCount: number;
  collectionMethodCode: "DIRECT" | "CONVERTED";
  conversionBaseQty: number | null;
  conversionRatio: number | null;
  occurredAt: string;
  recordedByWorkerNo: string;
}

export function toolUsageView(row: ToolUsageProjection): ToolUsageView {
  const method = collectionMethod(required(row.collection_method_code, "collectionMethodCode"));
  const base = decimal(row.conversion_base_qty, "conversionBaseQty");
  const ratio = decimal(row.conversion_ratio, "conversionRatio");
  if ((base === null) !== (ratio === null)) {
    throw new Error("Invalid stored tool usage conversion pair");
  }
  if (method === "DIRECT" && base !== null) {
    throw new Error("Invalid stored DIRECT conversion values");
  }
  if (method === "CONVERTED" && base === null) {
    throw new Error("Missing stored CONVERTED conversion values");
  }

  return {
    toolUsageId: safeInt(row.tool_usage_id, "toolUsageId"),
    moldId: safeInt(row.mold_id, "moldId"),
    moldCode: row.mold_code,
    workOrderId: safeInt(required(row.work_order_id, "workOrderId"), "workOrderId"),
    shotCount: safeInt(required(row.shot_count, "shotCount"), "shotCount"),
    collectionMethodCode: method,
    conversionBaseQty: base,
    conversionRatio: ratio,
    occurredAt: maintenanceInstantFromEpoch(
      required(row.occurred_epoch_microseconds, "occurredAt"),
    ).utcIso,
    recordedByWorkerNo: required(row.worker_no, "recordedByWorkerNo"),
  };
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`Missing required tool usage field: ${name}`);
  return value;
}

function collectionMethod(value: string): ToolUsageView["collectionMethodCode"] {
  if (value !== "DIRECT" && value !== "CONVERTED") {
    throw new Error("Invalid stored tool usage collection method");
  }
  return value;
}

function decimal(value: Prisma.Decimal | null, name: string): number | null {
  if (value === null) return null;
  const converted = value.toNumber();
  if (!Number.isFinite(converted)) {
    throw new Error(`Tool usage number exceeds response range: ${name}`);
  }
  return converted;
}

function safeInt(value: bigint, name: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error(`Tool usage integer exceeds safe range: ${name}`);
  }
  return converted;
}
