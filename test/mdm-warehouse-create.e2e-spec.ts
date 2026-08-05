import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-WHC';
const READER = 'E2E-WHC-R';

type ErrorItem = { scope: string; field?: string; code: string; uniqueScope?: string[] };

describe('POST /api/mdm/warehouses (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let readerToken: string;
  let plantId: bigint;
  let businessUnitId: bigint;
  let otherPlantId: bigint;
  let partnerId: bigint | null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, ['MASTER_LOGISTICS_WRITE']));
    ({ token: readerToken } = await createUserWithPermissions(app, READER, ['MASTER_READ']));
    ({ plantId, businessUnitId } = await createOrganization(prisma, PREFIX));

    // 「전역 유일이 아니다」를 증명하려면 같은 법인 아래 공장이 둘 있어야 한다.
    const legalEntity = await prisma.legal_entity.findUniqueOrThrow({
      where: { legal_entity_code: `${PREFIX}-LE` },
    });
    const other = await prisma.plant.upsert({
      where: {
        legal_entity_id_plant_code: {
          legal_entity_id: legalEntity.legal_entity_id,
          plant_code: `${PREFIX}-PLT2`,
        },
      },
      update: {},
      create: {
        legal_entity_id: legalEntity.legal_entity_id,
        business_unit_id: businessUnitId,
        plant_code: `${PREFIX}-PLT2`,
        plant_name: 'e2e 두번째 공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    otherPlantId = other.plant_id;

    partnerId = (await prisma.partner.findFirst())?.partner_id ?? null;
  });

  afterEach(async () => {
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await deleteUserWithPermissions(app, READER);
    await app.close();
  });

  /** 키를 매번 새로 만든다 — 고정하면 두 번째 요청부터 첫 응답이 재생된다. */
  function post(body: Record<string, unknown>, bearer = token, key = randomUUID()) {
    return request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Authorization', `Bearer ${bearer}`)
      .set('Idempotency-Key', key)
      .send(body);
  }

  function valid(overrides: Record<string, unknown> = {}) {
    return {
      plantId: Number(plantId),
      businessUnitId: Number(businessUnitId),
      warehouseCode: `${PREFIX}-01`,
      warehouseName: '등록 테스트 창고',
      warehouseTypeCode: 'MATERIAL',
      managementLevelCode: 'WAREHOUSE',
      ...overrides,
    };
  }

  describe('성공', () => {
    it('201 과 계약 모양의 Warehouse 를 준다', async () => {
      const { body } = await post(valid()).expect(201);

      expect(Object.keys(body).sort()).toEqual([
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
      expect(body).toMatchObject({ warehouseCode: `${PREFIX}-01`, isActive: true });
    });

    it('감사 컬럼에 인증 주체를 기록한다', async () => {
      const { body } = await post(valid()).expect(201);

      const row = await prisma.warehouse.findUniqueOrThrow({
        where: { warehouse_id: BigInt(body.warehouseId) },
      });
      expect(row.created_by).not.toBeNull();
      expect(row.created_by).toEqual(row.updated_by);
    });

    it('코드 앞뒤 공백을 다듬는다', async () => {
      const { body } = await post(valid({ warehouseCode: `  ${PREFIX}-02  ` })).expect(201);

      expect(body.warehouseCode).toBe(`${PREFIX}-02`);
    });

    it('다른 공장이면 같은 코드를 쓸 수 있다 — 전역 유일이 아니다', async () => {
      await post(valid()).expect(201);

      await post(valid({ plantId: Number(otherPlantId) })).expect(201);
    });
  });

  describe('DTO 검증', () => {
    it('필수 필드가 없으면 계약 봉투로 400 이다', async () => {
      const { body } = await post({ warehouseName: 'x' }).expect(400);

      expect(body.errors.every((e: ErrorItem) => e.scope === 'field')).toBe(true);
      expect(body.errors.map((e: ErrorItem) => e.field)).toEqual(
        expect.arrayContaining(['plantId', 'warehouseCode', 'warehouseTypeCode']),
      );
    });

    it('여러 필드가 동시에 틀리면 한 번에 다 알려준다', async () => {
      const { body } = await post({}).expect(400);

      expect(body.errors.length).toBeGreaterThan(3);
    });

    it('코드가 공백뿐이면 REQUIRED 다', async () => {
      const { body } = await post(valid({ warehouseCode: '   ' })).expect(400);

      expect(body.errors).toContainEqual(
        expect.objectContaining({ field: 'warehouseCode', code: 'REQUIRED' }),
      );
    });

    it('정의되지 않은 필드는 400 이다', async () => {
      await post(valid({ isActive: true })).expect(400);
    });
  });

  describe('도메인 규칙', () => {
    it('없는 공장이면 RANGE 다', async () => {
      const { body } = await post(valid({ plantId: 999999999 })).expect(400);

      expect(body.errors).toContainEqual(
        expect.objectContaining({ field: 'plantId', code: 'RANGE' }),
      );
    });

    it('공통코드에 없는 값이면 RANGE 다', async () => {
      const { body } = await post(valid({ warehouseTypeCode: 'NOT_A_CODE' })).expect(400);

      expect(body.errors).toContainEqual(
        expect.objectContaining({ field: 'warehouseTypeCode', code: 'RANGE' }),
      );
    });

    it('외부창고인데 거래처가 없으면 PAIR 다 — ck_external_warehouse_partner', async () => {
      const { body } = await post(valid({ isExternal: true })).expect(400);

      expect(body.errors).toContainEqual(
        expect.objectContaining({ field: 'partnerId', code: 'PAIR' }),
      );
    });

    it('외부창고가 아니면 거래처를 저장하지 않는다', async () => {
      if (partnerId === null) return;

      const { body } = await post(valid({ isExternal: false, partnerId: Number(partnerId) })).expect(
        201,
      );

      expect(body.partnerId).toBeNull();
    });
  });

  describe('유일성', () => {
    it('같은 공장에 같은 코드면 UNIQUE_VIOLATION 이고 범위를 담는다', async () => {
      await post(valid()).expect(201);

      const { body } = await post(valid()).expect(400);

      expect(body.errors).toEqual([
        expect.objectContaining({
          scope: 'field',
          field: 'warehouseCode',
          code: 'UNIQUE_VIOLATION',
          uniqueScope: ['plantId', 'warehouseCode'],
        }),
      ]);
    });

    it('선제 조회를 우회한 경합도 같은 봉투로 답한다', async () => {
      // 동시에 보내면 둘 다 선제 조회를 통과하고 진 쪽이 DB 제약에 걸린다.
      const results = await Promise.all([post(valid()), post(valid())]);
      const statuses = results.map((r) => r.status).sort();

      expect(statuses).toEqual([201, 400]);
      const failed = results.find((r) => r.status === 400);
      expect(failed?.body.errors[0]).toMatchObject({
        field: 'warehouseCode',
        code: 'UNIQUE_VIOLATION',
        uniqueScope: ['plantId', 'warehouseCode'],
      });
    });
  });

  describe('권한', () => {
    it('MASTER_READ 만 있으면 403 이다', async () => {
      const { body } = await post(valid(), readerToken).expect(403);

      expect(body.errors[0].code).toBe('PERMISSION_DENIED');
    });

    it('토큰이 없으면 401 이다', async () => {
      await request(app.getHttpServer())
        .post('/api/mdm/warehouses')
        .set('Idempotency-Key', randomUUID())
        .send(valid())
        .expect(401);
    });
  });
});
