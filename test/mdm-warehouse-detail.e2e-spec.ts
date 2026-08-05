import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  WAREHOUSE_REFERENCES,
  referenceKey,
} from '../src/mdm/warehouse/warehouse.references';
import { PrismaService } from '../src/prisma/prisma.service';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-WHD';

describe('GET /api/mdm/warehouses/{warehouseId} (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let warehouseId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();

    prisma = app.get(PrismaService);
    const { plantId, businessUnitId } = await createOrganization(prisma, PREFIX);

    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plantId,
        business_unit_id: businessUnitId,
        warehouse_code: `${PREFIX}-01`,
        warehouse_name: '상세조회 창고',
        warehouse_type_code: 'MATERIAL',
        management_level_code: 'WAREHOUSE',
      },
    });
    warehouseId = warehouse.warehouse_id;
  });

  afterAll(async () => {
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await app.close();
  });

  function detail(id: bigint | number | string) {
    return request(app.getHttpServer()).get(`/api/mdm/warehouses/${id}`);
  }

  it('참조 목록이 정본 물리 모델과 일치한다', async () => {
    // 코드에 적힌 목록에서 하나가 빠지면 쓰이고 있는 창고가 「수정 가능」으로 잘못
    // 판정된다. 정본에 FK 가 늘거나 줄면 이 단언이 깨져 알려준다.
    const rows = await prisma.$queryRaw<{ key: string }[]>`
      SELECT n.nspname || '.' || t.relname || '.' || a.attname AS key
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f' AND c.confrelid = 'mdm.warehouse'::regclass
    `;

    expect(rows.map((r) => r.key).sort()).toEqual(WAREHOUSE_REFERENCES.map(referenceKey).sort());
  });

  it('{warehouse, editability} 로 감싸 내린다', async () => {
    const { body } = await detail(warehouseId).expect(200);

    expect(Object.keys(body).sort()).toEqual(['editability', 'warehouse']);
    expect(body.warehouse.warehouseCode).toBe(`${PREFIX}-01`);
  });

  it('ETag 헤더에 version_no 를 싣는다 — 본문에는 내리지 않는다(공유계약 A-4)', async () => {
    const response = await detail(warehouseId).expect(200);
    const row = await prisma.warehouse.findUniqueOrThrow({
      where: { warehouse_id: warehouseId },
    });

    expect(response.headers.etag).toBe(String(row.version_no));
    expect(JSON.stringify(response.body)).not.toContain('version');
  });

  it('아무도 안 쓰는 창고는 코드를 고칠 수 있다', async () => {
    const { body } = await detail(warehouseId).expect(200);

    expect(body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('로케이션이 생기면 참조 건수가 오르고 코드가 잠긴다', async () => {
    await prisma.location.create({
      data: {
        warehouse_id: warehouseId,
        location_code: `${PREFIX}-LOC`,
        location_name: '상세조회 로케이션',
        location_type_code: 'RACK',
      },
    });

    const { body } = await detail(warehouseId).expect(200);

    expect(body.editability).toEqual({
      codeEditable: false,
      reason: 'REFERENCED',
      referenceCount: 1,
    });
  });

  it('없는 창고는 404 다', async () => {
    await detail(999999999).expect(404);
  });

  it('숫자가 아닌 식별자는 400 이다', async () => {
    await detail('abc').expect(400);
  });
});
