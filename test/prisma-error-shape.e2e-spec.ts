import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { UNIQUE_VIOLATIONS } from '../src/mdm/unique-violations';
import { PrismaService } from '../src/prisma/prisma.service';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-P2002';

/**
 * `PrismaExceptionFilter` 의 매핑 키가 Prisma 의 오류 형태를 전제한다. 그 전제를
 * 실제 DB 로 확인한다.
 *
 * 필터 단위 테스트만으로는 부족하다 — 그 테스트도 같은 전제를 손으로 적어 둔 것이라,
 * Prisma 를 올려 형태가 바뀌면 **코드와 테스트가 함께 옛 전제를 유지한다.** CI 는
 * 초록인데 경합에 진 요청만 운영에서 500 을 받는다. 실제로 #18 에서 그 상태였다.
 */
describe('Prisma 오류 형태 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plantId: bigint;
  let businessUnitId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    ({ plantId, businessUnitId } = await createOrganization(prisma, PREFIX));
  });

  afterAll(async () => {
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.department.deleteMany({ where: { department_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await app.close();
  });

  /** 같은 데이터를 두 번 넣어 P2002 를 받아낸다. */
  async function duplicate(insert: () => Promise<unknown>): Promise<Prisma.PrismaClientKnownRequestError> {
    await insert();
    const caught: unknown = await insert().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    return caught as Prisma.PrismaClientKnownRequestError;
  }

  it('유니크 위반이 담는 값이 UNIQUE_VIOLATIONS 의 키와 맞는다', async () => {
    const data = {
      plant_id: plantId,
      business_unit_id: businessUnitId,
      warehouse_code: `${PREFIX}-01`,
      warehouse_name: '형태 확인용',
      warehouse_type_code: 'MATERIAL',
      management_level_code: 'WAREHOUSE',
    };

    await prisma.warehouse.create({ data });
    const caught: unknown = await prisma.warehouse.create({ data }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const { code, meta } = caught as Prisma.PrismaClientKnownRequestError;

    expect(code).toBe('P2002');
    // uq_warehouse 를 위반했는데 제약 이름이 오지 않는다 — 컬럼 목록이 온다.
    expect(meta?.target).toEqual(['plant_id', 'warehouse_code']);

    // 형태만 보면 부족하다. 그 형태로 만든 키가 실제 매핑에 있어야 필터가 동작한다.
    // 이 단언이 없으면 매핑 키를 제약 이름으로 잘못 적어도 아무 테스트가 깨지지 않는다.
    const key = (meta?.target as string[]).join(',');
    expect(UNIQUE_VIOLATIONS.has(key)).toBe(true);
  });

  it('단일 컬럼 유니크도 배열로 온다 — 문자열이면 키가 어긋난다', async () => {
    // 창고·로케이션은 두 컬럼짜리다. 부서는 department_code 하나뿐이라 형태가
    // 다를 수 있다 — 문자열로 오면 join 이 글자를 쪼개 키가 완전히 어긋난다.
    const { code, meta } = await duplicate(() =>
      prisma.department.create({
        data: { department_code: `${PREFIX}-DEP`, department_name: '형태 확인용' },
      }),
    );

    expect(code).toBe('P2002');
    expect(Array.isArray(meta?.target)).toBe(true);
    expect(meta?.target).toEqual(['department_code']);
    expect(UNIQUE_VIOLATIONS.has((meta?.target as string[]).join(','))).toBe(true);
  });

  it('로케이션의 키도 실제 매핑에 있다', async () => {
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plantId,
        business_unit_id: businessUnitId,
        warehouse_code: `${PREFIX}-LOC-WH`,
        warehouse_name: '형태 확인용',
        warehouse_type_code: 'MATERIAL',
        management_level_code: 'WAREHOUSE',
      },
    });

    const { code, meta } = await duplicate(() =>
      prisma.location.create({
        data: {
          warehouse_id: warehouse.warehouse_id,
          location_code: `${PREFIX}-LOC`,
          location_name: '형태 확인용',
          location_type_code: 'RACK',
        },
      }),
    );

    expect(code).toBe('P2002');
    expect(meta?.target).toEqual(['warehouse_id', 'location_code']);
    expect(UNIQUE_VIOLATIONS.has((meta?.target as string[]).join(','))).toBe(true);
  });

  it('매핑에 등록한 키가 모두 실제 유니크 제약과 맞는다', async () => {
    // 위 셋은 마스터가 늘 때마다 손으로 더해야 한다. 이 단언은 자동이다 —
    // 매핑에 오타가 있거나 정본에서 제약이 사라지면 여기서 깨진다.
    const constraints = await prisma.$queryRaw<{ key: string }[]>`
      SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS key
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'u' AND c.connamespace = 'mdm'::regnamespace
      GROUP BY c.oid
    `;
    const actual = new Set(constraints.map((row) => row.key));

    for (const key of UNIQUE_VIOLATIONS.keys()) {
      expect(actual.has(key)).toBe(true);
    }
  });
});
