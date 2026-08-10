import { item } from '@prisma/client';

import type { components } from '../../contracts/mdm';

export type Item = components['schemas']['Item'];

/**
 * Prisma 행을 계약 스키마로 옮긴다. 반환 타입이 계약에서 나오므로 필드를 빠뜨리거나
 * 이름을 틀리면 컴파일이 실패한다.
 *
 * 원본 4열(`itemCode`·`itemName`·`itemTypeCode`·`baseUomId`)도 **내려주긴 한다** —
 * 화면이 위 구획에 읽기 전용으로 그린다. 수정 요청이 그것을 받지 않을 뿐이다.
 */
export function toItem(row: item): Item {
  return {
    itemId: Number(row.item_id),
    itemCode: row.item_code,
    itemName: row.item_name,
    itemTypeCode: row.item_type_code,
    baseUomId: Number(row.base_uom_id),
    lotControlTypeCode: row.lot_control_type_code,
    serialControlTypeCode: row.serial_control_type_code,
    shelfLifeDays: row.shelf_life_days,
    inspectionRequired: row.inspection_required,
    fifoPolicyCode: row.fifo_policy_code,
    negativeStockAllowed: row.negative_stock_allowed,
    storageConditionCode: row.storage_condition_code,
    openedShelfLifeHours: row.opened_shelf_life_hours,
    isActive: row.is_active,
  };
}
