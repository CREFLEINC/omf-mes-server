import { FgResolution } from '../../core/erp-warehouse/fg-location';
import { WarehouseRef, fgOverrideWarning, fgWarehouseView, judgeFgOverride } from './fg-override';

const PLANT = 1n;
const warehouse = (id: bigint, overrides: Partial<WarehouseRef> = {}): WarehouseRef => ({
  warehouse_id: id, warehouse_code: `W${id}`, warehouse_name: `창고${id}`, plant_id: PLANT, is_active: true,
  warehouse_type_code: 'PRODUCT', is_defect: false, is_external: false, ...overrides,
});
const WAREHOUSES = new Map([10n, 20n, 30n, 40n].map((id) => [id, warehouse(id, id === 30n ? { warehouse_type_code: 'MATERIAL' } : id === 40n ? { plant_id: 2n } : {})]));
const ERP: FgResolution = {
  kind: 'ERP_STORAGE_LOCATION', erpCode: 'W10',
  warehouse: { id: 10n, code: 'W10', name: '창고10' }, location: { id: 101n, code: 'WH-ALL', name: '창고 전체', isActive: true },
};

function judge(body: { warehouseId: number; erpMismatchAcknowledged: boolean } | null, fg: FgResolution = ERP) {
  const errors: [string, string][] = [];
  const result = judgeFgOverride('plans[0]', body, fg, PLANT, WAREHOUSES, (field, code) => errors.push([field, code]));
  return { result, errors };
}

describe('judgeFgOverride — 입고 창고 수동 변경', () => {
  it('보내지 않으면 SL_CD 규칙 그대로다', () => {
    expect(judge(null)).toEqual({ result: { sent: false, applied: null, locationRule: null }, errors: [] });
  });

  it('SL_CD 와 다른 이 공장의 완제품 창고는 받는다', () => {
    const place = { id: 20n, code: 'W20', name: '창고20' };
    expect(judge({ warehouseId: 20, erpMismatchAcknowledged: true })).toEqual({ result: { sent: true, applied: place, locationRule: place }, errors: [] });
  });

  it('자재·다른 공장 창고, SL_CD 와 같은 창고, 확인 없는 변경은 칸마다 오류 — 받아들이지 않아 적용 창고가 없고, 위치는 고른 창고로 견준다', () => {
    expect(judge({ warehouseId: 30, erpMismatchAcknowledged: true }).result).toEqual({ sent: true, applied: null, locationRule: { id: 30n, code: 'W30', name: '창고30' } });
    expect(judge({ warehouseId: 20, erpMismatchAcknowledged: false }).result.applied).toBeNull();
    expect(judge({ warehouseId: 30, erpMismatchAcknowledged: true }).errors).toEqual([['plans[0].fgWarehouseOverride.warehouseId', 'FG_WAREHOUSE_NOT_ALLOWED']]);
    expect(judge({ warehouseId: 40, erpMismatchAcknowledged: true }).errors).toEqual([['plans[0].fgWarehouseOverride.warehouseId', 'FG_WAREHOUSE_OTHER_PLANT']]);
    expect(judge({ warehouseId: 10, erpMismatchAcknowledged: true }).errors).toEqual([['plans[0].fgWarehouseOverride.warehouseId', 'INVALID']]);
    expect(judge({ warehouseId: 20, erpMismatchAcknowledged: false }).errors).toEqual([['plans[0].fgWarehouseOverride.erpMismatchAcknowledged', 'REQUIRED']]);
  });

  it('SL_CD 가 없거나 연결이 실패한 ERP W/O 는 받지 않는다 — 연결 실패는 따로 가르는 코드다', () => {
    const rejected = { sent: true, applied: null, locationRule: null };
    expect(judge({ warehouseId: 20, erpMismatchAcknowledged: true }, { kind: 'NO_STORAGE_CODE' })).toEqual({ result: rejected, errors: [['plans[0].fgWarehouseOverride', 'INVALID']] });
    expect(judge({ warehouseId: 20, erpMismatchAcknowledged: true }, { kind: 'LINK_FAILED', erpCode: 'S999', reason: 'FG_WAREHOUSE_UNMAPPED' }))
      .toEqual({ result: rejected, errors: [['plans[0].fgWarehouseOverride', 'FG_OVERRIDE_LINK_FAILED']] });
  });
});

describe('fgWarehouseView — 재검증의 적용 창고', () => {
  const arrivalOf = async (warehouseId: bigint): Promise<bigint | null> => (warehouseId === 20n ? 201n : null);

  it('거부한 변경은 적용 창고·입고 위치를 비우고 「다름」이 아니다', async () => {
    expect(await fgWarehouseView(ERP, { sent: true, applied: null }, arrivalOf)).toEqual({
      erpStorageLocationCode: 'W10', erpWarehouseId: 10, appliedWarehouseId: null, arrivalLocationId: null, overridden: true, differsFromErp: false,
    });
    expect(fgOverrideWarning('plans[0]', ERP, null)).toEqual([]);
  });

  it('받아들인 변경은 그 창고와 입고 위치, 바꾸지 않았으면 SL_CD 창고와 그 입고 위치', async () => {
    expect(await fgWarehouseView(ERP, { sent: true, applied: { id: 20n, code: 'W20', name: '창고20' } }, arrivalOf))
      .toMatchObject({ appliedWarehouseId: 20, arrivalLocationId: 201, differsFromErp: true });
    expect(await fgWarehouseView(ERP, { sent: false, applied: null }, arrivalOf)).toMatchObject({ appliedWarehouseId: 10, arrivalLocationId: 101, differsFromErp: false, overridden: false });
  });
});
