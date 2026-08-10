import { code_group, code_value } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { toDateOnly } from '../date-only';

export type CodeGroup = components['schemas']['CodeGroup'];
export type CodeValue = components['schemas']['CodeValue'];

export function toCodeGroup(row: code_group): CodeGroup {
  return {
    codeGroupId: Number(row.code_group_id),
    groupCode: row.group_code,
    groupName: row.group_name,
    description: row.description,
    isActive: row.is_active,
  };
}

export function toCodeValue(row: code_value): CodeValue {
  return {
    codeValueId: Number(row.code_value_id),
    codeGroupId: Number(row.code_group_id),
    code: row.code,
    codeName: row.code_name,
    displayOrder: row.display_order,
    effectiveFrom: toDateOnly(row.effective_from),
    effectiveTo: toDateOnly(row.effective_to),
    isActive: row.is_active,
  };
}
