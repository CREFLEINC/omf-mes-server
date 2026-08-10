import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-ICH';
const READER = 'E2E-ICH-R';

describe('품목 부속 3종 — 전체 치환 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let readerToken: string;
  let itemId: bigint;
  let otherItemId: bigint;
  let eaUomId: bigint;
  let boxUomId: bigint;
  let partnerId: bigint;
  let businessUnitId: bigint;
  let otherBusinessUnitId: bigint;

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

    const organization = await createOrganization(prisma, PREFIX);
    businessUnitId = organization.businessUnitId;
    otherBusinessUnitId = (
      await prisma.business_unit.create({
        data: {
          legal_entity_id: organization.legalEntityId,
          business_unit_code: `${PREFIX}-BU2`,
          business_unit_name: 'e2e 사업부2',
        },
      })
    ).business_unit_id;

    const uom = async (code: string) =>
      (
        await prisma.uom.upsert({
          where: { uom_code: `${PREFIX}-${code}` },
          update: {},
          create: { uom_code: `${PREFIX}-${code}`, uom_name: `e2e ${code}` },
        })
      ).uom_id;
    eaUomId = await uom('EA');
    boxUomId = await uom('BOX');

    partnerId = (
      await prisma.partner.create({
        data: { partner_code: `${PREFIX}-P1`, partner_name: 'e2e 거래처' },
      })
    ).partner_id;

    const item = async (suffix: string) =>
      (
        await prisma.item.create({
          data: {
            item_code: `${PREFIX}-${suffix}`,
            item_name: `e2e 품목 ${suffix}`,
            item_type_code: 'RAW',
            base_uom_id: eaUomId,
            lot_control_type_code: 'NONE',
          },
        })
      ).item_id;
    itemId = await item('01');
    otherItemId = await item('02');
  });

  afterEach(async () => {
    await prisma.idempotency_record.deleteMany({});
    await prisma.item_uom_conversion.deleteMany({ where: { item_id: { in: [itemId, otherItemId] } } });
    await prisma.item_external_code.deleteMany({ where: { item_id: { in: [itemId, otherItemId] } } });
    await prisma.item_bu_item_map.deleteMany({
      where: { from_item_id: { in: [itemId, otherItemId] } },
    });
  });

  afterAll(async () => {
    await prisma.item_uom_conversion.deleteMany({ where: { item_id: { in: [itemId, otherItemId] } } });
    await prisma.item_external_code.deleteMany({ where: { item_id: { in: [itemId, otherItemId] } } });
    await prisma.item_bu_item_map.deleteMany({
      where: { from_item_id: { in: [itemId, otherItemId] } },
    });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
    await prisma.uom.deleteMany({ where: { uom_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: { startsWith: `${PREFIX}-BU2` } },
    });
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await deleteUserWithPermissions(app, READER);
    await app.close();
  });

  function get(path: string, id: bigint | number = itemId) {
    return request(app.getHttpServer())
      .get(`/api/mdm/items/${id}/${path}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function put(
    path: string,
    body: Record<string, unknown>,
    options: { id?: bigint | number; bearer?: string } = {},
  ) {
    return request(app.getHttpServer())
      .put(`/api/mdm/items/${options.id ?? itemId}/${path}`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }

  const conversion = (overrides: Record<string, unknown> = {}) => ({
    fromUomId: Number(boxUomId),
    toUomId: Number(eaUomId),
    conversionRate: 12,
    effectiveFrom: '2026-01-01',
    ...overrides,
  });

  const externalCode = (overrides: Record<string, unknown> = {}) => ({
    externalSystemCode: 'ERP',
    externalItemCode: 'XYZ-99',
    ...overrides,
  });

  const buMap = (overrides: Record<string, unknown> = {}) => ({
    fromBusinessUnitId: Number(businessUnitId),
    toBusinessUnitId: Number(otherBusinessUnitId),
    toItemId: Number(otherItemId),
    effectiveFrom: '2026-01-01',
    ...overrides,
  });

  describe('전체 치환의 뜻', () => {
    it('안 보낸 행은 지워진다 — 개별 삭제 API 가 없다', async () => {
      await put('uom-conversions', {
        conversions: [
          conversion(),
          conversion({ effectiveFrom: '2026-06-01' }),
          conversion({ effectiveFrom: '2026-09-01' }),
        ],
      }).expect(200);

      const { body } = await put('uom-conversions', {
        conversions: [conversion(), conversion({ effectiveFrom: '2026-09-01' })],
      }).expect(200);

      expect(body.items.map((row: { effectiveFrom: string }) => row.effectiveFrom)).toEqual([
        '2026-01-01',
        '2026-09-01',
      ]);
    });

    it('빈 배열을 보내면 전부 지워진다', async () => {
      await put('uom-conversions', { conversions: [conversion()] }).expect(200);

      const { body } = await put('uom-conversions', { conversions: [] }).expect(200);

      expect(body.items).toEqual([]);
    });

    it('다른 품목의 부속은 건드리지 않는다', async () => {
      await put('uom-conversions', { conversions: [conversion()] }, { id: otherItemId }).expect(200);

      await put('uom-conversions', { conversions: [] }).expect(200);

      const { body } = await get('uom-conversions', otherItemId).expect(200);
      expect(body.items).toHaveLength(1);
    });

    it('검증에 걸리면 기존 행이 그대로 남는다 — 지우고 넣기가 한 트랜잭션이다', async () => {
      await put('uom-conversions', { conversions: [conversion()] }).expect(200);

      await put('uom-conversions', {
        conversions: [conversion({ effectiveFrom: '2026-06-01' }), conversion({ toUomId: Number(boxUomId) })],
      }).expect(400);

      const { body } = await get('uom-conversions').expect(200);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].effectiveFrom).toBe('2026-01-01');
    });
  });

  describe('단위 환산', () => {
    it('만든 값이 그대로 내려온다 — 비율이 JSON 숫자다', async () => {
      const { body } = await put('uom-conversions', {
        conversions: [conversion({ conversionRate: 12.5, effectiveTo: '2026-12-31' })],
      }).expect(200);

      expect(body.items[0]).toMatchObject({
        itemId: Number(itemId),
        fromUomId: Number(boxUomId),
        toUomId: Number(eaUomId),
        conversionRate: 12.5,
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-12-31',
      });
    });

    it('출발과 도착 단위가 같으면 400 이다 — ck_item_uom_distinct', async () => {
      const { body } = await put('uom-conversions', {
        conversions: [conversion({ toUomId: Number(boxUomId) })],
      }).expect(400);

      expect(body.errors[0]).toMatchObject({ field: '[0].toUomId', code: 'RANGE' });
    });

    it('보낸 목록 안에 중복이 있으면 400 이고 몇 번째인지 알려준다', async () => {
      const { body } = await put('uom-conversions', {
        conversions: [conversion(), conversion({ conversionRate: 24 })],
      }).expect(400);

      expect(body.errors[0]).toMatchObject({ field: '[1].fromUomId', code: 'RANGE' });
      expect(body.errors[0].message).toContain('0');
    });

    it('종료일이 시작일보다 앞서면 400 이다 — ck_item_uom_dates', async () => {
      const { body } = await put('uom-conversions', {
        conversions: [conversion({ effectiveTo: '2025-12-31' })],
      }).expect(400);

      expect(body.errors[0]).toMatchObject({ field: '[0].effectiveTo', code: 'RANGE' });
    });

    it('비율이 0 이하면 400 이다', async () => {
      await put('uom-conversions', { conversions: [conversion({ conversionRate: 0 })] }).expect(400);
    });

    it('없는 단위면 400 이다', async () => {
      const { body } = await put('uom-conversions', {
        conversions: [conversion({ fromUomId: 999999999 })],
      }).expect(400);

      expect(body.errors.some((error: { field: string }) => error.field === 'fromUomId')).toBe(true);
    });

    it('날짜에 시각을 붙이면 400 이다 — @db.Date 다', async () => {
      await put('uom-conversions', {
        conversions: [conversion({ effectiveFrom: '2026-01-01T00:00:00Z' })],
      }).expect(400);
    });
  });

  describe('외부 코드', () => {
    it('거래처 없이 만들면 partnerId 가 null 이다', async () => {
      const { body } = await put('external-codes', {
        externalCodes: [externalCode()],
      }).expect(200);

      expect(body.items[0]).toMatchObject({ partnerId: null, externalItemCode: 'XYZ-99' });
    });

    it('거래처를 비운 것끼리 중복이면 400 이다 — (전체) 한 자리로 접힌다', async () => {
      // uq_item_external_code 는 COALESCE(partner_id, 0) 으로 유일 판정한다(A-7).
      const { body } = await put('external-codes', {
        externalCodes: [externalCode(), externalCode()],
      }).expect(400);

      expect(body.errors[0]).toMatchObject({ field: '[1].externalItemCode', code: 'RANGE' });
    });

    it('안 보낸 것과 null 로 보낸 것이 같은 자리다 — COALESCE(partner_id, 0)', async () => {
      // 접지 않으면 서버 검사를 빠져나가 DB 유일 제약에서 터진다. 그때도 400 이
      // 나오지만(필터가 봉투를 맞춘다) 트랜잭션 한복판이라 어느 행인지 못 알려준다.
      await put('external-codes', { externalCodes: [externalCode()] }).expect(200);

      const { body } = await put('external-codes', {
        externalCodes: [externalCode(), externalCode({ partnerId: null })],
      }).expect(400);

      expect(body.errors[0]).toMatchObject({ field: '[1].externalItemCode', code: 'RANGE' });

      // 검증에서 걸렸으므로 기존 행이 살아 있어야 한다.
      const kept = await get('external-codes').expect(200);
      expect(kept.body.items).toHaveLength(1);
    });

    it('거래처가 다르면 같은 코드를 둘 수 있다', async () => {
      const { body } = await put('external-codes', {
        externalCodes: [externalCode(), externalCode({ partnerId: Number(partnerId) })],
      }).expect(200);

      expect(body.items).toHaveLength(2);
    });

    it('없는 거래처면 400 이다', async () => {
      await put('external-codes', {
        externalCodes: [externalCode({ partnerId: 999999999 })],
      }).expect(400);
    });
  });

  describe('사업부 매핑', () => {
    it('경로의 품목이 fromItemId 로 고정된다', async () => {
      const { body } = await put('bu-item-maps', { maps: [buMap()] }).expect(200);

      expect(body.items[0].fromItemId).toBe(Number(itemId));
    });

    it('출발과 도착 사업부가 같으면 400 이다 — ck_item_bu_map_distinct', async () => {
      const { body } = await put('bu-item-maps', {
        maps: [buMap({ toBusinessUnitId: Number(businessUnitId) })],
      }).expect(400);

      expect(body.errors[0]).toMatchObject({ field: '[0].toBusinessUnitId', code: 'RANGE' });
    });

    it('보낸 목록 안에 중복이 있으면 400 이다', async () => {
      const { body } = await put('bu-item-maps', { maps: [buMap(), buMap()] }).expect(400);

      expect(body.errors[0]).toMatchObject({ field: '[1].toBusinessUnitId', code: 'RANGE' });
    });

    it('없는 사업부·품목이면 400 이다', async () => {
      await put('bu-item-maps', { maps: [buMap({ toItemId: 999999999 })] }).expect(400);
      await put('bu-item-maps', { maps: [buMap({ toBusinessUnitId: 999999999 })] }).expect(400);
    });

    it('반대 방향 매핑은 이 품목 목록에 안 나온다', async () => {
      await prisma.item_bu_item_map.create({
        data: {
          from_business_unit_id: otherBusinessUnitId,
          from_item_id: otherItemId,
          to_business_unit_id: businessUnitId,
          to_item_id: itemId,
          effective_from: new Date('2026-01-01T00:00:00.000Z'),
        },
      });

      const { body } = await get('bu-item-maps').expect(200);

      expect(body.items).toEqual([]);
    });
  });

  describe('그 외', () => {
    it.each([['uom-conversions'], ['external-codes'], ['bu-item-maps']])(
      '%s — 없는 품목은 404 다',
      async (path) => {
        await get(path, 999999999).expect(404);
      },
    );

    it.each([
      ['uom-conversions', { conversions: [] }],
      ['external-codes', { externalCodes: [] }],
      ['bu-item-maps', { maps: [] }],
    ])('%s — MASTER_READ 만 있으면 403 이다', async (path, body) => {
      await put(path, body, { bearer: readerToken }).expect(403);
    });

    it('상한을 넘기면 400 이다 — 한 요청으로 테이블을 잠글 수 없다', async () => {
      // 행이 서로 달라야 한다. 같은 키가 섞이면 중복 검사에 먼저 걸려 상한을 없애도
      // 400 이 나온다 — 실제로 그랬다.
      const day = (index: number) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
      const conversions = Array.from({ length: 501 }, (_, index) => ({
        ...conversion(),
        effectiveFrom: day(index),
      }));
      expect(new Set(conversions.map((row) => row.effectiveFrom)).size).toBe(501);

      await put('uom-conversions', { conversions }).expect(400);
    });

    it('멱등키가 없으면 400 이다', async () => {
      await request(app.getHttpServer())
        .put(`/api/mdm/items/${itemId}/uom-conversions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ conversions: [] })
        .expect(400);
    });
  });
});
