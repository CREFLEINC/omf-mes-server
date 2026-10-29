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
import { ContractException } from '../src/common/errors';
import { resolveDestinationLocation } from '../src/logistics/destination-location';
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
      data: { login_id: LOGIN_ID, user_name: '위치검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
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
    expect(detail.body.editability).toEqual({ codeEditable: false, reason: 'AUTO_ISSUED', referenceCount: 0 });
  });

  it('⭐ 하위 위치가 붙으면 참조로 센다', async () => {
    const parent = await createLocation(`${PREFIX}-P`);
    await createLocation(`${PREFIX}-C`, { parentLocationId: parent.id });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${parent.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.editability).toMatchObject({ reason: 'AUTO_ISSUED', referenceCount: 1 });
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

  it('⭐ locationCode 는 정확 일치다 — 스캔한 코드로 한 건을 집는다', async () => {
    const zone = await createLocation(`${PREFIX}-SCAN`);
    await createLocation(`${PREFIX}-SCAN-2`, { parentLocationId: zone.id });

    const exact = await request(app.getHttpServer())
      .get(`/api/mdm/locations?warehouseId=${warehouseId}&locationCode=${zone.code}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(exact.body.items.map((l: { locationId: number }) => l.locationId)).toEqual([zone.id]);

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
      .send(writeBody('고친 이름'))
      .expect(200);

    expect(updated.body.locationName).toBe('고친 이름');
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/locations/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(writeBody(`${PREFIX}-V`))
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
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

  // ── 서버가 만든 위치(장부 P-145) ──────────────────────────────────────────

  it('⭐ 창고를 만들면 서버가 「적치 대기」·「창고 전체」를 둔다 — 관리수준과 상관없다(장부 P-153)', async () => {
    const whole = await createWarehouse(`${PREFIX}-WH3`, 'WAREHOUSE');
    const cell = await createWarehouse(`${PREFIX}-WH4`, 'CELL');

    expect(await rolesOf(whole)).toEqual(['PUTAWAY_STAGING', 'WAREHOUSE_WHOLE']);
    expect(await rolesOf(cell)).toEqual(['PUTAWAY_STAGING', 'WAREHOUSE_WHOLE']);
  });

  it('⭐ 목록·상세가 역할을 싣고, 서버가 만든 자리는 SYSTEM_OWNED 로 잠긴다', async () => {
    const staging = await systemLocation(warehouseId, 'PUTAWAY_STAGING');

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/locations?warehouseId=${warehouseId}&locationCode=SYS-STAGING`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({ locationId: staging, systemRoleCode: 'PUTAWAY_STAGING', aliasName: null }),
    ]);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${staging}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.editability).toMatchObject({ codeEditable: false, reason: 'SYSTEM_OWNED' });
  });

  it('⛔ 서버가 만든 자리는 별칭만 고친다 — 다른 칸이 바뀌어 오면 400 STATE_LOCKED 다', async () => {
    const staging = await systemLocation(warehouseId, 'PUTAWAY_STAGING');
    const kept = { locationName: '적치 대기' };

    const aliased = await request(app.getHttpServer())
      .put(`/api/mdm/locations/${staging}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', (await detailOf(staging)).etag)
      .send({ ...kept, aliasName: '  품질검사실 앞  ' })
      .expect(200);
    expect(aliased.body).toMatchObject({ locationName: '적치 대기', aliasName: '품질검사실 앞' });

    const locked = await request(app.getHttpServer())
      .put(`/api/mdm/locations/${staging}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', aliased.headers.etag)
      .send({ ...kept, locationName: '다른 이름', aliasName: '바꿔 본다' })
      .expect(400);
    expect(locked.body.errors).toEqual([expect.objectContaining({ field: 'locationName', code: 'STATE_LOCKED' })]);
  });

  it('⛔ 적치 대기 자리는 끌 수 없다 · 창고 전체는 끈다', async () => {
    const id = await createWarehouse(`${PREFIX}-WH5`);
    const staging = await systemLocation(id, 'PUTAWAY_STAGING');
    const whole = await systemLocation(id, 'WAREHOUSE_WHOLE');

    const rejected = await request(app.getHttpServer())
      .post(`/api/mdm/locations/${staging}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', (await detailOf(staging)).etag)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });

    const off = await request(app.getHttpServer())
      .post(`/api/mdm/locations/${whole}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', (await detailOf(whole)).etag)
      .expect(200);
    expect(off.body.isActive).toBe(false);
  });

  it('⭐ 별칭은 사람이 만든 위치에도 붙는다 · 빈 글은 별칭 없음 · 글이 아니면 400', async () => {
    const { id, etag } = await createLocation(`${PREFIX}-AL`, { aliasName: '자재 랙 1' });
    const detail = await request(app.getHttpServer()).get(`/api/mdm/locations/${id}`).set('Cookie', cookie).expect(200);
    expect(detail.body.location.aliasName).toBe('자재 랙 1');

    const cleared = await request(app.getHttpServer())
      .put(`/api/mdm/locations/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(writeBody(`${PREFIX}-AL`, { aliasName: ' ' }))
      .expect(200);
    expect(cleared.body.aliasName).toBeNull();

    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/locations')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-AL2`, { aliasName: 3 }))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'aliasName', code: 'INVALID' });
  });

  it('⛔ 한 창고에 같은 역할의 자리는 하나뿐이다 — DB 가 막는다', async () => {
    await expect(
      prisma.location.create({
        data: {
          warehouse_id: warehouseId,
          location_code: `${PREFIX}-DUP`,
          location_name: '둘째 적치 대기',
          location_type_code: locationTypeCode,
          system_role_code: 'PUTAWAY_STAGING',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('⭐ 구역이 없는 창고의 도착 위치는 창고 전체다 — 관리수준 값과 상관없고 적치 대기 자리는 세지 않는다(장부 P-153)', async () => {
    for (const level of ['WAREHOUSE', 'CELL']) {
      const id = await createWarehouse(`${PREFIX}-WH6-${level}`, level);
      const input = { warehouseId: id, warehouseField: 'warehouseId' };

      expect(await resolveDestinationLocation(prisma, input)).toBe(BigInt(await systemLocation(id, 'WAREHOUSE_WHOLE')));
    }
  });

  it('⛔ 위치를 나눈 창고는 도착 위치를 받아야 한다 — 안 주면 위치 칸에 400 REQUIRED · 주면 그 위치다', async () => {
    const id = await createWarehouse(`${PREFIX}-WH8`);
    const zone = await createLocation(`${PREFIX}-WH8-Z`, {}, id);
    const input = { warehouseId: id, warehouseField: 'warehouseId', locationField: 'toLocationId' };

    const error = await resolveDestinationLocation(prisma, input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).errors).toMatchObject([{ field: 'toLocationId', code: 'REQUIRED' }]);
    expect(await resolveDestinationLocation(prisma, { ...input, requestedLocationId: zone.id })).toBe(BigInt(zone.id));
  });

  it('⭐ 켜진 하위가 있는 위치는 고를 자리로 세지 않는다 — 창고 전체를 끄고 구역 밑에 하나만 두면 그것이다', async () => {
    const id = await createWarehouse(`${PREFIX}-WH9`);
    const whole = await systemLocation(id, 'WAREHOUSE_WHOLE');
    await prisma.location.update({ where: { location_id: whole }, data: { is_active: false } });
    const zone = await createLocation(`${PREFIX}-WH9-Z`, {}, id);
    const rack = await createLocation(`${PREFIX}-WH9-R`, { parentLocationId: zone.id }, id);

    expect(await resolveDestinationLocation(prisma, { warehouseId: id, warehouseField: 'warehouseId' })).toBe(BigInt(rack.id));
  });

  it('⭐ 창고를 지우면 서버가 만든 자리도 함께 지워진다', async () => {
    const id = await createWarehouse(`${PREFIX}-WH7`, 'WAREHOUSE');

    await prisma.warehouse.delete({ where: { warehouse_id: id } });

    expect(await prisma.location.count({ where: { warehouse_id: id } })).toBe(0);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /** 수정 본문 — 이름과 별칭만 바꾼다. */
  function writeBody(locationName: string, extra: Record<string, unknown> = {}): object {
    return { locationName, ...extra };
  }

  /** 등록 본문 — 코드는 서버가 발행하므로 이름으로 가른다. */
  function body(locationName: string, extra: Record<string, unknown> = {}): object {
    return { warehouseId, locationName, ...extra };
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
  ): Promise<{ id: number; code: string; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/locations')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(locationCode, extra), warehouseId: inWarehouse })
      .expect(201);
    return { id: created.body.locationId, code: created.body.locationCode, ...(await detailOf(created.body.locationId)) };
  }

  async function createWarehouse(warehouseCode: string, managementLevelCode?: string): Promise<number> {
    const plant = await prisma.plant.findFirstOrThrow();
    const unit = await prisma.business_unit.findFirstOrThrow();
    const created = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: warehouseCode,
        warehouse_name: warehouseCode,
        warehouse_type_code: await firstCode('WAREHOUSE_TYPE'),
        management_level_code: managementLevelCode ?? (await firstCode('MANAGEMENT_LEVEL')),
      },
    });
    return Number(created.warehouse_id);
  }

  async function rolesOf(id: number): Promise<(string | null)[]> {
    const rows = await prisma.location.findMany({
      where: { warehouse_id: id, NOT: { system_role_code: null } },
      select: { system_role_code: true },
      orderBy: { system_role_code: 'asc' },
    });
    return rows.map((row) => row.system_role_code);
  }

  async function systemLocation(id: number, role: string): Promise<number> {
    const row = await prisma.location.findFirstOrThrow({
      where: { warehouse_id: id, system_role_code: role },
      select: { location_id: true },
    });
    return Number(row.location_id);
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
    // 자식 → 부모 순으로 지운다. parent_location_id 가 FK 다. 코드는 서버가 발행해 창고로 고른다.
    const ours = { warehouse: { warehouse_code: { startsWith: PREFIX } } };
    await prisma.location.deleteMany({ where: { ...ours, NOT: { parent_location_id: null } } });
    await prisma.location.deleteMany({ where: { ...ours, system_role_code: null } });
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
