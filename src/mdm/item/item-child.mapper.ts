import { item_bu_item_map, item_external_code, item_uom_conversion } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { toDateOnly } from '../date-only';

type Schemas = components['schemas'];

/**
 * 부속 3종에는 `is_active` 도 `version_no` 도 없다 — 부여·회수 형태다(공유계약 B-6).
 * 그래서 목록 응답에 `page` 도 없다: 한 품목의 부속은 통째로 보고 통째로 바꾼다.
 */
export function toUomConversion(row: item_uom_conversion): Schemas['ItemUomConversion'] {
  return {
    itemUomConversionId: Number(row.item_uom_conversion_id),
    itemId: Number(row.item_id),
    fromUomId: Number(row.from_uom_id),
    toUomId: Number(row.to_uom_id),
    // numeric(18,8) 이라 Prisma 가 Decimal 로 준다 — 그대로 내리면 객체가 나간다.
    conversionRate: row.conversion_rate.toNumber(),
    // @db.Date 다. effective_from 은 NOT NULL 이라 오버로드가 string 을 준다.
    effectiveFrom: toDateOnly(row.effective_from),
    effectiveTo: toDateOnly(row.effective_to),
  };
}

export function toExternalCode(row: item_external_code): Schemas['ItemExternalCode'] {
  return {
    itemExternalCodeId: Number(row.item_external_code_id),
    itemId: Number(row.item_id),
    externalSystemCode: row.external_system_code,
    partnerId: row.partner_id === null ? null : Number(row.partner_id),
    externalItemCode: row.external_item_code,
  };
}

export function toBuItemMap(row: item_bu_item_map): Schemas['ItemBuItemMap'] {
  return {
    itemBuItemMapId: Number(row.item_bu_item_map_id),
    fromBusinessUnitId: Number(row.from_business_unit_id),
    fromItemId: Number(row.from_item_id),
    toBusinessUnitId: Number(row.to_business_unit_id),
    toItemId: Number(row.to_item_id),
    effectiveFrom: toDateOnly(row.effective_from),
    effectiveTo: toDateOnly(row.effective_to),
  };
}
