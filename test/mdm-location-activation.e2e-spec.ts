import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import {
  createBalance,
  createInventoryRefs,
  deleteWarehouseContents,
  deleteInventoryRefs,
  InventoryRefs,
} from './support/inventory.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-LCA';
const WRITER = 'E2E-LCA-W';

describe('로케이션 중지·되살리기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let writerToken: string;
  let legalEntityId: bigint;
  let businessUnitId: bigint;
  let plantId: bigint;
  let warehouseId: bigint;
  let refs: InventoryRefs;
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
    ({ legalEntityId, businessUnitId, plantId } = await createOrganization(prisma, PREFIX));
    refs = await createInventoryRefs(prisma, PREFIX);

    warehouseId = (
      await prisma.warehouse.create({
        data: {
          plant_id: plantId,
          business_unit_id: businessUnitId,
          warehouse_code: `${PREFIX}-WH`,
          warehouse_name: 'e2e 창고',
          warehouse_type_code: 'MATERIAL',
          management_level_code: 'WAREHOUSE',
        },
      })
    ).warehouse_id;
  });

  afterEach(async () => {
    await prisma.idempotency_record.deleteMany({});
    await prisma.inventory_balance.deleteMany({ where: { warehouse_id: warehouseId } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: `${PREFIX}-L` } } });
    await prisma.warehouse.update({
      where: { warehouse_id: warehouseId },
      data: { is_active: true },
    });
  });

  afterAll(async () => {
    await deleteWarehouseContents(prisma, PREFIX);
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await deleteInventoryRefs(prisma, PREFIX);
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await deleteUserWithPermissions(app, WRITER);
    await app.close();
  });

  /** 자리를 만들고 상세 조회로 ETag 를 받는다 — 화면이 버튼을 누르기 전에 하는 일이다. */
  async function given(
    options: { isActive?: boolean; parentLocationId?: bigint } = {},
  ): Promise<{ id: bigint; etag: string }> {
    counter += 1;
    const row = await prisma.location.create({
      data: {
        warehouse_id: warehouseId,
        parent_location_id: options.parentLocationId ?? null,
        location_code: `${PREFIX}-L${counter}`,
        location_name: 'e2e 자리',
        location_type_code: 'RACK',
        is_active: options.isActive ?? true,
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${row.location_id}`)
      .set('Authorization', `Bearer ${token}`);

    return { id: row.location_id, etag: detail.headers.etag };
  }

  function act(
    action: 'deactivate' | 'activate',
    id: bigint | number,
    options: { etag?: string; key?: string; bearer?: string } = {},
  ) {
    const req = request(app.getHttpServer())
      .post(`/api/mdm/locations/${id}:${action}`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', options.key ?? randomUUID());

    if (options.etag !== undefined) req.set('If-Match', options.etag);

    return req.send();
  }

  async function stockIn(locationId: bigint, onHandQty: number): Promise<void> {
    await createBalance(prisma, {
      refs,
      legalEntityId,
      businessUnitId,
      plantId,
      warehouseId,
      locationId,
      onHandQty,
    });
  }

  describe('중지 — 안쪽을 본다', () => {
    it('맞는 If-Match 면 200 이고 isActive 가 거짓이다', async () => {
      const { id, etag } = await given();

      const response = await act('deactivate', id, { etag }).expect(200);

      expect(response.body).toMatchObject({ locationId: Number(id), isActive: false });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it('재고 잔량이 남아 있으면 400 STATE_LOCKED 다', async () => {
      const { id, etag } = await given();
      await stockIn(id, 5);

      const { body } = await act('deactivate', id, { etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('잔량이 0 인 재고 행만 있으면 중지된다 — 행이 아니라 수량을 본다', async () => {
      const { id, etag } = await given();
      await stockIn(id, 0);

      await act('deactivate', id, { etag }).expect(200);
    });

    it('사용 중인 하위 자리가 있으면 400 이다 — 아래에서부터 꺼야 한다', async () => {
      const parent = await given();
      await given({ parentLocationId: parent.id });

      const { body } = await act('deactivate', parent.id, { etag: parent.etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('하위 자리가 이미 중지되어 있으면 중지된다', async () => {
      const parent = await given();
      await given({ parentLocationId: parent.id, isActive: false });

      await act('deactivate', parent.id, { etag: parent.etag }).expect(200);
    });

    it('이미 중지된 자리는 400 이다', async () => {
      const { id, etag } = await given({ isActive: false });

      const { body } = await act('deactivate', id, { etag }).expect(400);
      expect(body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('틀린 If-Match 면 409 다 — ConflictResponse', async () => {
      const { id, etag } = await given();

      const { body } = await act('deactivate', id, { etag: String(Number(etag) + 5) }).expect(409);

      expect(body).toMatchObject({ conflictCause: 'user' });
      expect(body.errors).toBeUndefined();
    });
  });

  describe('되살리기 — 위쪽을 본다', () => {
    it('맞는 If-Match 면 200 이고 isActive 가 참이다', async () => {
      const { id, etag } = await given({ isActive: false });

      const response = await act('activate', id, { etag }).expect(200);

      expect(response.body).toMatchObject({ locationId: Number(id), isActive: true });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it('창고가 중지되어 있으면 400 이다', async () => {
      const { id, etag } = await given({ isActive: false });
      await prisma.warehouse.update({
        where: { warehouse_id: warehouseId },
        data: { is_active: false },
      });

      const { body } = await act('activate', id, { etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('상위 자리가 중지되어 있으면 400 이다 — 위에서부터 켜야 한다', async () => {
      const parent = await given({ isActive: false });
      const child = await given({ parentLocationId: parent.id, isActive: false });

      const { body } = await act('activate', child.id, { etag: child.etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('상위 자리가 살아 있으면 켜진다', async () => {
      const parent = await given();
      const child = await given({ parentLocationId: parent.id, isActive: false });

      await act('activate', child.id, { etag: child.etag }).expect(200);
    });

    it('하위 자리는 함께 켜지지 않는다 — 끌 때 하나씩 껐다', async () => {
      const parent = await given({ isActive: false });
      const child = await given({ parentLocationId: parent.id, isActive: false });

      await act('activate', parent.id, { etag: parent.etag }).expect(200);

      const row = await prisma.location.findUniqueOrThrow({ where: { location_id: child.id } });
      expect(row.is_active).toBe(false);
    });

    it('이미 사용 중인 자리는 400 이다', async () => {
      const { id, etag } = await given();

      const { body } = await act('activate', id, { etag }).expect(400);
      expect(body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });
  });

  describe('그 외', () => {
    it.each([['deactivate'], ['activate']])('%s — 없는 자리는 404 다', async (action) => {
      await act(action as 'deactivate' | 'activate', 999999999, { etag: '1' }).expect(404);
    });

    it.each([['deactivate'], ['activate']])('%s — If-Match 가 없으면 400 이다', async (action) => {
      const { id } = await given({ isActive: action === 'activate' ? false : true });

      const { body } = await act(action as 'deactivate' | 'activate', id).expect(400);
      expect(body.errors[0]).toMatchObject({ field: 'If-Match', code: 'REQUIRED' });
    });

    it.each([['deactivate'], ['activate']])(
      '%s — MASTER_LOGISTICS_WRITE 만 있으면 403 이다',
      async (action) => {
        const { id, etag } = await given({ isActive: action === 'activate' ? false : true });

        await act(action as 'deactivate' | 'activate', id, {
          etag,
          bearer: writerToken,
        }).expect(403);
      },
    );

    it('같은 키로 재전송하면 저장된 200 을 받는다', async () => {
      const { id, etag } = await given();
      const key = randomUUID();

      const first = await act('deactivate', id, { etag, key }).expect(200);
      const second = await act('deactivate', id, { etag, key }).expect(200);

      expect(second.body).toEqual(first.body);
      expect(second.headers.etag).toBe(first.headers.etag);
    });

    it('감사 컬럼에 주체를 기록한다', async () => {
      const { id, etag } = await given();
      await act('deactivate', id, { etag }).expect(200);

      const row = await prisma.location.findUniqueOrThrow({ where: { location_id: id } });
      expect(row.updated_by).not.toBeNull();
    });
  });
});
