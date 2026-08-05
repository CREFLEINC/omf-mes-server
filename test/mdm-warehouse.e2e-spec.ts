import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/** 이 테스트가 만든 행만 지우기 위한 표식. `q` 로 검색 범위를 좁히는 데도 쓴다. */
const PREFIX = 'E2E-WH';

describe('GET /api/mdm/warehouses (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();

    prisma = app.get(PrismaService);
    const plant = await prisma.plant.findFirstOrThrow();
    const businessUnit = await prisma.business_unit.findFirstOrThrow();

    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.warehouse.createMany({
      data: [
        {
          plant_id: plant.plant_id,
          business_unit_id: businessUnit.business_unit_id,
          warehouse_code: `${PREFIX}-01`,
          warehouse_name: '자재창고',
          warehouse_type_code: 'MATERIAL',
          management_level_code: 'WAREHOUSE',
        },
        {
          plant_id: plant.plant_id,
          business_unit_id: businessUnit.business_unit_id,
          warehouse_code: `${PREFIX}-02`,
          warehouse_name: '완제품창고',
          warehouse_type_code: 'PRODUCT',
          management_level_code: 'ZONE',
        },
        {
          plant_id: plant.plant_id,
          business_unit_id: businessUnit.business_unit_id,
          warehouse_code: `${PREFIX}-03`,
          warehouse_name: '폐쇄창고',
          warehouse_type_code: 'MATERIAL',
          management_level_code: 'WAREHOUSE',
          is_active: false,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await app.close();
  });

  function list(query: Record<string, string> = {}) {
    return request(app.getHttpServer())
      .get('/api/mdm/warehouses')
      .query({ q: PREFIX, ...query });
  }

  it('기본은 사용 중인 것만 내린다', async () => {
    const { body } = await list().expect(200);

    expect(body.items.map((w: { warehouseCode: string }) => w.warehouseCode)).toEqual([
      `${PREFIX}-01`,
      `${PREFIX}-02`,
    ]);
  });

  it('includeInactive 를 켜면 사용 중지된 것도 함께 내린다', async () => {
    const { body } = await list({ includeInactive: 'true' }).expect(200);

    expect(body.items).toHaveLength(3);
    expect(body.items.find((w: { warehouseCode: string }) => w.warehouseCode === `${PREFIX}-03`))
      .toMatchObject({ isActive: false });
  });

  it('q 는 코드와 명칭 양쪽을 찾는다', async () => {
    const byName = await list({ q: '완제품창고' }).expect(200);

    expect(byName.body.items).toHaveLength(1);
    expect(byName.body.items[0].warehouseCode).toBe(`${PREFIX}-02`);
  });

  it('warehouseTypeCode 로 거른다', async () => {
    const { body } = await list({ warehouseTypeCode: 'PRODUCT' }).expect(200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].warehouseTypeCode).toBe('PRODUCT');
  });

  it('page 봉투는 {page, size, total} 이다 — totalPages 를 만들지 않는다', async () => {
    const { body } = await list({ page: '2', size: '1' }).expect(200);

    expect(body.page).toEqual({ page: 2, size: 1, total: 2 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0].warehouseCode).toBe(`${PREFIX}-02`);
  });

  it('계약에 없는 컬럼을 내리지 않는다 — version_no·감사 컬럼', async () => {
    const { body } = await list().expect(200);

    expect(Object.keys(body.items[0]).sort()).toEqual([
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

  it('식별자는 JSON 숫자다 — 계약이 type: integer 다', async () => {
    const { body } = await list().expect(200);

    expect(typeof body.items[0].warehouseId).toBe('number');
    expect(typeof body.items[0].plantId).toBe('number');
  });

  it('정의되지 않은 쿼리 파라미터는 400 이다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/warehouses')
      .query({ unknownParam: 'x' })
      .expect(400);
  });
});
