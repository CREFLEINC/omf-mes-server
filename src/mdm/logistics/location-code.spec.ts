import { issueCode } from './location-code';

type Row = { warehouse_id: number; parent_location_id: number | null; location_code: string };

/** where 를 실제로 풀어 거르는 가짜 — 창고 조건을 잘못 걸면 결과가 틀린다. */
function fakeTx(warehouses: Record<number, string>, rows: Row[]) {
  type Where = { warehouse_id?: number; parent_location_id?: number | null; location_code: string | { startsWith: string } };
  const matches = (row: Row, where: Where) =>
    (where.warehouse_id === undefined || row.warehouse_id === where.warehouse_id) &&
    (where.parent_location_id === undefined || row.parent_location_id === where.parent_location_id) &&
    (typeof where.location_code === 'string'
      ? row.location_code === where.location_code
      : row.location_code.startsWith(where.location_code.startsWith));
  return {
    warehouse: {
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { warehouse_id: number } }) => ({ warehouse_code: warehouses[where.warehouse_id] })),
    },
    location: {
      findMany: jest.fn(async ({ where }: { where: Where }) => rows.filter((row) => matches(row, where))),
      count: jest.fn(async ({ where }: { where: Where }) => rows.filter((row) => matches(row, where)).length),
    },
  } as never;
}

describe('issueCode — 위치 코드는 창고 코드로 시작한다(omf-all-around#292)', () => {
  it('⭐ 구역은 {창고 코드}-Z01 부터 — 옛 Z01 이나 창고 코드로 시작하는 사람 코드는 번호에 세지 않는다', async () => {
    const tx = fakeTx({ 1: 'S230' }, [
      { warehouse_id: 1, parent_location_id: null, location_code: 'S230-SYS-STAGING' },
      { warehouse_id: 1, parent_location_id: null, location_code: 'S230-01' },
    ]);
    await expect(issueCode(tx, 1, null, 'ZONE')).resolves.toBe('S230-Z01');
  });

  it('⭐ 같은 창고 같은 상위 밑 가장 큰 번호 + 1', async () => {
    const tx = fakeTx({ 1: 'S230' }, [
      { warehouse_id: 1, parent_location_id: null, location_code: 'S230-Z01' },
      { warehouse_id: 1, parent_location_id: null, location_code: 'S230-Z03' },
      { warehouse_id: 2, parent_location_id: null, location_code: 'S240-Z07' },
    ]);
    await expect(issueCode(tx, 1, null, 'ZONE')).resolves.toBe('S230-Z04');
  });

  it('⭐ 하위는 상위 코드를 잇는다 — 창고 코드가 따라온다', async () => {
    const tx = fakeTx({ 1: 'S230' }, [{ warehouse_id: 1, parent_location_id: 10, location_code: 'S230-Z01-R001' }]);
    await expect(issueCode(tx, 1, { locationId: 10, locationCode: 'S230-Z01' }, 'RACK')).resolves.toBe('S230-Z01-R002');
    await expect(issueCode(tx, 1, { locationId: 20, locationCode: 'S230-Z01-R002' }, 'LEVEL')).resolves.toBe('S230-Z01-R002-L01');
  });

  it('⛔ 겹침 검사는 모든 창고를 본다 — 다른 창고에 같은 코드가 있으면 건너뛴다', async () => {
    // 다른 창고(2)에 사람이 지은 코드가 이 창고의 다음 번호와 같다 — 번호 세기에는 안 들어가도 겹침 검사에는 걸린다.
    const tx = fakeTx({ 1: 'S230', 2: 'S240' }, [{ warehouse_id: 2, parent_location_id: null, location_code: 'S230-Z01' }]);
    await expect(issueCode(tx, 1, null, 'ZONE')).resolves.toBe('S230-Z02');
  });
});
