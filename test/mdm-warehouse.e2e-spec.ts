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
import { commonCodeTable } from '../src/integration/erp/apply/common-code.apply';
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
      data: { login_id: LOGIN_ID, user_name: '창고검사', status_code: 'EMPLOYED' },
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

  it('⛔ 거래처는 받지 않는다 — partnerId 는 400 · 외부창고는 거래처 없이 저장되고 응답에 거래처가 없다(장부 P-146)', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-EXT`, { isExternal: true, partnerId: 1 }))
      .expect(400);
    expect(rejected.body.errors).toEqual([expect.objectContaining({ field: 'partnerId', code: 'INVALID' })]);

    const { id, etag } = await createWarehouse(`${PREFIX}-EXT`, { isExternal: true, partnerId: null });
    const stored = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id }, select: { is_external: true } });
    expect(stored.is_external).toBe(true);
    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...body(`${PREFIX}-EXT`), plantId: undefined, isExternal: false, isDefect: false })
      .expect(200);
    expect(updated.body.isExternal).toBe(false);
    expect(updated.body).not.toHaveProperty('partnerId');
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
    expect(stale.body.conflictCause).toBe('user');
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

  it('⭐ plantId 로 그 공장 창고만 거른다 — 창고 선택 목록이 공장으로 좁힌다(장부 P-109)', async () => {
    const first = await prisma.plant.findUniqueOrThrow({ where: { plant_id: plantId } });
    const other = await prisma.plant.create({
      data: {
        legal_entity_id: first.legal_entity_id,
        plant_code: `${PREFIX}-P2`,
        plant_name: '창고검사 둘째 공장',
        timezone_code: first.timezone_code,
      },
    });
    await createWarehouse(`${PREFIX}-HERE`);
    await createWarehouse(`${PREFIX}-THERE`, { plantId: Number(other.plant_id) });

    const codesOf = async (plant: number): Promise<string[]> => {
      const response = await request(app.getHttpServer())
        .get(`/api/mdm/warehouses?q=${PREFIX}&plantId=${plant}`)
        .set('Cookie', cookie)
        .expect(200);
      return response.body.items.map((w: { warehouseCode: string }) => w.warehouseCode);
    };

    expect(await codesOf(Number(other.plant_id))).toEqual([`${PREFIX}-THERE`]);
    const here = await codesOf(plantId);
    expect(here).toContain(`${PREFIX}-HERE`);
    expect(here).not.toContain(`${PREFIX}-THERE`);
  });

  it('⛔ plantId 가 정수가 아니면 400 이다 — 계약 사본의 질의 칸이 검증한다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/warehouses?plantId=abc')
      .set('Cookie', cookie)
      .expect(400);
  });

  it('⭐ dividedOnly 는 «고를 수 있는 활성 위치가 둘 이상»인 창고다 — 적치 대기는 세지 않고 창고 전체는 센다(장부 P-152)', async () => {
    const locationTypeCode = await firstCode('LOCATION_TYPE');
    await createWarehouse(`${PREFIX}-NONE`);
    const zoned = await createWarehouse(`${PREFIX}-ZONED`);
    const legacy = await createWarehouse(`${PREFIX}-LEGACY`);
    // 관리수준이 있던 때의 창고 — 위치 하나가 창고 전체 노릇을 해서 「창고 전체」가 없다.
    await prisma.location.updateMany({
      where: { warehouse_id: legacy.id, system_role_code: 'WAREHOUSE_WHOLE' },
      data: { is_active: false },
    });
    await prisma.location.createMany({
      data: [zoned.id, legacy.id].map((id, n) => ({
        warehouse_id: id,
        location_code: `${PREFIX}-L${n}`,
        location_name: '구역',
        location_type_code: locationTypeCode,
      })),
    });

    const divided = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses?q=${PREFIX}&dividedOnly=true`)
      .set('Cookie', cookie)
      .expect(200);

    const codes = divided.body.items.map((w: { warehouseCode: string }) => w.warehouseCode);
    expect(codes).toContain(`${PREFIX}-ZONED`);
    expect(codes).not.toContain(`${PREFIX}-NONE`);
    expect(codes).not.toContain(`${PREFIX}-LEGACY`);
  });

  it('⭐ 관리수준은 보지 않는다 — 공통코드에 없는 값도 받아 그대로 둔다(장부 P-152)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-ANYLV`), managementLevelCode: 'NONE' })
      .expect(201);

    expect(created.body.managementLevelCode).toBe('NONE');
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

  // ── ERP 창고(장부 P-148) — 코드·이름은 ERP 가 정하고 현장 이름은 별칭에 둔다 ──────────────

  it('⭐ ERP 창고는 ERP 이름으로만 만들고 RECEIVED_FROM_ERP 로 잠긴다 · 별칭은 고친다', async () => {
    const code = await erpCode('E1', 'ERP 자재창고');

    const misnamed = await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(code, { warehouseName: '다른 이름' }))
      .expect(400);
    expect(misnamed.body.errors).toEqual([expect.objectContaining({ field: 'warehouseName', code: 'STATE_LOCKED' })]);

    const { id, etag } = await createWarehouse(code, { warehouseName: 'ERP 자재창고', aliasName: ' 자재창고 ' });
    const detail = await request(app.getHttpServer()).get(`/api/mdm/warehouses/${id}`).set('Cookie', cookie).expect(200);
    expect(detail.body.editability).toMatchObject({ codeEditable: false, reason: 'RECEIVED_FROM_ERP' });
    expect(detail.body.warehouse.aliasName).toBe('자재창고');

    const put = (changes: Record<string, unknown>, ifMatch: string) => request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', ifMatch)
      .send({ ...body(code, { warehouseName: 'ERP 자재창고' }), plantId: undefined, isExternal: false, isDefect: false, ...changes });
    const locked = await put({ warehouseCode: `${PREFIX}-RENAMED`, warehouseName: '고친 이름' }, etag).expect(400);
    expect(locked.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['warehouseCode', 'warehouseName']);

    const aliased = await put({ aliasName: '1층 자재창고' }, etag).expect(200);
    expect(aliased.body).toMatchObject({ warehouseName: 'ERP 자재창고', aliasName: '1층 자재창고' });
    await put({ aliasName: 3 }, aliased.headers.etag).expect(400);
  });

  it('⛔ ERP 코드 하나에 MES 창고는 하나다 — 다른 공장에도 같은 코드를 만들 수 없다', async () => {
    const code = await erpCode('E2', 'ERP 제품창고');
    await createWarehouse(code, { warehouseName: 'ERP 제품창고' });
    const first = await prisma.plant.findUniqueOrThrow({ where: { plant_id: plantId } });
    const other = await prisma.plant.create({
      data: { legal_entity_id: first.legal_entity_id, plant_code: `${PREFIX}-P3`, plant_name: 'ERP 창고 둘째 공장', timezone_code: first.timezone_code },
    });

    const duplicated = await request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(code, { warehouseName: 'ERP 제품창고', plantId: Number(other.plant_id) }))
      .expect(400);
    expect(duplicated.body.errors).toEqual([
      expect.objectContaining({ field: 'warehouseCode', code: 'UNIQUE_VIOLATION', uniqueScope: ['warehouseCode'] }),
    ]);
  });

  it('⭐ ERP 가 이름을 바꿔 보내면 같은 코드의 MES 창고 이름도 바뀐다 — 공통코드 받기', async () => {
    const code = await erpCode('E3', 'ERP 옛 이름');
    const { id } = await createWarehouse(code, { warehouseName: 'ERP 옛 이름' });
    const before = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id } });

    await commonCodeTable.apply(prisma, {
      MES_INF_ID: 1, TYPE_CODE: 'SL_TYPE', TYPE_NAME: '창고구분', CODE: code, CODE_NAME: 'ERP 새 이름', T_FLAG: 'U',
    });

    const after = await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id } });
    expect(after.warehouse_name).toBe('ERP 새 이름');
    expect(after.version_no).toBe(before.version_no + 1);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /** ERP 창고 코드 — 공통코드 `SL_TYPE` 값으로 둔다(그룹은 다른 시험·ERP 받기와 같이 쓴다). */
  async function erpCode(suffix: string, name: string): Promise<string> {
    const group = await prisma.code_group.upsert({
      where: { group_code: 'SL_TYPE' },
      update: {},
      create: { group_code: 'SL_TYPE', group_name: '창고구분', is_system_owned: true },
    });
    const code = `${PREFIX}-${suffix}`;
    await prisma.code_value.create({ data: { code_group_id: group.code_group_id, code, code_name: name } });
    return code;
  }

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
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
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
