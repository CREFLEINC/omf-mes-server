import { PUTAWAY_STAGING, WAREHOUSE_WHOLE } from '../../common/master';
import { FgResolution, LocationFact, fgKey, fgLocationOf, locationFinding, resolveFgLocation, resolveFgLocations } from './fg-location';

type Warehouse = {
  warehouse_id: bigint; warehouse_code: string; warehouse_name: string; plant_id: bigint;
  warehouse_type_code: string; is_active: boolean; is_defect: boolean; is_external: boolean;
};
type Location = { location_id: bigint; warehouse_id: bigint; location_code: string; location_name: string; is_active: boolean; system_role_code: string | null };

const warehouse = (id: bigint, code: string, over: Partial<Warehouse> = {}): Warehouse => ({
  warehouse_id: id, warehouse_code: code, warehouse_name: `창고 ${code}`, plant_id: 1n,
  warehouse_type_code: 'PRODUCT', is_active: true, is_defect: false, is_external: false, ...over,
});
const location = (id: bigint, warehouseId: bigint, role: string | null, active = true): Location => ({
  location_id: id, warehouse_id: warehouseId, location_code: `L${id}`, location_name: `위치 ${id}`, is_active: active, system_role_code: role,
});

/** where 를 실제로 풀어 거르는 가짜 — 조건을 잘못 걸면 결과가 틀린다. */
function fakeDb(warehouses: Warehouse[], locations: Location[]) {
  type LocationWhere = { warehouse_id: bigint; is_active?: boolean; system_role_code?: string | null };
  const matches = (row: Location, where: LocationWhere) =>
    row.warehouse_id === where.warehouse_id &&
    (where.is_active === undefined || row.is_active === where.is_active) &&
    (where.system_role_code === undefined || row.system_role_code === where.system_role_code);
  return {
    warehouse: {
      findMany: jest.fn(async ({ where }: { where: { warehouse_code: { in: string[] } } }) =>
        warehouses.filter((row) => where.warehouse_code.in.includes(row.warehouse_code))),
    },
    location: {
      // 나뉜 창고 판정은 `system_role_code: null` 로, 입고 위치 조회는 역할로 건다.
      findFirst: jest.fn(async ({ where }: { where: LocationWhere }) => {
        const row = locations.find((candidate) => matches(candidate, where));
        return row === undefined ? null : { location_id: row.location_id };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { location_id: bigint } }) =>
        locations.find((row) => row.location_id === where.location_id) as Location),
    },
    department_production_warehouse: {},
  } as never;
}

describe('resolveFgLocations — SL_CD → 창고 → 완제품 위치', () => {
  // 창고 10: 나뉘지 않음(창고 전체만). 창고 11: 나뉨(구역 + 적치 대기). 12: 꺼짐. 13: 다른 공장. 14: 자재. 15: 불량. 16: 외부.
  const warehouses = [
    warehouse(10n, 'S10'),
    warehouse(11n, 'S11'),
    warehouse(12n, 'S12', { is_active: false }),
    warehouse(13n, 'S13', { plant_id: 2n }),
    warehouse(14n, 'S14', { warehouse_type_code: 'MATERIAL' }),
    warehouse(15n, 'S15', { is_defect: true }),
    warehouse(16n, 'S16', { is_external: true }),
  ];
  const locations = [
    location(100n, 10n, WAREHOUSE_WHOLE),
    location(110n, 11n, WAREHOUSE_WHOLE), location(111n, 11n, PUTAWAY_STAGING), location(112n, 11n, null),
  ];
  const resolve = (erpCode: string | null) => resolveFgLocation(fakeDb(warehouses, locations), { plantId: 1n, erpCode });

  it('나뉘지 않은 창고는 「창고 전체」를 쓴다', async () => {
    expect(await resolve('S10')).toMatchObject({
      kind: 'ERP_STORAGE_LOCATION', warehouse: { id: 10n, code: 'S10' }, location: { id: 100n, isActive: true },
    });
  });

  it('나뉜 창고는 「적치 대기」를 쓴다', async () => {
    expect(await resolve('S11')).toMatchObject({ kind: 'ERP_STORAGE_LOCATION', warehouse: { id: 11n }, location: { id: 111n } });
  });

  it('SL_CD 를 앞뒤 공백 없이 비교하고, 비었으면 NO_STORAGE_CODE', async () => {
    expect(await resolve(' S10 ')).toMatchObject({ kind: 'ERP_STORAGE_LOCATION', warehouse: { id: 10n } });
    expect(await resolve(null)).toEqual({ kind: 'NO_STORAGE_CODE' });
    expect(await resolve('  ')).toEqual({ kind: 'NO_STORAGE_CODE' });
  });

  it.each([
    ['S99', 'FG_WAREHOUSE_UNMAPPED'],
    ['S12', 'FG_WAREHOUSE_INACTIVE'],
    ['S13', 'FG_WAREHOUSE_OTHER_PLANT'],
    ['S14', 'FG_WAREHOUSE_NOT_ALLOWED'],
    ['S15', 'FG_WAREHOUSE_NOT_ALLOWED'],
    ['S16', 'FG_WAREHOUSE_NOT_ALLOWED'],
  ])('SL_CD %s 는 연결 실패 %s — 다른 창고로 대체하지 않는다', async (code, reason) => {
    expect(await resolve(code)).toEqual({ kind: 'LINK_FAILED', erpCode: code, reason });
  });

  it('여러 오더를 한 번에 풀되 창고 조회는 한 번이다', async () => {
    const db = fakeDb(warehouses, locations);
    const result = await resolveFgLocations(db, [
      { plantId: 1n, erpCode: 'S10' }, { plantId: 1n, erpCode: 'S10' }, { plantId: 1n, erpCode: 'S11' }, { plantId: 2n, erpCode: 'S10' },
    ]);
    expect((db as unknown as { warehouse: { findMany: jest.Mock } }).warehouse.findMany).toHaveBeenCalledTimes(1);
    expect(result.get(fgKey({ plantId: 1n, erpCode: 'S11' }))).toMatchObject({ kind: 'ERP_STORAGE_LOCATION' });
    // 같은 코드라도 다른 공장의 오더는 그 창고가 다른 공장이다.
    expect(result.get(fgKey({ plantId: 2n, erpCode: 'S10' }))).toMatchObject({ kind: 'LINK_FAILED', reason: 'FG_WAREHOUSE_OTHER_PLANT' });
  });
});

