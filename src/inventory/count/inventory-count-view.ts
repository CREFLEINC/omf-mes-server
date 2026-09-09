import { Prisma } from '@prisma/client';

export type InventoryCountRow = Prisma.inventory_countGetPayload<object>;
export type InventoryCountLineRow = Prisma.inventory_count_lineGetPayload<{
  include: {
    item: { select: { item_code: true; item_name: true } };
    lot: { select: { lot_no: true } };
    location: { select: { location_code: true } };
  };
}>;

export interface InventoryCountView {
  inventoryCountId: number;
  inventoryCountNo: string;
  countTypeCode: string;
  warehouseId: number;
  plannedDate: string;
  blindCount: boolean;
  statusCode: string;
}

export interface InventoryCountLineView {
  inventoryCountLineId: number;
  inventoryCountId: number;
  lineNo: number;
  locationId: number;
  itemId: number;
  lotId: number | null;
  systemQty?: number;
  countedQty: number;
  varianceQty: number;
  uomId: number;
  varianceReasonCode: string | null;
  countedBy: number | null;
  countedAt: string;
  counted: boolean;
  itemCode: string;
  itemName: string;
  lotNo: string | null;
  locationCode: string;
}

export interface InventoryCountSummary {
  plannedCount: number;
  countedCount: number;
  uncountedCount: number;
  varianceCount: number;
  closable: boolean;
  closeBlockedReasonCode: string | null;
}

export interface InventoryCountDetail {
  inventoryCount: InventoryCountView;
  summary: InventoryCountSummary;
}

export function inventoryCountView(row: InventoryCountRow): InventoryCountView {
  return {
    inventoryCountId: Number(row.inventory_count_id),
    inventoryCountNo: row.inventory_count_no,
    countTypeCode: row.count_type_code,
    warehouseId: Number(row.warehouse_id),
    plannedDate: row.planned_date.toISOString().slice(0, 10),
    blindCount: row.blind_count,
    statusCode: row.status_code,
  };
}

/** 블라인드이면 systemQty를 언제나 생략한다. 미실사는 차이에서도 장부가 역산되지 않게 0이다. */
export function inventoryCountLineView(
  row: InventoryCountLineRow,
  blindCount: boolean,
): InventoryCountLineView {
  return {
    inventoryCountLineId: Number(row.inventory_count_line_id),
    inventoryCountId: Number(row.inventory_count_id),
    lineNo: row.line_no,
    locationId: Number(row.location_id),
    itemId: Number(row.item_id),
    lotId: row.lot_id === null ? null : Number(row.lot_id),
    ...(blindCount ? {} : { systemQty: Number(row.system_qty) }),
    countedQty: row.counted ? Number(row.counted_qty) : 0,
    varianceQty: row.counted ? Number(row.variance_qty) : 0,
    uomId: Number(row.uom_id),
    varianceReasonCode: row.variance_reason_code,
    countedBy: row.counted_by === null ? null : Number(row.counted_by),
    countedAt: row.counted_at.toISOString(),
    counted: row.counted,
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    lotNo: row.lot?.lot_no ?? null,
    locationCode: row.location.location_code,
  };
}
