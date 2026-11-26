import { arrivalLocationId, isDividedWarehouse, isProductionWarehouse, plantProductionWarehouses } from './production-warehouse';

type Warehouse = { id: bigint; plant: bigint; active: boolean; type: string };
type Location = { id: bigint; warehouse: bigint; active: boolean; role: string | null };

/** 질의의 where 를 실제로 풀어 거르는 가짜 — 조건을 잘못 걸면 결과가 틀린다(호출 모양만 보지 않는다). */
function fakeDb(warehouses: Warehouse[], locations: Location[]) {
  type WarehouseWhere = { warehouse_id?: bigint; plant_id?: bigint; warehouse_type_code?: string; is_active?: boolean };
  const warehouseMatch = (row: Warehouse, where: WarehouseWhere) =>
    (where.warehouse_id === undefined || row.id === where.warehouse_id) &&
    (where.plant_id === undefined || row.plant === where.plant_id) &&
    (where.warehouse_type_code === undefined || row.type === where.warehouse_type_code) &&
    (where.is_active === undefined || row.active === where.is_active);
  type LocationWhere = { warehouse_id: bigint; is_active?: boolean; system_role_code?: string | null };
  const locationMatch = (row: Location, where: LocationWhere) =>
    row.warehouse === where.warehouse_id &&
    (where.is_active === undefined || row.active === where.is_active) &&
    (where.system_role_code === undefined || row.role === where.system_role_code);
  return {
    warehouse: {
      findMany: jest.fn(async ({ where }: { where: WarehouseWhere }) =>
        warehouses.filter((row) => warehouseMatch(row, where)).sort((a, b) => (a.id < b.id ? -1 : 1)).map((row) => ({ warehouse_id: row.id }))),
      findFirst: jest.fn(async ({ where }: { where: WarehouseWhere }) => {
        const row = warehouses.find((w) => warehouseMatch(w, where));
        return row === undefined ? null : { warehouse_id: row.id };
      }),
    },
    location: {
      findFirst: jest.fn(async ({ where }: { where: LocationWhere }) => {
        const row = locations.find((l) => locationMatch(l, where));
        return row === undefined ? null : { location_id: row.id };
      }),
    },
  } as never;
}

describe('생산 창고 판정 (피처 004)', () => {
  // 공장 1: 창고 10·13(생산창고), 11(생산창고·사용 중지), 12(자재창고). 공장 2: 창고 20(생산창고).
  const warehouses: Warehouse[] = [
    { id: 13n, plant: 1n, active: true, type: 'PRODUCTION' },
    { id: 10n, plant: 1n, active: true, type: 'PRODUCTION' },
    { id: 11n, plant: 1n, active: false, type: 'PRODUCTION' },
    { id: 12n, plant: 1n, active: true, type: 'MATERIAL' },
    { id: 20n, plant: 2n, active: true, type: 'PRODUCTION' },
  ];
  const system = (warehouse: bigint, base: bigint): Location[] => [
    { id: base, warehouse, active: true, role: 'PUTAWAY_STAGING' },
    { id: base + 1n, warehouse, active: true, role: 'WAREHOUSE_WHOLE' },
  ];
  const locations: Location[] = [
    ...system(10n, 100n),
    { id: 110n, warehouse: 10n, active: true, role: null },
    ...system(12n, 120n),
    { id: 130n, warehouse: 12n, active: false, role: null },
    ...system(20n, 200n),
  ];
  const db = fakeDb(warehouses, locations);

  it('공장 생산 창고는 그 공장의 활성 생산창고 — 창고 번호 순, 다른 공장·사용 중지·다른 유형은 뺀다', async () => {
    expect(await plantProductionWarehouses(db, 1n)).toEqual([10n, 13n]);
    expect(await plantProductionWarehouses(db, 2n)).toEqual([20n]);
    expect(await plantProductionWarehouses(db, 9n)).toEqual([]);
  });

  it('생산 창고 여부 — 활성 생산창고만', async () => {
    expect(await isProductionWarehouse(db, 10n)).toBe(true);
    expect(await isProductionWarehouse(db, 11n)).toBe(false);
    expect(await isProductionWarehouse(db, 12n)).toBe(false);
  });

  it('나뉜 창고 = 사람이 만든 활성 위치가 하나라도 있다 — 시스템 위치·꺼진 위치는 세지 않는다', async () => {
    expect(await isDividedWarehouse(db, 10n)).toBe(true);
    expect(await isDividedWarehouse(db, 12n)).toBe(false);
    expect(await isDividedWarehouse(db, 20n)).toBe(false);
  });

  it('도착 위치 — 나뉜 창고는 적치 대기, 아니면 창고 전체', async () => {
    expect(await arrivalLocationId(db, 10n)).toBe(100n);
    expect(await arrivalLocationId(db, 20n)).toBe(201n);
  });
});
