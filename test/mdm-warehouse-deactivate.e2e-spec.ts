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
  createLocation,
  deleteInventoryRefs,
  deleteWarehouseContents,
  InventoryRefs,
} from './support/inventory.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-WHD';
const WRITER = 'E2E-WHD-W';

describe('POST /api/mdm/warehouses/{warehouseId}:deactivate (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let writerToken: string;
  let legalEntityId: bigint;
  let businessUnitId: bigint;
  let plantId: bigint;
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
    // 중지는 등록·수정과 다른 권한이다 — 쓰기만 가진 사용자로 그것을 확인한다.
    ({ token: writerToken } = await createUserWithPermissions(app, WRITER, [
      'MASTER_READ',
      'MASTER_LOGISTICS_WRITE',
    ]));
    ({ legalEntityId, businessUnitId, plantId } = await createOrganization(prisma, PREFIX));
    refs = await createInventoryRefs(prisma, PREFIX);
  });

  afterEach(async () => {
    await prisma.idempotency_record.deleteMany({});
    await deleteWarehouseContents(prisma, PREFIX);
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
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

  /** 창고를 만들고 상세 조회로 ETag 를 받는다 — 화면이 중지를 누르기 전에 하는 일 그대로다. */
  async function given(isActive = true): Promise<{ id: bigint; etag: string }> {
    counter += 1;
    const row = await prisma.warehouse.create({
      data: {
        plant_id: plantId,
        business_unit_id: businessUnitId,
        warehouse_code: `${PREFIX}-${counter}`,
        warehouse_name: '중지 대상',
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

  function deactivate(
    id: bigint | number,
    options: { etag?: string; key?: string; bearer?: string } = {},
  ) {
    const req = request(app.getHttpServer())
      .post(`/api/mdm/warehouses/${id}:deactivate`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', options.key ?? randomUUID());

    if (options.etag !== undefined) req.set('If-Match', options.etag);

    return req.send();
  }

  async function stockIn(warehouseId: bigint, onHandQty: number): Promise<void> {
    // 재고를 넣으려면 로케이션이 있어야 한다. 중지된 것으로 만들어야 로케이션 규칙이
    // 함께 걸리지 않는다 — 이 테스트가 보려는 것은 잔량 하나다.
    const locationId = await createLocation(prisma, warehouseId, `${PREFIX}-L${counter}`, false);

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

  describe('낙관적 잠금', () => {
    it('맞는 If-Match 면 200 이고 isActive 가 거짓이다', async () => {
      const { id, etag } = await given();

      const response = await deactivate(id, { etag }).expect(200);

      expect(response.body).toMatchObject({ warehouseId: Number(id), isActive: false });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it('틀린 If-Match 면 409 이고 봉투가 다르다 — ConflictResponse', async () => {
      const { id, etag } = await given();

      const stale = String(Number(etag) + 5);
      const { body } = await deactivate(id, { etag: stale }).expect(409);

      expect(body).toMatchObject({ conflictCause: 'user' });
      expect(body.errors).toBeUndefined();
    });

    it('충돌하면 창고가 그대로 사용 중이다', async () => {
      const { id, etag } = await given();

      await deactivate(id, { etag: String(Number(etag) + 5) }).expect(409);

      const row = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id } });
      expect(row.is_active).toBe(true);
    });

    it('If-Match 가 없으면 400 이다', async () => {
      const { id } = await given();

      const { body } = await deactivate(id).expect(400);
      expect(body.errors[0]).toMatchObject({ field: 'If-Match', code: 'REQUIRED' });
    });
  });

  describe('중지를 막는 것', () => {
    it('재고 잔량이 남아 있으면 400 STATE_LOCKED 다', async () => {
      const { id, etag } = await given();
      await stockIn(id, 5);

      const { body } = await deactivate(id, { etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
      const row = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id } });
      expect(row.is_active).toBe(true);
    });

    it('사용 중인 로케이션이 있으면 400 STATE_LOCKED 다', async () => {
      const { id, etag } = await given();
      await createLocation(prisma, id, `${PREFIX}-L${counter}`, true);

      const { body } = await deactivate(id, { etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });
  });

  describe('막지 않는 것', () => {
    it('잔량이 0 인 재고 행만 있으면 중지된다 — 행이 아니라 수량을 본다', async () => {
      const { id, etag } = await given();
      await stockIn(id, 0);

      await deactivate(id, { etag }).expect(200);
    });

    it('중지된 로케이션만 있으면 중지된다', async () => {
      const { id, etag } = await given();
      await createLocation(prisma, id, `${PREFIX}-L${counter}`, false);

      await deactivate(id, { etag }).expect(200);
    });

    it('참조 건수가 0 이 아니어도 중지된다 — 중지는 참조 건수를 보지 않는다', async () => {
      const { id, etag } = await given();
      // 참조를 만드는 데 로케이션을 쓴다. 창고를 가리키는 15개 중 전표 8종은 픽스처가
      // 없어(그 모듈이 아직 없다) 여기서 만들지 못한다 — 「과거 전표는 막지 않는다」는
      // 이 테스트가 아니라 checkDeactivable 이 그 목록을 아예 조회하지 않는다는 사실로 선다.
      await createLocation(prisma, id, `${PREFIX}-L${counter}`, false);

      const referenceCount = await request(app.getHttpServer())
        .get(`/api/mdm/warehouses/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .then((res) => res.body.editability.referenceCount);

      expect(referenceCount).toBeGreaterThan(0);
      await deactivate(id, { etag }).expect(200);
    });
  });

  describe('그 외', () => {
    it('이미 중지된 창고는 400 이다', async () => {
      const { id, etag } = await given(false);

      const { body } = await deactivate(id, { etag }).expect(400);
      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('없는 창고는 404 다', async () => {
      await deactivate(999999999, { etag: '1' }).expect(404);
    });

    it('MASTER_LOGISTICS_WRITE 만 있으면 403 이다 — 중지는 별도 권한', async () => {
      const { id, etag } = await given();

      await deactivate(id, { etag, bearer: writerToken }).expect(403);
    });

    it('같은 키로 재전송하면 저장된 200 을 받는다', async () => {
      const { id, etag } = await given();
      const key = randomUUID();

      const first = await deactivate(id, { etag, key }).expect(200);
      const second = await deactivate(id, { etag, key }).expect(200);

      expect(second.body).toEqual(first.body);
      expect(second.headers.etag).toBe(first.headers.etag);
    });

    it('감사 컬럼에 중지 주체를 기록한다', async () => {
      const { id, etag } = await given();
      await deactivate(id, { etag }).expect(200);

      const row = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id } });
      expect(row.updated_by).not.toBeNull();
    });
  });
});
