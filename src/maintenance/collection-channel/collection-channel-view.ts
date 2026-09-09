export interface CollectionChannelProjection {
  collection_channel_id: bigint;
  equipment_id: bigint;
  equipment_code: string;
  channel_key: string | null;
  signal_name: string | null;
  uom_id: bigint | null;
  unit_code: string | null;
  inspection_item_id: bigint | null;
  item_id: bigint | null;
  item_code: string | null;
  process_id: bigint | null;
  process_code: string | null;
  inspection_item_name: string | null;
  inspection_item_code: string | null;
  inspection_item_unit_code: string | null;
  inspection_plan_version_id: bigint | null;
  inspection_plan_version: number | null;
  inspection_item_is_current_revision: boolean | null;
  is_active: boolean;
  version_no: number;
}

export interface CollectionChannelView {
  collectionChannelId: number;
  equipmentId: number;
  equipmentCode: string;
  channelKey: string;
  signalName?: string;
  unitCode?: string;
  inspectionItemId: number | null;
  itemId: number | null;
  itemCode: string | null;
  processId: number | null;
  processCode: string | null;
  inspectionItemName: string | null;
  inspectionItemCode: string | null;
  inspectionItemUnitCode: string | null;
  inspectionPlanVersionId: number | null;
  inspectionPlanVersion: number | null;
  inspectionItemIsCurrentRevision: boolean | null;
  isActive: boolean;
}

export function collectionChannelView(row: CollectionChannelProjection): CollectionChannelView {
  if (row.uom_id !== null && row.unit_code === null) {
    throw new Error("Missing referenced collection channel unit");
  }
  if (row.item_id !== null && row.item_code === null) {
    throw new Error("Missing referenced collection channel item");
  }
  if (row.process_id !== null && row.process_code === null) {
    throw new Error("Missing referenced collection channel process");
  }
  if (row.inspection_item_id !== null) {
    required(row.inspection_item_name, "inspectionItemName");
    required(row.inspection_item_code, "inspectionItemCode");
    required(row.inspection_plan_version_id, "inspectionPlanVersionId");
    required(row.inspection_plan_version, "inspectionPlanVersion");
    required(row.inspection_item_is_current_revision, "inspectionItemIsCurrentRevision");
  }
  const view: CollectionChannelView = {
    collectionChannelId: safeInt(row.collection_channel_id, "collectionChannelId"),
    equipmentId: safeInt(row.equipment_id, "equipmentId"),
    equipmentCode: row.equipment_code,
    channelKey: required(row.channel_key, "channelKey"),
    inspectionItemId: nullableInt(row.inspection_item_id, "inspectionItemId"),
    itemId: nullableInt(row.item_id, "itemId"),
    itemCode: row.item_code,
    processId: nullableInt(row.process_id, "processId"),
    processCode: row.process_code,
    inspectionItemName: row.inspection_item_name,
    inspectionItemCode: row.inspection_item_code,
    inspectionItemUnitCode: row.inspection_item_unit_code,
    inspectionPlanVersionId: nullableInt(
      row.inspection_plan_version_id,
      "inspectionPlanVersionId",
    ),
    inspectionPlanVersion: row.inspection_plan_version,
    inspectionItemIsCurrentRevision: row.inspection_item_is_current_revision,
    isActive: row.is_active,
  };
  if (row.signal_name !== null) view.signalName = row.signal_name;
  if (row.unit_code !== null) view.unitCode = row.unit_code;
  return view;
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`Missing required collection channel field: ${name}`);
  return value;
}

function nullableInt(value: bigint | null, name: string): number | null {
  return value === null ? null : safeInt(value, name);
}

function safeInt(value: bigint, name: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error(`Collection channel integer exceeds safe range: ${name}`);
  }
  return converted;
}
