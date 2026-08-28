import { warehouse } from '@prisma/client';

import { toWarehouse } from './warehouse.mapper';

function row(overrides: Partial<warehouse> = {}): warehouse {
  return {
    warehouse_id: 1001n,
    plant_id: 11n,
    business_unit_id: 21n,
    warehouse_code: 'WH-01',
    warehouse_name: '1공장 자재창고',
    warehouse_type_code: 'MATERIAL',
    management_level_code: 'STANDARD',
    is_external: false,
    partner_id: null,
    is_active: true,
    created_at: new Date('2026-08-04T00:00:00Z'),
    created_by: 7n,
    updated_at: new Date('2026-08-05T00:00:00Z'),
    updated_by: 7n,
    version_no: 3,
    // 계약의 isDefect 를 아직 내려주지 않는다 — 매퍼 반영은 계약 사본 갱신과 함께 온다(#47).
    is_defect: false,
    ...overrides,
  };
}

describe('toWarehouse', () => {
  it('Prisma 행을 계약 필드명으로 옮긴다', () => {
    expect(toWarehouse(row())).toMatchObject({
      warehouseCode: 'WH-01',
      warehouseName: '1공장 자재창고',
      warehouseTypeCode: 'MATERIAL',
      managementLevelCode: 'STANDARD',
      isExternal: false,
      isActive: true,
    });
  });

  it('bigint 식별자를 숫자로 내린다 — 계약이 type: integer 다', () => {
    const result = toWarehouse(row());

    expect(result.warehouseId).toBe(1001);
    expect(result.plantId).toBe(11);
    expect(result.businessUnitId).toBe(21);
    expect(typeof result.warehouseId).toBe('number');
  });

  it('외부창고면 partnerId 도 숫자로 내린다', () => {
    expect(toWarehouse(row({ is_external: true, partner_id: 55n }))).toMatchObject({
      isExternal: true,
      partnerId: 55,
    });
  });

  it('거래처가 없으면 partnerId 는 null 이다 — 키를 빼지 않는다', () => {
    const result = toWarehouse(row({ partner_id: null }));

    expect(result.partnerId).toBeNull();
    expect('partnerId' in result).toBe(true);
  });

  it('계약에 없는 컬럼을 내리지 않는다 — version_no 는 A-4 로 본문 노출 금지다', () => {
    expect(Object.keys(toWarehouse(row())).sort()).toEqual([
      'businessUnitId',
      'isActive',
      'isExternal',
      'managementLevelCode',
      'partnerId',
      'plantId',
      'warehouseCode',
      'warehouseId',
      'warehouseName',
      'warehouseTypeCode',
    ]);
  });
});
