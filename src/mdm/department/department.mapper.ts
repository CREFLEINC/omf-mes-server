import { department } from '@prisma/client';

import type { components } from '../../contracts/mdm';

export type Department = components['schemas']['Department'];

export function toDepartment(row: department): Department {
  return {
    departmentId: Number(row.department_id),
    departmentCode: row.department_code,
    departmentName: row.department_name,
    parentDepartmentId:
      row.parent_department_id === null ? null : Number(row.parent_department_id),
    businessUnitId: row.business_unit_id === null ? null : Number(row.business_unit_id),
    isActive: row.is_active,
  };
}
