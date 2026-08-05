import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-WHU';
const READER = 'E2E-WHU-R';

describe('PUT /api/mdm/warehouses/{warehouseId} (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let readerToken: string;
  let plantId: bigint;
  let businessUnitId: bigint;
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    // 수정하려면 먼저 상세를 열어 ETag 를 받아야 한다 — 실제 화면과 같이 조회 권한도 준다.
    ({ token } = await createUserWithPermissions(app, PREFIX, ['MASTER_READ', 'MASTER_LOGISTICS_WRITE']));
    ({ token: readerToken } = await createUserWithPermissions(app, READER, ['MASTER_READ']));
    ({ plantId, businessUnitId } = await createOrganization(prisma, PREFIX));
  });

  afterEach(async () => {
    await prisma.idempotency_record.deleteMany({});
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await deleteUserWithPermissions(app, READER);
    await app.close();
  });

  /** 창고를 만들고 상세 조회로 ETag 를 받는다 — 화면이 편집 전에 하는 일 그대로다. */
  async function given(): Promise<{ id: number; etag: string; code: string }> {
    counter += 1;
    const code = `${PREFIX}-${counter}`;
    const row = await prisma.warehouse.create({
      data: {
        plant_id: plantId,
        business_unit_id: businessUnitId,
        warehouse_code: code,
        warehouse_name: '수정 전',
        warehouse_type_code: 'MATERIAL',
        management_level_code: 'WAREHOUSE',
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses/${row.warehouse_id}`)
      .set('Authorization', `Bearer ${token}`);

    return { id: Number(row.warehouse_id), etag: detail.headers.etag, code };
  }

  function put(
    id: number | string,
    body: Record<string, unknown>,
    options: { etag?: string; key?: string; bearer?: string } = {},
  ) {
    const req = request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${id}`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', options.key ?? randomUUID());

    if (options.etag !== undefined) req.set('If-Match', options.etag);

    return req.send(body);
  }

  function payload(code: string, overrides: Record<string, unknown> = {}) {
    return {
      businessUnitId: Number(businessUnitId),
      warehouseCode: code,
      warehouseName: '수정 후',
      warehouseTypeCode: 'PRODUCT',
      managementLevelCode: 'ZONE',
      isExternal: false,
      ...overrides,
    };
  }

  describe('낙관적 잠금', () => {
    it('맞는 If-Match 면 200 이고 ETag 가 오른다', async () => {
      const { id, etag, code } = await given();

      const response = await put(id, payload(code), { etag }).expect(200);

      expect(response.body).toMatchObject({ warehouseName: '수정 후', warehouseTypeCode: 'PRODUCT' });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it('틀린 If-Match 면 409 이고 봉투가 다르다 — ConflictResponse', async () => {
      const { id, etag, code } = await given();
      await put(id, payload(code), { etag }).expect(200);

      // 화면이 아직 옛 버전을 들고 있는 상황.
      const { body } = await put(id, payload(code, { warehouseName: '덮어쓰기' }), { etag }).expect(
        409,
      );

      expect(body).toMatchObject({ conflictCause: 'user' });
      expect(body.errors).toBeUndefined();
    });

    it('충돌하면 아무것도 바뀌지 않는다', async () => {
      const { id, etag, code } = await given();
      await put(id, payload(code, { warehouseName: '첫 수정' }), { etag }).expect(200);
      await put(id, payload(code, { warehouseName: '덮어쓰기' }), { etag }).expect(409);

      const row = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: BigInt(id) } });
      expect(row.warehouse_name).toBe('첫 수정');
    });

    it('동시에 수정하면 하나만 성공한다', async () => {
      const { id, etag, code } = await given();

      const results = await Promise.all([
        put(id, payload(code, { warehouseName: 'A' }), { etag }),
        put(id, payload(code, { warehouseName: 'B' }), { etag }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it.each([
      ['없으면', undefined],
      ['숫자가 아니면', 'abc'],
      ['0 이면', '0'],
    ])('If-Match 가 %s 400 이다', async (_label, etag) => {
      const { id, code } = await given();

      const { body } = await put(id, payload(code), { etag }).expect(400);
      expect(body.errors[0]).toMatchObject({ field: 'If-Match', code: 'REQUIRED' });
    });
  });

  describe('전체 교체', () => {
    it('안 보낸 partnerId 는 지워진다', async () => {
      const partner = await prisma.partner.findFirst();
      if (!partner) return;

      const { id, etag, code } = await given();
      await prisma.warehouse.update({
        where: { warehouse_id: BigInt(id) },
        data: { is_external: true, partner_id: partner.partner_id },
      });
      const refreshed = await request(app.getHttpServer())
        .get(`/api/mdm/warehouses/${id}`)
        .set('Authorization', `Bearer ${token}`);

      const { body } = await put(id, payload(code), { etag: refreshed.headers.etag }).expect(200);

      expect(body.isExternal).toBe(false);
      expect(body.partnerId).toBeNull();
      expect(etag).toBeDefined();
    });

    it.each([['plantId'], ['isActive']])('%s 를 보내면 400 이다 — 이 경로로 못 바꾼다', async (
      field,
    ) => {
      const { id, etag, code } = await given();

      await put(id, payload(code, { [field]: 1 }), { etag }).expect(400);
    });

    it('자기 코드를 그대로 두고 이름만 고칠 수 있다', async () => {
      const { id, etag, code } = await given();

      // 유일성 검사가 자기 자신을 제외하지 않으면 여기서 중복으로 막힌다.
      await put(id, payload(code, { warehouseName: '이름만 변경' }), { etag }).expect(200);
    });

    it('다른 창고의 코드로 바꾸려 하면 UNIQUE_VIOLATION 이다', async () => {
      const other = await given();
      const { id, etag } = await given();

      const { body } = await put(id, payload(other.code), { etag }).expect(400);
      expect(body.errors[0]).toMatchObject({ code: 'UNIQUE_VIOLATION' });
    });
  });

  describe('멱등 재전송', () => {
    it('같은 키로 재전송하면 409 가 아니라 저장된 200 을 받는다', async () => {
      // 1차에서 version_no 가 올라 클라이언트의 If-Match 는 이미 낡았다.
      // 멱등 검사가 If-Match 검사보다 앞에 있어야 이것이 성립한다.
      const { id, etag, code } = await given();
      const key = randomUUID();

      const first = await put(id, payload(code), { etag, key }).expect(200);
      const second = await put(id, payload(code), { etag, key }).expect(200);

      expect(second.body).toEqual(first.body);
    });

    it('재전송이 ETag 까지 되돌려준다 — 없으면 다음 쓰기의 If-Match 를 못 채운다', async () => {
      const { id, etag, code } = await given();
      const key = randomUUID();

      const first = await put(id, payload(code), { etag, key }).expect(200);
      const second = await put(id, payload(code), { etag, key }).expect(200);

      expect(second.headers.etag).toBe(first.headers.etag);
    });

    it('재전송이 version_no 를 두 번 올리지 않는다', async () => {
      const { id, etag, code } = await given();
      const key = randomUUID();

      await put(id, payload(code), { etag, key }).expect(200);
      await put(id, payload(code), { etag, key }).expect(200);

      const row = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: BigInt(id) } });
      expect(row.version_no).toBe(Number(etag) + 1);
    });
  });

  describe('그 외', () => {
    it('없는 창고는 404 다', async () => {
      await put(999999999, payload('X'), { etag: '1' }).expect(404);
    });

    it('MASTER_READ 만 있으면 403 이다', async () => {
      const { id, etag, code } = await given();

      await put(id, payload(code), { etag, bearer: readerToken }).expect(403);
    });

    it('감사 컬럼에 수정 주체를 기록한다', async () => {
      const { id, etag, code } = await given();
      await put(id, payload(code), { etag }).expect(200);

      const row = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: BigInt(id) } });
      expect(row.updated_by).not.toBeNull();
    });
  });
});
