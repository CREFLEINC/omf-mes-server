import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';

const PREFIX = 'E2E-ITM';
const READER = 'E2E-ITM-R';

describe('품목 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let readerToken: string;
  let uomId: bigint;
  let plainItemId: bigint;
  let routedItemId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, [
      'MASTER_READ',
      'MASTER_PRODUCTION_WRITE',
    ]));
    ({ token: readerToken } = await createUserWithPermissions(app, READER, ['MASTER_READ']));

    uomId = (
      await prisma.uom.upsert({
        where: { uom_code: `${PREFIX}-EA` },
        update: {},
        create: { uom_code: `${PREFIX}-EA`, uom_name: 'e2e 개' },
      })
    ).uom_id;

    const item = async (suffix: string, overrides: Record<string, unknown> = {}) =>
      (
        await prisma.item.create({
          data: {
            item_code: `${PREFIX}-${suffix}`,
            item_name: `e2e 품목 ${suffix}`,
            item_type_code: 'RAW',
            base_uom_id: uomId,
            lot_control_type_code: 'NONE',
            ...overrides,
          },
        })
      ).item_id;

    plainItemId = await item('01');
    routedItemId = await item('02', { item_type_code: 'FG' });
    await item('03', { is_active: false });

    await prisma.routing.create({
      data: {
        item_id: routedItemId,
        routing_code: `${PREFIX}-RT`,
        routing_version: 1,
        status_code: 'DRAFT',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.uom.deleteMany({ where: { uom_code: { startsWith: PREFIX } } });
    await deleteUserWithPermissions(app, PREFIX);
    await deleteUserWithPermissions(app, READER);
    await app.close();
  });

  function get(path: string) {
    return request(app.getHttpServer())
      .get(`/api/mdm/items${path}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function put(
    id: bigint | number,
    body: Record<string, unknown>,
    options: { etag?: string; bearer?: string } = {},
  ) {
    const req = request(app.getHttpServer())
      .put(`/api/mdm/items/${id}`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', randomUUID());

    if (options.etag !== undefined) req.set('If-Match', options.etag);

    return req.send(body);
  }

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      lotControlTypeCode: 'LOT',
      serialControlTypeCode: 'NONE',
      inspectionRequired: true,
      fifoPolicyCode: 'FEFO',
      negativeStockAllowed: false,
      isActive: true,
      ...overrides,
    };
  }

  async function etagOf(id: bigint): Promise<string> {
    const { headers } = await get(`/${id}`).expect(200);

    return headers.etag;
  }

  describe('목록', () => {
    it('계약 봉투로 내려온다', async () => {
      const { body } = await get(`?q=${PREFIX}`).expect(200);

      expect(body.items).toHaveLength(2);
      expect(body.page).toEqual({ page: 1, size: 50, total: 2 });
    });

    it('품목구분으로 거른다', async () => {
      const { body } = await get(`?q=${PREFIX}&itemTypeCode=FG`).expect(200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].itemCode).toBe(`${PREFIX}-02`);
    });

    it('기본은 사용 중인 것만 — includeInactive 로 켠다', async () => {
      const { body } = await get(`?q=${PREFIX}&includeInactive=true`).expect(200);

      expect(body.items).toHaveLength(3);
    });

    it('hasRouting=false 면 Routing 이 없는 품목만 나온다', async () => {
      const { body } = await get(`?q=${PREFIX}&hasRouting=false`).expect(200);

      expect(body.items.map((row: { itemCode: string }) => row.itemCode)).toEqual([
        `${PREFIX}-01`,
      ]);
    });

    it('hasRouting=true 면 Routing 이 있는 품목만 나온다', async () => {
      const { body } = await get(`?q=${PREFIX}&hasRouting=true`).expect(200);

      expect(body.items.map((row: { itemCode: string }) => row.itemCode)).toEqual([
        `${PREFIX}-02`,
      ]);
    });

    it('hasRouting 을 안 보내면 안 거른다 — false 로 접히면 안 된다', async () => {
      const { body } = await get(`?q=${PREFIX}`).expect(200);

      expect(body.items).toHaveLength(2);
    });
  });

  describe('상세', () => {
    it('{item, editability} 로 감싸 내린다', async () => {
      const { body } = await get(`/${plainItemId}`).expect(200);

      expect(Object.keys(body).sort()).toEqual(['editability', 'item']);
      expect(body.item.itemCode).toBe(`${PREFIX}-01`);
    });

    it('원본 4열도 함께 내린다 — 화면이 위 구획에 읽기 전용으로 그린다', async () => {
      const { body } = await get(`/${plainItemId}`).expect(200);

      expect(body.item).toMatchObject({
        itemCode: `${PREFIX}-01`,
        itemName: 'e2e 품목 01',
        itemTypeCode: 'RAW',
        baseUomId: Number(uomId),
      });
    });

    it('언제나 RECEIVED_FROM_ERP 다 — 참조를 세지 않는다', async () => {
      const { body } = await get(`/${plainItemId}`).expect(200);

      expect(body.editability).toEqual({
        codeEditable: false,
        reason: 'RECEIVED_FROM_ERP',
        referenceCount: null,
      });
    });

    it('ETag 헤더에 version_no 를 싣는다 — 본문에는 없다', async () => {
      const response = await get(`/${plainItemId}`).expect(200);
      const row = await prisma.item.findUniqueOrThrow({ where: { item_id: plainItemId } });

      expect(response.headers.etag).toBe(String(row.version_no));
      expect(JSON.stringify(response.body)).not.toContain('version');
    });

    it('없는 품목은 404 다', async () => {
      await get('/999999999').expect(404);
    });
  });

  describe('수정 — MES 확장 속성만', () => {
    it('맞는 If-Match 면 200 이고 ETag 가 오른다', async () => {
      const etag = await etagOf(plainItemId);

      const response = await put(plainItemId, payload(), { etag }).expect(200);

      expect(response.body).toMatchObject({ lotControlTypeCode: 'LOT', fifoPolicyCode: 'FEFO' });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it.each([['itemCode'], ['itemName'], ['itemTypeCode'], ['baseUomId']])(
      '원본 %s 을 보내면 400 이다 — ERP 수신본이라 아예 받지 않는다',
      async (field) => {
        const etag = await etagOf(plainItemId);

        await put(plainItemId, payload({ [field]: 'X' }), { etag }).expect(400);
      },
    );

    it('shelfLifeDays 를 null 로 보내면 유효기한 관리가 꺼진다', async () => {
      await prisma.item.update({
        where: { item_id: plainItemId },
        data: { shelf_life_days: 30 },
      });
      const etag = await etagOf(plainItemId);

      const { body } = await put(plainItemId, payload(), { etag }).expect(200);

      expect(body.shelfLifeDays).toBeNull();
    });

    it('isActive 를 여기서 바꾼다 — 품목에는 :deactivate 가 없다', async () => {
      const etag = await etagOf(plainItemId);

      const { body } = await put(plainItemId, payload({ isActive: false }), { etag }).expect(200);

      expect(body.isActive).toBe(false);
      await prisma.item.update({ where: { item_id: plainItemId }, data: { is_active: true } });
    });

    it.each([
      ['lotControlTypeCode', 'NOPE'],
      ['fifoPolicyCode', 'NOPE'],
      ['storageConditionCode', 'NOPE'],
    ])('%s 가 코드그룹에 없으면 400 이다', async (field, value) => {
      const etag = await etagOf(plainItemId);

      const { body } = await put(plainItemId, payload({ [field]: value }), { etag }).expect(400);
      expect(body.errors[0]).toMatchObject({ field, code: 'RANGE' });
    });

    it('틀린 If-Match 면 409 다 — ConflictResponse', async () => {
      const etag = await etagOf(plainItemId);

      const { body } = await put(plainItemId, payload(), {
        etag: String(Number(etag) + 5),
      }).expect(409);

      expect(body).toMatchObject({ conflictCause: 'user' });
      expect(body.errors).toBeUndefined();
    });

    it('If-Match 가 없으면 400 이다', async () => {
      const { body } = await put(plainItemId, payload()).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'If-Match', code: 'REQUIRED' });
    });

    it('없는 품목은 404 다', async () => {
      await put(999999999, payload(), { etag: '1' }).expect(404);
    });

    it('MASTER_READ 만 있으면 403 이다', async () => {
      const etag = await etagOf(plainItemId);

      await put(plainItemId, payload(), { etag, bearer: readerToken }).expect(403);
    });
  });

  it('토큰이 없으면 401 이다', async () => {
    await request(app.getHttpServer()).get('/api/mdm/items').expect(401);
  });
});
