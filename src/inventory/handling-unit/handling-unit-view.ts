import { Prisma } from '@prisma/client';

/**
 * 계약 `HandlingUnit`·`HandlingUnitContent` 로 옮기는 자리. PR ②③④⑤ 가 그대로 재사용한다.
 *
 * ⛔ `parentHandlingUnitId`·`warehouseId`·`locationId` 는 계약이 `[integer,null]` 로 널을
 * 명시했다 — 널이어도 키를 생략하지 않고 «싣는다»(`stock-transfer-view.ts` 선례).
 */

export type HandlingUnitRow = Prisma.handling_unitGetPayload<object>;
export type HandlingUnitContentRow = Prisma.handling_unit_contentGetPayload<object>;

export interface HandlingUnitView {
  handlingUnitId: number;
  handlingUnitNo: string;
  handlingUnitTypeCode: string;
  parentHandlingUnitId: number | null;
  warehouseId: number | null;
  locationId: number | null;
  statusCode: string;
}

export interface HandlingUnitContentView {
  handlingUnitContentId: number;
  handlingUnitId: number;
  itemId: number;
  lotId: number;
  qty: number;
  uomId: number;
}

export interface HandlingUnitDetailView {
  handlingUnit: HandlingUnitView;
  contents: HandlingUnitContentView[];
}

export function handlingUnitView(row: HandlingUnitRow): HandlingUnitView {
  return {
    handlingUnitId: Number(row.handling_unit_id),
    handlingUnitNo: row.handling_unit_no,
    handlingUnitTypeCode: row.handling_unit_type_code,
    parentHandlingUnitId:
      row.parent_handling_unit_id === null ? null : Number(row.parent_handling_unit_id),
    warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
    locationId: row.location_id === null ? null : Number(row.location_id),
    statusCode: row.status_code,
  };
}

export function handlingUnitContentView(row: HandlingUnitContentRow): HandlingUnitContentView {
  return {
    handlingUnitContentId: Number(row.handling_unit_content_id),
    handlingUnitId: Number(row.handling_unit_id),
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    qty: Number(row.qty),
    uomId: Number(row.uom_id),
  };
}
