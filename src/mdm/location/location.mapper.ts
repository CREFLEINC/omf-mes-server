import { location } from '@prisma/client';

import type { components } from '../../contracts/mdm';

export type Location = components['schemas']['Location'];

/**
 * Prisma 행을 계약 스키마로 옮긴다. 반환 타입이 계약에서 나오므로 필드를 빠뜨리거나
 * 이름을 틀리면 컴파일이 실패한다.
 *
 * `capacity_qty` 는 `numeric(20,6)` 이라 Prisma 가 `Decimal` 로 준다. 계약은 JSON
 * 숫자를 요구하므로 여기서 바꾼다 — 그냥 내리면 `{"s":1,"e":2,"d":[500]}` 이 나간다.
 */
export function toLocation(row: location): Location {
  return {
    locationId: Number(row.location_id),
    warehouseId: Number(row.warehouse_id),
    parentLocationId: row.parent_location_id === null ? null : Number(row.parent_location_id),
    locationCode: row.location_code,
    locationName: row.location_name,
    locationTypeCode: row.location_type_code,
    qualityZoneCode: row.quality_zone_code,
    storageConditionCode: row.storage_condition_code,
    allowMixedItem: row.allow_mixed_item,
    allowMixedLot: row.allow_mixed_lot,
    capacityQty: row.capacity_qty === null ? null : row.capacity_qty.toNumber(),
    capacityUomId: row.capacity_uom_id === null ? null : Number(row.capacity_uom_id),
    isActive: row.is_active,
  };
}
