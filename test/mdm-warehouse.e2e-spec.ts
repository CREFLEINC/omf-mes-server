/**
 * 창고 마스터.
 *
 * 참조를 «셀 수 있는» 마스터 중 가리키는 자리가 처음으로 많은 것(16곳)이다.
 * 그 목록이 낡는 것이 이 코드의 진짜 위험이라, 검사가 DB 에서 다시 뽑아 대조한다.
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
import { WAREHOUSE_REFERRERS } from '../src/mdm/logistics/warehouse.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-mdmwh-probe';
const NOPERM_ID = 'e2e-mdmwh-noperm';
const PASSWORD = '창고-마스터-검사-비밀번호';
const PREFIX = 'MDMWH';
const ROLE = 'E2E_MDMWH';

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

describe('창고 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let businessUnitId: number;
  let warehouseTypeCode: string;
  let managementLevelCode: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '창고검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '창고검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-07' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    const plant = await prisma.plant.findFirstOrThrow();
    plantId = Number(plant.plant_id);
    businessUnitId = Number((await prisma.business_unit.findFirstOrThrow()).business_unit_id);
    // 코드 값을 하드코딩하지 않는다 — 환경마다 다르다(G-32).
    warehouseTypeCode = await firstCode('WAREHOUSE_TYPE');
    managementLevelCode = await firstCode('MANAGEMENT_LEVEL');
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 참조 목록이 DB 의 FK 와 정확히 같다 — 낡으면 잠금이 조용히 열린다', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table: string; column: string }[]>(`
      SELECT n.nspname || '.' || r.relname AS "table",
             (SELECT a.attname FROM unnest(c.conkey) k
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS "column"
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.confrelid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND tn.nspname = 'mdm' AND t.relname = 'warehouse'
    `);

    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    const declared = WAREHOUSE_REFERRERS.map(([t, c]) => `${t}.${c}`).sort();

    // 새 FK 가 붙었는데 상수에 없으면 그 자리는 세지 않는다 → 참조 0 으로 보여 코드 칸이
    // 열린다. 오류가 아니라 «조용히 틀린 허가»라 검사가 아니면 드러나지 않는다.
    expect(declared).toEqual(actual);
    expect(actual.length).toBeGreaterThan(10);
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/mdm/warehouses?size=5')
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/warehouses');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('⛔ 권한이 없으면 쓰기가 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-X`))
      .expect(403);
  });

  it('⭐ 등록하고, 상세가 계약 스키마와 ETag 를 준다', async () => {
    const { id, etag } = await createWarehouse(`${PREFIX}-A`);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/warehouses/{warehouseId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⭐ 위치가 붙으면 REFERENCED 로 잠긴다 — 16곳 중 하나가 걸려도 잠근다', async () => {
    const { id } = await createWarehouse(`${PREFIX}-REF`);
    await prisma.location.create({
      data: {
        warehouse_id: id,
        location_code: `${PREFIX}-L1`,
        location_name: '기본',
        location_type_code: await firstCode('LOCATION_TYPE'),
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.editability).toEqual({
      codeEditable: false,
      reason: 'REFERENCED',
      referenceCount: 1,
    });
  });

  it('⛔ 창고코드가 공백만이면 400 이다 — 계약이 「공백만 불가」로 적었다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-BLANK`), warehouseCode: '   ' })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'warehouseCode', code: 'REQUIRED' });
  });

  it('⛔ 마스터에 없는 공통코드는 400 이다 — 계약이 enum 을 안 적었다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-BAD`), warehouseTypeCode: '없는유형' })
      .expect(400);

    expect(rejected.body.errors).toEqual([
      { scope: 'field', field: 'warehouseTypeCode', code: 'INVALID', message: expect.any(String) },
    ]);
  });

  it('⛔ 사용 중지된 공통코드로 새 창고를 세울 수 없다', async () => {
    const group = await prisma.code_group.findFirstOrThrow({
      where: { group_code: 'WAREHOUSE_TYPE' },
    });
    const retired = await prisma.code_value.create({
      data: {
        code_group_id: group.code_group_id,
        code: `${PREFIX}-RETIRED`,
        code_name: '중지된 유형',
        is_active: false,
      },
    });

    await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-RET`), warehouseTypeCode: retired.code })
      .expect(400);
  });

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await createWarehouse(`${PREFIX}-V`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({
        businessUnitId,
        warehouseCode: `${PREFIX}-V`,
        warehouseName: '고친 이름',
        warehouseTypeCode,
        managementLevelCode,
        isExternal: false,
        isDefect: true,
      })
      .expect(200);

    expect(updated.body.warehouseName).toBe('고친 이름');
    expect(updated.body.isDefect).toBe(true);
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({
        businessUnitId,
        warehouseCode: `${PREFIX}-V`,
        warehouseName: '뒤늦게',
        warehouseTypeCode,
        managementLevelCode,
        isExternal: false,
        isDefect: false,
      })
      .expect(409);
    expect(stale.body.errors[0].code).toBe('STALE_VERSION');
  });

  it('⭐ isDefect 로 불량창고만 거른다 — W-01-06 이 이 조건으로 건다', async () => {
    await createWarehouse(`${PREFIX}-DEF`, { isDefect: true });
    await createWarehouse(`${PREFIX}-NORMAL`);

    const defects = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses?q=${PREFIX}&isDefect=true`)
      .set('Cookie', cookie)
      .expect(200);

    const codes = defects.body.items.map((w: { warehouseCode: string }) => w.warehouseCode);
    expect(codes).toContain(`${PREFIX}-DEF`);
    expect(codes).not.toContain(`${PREFIX}-NORMAL`);
  });

  it('⭐ dividedOnly 는 «활성 위치가 둘 이상»인 창고다 — 하나짜리는 안 걸린다', async () => {
    const locationTypeCode = await firstCode('LOCATION_TYPE');
    const one = await createWarehouse(`${PREFIX}-ONE`);
    const two = await createWarehouse(`${PREFIX}-TWO`);
    // 재고를 한 번이라도 받은 창고는 기본 위치 한 행이 반드시 있다 — 그것으로는 안 걸린다.
    await prisma.location.create({
      data: {
        warehouse_id: one.id,
        location_code: `${PREFIX}-O1`,
        location_name: '기본',
        location_type_code: locationTypeCode,
      },
    });
    await prisma.location.createMany({
      data: [1, 2].map((n) => ({
        warehouse_id: two.id,
        location_code: `${PREFIX}-T${n}`,
        location_name: `구역${n}`,
        location_type_code: locationTypeCode,
      })),
    });

    const divided = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses?q=${PREFIX}&dividedOnly=true`)
      .set('Cookie', cookie)
      .expect(200);

    const codes = divided.body.items.map((w: { warehouseCode: string }) => w.warehouseCode);
    expect(codes).toContain(`${PREFIX}-TWO`);
    expect(codes).not.toContain(`${PREFIX}-ONE`);
  });

  it('중지·재개가 돌고, 중지된 것은 기본 목록에서 빠진다', async () => {
    const { id, etag } = await createWarehouse(`${PREFIX}-D`);

    const off = await request(app.getHttpServer())
      .post(`/api/mdm/warehouses/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    expect(off.body.isActive).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses?q=${PREFIX}-D`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.items.map((w: { warehouseId: number }) => w.warehouseId)).not.toContain(id);

    const on = await request(app.getHttpServer())
      .post(`/api/mdm/warehouses/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', off.headers.etag)
      .expect(200);
    expect(on.body.isActive).toBe(true);
  });

  it('⭐ 같은 멱등키로 다시 보내면 두 번 만들지 않는다', async () => {
    const idempotencyKey = key();
    const payload = body(`${PREFIX}-IDEM`);

    const first = await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(201);

    expect(second.body.warehouseId).toBe(first.body.warehouseId);
    expect(
      await prisma.warehouse.count({ where: { warehouse_code: `${PREFIX}-IDEM` } }),
    ).toBe(1);
  });

  it('⛔ 없는 창고는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/warehouses/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function body(warehouseCode: string, extra: Record<string, unknown> = {}): object {
    return {
      plantId,
      businessUnitId,
      warehouseCode,
      warehouseName: warehouseCode,
      warehouseTypeCode,
      managementLevelCode,
      ...extra,
    };
  }

  async function createWarehouse(
    warehouseCode: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(warehouseCode, extra))
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses/${created.body.warehouseId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { id: created.body.warehouseId, etag: detail.headers.etag };
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
    const warehouses = await prisma.warehouse.findMany({
      where: { warehouse_code: { startsWith: PREFIX } },
      select: { warehouse_id: true },
    });
    await prisma.location.deleteMany({
      where: { warehouse_id: { in: warehouses.map((w) => w.warehouse_id) } },
    });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.code_value.deleteMany({ where: { code: { startsWith: PREFIX } } });
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
