import { arrivalLocationId, isDividedWarehouse, isProductionWarehouse, plantProductionWarehouses } from './production-warehouse';

type Warehouse = { id: bigint; plant: bigint; active: boolean };
type Location = { id: bigint; warehouse: bigint; active: boolean; role: string | null };

/** 질의의 where 를 실제로 풀어 거르는 가짜 — 조건을 잘못 걸면 결과가 틀린다(호출 모양만 보지 않는다). */
function fakeDb(warehouses: Warehouse[], links: [bigint, bigint][], locations: Location[]) {
  const whOf = (id: bigint) => warehouses.find((w) => w.id === id) as Warehouse;
  const linkRows = links.map(([department, warehouse]) => ({ department_id: department, warehouse_id: warehouse }));
  type LinkWhere = { warehouse_id?: bigint; warehouse?: { plant_id?: bigint; is_active?: boolean } };
  const linkMatch = (row: (typeof linkRows)[number], where: LinkWhere) =>
    (where.warehouse_id === undefined || row.warehouse_id === where.warehouse_id) &&
    (where.warehouse?.plant_id === undefined || whOf(row.warehouse_id).plant === where.warehouse.plant_id) &&
    (where.warehouse?.is_active === undefined || whOf(row.warehouse_id).active === where.warehouse.is_active);
  type LocationWhere = { warehouse_id: bigint; is_active?: boolean; system_role_code?: string | null };
  const locationMatch = (row: Location, where: LocationWhere) =>
    row.warehouse === where.warehouse_id &&
    (where.is_active === undefined || row.active === where.is_active) &&
    (where.system_role_code === undefined || row.role === where.system_role_code);
  return {
    department_production_warehouse: {
      findMany: jest.fn(async ({ where }: { where: LinkWhere }) => {
        const ids = [...new Set(linkRows.filter((row) => linkMatch(row, where)).map((row) => row.warehouse_id))];
        return ids.sort((a, b) => (a < b ? -1 : 1)).map((warehouse_id) => ({ warehouse_id }));
      }),
      findFirst: jest.fn(async ({ where }: { where: LinkWhere }) => linkRows.find((row) => linkMatch(row, where)) ?? null),
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
  // 공장 1: 창고 10(생산·두 부서), 11(생산·사용 중지), 12(연결 없음). 공장 2: 창고 20(생산).
  const warehouses: Warehouse[] = [
    { id: 10n, plant: 1n, active: true },
    { id: 11n, plant: 1n, active: false },
    { id: 12n, plant: 1n, active: true },
    { id: 20n, plant: 2n, active: true },
  ];
  const links: [bigint, bigint][] = [[1n, 10n], [2n, 10n], [1n, 11n], [3n, 20n]];
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
  const db = fakeDb(warehouses, links, locations);

  it('공장 생산 창고는 부서에 연결된 그 공장의 활성 창고 — 중복을 빼고 다른 공장·사용 중지·미연결은 뺀다', async () => {
    expect(await plantProductionWarehouses(db, 1n)).toEqual([10n]);
    expect(await plantProductionWarehouses(db, 2n)).toEqual([20n]);
    expect(await plantProductionWarehouses(db, 9n)).toEqual([]);
  });

  it('생산 창고 여부 — 연결된 활성 창고만', async () => {
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
