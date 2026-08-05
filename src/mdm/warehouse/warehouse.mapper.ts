import { warehouse } from '@prisma/client';

import type { components } from '../../contracts/mdm';

export type Warehouse = components['schemas']['Warehouse'];

/**
 * Prisma 행을 계약 스키마로 옮긴다.
 *
 * 반환 타입이 계약에서 나오므로 필드를 빠뜨리거나 이름을 틀리면 컴파일이 실패한다.
 * 감사 컬럼과 `version_no` 는 계약에 없어 여기서 걸러진다 — `version_no` 는 공유계약
 * A-4 가 본문 노출을 금지하고 ETag 헤더로만 나른다.
 */
export function toWarehouse(row: warehouse): Warehouse {
  return {
    warehouseId: Number(row.warehouse_id),
    plantId: Number(row.plant_id),
    businessUnitId: Number(row.business_unit_id),
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    warehouseTypeCode: row.warehouse_type_code,
    managementLevelCode: row.management_level_code,
    isExternal: row.is_external,
    partnerId: row.partner_id === null ? null : Number(row.partner_id),
    isActive: row.is_active,
  };
}