describe('fgLocationOf — 출처', () => {
  const erp: FgResolution = {
    kind: 'ERP_STORAGE_LOCATION', erpCode: 'S10', warehouse: { id: 10n, code: 'S10', name: 'a' }, location: { id: 100n, code: 'L', name: 'l', isActive: true },
  };

  it('ERP 창고가 정해졌으면 라인 기본값이 있어도 ERP 위치다', () => {
    expect(fgLocationOf(erp, 32n)).toEqual({ source: 'ERP_STORAGE_LOCATION', locationId: 100n });
  });
  it('SL_CD 가 없으면 라인 기본값, 그것도 없으면 NONE', () => {
    expect(fgLocationOf({ kind: 'NO_STORAGE_CODE' }, 32n)).toEqual({ source: 'LINE_DEFAULT', locationId: 32n });
    expect(fgLocationOf({ kind: 'NO_STORAGE_CODE' }, null)).toEqual({ source: 'NONE', locationId: null });
  });
  it('연결이 실패하면 라인 기본값이 있어도 NONE', () => {
    expect(fgLocationOf({ kind: 'LINK_FAILED', erpCode: 'S10', reason: 'FG_WAREHOUSE_UNMAPPED' }, 32n)).toEqual({ source: 'NONE', locationId: null });
  });
});

describe('locationFinding — 사용자가 넣은 위치', () => {
  const fact = (warehouseId: bigint, over: Partial<LocationFact['warehouse']> = {}, active = true): LocationFact => ({
    location_id: 1n, is_active: active, warehouse_id: warehouseId,
    warehouse: { plant_id: 1n, warehouse_type_code: 'PRODUCT', is_active: true, is_external: false, is_defect: false, ...over },
  });
  const erp: FgResolution = {
    kind: 'ERP_STORAGE_LOCATION', erpCode: 'S10', warehouse: { id: 10n, code: 'S10', name: '완제품' }, location: { id: 100n, code: 'L', name: 'l', isActive: true },
  };

  it('규칙 없이(WIP·스크랩) 보면 공장·자재·활성만 본다', () => {
    expect(locationFinding(1n, fact(10n))).toBeNull();
    expect(locationFinding(1n, fact(10n, { is_external: true }))).toBeNull();
    expect(locationFinding(1n, fact(10n, { plant_id: 2n }))?.code).toBe('LOCATION_INVALID');
    expect(locationFinding(1n, fact(10n, { warehouse_type_code: 'MATERIAL' }))?.code).toBe('LOCATION_INVALID');
    expect(locationFinding(1n, fact(10n, {}, false))?.code).toBe('LOCATION_INVALID');
    expect(locationFinding(1n, undefined)?.code).toBe('LOCATION_INVALID');
  });

  it('ERP 입고 창고가 정해졌으면 그 창고 안만 — 다른 창고는 FG_LOCATION_OUTSIDE_WAREHOUSE', () => {
    expect(locationFinding(1n, fact(10n), erp)).toBeNull();
    expect(locationFinding(1n, fact(11n), erp)?.code).toBe('FG_LOCATION_OUTSIDE_WAREHOUSE');
  });

  it('SL_CD 가 없으면 외부·불량 창고도 막는다', () => {
    const none: FgResolution = { kind: 'NO_STORAGE_CODE' };
    expect(locationFinding(1n, fact(11n), none)).toBeNull();
    expect(locationFinding(1n, fact(11n, { is_external: true }), none)?.code).toBe('LOCATION_INVALID');
    expect(locationFinding(1n, fact(11n, { is_defect: true }), none)?.code).toBe('LOCATION_INVALID');
  });

  it('연결이 실패한 오더는 어떤 위치도 받지 않고 그 사유를 낸다', () => {
    expect(locationFinding(1n, fact(10n), { kind: 'LINK_FAILED', erpCode: 'S10', reason: 'FG_WAREHOUSE_INACTIVE' })?.code).toBe('FG_WAREHOUSE_INACTIVE');
  });
});
