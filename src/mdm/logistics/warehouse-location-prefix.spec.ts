import { LOCATION_PREFIX_PATTERN, assertLocationPrefixFormat, assertLocationPrefixKept } from './location-prefix';
import { WarehouseService } from './warehouse.service';

/** 던진 ContractException 의 상태·오류 항목을 꺼낸다. */
async function rejection(run: () => unknown): Promise<{ status: number; errors: unknown[] }> {
  try {
    await run();
  } catch (error) {
    const contract = error as { getStatus(): number; getResponse(): { errors: unknown[] } };
    return { status: contract.getStatus(), errors: contract.getResponse().errors };
  }
  throw new Error('막지 않았다');
}

const ROW = {
  warehouse_id: 7n, plant_id: 1n, business_unit_id: 2n, warehouse_code: 'WH-01', warehouse_name: '자재창고',
  warehouse_type_code: 'RAW', is_external: false, is_defect: false, is_active: true, alias_name: null,
  location_prefix: 'K7QX', version_no: 1,
};

/** 창고 서비스가 부르는 자리만 흉내 낸다 — `taken` 은 이미 쓰는 창고 위치 코드다. */
function fakePrisma(taken: string[] = []) {
  return {
    code_value: {
      findMany: jest.fn(async () => [{ code: 'RAW', code_group: { group_code: 'WAREHOUSE_TYPE' } }]),
      // ERP 창고 코드가 아니다.
      findFirst: jest.fn(async () => null),
    },
    warehouse: {
      findUnique: jest.fn(async ({ where }: { where: { location_prefix?: string; warehouse_id?: number } }) => {
        if (where.location_prefix !== undefined) return taken.includes(where.location_prefix) ? { warehouse_id: 9n } : null;
        return ROW;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...ROW, location_prefix: data.location_prefix ?? 'R4ND' })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    location: { count: jest.fn(async () => 2) },
    $queryRawUnsafe: jest.fn(async () => [{ total: 2n }]),
  };
}

const CREATE = { plantId: 1, businessUnitId: 2, warehouseCode: 'WH-01', warehouseName: '자재창고', warehouseTypeCode: 'RAW' };
const UPDATE = { businessUnitId: 2, warehouseCode: 'WH-01', warehouseName: '자재창고', warehouseTypeCode: 'RAW', isExternal: false, isDefect: false };

describe('창고 위치 코드 형식(omf-all-around#292)', () => {
  it.each(['AB', 'K7QX', 'ZQ7', 'A1B2C3', '0000'])('⭐ %s 는 받는다 — 대문자·숫자 2~6자', (prefix) => {
    expect(() => assertLocationPrefixFormat(prefix)).not.toThrow();
  });

  it.each(['A', 'ABCDEFG', 'k7qx', 'K7-Q', 'K7 Q', '창고', ''])('⛔ "%s" 는 400 locationPrefix INVALID', async (prefix) => {
    await expect(rejection(() => assertLocationPrefixFormat(prefix))).resolves.toEqual({
      status: 400, errors: [expect.objectContaining({ scope: 'field', field: 'locationPrefix', code: 'INVALID' })],
    });
  });

  it('⭐ 형식에 `-` 가 없다 — 위치 코드의 첫 조각이 곧 창고다', () => {
    expect(LOCATION_PREFIX_PATTERN.test('K7-Q')).toBe(false);
  });
});

describe('창고 등록 — 창고 위치 코드(omf-all-around#292)', () => {
  it('⭐ 빼고 보내면 칸을 싣지 않는다 — DB 기본값이 무작위로 채우고 응답에 싣는다', async () => {
    const prisma = fakePrisma();
    const created = await new WarehouseService(prisma as never).create(CREATE);
    expect(prisma.warehouse.create.mock.calls[0][0].data).not.toHaveProperty('location_prefix');
    expect(created.locationPrefix).toBe('R4ND');
  });

  it('⭐ 사람이 고쳐 보낸 값을 그대로 쓴다', async () => {
    const prisma = fakePrisma(['K7QX']);
    const created = await new WarehouseService(prisma as never).create({ ...CREATE, locationPrefix: 'ZQ7' });
    expect(prisma.warehouse.create.mock.calls[0][0].data).toMatchObject({ location_prefix: 'ZQ7' });
    expect(created.locationPrefix).toBe('ZQ7');
  });

  it('⛔ 다른 창고가 쓰는 값이면 400 locationPrefix UNIQUE_VIOLATION — 만들지 않는다', async () => {
    const prisma = fakePrisma(['K7QX']);
    await expect(rejection(() => new WarehouseService(prisma as never).create({ ...CREATE, locationPrefix: 'K7QX' }))).resolves.toEqual({
      status: 400,
      errors: [expect.objectContaining({
        scope: 'field', field: 'locationPrefix', code: 'UNIQUE_VIOLATION', uniqueScope: ['locationPrefix'],
        message: '이미 다른 창고가 쓰는 창고 위치 코드입니다.',
      })],
    });
    expect(prisma.warehouse.create).not.toHaveBeenCalled();
  });

  it('⛔ 형식이 틀리면 400 locationPrefix INVALID — 만들지 않는다', async () => {
    const prisma = fakePrisma();
    await expect(rejection(() => new WarehouseService(prisma as never).create({ ...CREATE, locationPrefix: 'k7' }))).resolves
      .toMatchObject({ status: 400, errors: [expect.objectContaining({ field: 'locationPrefix', code: 'INVALID' })] });
    expect(prisma.warehouse.create).not.toHaveBeenCalled();
  });
});

describe('창고 수정 — 창고 위치 코드는 등록한 뒤 바꾸지 않는다(omf-all-around#292)', () => {
  it('⛔ 다른 값이면 400 locationPrefix STATE_LOCKED — 저장하지 않는다', async () => {
    const prisma = fakePrisma();
    await expect(rejection(() => new WarehouseService(prisma as never).update(7, 1, { ...UPDATE, locationPrefix: 'ZQ7' }))).resolves.toEqual({
      status: 400,
      errors: [expect.objectContaining({ scope: 'field', field: 'locationPrefix', code: 'STATE_LOCKED' })],
    });
    expect(prisma.warehouse.updateMany).not.toHaveBeenCalled();
  });

  it.each([['빼고 보내면', undefined], ['같은 값이면', 'K7QX']])('⭐ %s 저장한다 — 칸은 건드리지 않는다', async (_label, locationPrefix) => {
    const prisma = fakePrisma();
    const result = await new WarehouseService(prisma as never).update(7, 1, { ...UPDATE, locationPrefix });
    expect(prisma.warehouse.updateMany.mock.calls[0]).toEqual([
      expect.objectContaining({ data: expect.not.objectContaining({ location_prefix: expect.anything() }) }),
    ]);
    expect(result.warehouse.locationPrefix).toBe('K7QX');
  });

  it('⭐ assertLocationPrefixKept — 뺀 값·같은 값은 통과한다', () => {
    expect(() => assertLocationPrefixKept('K7QX', undefined)).not.toThrow();
    expect(() => assertLocationPrefixKept('K7QX', 'K7QX')).not.toThrow();
  });
});
