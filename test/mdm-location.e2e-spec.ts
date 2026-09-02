/**
 * 위치(로케이션) 마스터.
 *
 * 계층에 물리 제약이 **하나도 없는** 자리다 — 자기 자신을 상위로 두는 것조차 DB 가
 * 막지 않는다. 그 빈자리를 서버가 어디까지 메우는지가 이 검사의 뼈대다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { LOCATION_REFERRERS } from '../src/mdm/logistics/location.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-mdmloc-probe';
const NOPERM_ID = 'e2e-mdmloc-noperm';
const PASSWORD = '위치-마스터-검사-비밀번호';
const PREFIX = 'MDMLOC';
const ROLE = 'E2E_MDMLOC';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('위치 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let warehouseId: number;
  let otherWarehouseId: number;
  let locationTypeCode: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '위치검사', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '위치검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-07' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    locationTypeCode = await firstCode('LOCATION_TYPE');
    warehouseId = await createWarehouse(`${PREFIX}-WH1`);
    otherWarehouseId = await createWarehouse(`${PREFIX}-WH2`);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 참조 목록이 DB 의 FK 와 정확히 같다 — 서른 곳이다', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table: string; column: string }[]>(`
      SELECT n.nspname || '.' || r.relname AS "table",
             (SELECT a.attname FROM unnest(c.conkey) k
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS "column"
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.confrelid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND tn.nspname = 'mdm' AND t.relname = 'location'
    `);

    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(LOCATION_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
    expect(actual.length).toBeGreaterThan(25);
  });

  it('목록이 계약 스키마를 만족한다 — 창고를 고른 뒤에만 연다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/locations?warehouseId=${warehouseId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/locations');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('⛔ warehouseId 없이 부르면 400 이다 — 계약이 필수로 두었다 (G-8)', async () => {
    const rejected = await request(app.getHttpServer())
      .get('/api/mdm/locations')
      .set('Cookie', cookie)
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'warehouseId', code: 'REQUIRED' });
  });

  it('⛔ 권한이 없으면 쓰기가 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/locations')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-X`))
      .expect(403);
  });

  it('⭐ 등록하고, 상세가 계약 스키마와 ETag 를 준다', async () => {
    const { id, etag } = await createLocation(`${PREFIX}-A`);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/locations/{locationId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⭐ 하위 위치가 붙으면 REFERENCED 로 잠긴다', async () => {
    const parent = await createLocation(`${PREFIX}-P`);
    await createLocation(`${PREFIX}-C`, { parentLocationId: parent.id });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${parent.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.editability).toMatchObject({ reason: 'REFERENCED', referenceCount: 1 });
  });

  it('⛔ 자기 자신을 상위로 둘 수 없다 — DB 에 그 제약조차 없다', async () => {
    const { id, etag } = await createLocation(`${PREFIX}-SELF`);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/locations/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...writeBody(`${PREFIX}-SELF`), parentLocationId: id })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      scope: 'field',
      field: 'parentLocationId',
      code: 'INVALID',
    });
  });

  it('⛔ 위치 계층에 순환을 만들 수 없다', async () => {
    const a = await createLocation(`${PREFIX}-CY-A`);
    const b = await createLocation(`${PREFIX}-CY-B`, { parentLocationId: a.id });
    const current = await detailOf(a.id);

    await request(app.getHttpServer())
      .put(`/api/mdm/locations/${a.id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', current.etag)
      .send({ ...writeBody(`${PREFIX}-CY-A`), parentLocationId: b.id })
      .expect(400);
  });

  it('⛔ 다른 창고의 위치를 상위로 둘 수 없다 — 목록이 창고 단위로만 열린다', async () => {
    const outsider = await createLocation(`${PREFIX}-OUT`, {}, otherWarehouseId);

    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/locations')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-CROSS`), parentLocationId: outsider.id })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'parentLocationId', code: 'INVALID' });
  });

  it('⛔ 용량과 단위는 짝이다 — ck_location_capacity 는 어느 칸인지 못 짚는다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/locations')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-CAP`), capacityQty: 100 })
      .expect(400);

    expect(rejected.body.errors).toEqual([
      { scope: 'field', field: 'capacityUomId', code: 'PAIR', message: expect.any(String) },
    ]);
  });

  it('⛔ 마스터에 없는 공통코드는 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/locations')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-BADZONE`), qualityZoneCode: '없는구역' })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'qualityZoneCode', code: 'INVALID' });
  });

  it('⭐ locationCode 는 정확 일치다 — 스캔한 코드로 한 건을 집는다', async () => {
    await createLocation(`${PREFIX}-SCAN`);
    await createLocation(`${PREFIX}-SCAN-2`);

    const exact = await request(app.getHttpServer())
      .get(`/api/mdm/locations?warehouseId=${warehouseId}&locationCode=${PREFIX}-SCAN`)
      .set('Cookie', cookie)
      .expect(200);
    expect(exact.body.items).toHaveLength(1);

    // 같은 글자를 `q` 로 보내면 부분 일치라 둘 다 온다 — 그래서 갈라 두었다.
    const partial = await request(app.getHttpServer())
      .get(`/api/mdm/locations?warehouseId=${warehouseId}&q=${PREFIX}-SCAN`)
      .set('Cookie', cookie)
      .expect(200);
    expect(partial.body.items.length).toBeGreaterThan(1);
  });

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await createLocation(`${PREFIX}-V`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/locations/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...writeBody(`${PREFIX}-V`), locationName: '고친 이름', allowMixedLot: false })
      .expect(200);

    expect(updated.body.locationName).toBe('고친 이름');
    expect(updated.body.allowMixedLot).toBe(false);
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/locations/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(writeBody(`${PREFIX}-V`))
      .expect(409);
    expect(stale.body.errors[0].code).toBe('STALE_VERSION');
  });

  it('중지·재개가 돌고, 중지된 것은 기본 목록에서 빠진다', async () => {
    const { id, etag } = await createLocation(`${PREFIX}-D`);

    const off = await request(app.getHttpServer())
      .post(`/api/mdm/locations/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    expect(off.body.isActive).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/locations?warehouseId=${warehouseId}&q=${PREFIX}-D`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.items.map((l: { locationId: number }) => l.locationId)).not.toContain(id);

    await request(app.getHttpServer())
      .post(`/api/mdm/locations/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', off.headers.etag)
      .expect(200);
  });

  it('⛔ 없는 위치는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/locations/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /** 수정 본문 — 계약이 `allowMixedItem`·`allowMixedLot` 를 «필수»로 두었다. */
  function writeBody(locationCode: string, extra: Record<string, unknown> = {}): object {
    return {
      locationCode,
      locationName: locationCode,
      locationTypeCode,
      allowMixedItem: true,
      allowMixedLot: true,
      ...extra,
    };
  }

  /** 등록 본문 — 두 칸은 선택이라 뺀다(계약이 갈랐다). */
  function body(locationCode: string, extra: Record<string, unknown> = {}): object {
    return { warehouseId, locationCode, locationName: locationCode, locationTypeCode, ...extra };
  }

  async function detailOf(id: number): Promise<{ etag: string }> {
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return { etag: detail.headers.etag };
  }

  async function createLocation(
    locationCode: string,
    extra: Record<string, unknown> = {},
    inWarehouse: number = warehouseId,
  ): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/locations')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(locationCode, extra), warehouseId: inWarehouse })
      .expect(201);
    return { id: created.body.locationId, ...(await detailOf(created.body.locationId)) };
  }

  async function createWarehouse(warehouseCode: string): Promise<number> {
    const plant = await prisma.plant.findFirstOrThrow();
    const unit = await prisma.business_unit.findFirstOrThrow();
    const created = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: warehouseCode,
        warehouse_name: warehouseCode,
        warehouse_type_code: await firstCode('WAREHOUSE_TYPE'),
        management_level_code: await firstCode('MANAGEMENT_LEVEL'),
      },
    });
    return Number(created.warehouse_id);
  }

  async function firstCode(groupCode: string): Promise<string> {
    const value = await prisma.code_value.findFirstOrThrow({
      where: { is_active: true, code_group: { group_code: groupCode } },
      orderBy: { display_order: 'asc' },
    });
    return value.code;
  }

  async function login(loginId: string = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    // 자식 → 부모 순으로 지운다. parent_location_id 가 FK 다.
    await prisma.location.deleteMany({
      where: { location_code: { startsWith: PREFIX }, NOT: { parent_location_id: null } },
    });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
