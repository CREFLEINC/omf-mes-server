import { ContractException } from '../../common/errors';
import { assertLocationsAllowed } from './work-order-location-check';

/** ERP W/O 공장 1, SL_CD S10 → 창고 10(전체 100·구역 101·적치 대기 102). 창고 11 은 다른 창고. 위치 200 은 자재창고. */
function fakeTx(options: { erpCode: string | null; planned?: boolean; current?: { wip?: bigint | null; fg?: bigint | null; scrap?: bigint | null } }) {
  const warehouses = [
    { warehouse_id: 10n, warehouse_code: 'S10', warehouse_name: '완제품', plant_id: 1n, warehouse_type_code: 'PRODUCT', is_active: true, is_defect: false, is_external: false },
  ];
  const locations = [
    { location_id: 100n, warehouse_id: 10n, location_code: 'WH', location_name: '창고 전체', is_active: true, system_role_code: 'WAREHOUSE_WHOLE', wh: { plant_id: 1n, warehouse_type_code: 'PRODUCT', is_active: true, is_external: false, is_defect: false } },
    { location_id: 101n, warehouse_id: 10n, location_code: 'A1', location_name: 'A1', is_active: true, system_role_code: null, wh: { plant_id: 1n, warehouse_type_code: 'PRODUCT', is_active: true, is_external: false, is_defect: false } },
    { location_id: 102n, warehouse_id: 10n, location_code: 'STG', location_name: '적치 대기', is_active: true, system_role_code: 'PUTAWAY_STAGING', wh: { plant_id: 1n, warehouse_type_code: 'PRODUCT', is_active: true, is_external: false, is_defect: false } },
    { location_id: 150n, warehouse_id: 11n, location_code: 'B1', location_name: 'B1', is_active: true, system_role_code: null, wh: { plant_id: 1n, warehouse_type_code: 'PRODUCT', is_active: true, is_external: false, is_defect: false } },
    { location_id: 200n, warehouse_id: 12n, location_code: 'M1', location_name: 'M1', is_active: true, system_role_code: null, wh: { plant_id: 1n, warehouse_type_code: 'MATERIAL', is_active: true, is_external: false, is_defect: false } },
  ];
  const current = options.current ?? {};
  return {
    work_order: {
      findUniqueOrThrow: jest.fn(async () => ({
        default_wip_location_id: current.wip ?? null,
        default_fg_location_id: current.fg ?? null,
        default_scrap_location_id: current.scrap ?? null,
        production_plan: options.planned === false ? null : { production_order: { plant_id: 1n, erp_storage_location_code: options.erpCode } },
      })),
    },
    warehouse: { findMany: jest.fn(async () => (options.erpCode === 'S10' ? warehouses : [])) },
    location: {
      findMany: jest.fn(async ({ where }: { where: { location_id: { in: bigint[] } } }) =>
        locations.filter((row) => where.location_id.in.includes(row.location_id)).map((row) => ({ location_id: row.location_id, is_active: row.is_active, warehouse_id: row.warehouse_id, warehouse: row.wh }))),
      findFirst: jest.fn(async ({ where }: { where: { system_role_code?: string | null } }) => {
        const row = locations.find((candidate) => candidate.warehouse_id === 10n && (where.system_role_code === undefined || candidate.system_role_code === where.system_role_code));
        return row === undefined ? null : { location_id: row.location_id };
      }),
      findUniqueOrThrow: jest.fn(async () => locations[0]),
    },
    department_production_warehouse: {},
  } as never;
}

const failures = async (tx: never, body: Parameters<typeof assertLocationsAllowed>[2]) => {
  const caught = await assertLocationsAllowed(tx, 1, body).then(() => null, (error: unknown) => error);
  if (caught === null) return null;
  expect(caught).toBeInstanceOf(ContractException);
  return ((caught as ContractException).getResponse() as { errors: { field: string; code: string }[] }).errors.map((item) => [item.field, item.code]);
};

describe('assertLocationsAllowed — MES W/O 수정의 기본 위치 검증', () => {
  it('위치 칸이 본문에 없으면 아무것도 읽지 않는다', async () => {
    const tx = fakeTx({ erpCode: 'S10' });
    expect(await failures(tx, { orderQty: 1 } as never)).toBeNull();
    expect((tx as unknown as { work_order: { findUniqueOrThrow: jest.Mock } }).work_order.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('SL_CD 창고 안의 완제품 위치는 통과, 다른 창고면 FG_LOCATION_OUTSIDE_WAREHOUSE', async () => {
    expect(await failures(fakeTx({ erpCode: 'S10' }), { defaultFgLocationId: 101 })).toBeNull();
    expect(await failures(fakeTx({ erpCode: 'S10' }), { defaultFgLocationId: 150 })).toEqual([['defaultFgLocationId', 'FG_LOCATION_OUTSIDE_WAREHOUSE']]);
  });

  it('SL_CD 를 창고로 풀지 못하면 어떤 완제품 위치도 받지 않는다', async () => {
    expect(await failures(fakeTx({ erpCode: 'S99' }), { defaultFgLocationId: 101 })).toEqual([['defaultFgLocationId', 'FG_WAREHOUSE_UNMAPPED']]);
  });

  it('SL_CD 가 없으면 같은 공장의 자재창고가 아닌 위치면 된다', async () => {
    expect(await failures(fakeTx({ erpCode: null }), { defaultFgLocationId: 150 })).toBeNull();
    expect(await failures(fakeTx({ erpCode: null }), { defaultFgLocationId: 200 })).toEqual([['defaultFgLocationId', 'LOCATION_INVALID']]);
  });

  it('WIP·스크랩은 입고 창고와 무관하게 기존 자원 규칙만 본다', async () => {
    expect(await failures(fakeTx({ erpCode: 'S99' }), { defaultWipLocationId: 150, defaultScrapLocationId: 150 })).toBeNull();
    expect(await failures(fakeTx({ erpCode: 'S10' }), { defaultWipLocationId: 200, defaultScrapLocationId: 200 })).toEqual([
      ['defaultWipLocationId', 'LOCATION_INVALID'],
      ['defaultScrapLocationId', 'LOCATION_INVALID'],
    ]);
  });

  it('값을 바꾸지 않는 재전송과 null 해제는 검증하지 않는다 — 옛 W/O 를 다른 칸 수정으로 막지 않는다', async () => {
    expect(await failures(fakeTx({ erpCode: 'S10', current: { fg: 150n } }), { defaultFgLocationId: 150 })).toBeNull();
    expect(await failures(fakeTx({ erpCode: 'S10' }), { defaultFgLocationId: null })).toBeNull();
  });

  it('계획이 없는 W/O 는 공장을 알 수 없어 검증하지 않는다', async () => {
    expect(await failures(fakeTx({ erpCode: 'S10', planned: false }), { defaultFgLocationId: 150 })).toBeNull();
  });
});
