import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { LOCATION_REFERENCES } from '../src/mdm/location/location.references';
import { referenceKey } from '../src/mdm/reference-count';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { createLocation, deleteWarehouseContents } from './support/inventory.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-LOC';

describe('GET /api/mdm/locations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let warehouseId: bigint;
  let otherWarehouseId: bigint;
  let locationId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, ['MASTER_READ']));
    const { plantId, businessUnitId } = await createOrganization(prisma, PREFIX);

    const warehouse = async (suffix: string) =>
      (
        await prisma.warehouse.create({
          data: {
            plant_id: plantId,
            business_unit_id: businessUnitId,
            warehouse_code: `${PREFIX}-${suffix}`,
            warehouse_name: 'e2e 창고',
            warehouse_type_code: 'MATERIAL',
            management_level_code: 'WAREHOUSE',
          },
        })
      ).warehouse_id;

    warehouseId = await warehouse('WH1');
    otherWarehouseId = await warehouse('WH2');

    locationId = await createLocation(prisma, warehouseId, `${PREFIX}-A-01`, true);
    await createLocation(prisma, warehouseId, `${PREFIX}-A-02`, true);
    await createLocation(prisma, warehouseId, `${PREFIX}-B-01`, false);
    await createLocation(prisma, otherWarehouseId, `${PREFIX}-A-01`, true);
  });

  afterAll(async () => {
    await deleteWarehouseContents(prisma, PREFIX);
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await app.close();
  });

  function list(query: string) {
    return request(app.getHttpServer())
      .get(`/api/mdm/locations?${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function detail(id: bigint | number) {
    return request(app.getHttpServer())
      .get(`/api/mdm/locations/${id}`)
      .set('Authorization', `Bearer ${token}`);
  }

  describe('참조 목록', () => {
    it('손으로 적은 26개가 정본 물리 모델의 외래키와 일치한다', async () => {
      const rows = await prisma.$queryRaw<{ key: string }[]>`
        SELECT n.nspname || '.' || t.relname || '.' || a.attname AS key
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'f' AND c.confrelid = 'mdm.location'::regclass
      `;

      expect(rows.map((r) => r.key).sort()).toEqual(LOCATION_REFERENCES.map(referenceKey).sort());
    });

    it.each([['mdm.location'], ['mdm.warehouse']])(
      '%s 를 가리키는 모든 FK 컬럼에 쓸 수 있는 인덱스가 있다',
      async (target) => {
        // 「인덱스가 있다」를 눈으로 세다 두 번 틀렸다 — ix_inventory_available 과
        // ix_picking_open 은 warehouse_id 가 선행 컬럼이지만 부분 인덱스라
        // 마스터 하나로 조회하는 쪽은 쓸 수 없다. 판정을 테스트에 넘긴다.
        //   indkey[0] = 그 컬럼  … 선행 컬럼이어야 탐색이 된다
        //   indpred IS NULL      … 부분 인덱스는 조건이 안 맞으면 못 쓴다
        const uncovered = await prisma.$queryRawUnsafe<{ key: string }[]>(
          `SELECT n.nspname || '.' || t.relname || '.' || a.attname AS key
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN unnest(c.conkey) AS k(attnum) ON true
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           WHERE c.contype = 'f' AND c.confrelid = $1::regclass
             AND NOT EXISTS (
               SELECT 1 FROM pg_index x
               WHERE x.indrelid = c.conrelid AND x.indkey[0] = a.attnum AND x.indpred IS NULL
             )`,
          target,
        );

        expect(uncovered.map((r) => r.key)).toEqual([]);
      },
    );
  });

  describe('목록', () => {
    it('warehouseId 를 안 보내면 400 이다 — 창고를 고른 뒤에 보는 화면이다', async () => {
      await list('').expect(400);
    });

    it('그 창고의 로케이션만 나온다', async () => {
      const { body } = await list(`warehouseId=${warehouseId}`).expect(200);

      expect(body.items).toHaveLength(2);
      expect(body.items.every((item: { warehouseId: number }) => item.warehouseId === Number(warehouseId))).toBe(true);
    });

    it('다른 창고에 같은 코드가 있어도 섞이지 않는다 — uq_location 은 창고 안에서만 유일하다', async () => {
      const { body } = await list(`warehouseId=${otherWarehouseId}`).expect(200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].locationCode).toBe(`${PREFIX}-A-01`);
    });

    it('기본은 사용 중인 것만 — includeInactive 로 켠다', async () => {
      const { body } = await list(`warehouseId=${warehouseId}&includeInactive=true`).expect(200);

      expect(body.items).toHaveLength(3);
    });

    it('코드·명칭으로 검색된다', async () => {
      const { body } = await list(`warehouseId=${warehouseId}&q=A-02`).expect(200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].locationCode).toBe(`${PREFIX}-A-02`);
    });

    it('페이지를 넘겨도 같은 행이 두 번 나오지 않는다', async () => {
      const first = await list(`warehouseId=${warehouseId}&size=1&page=1`).expect(200);
      const second = await list(`warehouseId=${warehouseId}&size=1&page=2`).expect(200);

      expect(first.body.items[0].locationId).not.toBe(second.body.items[0].locationId);
      expect(first.body.page).toEqual({ page: 1, size: 1, total: 2 });
    });

    it('size 상한을 넘기면 400 이다', async () => {
      await list(`warehouseId=${warehouseId}&size=1000000`).expect(400);
    });
  });

  describe('상세', () => {
    it('{location, editability} 로 감싸 내린다', async () => {
      const { body } = await detail(locationId).expect(200);

      expect(Object.keys(body).sort()).toEqual(['editability', 'location']);
      expect(body.location.locationCode).toBe(`${PREFIX}-A-01`);
    });

    it('ETag 헤더에 version_no 를 싣는다 — 본문에는 내리지 않는다(공유계약 A-4)', async () => {
      const response = await detail(locationId).expect(200);
      const row = await prisma.location.findUniqueOrThrow({ where: { location_id: locationId } });

      expect(response.headers.etag).toBe(String(row.version_no));
      expect(JSON.stringify(response.body)).not.toContain('version');
    });

    it('아무도 안 쓰는 자리는 코드를 고칠 수 있다', async () => {
      const { body } = await detail(locationId).expect(200);

      expect(body.editability).toEqual({ codeEditable: true, reason: 'EDITABLE', referenceCount: 0 });
    });

    it('하위 자리를 가지면 코드가 잠긴다 — parent_location_id 도 참조다', async () => {
      const child = await prisma.location.create({
        data: {
          warehouse_id: warehouseId,
          parent_location_id: locationId,
          location_code: `${PREFIX}-A-01-CHILD`,
          location_name: '하위 자리',
          location_type_code: 'RACK',
        },
      });

      try {
        const { body } = await detail(locationId).expect(200);

        expect(body.editability).toMatchObject({ codeEditable: false, reason: 'REFERENCED' });
        expect(body.editability.referenceCount).toBeGreaterThan(0);
      } finally {
        await prisma.location.delete({ where: { location_id: child.location_id } });
      }
    });

    it('capacityQty 를 JSON 숫자로 내린다 — Decimal 을 그대로 내리면 객체가 나간다', async () => {
      const uom = await prisma.uom.upsert({
        where: { uom_code: `${PREFIX}-BOX` },
        update: {},
        create: { uom_code: `${PREFIX}-BOX`, uom_name: 'e2e 박스' },
      });
      await prisma.location.update({
        where: { location_id: locationId },
        data: { capacity_qty: 500, capacity_uom_id: uom.uom_id },
      });

      try {
        const { body } = await detail(locationId).expect(200);

        expect(body.location.capacityQty).toBe(500);
      } finally {
        await prisma.location.update({
          where: { location_id: locationId },
          data: { capacity_qty: null, capacity_uom_id: null },
        });
        await prisma.uom.delete({ where: { uom_id: uom.uom_id } });
      }
    });

    it('없는 로케이션은 404 다', async () => {
      await detail(999999999).expect(404);
    });

    it('토큰이 없으면 401 이다', async () => {
      await request(app.getHttpServer()).get(`/api/mdm/locations/${locationId}`).expect(401);
    });
  });
});
