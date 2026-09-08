import { Prisma } from "@prisma/client";

import { maintenanceInstantFromEpoch } from "../maintenance-instant";

export interface ResultProjection {
  maintenance_result_id: bigint;
  maintenance_order_id: bigint | null;
  breakdown_id: bigint | null;
  target_type_code: string | null;
  equipment_id: bigint | null;
  mold_id: bigint | null;
  started_epoch_microseconds: string;
  finished_epoch_microseconds: string | null;
  result_note: string | null;
  performed_by_user_id: bigint | null;
  is_outsourced: boolean | null;
  outsource_vendor_name: string | null;
  reset_counter: boolean | null;
  shot_count_before_reset: bigint | null;
  shot_count_after_reset: bigint | null;
  closed: boolean | null;
  version_no: number;
}

export interface ResultLineProjection {
  maintenance_result_id: bigint;
  sequence_no: number;
  maintenance_order_item_id: bigint | null;
  part_name: string | null;
  result_code: string;
  remarks: string | null;
}

export interface ResultPartProjection {
  maintenance_result_id: bigint;
  sequence_no: number;
  spare_part_id: bigint;
  part_name: string | null;
  used_qty: Prisma.Decimal;
  goods_issue_id: bigint | null;
  goods_issue_no: string | null;
  issued_epoch_microseconds: string | null;
  uom_code: string | null;
}

export interface MaintenanceResultLineView {
  orderItemId: number | null;
  partName: string | null;
  resultCode: string;
  remarks: string | null;
}

export interface MaintenanceResultPartView {
  sparePartId: number;
  partName?: string;
  usedQty: number;
  goodsIssueId: number | null;
  goodsIssueNo: string | null;
  issuedAt: string | null;
  uomCode: string | null;
}

export interface MaintenanceResultView {
  maintenanceResultId: number;
  maintenanceOrderId: number | null;
  breakdownId: number | null;
  targetTypeCode: "EQUIPMENT" | "MOLD";
  targetId: number;
  startedAt: string;
  finishedAt: string | null;
  resultNote: string;
  performedByUserId: number | null;
  isOutsourced?: boolean;
  outsourceVendorName: string | null;
  resetCounter?: boolean;
  shotCountBeforeReset: number | null;
  shotCountAfterReset: number | null;
  closed?: boolean;
  lines: MaintenanceResultLineView[];
  parts: MaintenanceResultPartView[];
}

export function maintenanceResultViews(
  results: ResultProjection[],
  lines: ResultLineProjection[],
  parts: ResultPartProjection[],
): MaintenanceResultView[] {
  const linesByResult = groupBy(lines);
  const partsByResult = groupBy(parts);
  return results.map((result) =>
    maintenanceResultView(
      result,
      linesByResult.get(result.maintenance_result_id) ?? [],
      partsByResult.get(result.maintenance_result_id) ?? [],
    ),
  );
}

function maintenanceResultView(
  row: ResultProjection,
  lines: ResultLineProjection[],
  parts: ResultPartProjection[],
): MaintenanceResultView {
  if (row.result_note === null)
    throw new Error("Missing required maintenance result field: resultNote");
  const target = targetView(row);
  const view: MaintenanceResultView = {
    maintenanceResultId: safeInt(
      row.maintenance_result_id,
      "maintenanceResultId",
    ),
    maintenanceOrderId: nullableInt(
      row.maintenance_order_id,
      "maintenanceOrderId",
    ),
    breakdownId: nullableInt(row.breakdown_id, "breakdownId"),
    ...target,
    startedAt: maintenanceInstantFromEpoch(row.started_epoch_microseconds)
      .utcIso,
    finishedAt:
      row.finished_epoch_microseconds === null
        ? null
        : maintenanceInstantFromEpoch(row.finished_epoch_microseconds).utcIso,
    resultNote: row.result_note,
    performedByUserId: nullableInt(
      row.performed_by_user_id,
      "performedByUserId",
    ),
    outsourceVendorName: row.outsource_vendor_name,
    shotCountBeforeReset: nullableInt(
      row.shot_count_before_reset,
      "shotCountBeforeReset",
    ),
    shotCountAfterReset: nullableInt(
      row.shot_count_after_reset,
      "shotCountAfterReset",
    ),
    lines: lines.map(lineView),
    parts: parts.map(partView),
  };
  if (row.is_outsourced !== null) view.isOutsourced = row.is_outsourced;
  if (row.reset_counter !== null) view.resetCounter = row.reset_counter;
  if (row.closed !== null) view.closed = row.closed;
  return view;
}

function lineView(row: ResultLineProjection): MaintenanceResultLineView {
  return {
    orderItemId: nullableInt(row.maintenance_order_item_id, "orderItemId"),
    partName: row.part_name,
    resultCode: row.result_code,
    remarks: row.remarks,
  };
}

function partView(row: ResultPartProjection): MaintenanceResultPartView {
  const view: MaintenanceResultPartView = {
    sparePartId: safeInt(row.spare_part_id, "sparePartId"),
    usedQty: row.used_qty.toNumber(),
    goodsIssueId: nullableInt(row.goods_issue_id, "goodsIssueId"),
    goodsIssueNo: row.goods_issue_no,
    issuedAt:
      row.issued_epoch_microseconds === null
        ? null
        : maintenanceInstantFromEpoch(row.issued_epoch_microseconds).utcIso,
    uomCode: row.uom_code,
  };
  if (row.part_name !== null) view.partName = row.part_name;
  return view;
}

function targetView(
  row: ResultProjection,
): Pick<MaintenanceResultView, "targetTypeCode" | "targetId"> {
  if (
    row.target_type_code === "EQUIPMENT" &&
    row.equipment_id !== null &&
    row.mold_id === null
  )
    return {
      targetTypeCode: "EQUIPMENT",
      targetId: safeInt(row.equipment_id, "targetId"),
    };
  if (
    row.target_type_code === "MOLD" &&
    row.mold_id !== null &&
    row.equipment_id === null
  )
    return {
      targetTypeCode: "MOLD",
      targetId: safeInt(row.mold_id, "targetId"),
    };
  throw new Error("Invalid stored maintenance result target");
}

function groupBy<T extends { maintenance_result_id: bigint }>(
  rows: T[],
): Map<bigint, T[]> {
  const grouped = new Map<bigint, T[]>();
  for (const row of rows) {
    const values = grouped.get(row.maintenance_result_id) ?? [];
    values.push(row);
    grouped.set(row.maintenance_result_id, values);
  }
  return grouped;
}

function safeInt(value: bigint, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(`Maintenance result integer exceeds safe range: ${name}`);
  return number;
}

function nullableInt(value: bigint | null, name: string): number | null {
  return value === null ? null : safeInt(value, name);
}
