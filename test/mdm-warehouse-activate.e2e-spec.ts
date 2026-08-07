import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { createLocation, deleteWarehouseContents } from './support/inventory.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-WHA';
const WRITER = 'E2E-WHA-W';

describe('POST /api/mdm/warehouses/{warehouseId}:activate (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let writerToken: string;
  let businessUnitId: bigint;
  let plantId: bigint;
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, [
      'MASTER_READ',
      'MASTER_LOGISTICS_DEACTIVATE',
    ]));
    ({ token: writerToken } = await createUserWithPermissions(app, WRITER, [
      'MASTER_READ',
      'MASTER_LOGISTICS_WRITE',
    ]));
    ({ businessUnitId, plantId } = await createOrganization(prisma, PREFIX));
  });

  afterEach(async () => {
    await prisma.idempotency_record.deleteMany({});
    await deleteWarehouseContents(prisma, PREFIX);
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    // 조직은 테스트마다 만들지 않으므로 끈 것을 되돌려야 다음 테스트가 영향을 안 받는다.
    await prisma.plant.update({ where: { plant_id: plantId }, data: { is_active: true } });
    await prisma.business_unit.update({
      where: { business_unit_id: businessUnitId },
      data: { is_active: true },
    });
  });

  afterAll(async () => {
    await deleteWarehouseContents(prisma, PREFIX);
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await deleteUserWithPermissions(app, WRITER);
    await app.close();
  });

  /**
   * 중지된 창고를 만들고 상세 조회로 ETag 를 받는다. 화면은 목록에서
   * `includeInactive=true` 로 찾아 상세를 여는데, 상세는 중지 여부와 무관하게 200 이다.
   */
  async function given(isActive = false): Promise<{ id: bigint; etag: string }> {
    counter += 1;
    const row = await prisma.warehouse.create({
      data: {
        plant_id: plantId,
        business_unit_id: businessUnitId,
        warehouse_code: `${PREFIX}-${counter}`,
        warehouse_name: '되살릴 창고',
        warehouse_type_code: 'MATERIAL',
        management_level_code: 'WAREHOUSE',
        is_active: isActive,
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses/${row.warehouse_id}`)
      .set('Authorization', `Bearer ${token}`);

    return { id: row.warehouse_id, etag: detail.headers.etag };
  }

  function activate(
    id: bigint | number,
    options: { etag?: string; key?: string; bearer?: string } = {},
  ) {
    const req = request(app.getHttpServer())
      .post(`/api/mdm/warehouses/${id}:activate`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', options.key ?? randomUUID());

    if (options.etag !== undefined) req.set('If-Match', options.etag);

    return req.send();
  }

  describe('낙관적 잠금', () => {
    it('맞는 If-Match 면 200 이고 isActive 가 참이다', async () => {
      const { id, etag } = await given();

      const response = await activate(id, { etag }).expect(200);

      expect(response.body).toMatchObject({ warehouseId: Number(id), isActive: true });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it('틀린 If-Match 면 409 이고 봉투가 다르다 — ConflictResponse', async () => {
      const { id, etag } = await given();

      const { body } = await activate(id, { etag: String(Number(etag) + 5) }).expect(409);

      expect(body).toMatchObject({ conflictCause: 'user' });
      expect(body.errors).toBeUndefined();
    });

    it('If-Match 가 없으면 400 이다', async () => {
      const { id } = await given();

      const { body } = await activate(id).expect(400);
      expect(body.errors[0]).toMatchObject({ field: 'If-Match', code: 'REQUIRED' });
    });
  });

  describe('되살리기를 막는 것', () => {
    it('공장이 중지되어 있으면 400 STATE_LOCKED 다', async () => {
      const { id, etag } = await given();
      await prisma.plant.update({ where: { plant_id: plantId }, data: { is_active: false } });

      const { body } = await activate(id, { etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
      const row = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id } });
      expect(row.is_active).toBe(false);
    });

    it('사업부가 중지되어 있으면 400 STATE_LOCKED 다', async () => {
      const { id, etag } = await given();
      await prisma.business_unit.update({
        where: { business_unit_id: businessUnitId },
        data: { is_active: false },
      });

      const { body } = await activate(id, { etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('이미 사용 중인 창고는 400 이다', async () => {
      const { id, etag } = await given(true);

      const { body } = await activate(id, { etag }).expect(400);
      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });
  });

  describe('건드리지 않는 것', () => {
    it('중지된 로케이션은 함께 켜지지 않는다', async () => {
      const { id, etag } = await given();
      const locationId = await createLocation(prisma, id, `${PREFIX}-L${counter}`, false);

      await activate(id, { etag }).expect(200);

      // 중지할 때 하나씩 껐으니 켤 때도 골라서 켜야 한다.
      const location = await prisma.location.findUniqueOrThrow({
        where: { location_id: locationId },
      });
      expect(location.is_active).toBe(false);
    });
  });

  describe('그 외', () => {
    it('중지된 창고의 코드는 중지 중에도 잠겨 있다 — 그래서 되살릴 때 중복을 보지 않는다', async () => {
      // activate 가 중복 검사를 생략하는 근거가 uq_warehouse 다. 부분 인덱스(WHERE is_active)
      // 였다면 중지된 사이에 같은 코드가 생기고, 되살리기가 제약 위반으로 떨어진다.
      const { id } = await given();
      const row = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id } });

      await expect(
        prisma.warehouse.create({
          data: {
            plant_id: plantId,
            business_unit_id: businessUnitId,
            warehouse_code: row.warehouse_code,
            warehouse_name: '같은 코드',
            warehouse_type_code: 'MATERIAL',
            management_level_code: 'WAREHOUSE',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('없는 창고는 404 다', async () => {
      await activate(999999999, { etag: '1' }).expect(404);
    });

    it('MASTER_LOGISTICS_WRITE 만 있으면 403 이다 — 되살리기는 중지와 같은 권한', async () => {
      const { id, etag } = await given();

      await activate(id, { etag, bearer: writerToken }).expect(403);
    });

    it('같은 키로 재전송하면 저장된 200 을 받는다', async () => {
      const { id, etag } = await given();
      const key = randomUUID();

      const first = await activate(id, { etag, key }).expect(200);
      const second = await activate(id, { etag, key }).expect(200);

      expect(second.body).toEqual(first.body);
      expect(second.headers.etag).toBe(first.headers.etag);
    });

    it('감사 컬럼에 되살린 주체를 기록한다', async () => {
      const { id, etag } = await given();
      await activate(id, { etag }).expect(200);

      const row = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id } });
      expect(row.updated_by).not.toBeNull();
    });
  });
});
