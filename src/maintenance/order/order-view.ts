import { Prisma } from "@prisma/client";

export const ORDER_INCLUDE = {
  equipment: { select: { equipment_code: true } },
  mold: { select: { mold_code: true } },
  maintenance_order_item: {
    include: {
      equipment_inspection_item: {
        select: { inspection_item_name: true },
      },
    },
    orderBy: [{ sequence_no: "asc" }, { maintenance_order_item_id: "asc" }],
  },
  maintenance_order_trigger: {
    orderBy: [{ created_at: "asc" }, { maintenance_order_trigger_id: "asc" }],
  },
} satisfies Prisma.maintenance_orderInclude;

export type MaintenanceOrderRow = Prisma.maintenance_orderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;
type OrderItemRow = MaintenanceOrderRow["maintenance_order_item"][number];
type OrderTriggerRow = MaintenanceOrderRow["maintenance_order_trigger"][number];

export interface OrderItemView {
  orderItemId: number;
  itemName: string;
  statusCode: string;
  inspectionItemId: number | null;
  sequenceNo: number;
}

export interface OrderTriggerView {
  triggerTypeCode: string;
  sourceId: number | null;
  snapshotNote: string | null;
  pmDueAxisCode?: "SHOT" | "DATE";
  shotCountAtDue: number | null;
  guaranteedShotCountAtDue: number | null;
}

export interface MaintenanceOrderView {
  maintenanceOrderId: number;
  maintenanceOrderNo: string;
  targetTypeCode: "EQUIPMENT" | "MOLD";
  targetId: number;
  targetCode: string;
  maintenanceTypeCode: "CORRECTIVE" | "PREVENTIVE";
  plannedDate: string;
  assigneeUserId?: number;
  statusCode: string;
  items: OrderItemView[];
  triggers: OrderTriggerView[];
  baseDate: string | null;
  orderNote: string | null;
  issuedByUserId: number | null;
  issuedAt: string | null;
}

function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined)
    throw new Error(`Missing required maintenance order field: ${name}`);
  return value;
}

function safeInt(value: bigint | number, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(`Maintenance order integer exceeds safe range: ${name}`);
  return number;
}

function nullableInt(value: bigint | null, name: string): number | null {
  return value === null ? null : safeInt(value, name);
}

function date(value: Date | null, name: string): string {
  return required(value, name).toISOString().slice(0, 10);
}

export function maintenanceOrderView(
  row: MaintenanceOrderRow,
): MaintenanceOrderView {
  const target = targetView(row);
  const maintenanceTypeCode = row.order_type_code;
  if (
    maintenanceTypeCode !== "CORRECTIVE" &&
    maintenanceTypeCode !== "PREVENTIVE"
  )
    throw new Error("Invalid stored maintenance order type");

  const view: MaintenanceOrderView = {
    maintenanceOrderId: safeInt(row.maintenance_order_id, "maintenanceOrderId"),
    maintenanceOrderNo: row.maintenance_order_no,
    ...target,
    maintenanceTypeCode,
    plannedDate: date(row.planned_date, "plannedDate"),
    statusCode: row.status_code,
    items: row.maintenance_order_item.map((item) =>
      orderItemView(item, target.targetTypeCode),
    ),
    triggers: row.maintenance_order_trigger.map(orderTriggerView),
    baseDate: row.base_date === null ? null : date(row.base_date, "baseDate"),
    orderNote: row.order_note,
    issuedByUserId: nullableInt(row.issued_by, "issuedByUserId"),
    issuedAt: row.issued_at?.toISOString() ?? null,
  };
  if (row.assignee_user_id !== null)
    view.assigneeUserId = safeInt(row.assignee_user_id, "assigneeUserId");
  return view;
}

function orderItemView(
  item: OrderItemRow,
  targetType: MaintenanceOrderView["targetTypeCode"],
): OrderItemView {
  return {
    orderItemId: safeInt(item.maintenance_order_item_id, "orderItemId"),
    itemName:
      targetType === "EQUIPMENT"
        ? required(
            item.equipment_inspection_item?.inspection_item_name,
            "itemName",
          )
        : required(item.item_name, "itemName"),
    statusCode: item.status_code,
    inspectionItemId: nullableInt(item.inspection_item_id, "inspectionItemId"),
    sequenceNo: item.sequence_no,
  };
}

function orderTriggerView(trigger: OrderTriggerRow): OrderTriggerView {
  const view: OrderTriggerView = {
    triggerTypeCode: trigger.trigger_type_code,
    sourceId: nullableInt(trigger.source_id, "sourceId"),
    snapshotNote: trigger.snapshot_note,
    shotCountAtDue: nullableInt(trigger.shot_count_at_due, "shotCountAtDue"),
    guaranteedShotCountAtDue: nullableInt(
      trigger.guaranteed_shot_count_at_due,
      "guaranteedShotCountAtDue",
    ),
  };
  if (trigger.pm_due_axis_code !== null) {
    if (
      trigger.pm_due_axis_code !== "SHOT" &&
      trigger.pm_due_axis_code !== "DATE"
    )
      throw new Error("Invalid stored PM due axis");
    view.pmDueAxisCode = trigger.pm_due_axis_code;
  }
  return view;
}

function targetView(
  row: MaintenanceOrderRow,
): Pick<MaintenanceOrderView, "targetTypeCode" | "targetId" | "targetCode"> {
  if (
    row.target_type_code === "EQUIPMENT" &&
    row.equipment_id !== null &&
    row.mold_id === null &&
    row.equipment
  ) {
    return {
      targetTypeCode: "EQUIPMENT",
      targetId: safeInt(row.equipment_id, "targetId"),
      targetCode: row.equipment.equipment_code,
    };
  }
  if (
    row.target_type_code === "MOLD" &&
    row.mold_id !== null &&
    row.equipment_id === null &&
    row.mold
  ) {
    return {
      targetTypeCode: "MOLD",
      targetId: safeInt(row.mold_id, "targetId"),
      targetCode: row.mold.mold_code,
    };
  }
  throw new Error("Invalid stored maintenance order target");
}
