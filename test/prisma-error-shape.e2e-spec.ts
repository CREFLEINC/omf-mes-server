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
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await app.close();
  });

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
});
