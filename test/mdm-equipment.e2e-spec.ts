/**
 * 설비 마스터.
 *
 * 이 자원은 상태 축이 «둘»이다 — `is_active`(목록에서 감춤)와 `status_code`(자산이 끝남).
 * 공유계약 `B-16` 이 둘을 가르라 했고, 그 차이가 이 검사의 뼈대다.
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
import { EQUIPMENT_REFERRERS } from '../src/mdm/equipment/equipment.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-mdmeq-probe';
const NOPERM_ID = 'e2e-mdmeq-noperm';
const PASSWORD = '설비-마스터-검사-비밀번호';
const PREFIX = 'MDMEQ';
const ROLE = 'E2E_MDMEQ';

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

describe('설비 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let parentGroupId: number;
  let groupId: number;
  let uomId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '설비검사', status_code: 'EMPLOYED' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '설비검사용' } });
    for (const permission of ['W-05-11', 'W-05-12']) {
      await prisma.role_permission.create({
        data: { role_id: role.role_id, permission_code: permission },
      });
    }
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    plantId = Number((await prisma.plant.findFirstOrThrow()).plant_id);
    uomId = Number((await prisma.uom.findFirstOrThrow()).uom_id);
    parentGroupId = await createGroup(`${PREFIX}-PARENT`, null);
    groupId = await createGroup(`${PREFIX}-CHILD`, parentGroupId);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 참조 목록이 DB 의 FK 와 정확히 같다 — 스물두 곳이다', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table: string; column: string }[]>(`
      SELECT n.nspname || '.' || r.relname AS "table",
             (SELECT a.attname FROM unnest(c.conkey) k
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS "column"
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.confrelid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND tn.nspname = 'mdm' AND t.relname = 'equipment'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(EQUIPMENT_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
    expect(actual.length).toBeGreaterThan(15);
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/equipments?plantId=${plantId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/equipments');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/equipments')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-X`))
      .expect(403);
  });

  it('⭐ 등록하고 상세가 계약 스키마·ETag·계층을 준다', async () => {
    const { id, etag } = await create(`${PREFIX}-A`, { productionLineId: groupId });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipments/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/equipments/{equipmentId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    expect(detail.body.equipment.statusCode).toBe('IN_SERVICE');
    // 계층은 최상위부터 차례로 — 화면이 「공장 > 상위 > 하위 > 설비」로 잇는다.
    expect(detail.body.hierarchy.groupNames).toEqual([`${PREFIX}-PARENT`, `${PREFIX}-CHILD`]);
    expect(detail.body.hierarchy.groupAssigned).toBe(true);
    expect(detail.body.hierarchy.equipmentName).toBe(`${PREFIX}-A`);
  });

  it('⭐ 소속 그룹이 없으면 groupAssigned 가 거짓이다 — 빈 배열과 다른 뜻이다', async () => {
    const { id } = await create(`${PREFIX}-NOGRP`);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipments/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.hierarchy.groupNames).toEqual([]);
    // 「화면은 빈칸으로 두지 않고 «소속 그룹 없음»으로 밝힌다」(계약).
    expect(detail.body.hierarchy.groupAssigned).toBe(false);
  });

  it('⛔ 검교정 대상이면 주기 두 칸이 함께 필요하다 — 계약이 이유를 적었다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/equipments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-CAL`), calibrationRequired: true })
      .expect(400);

    expect(rejected.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'calibrationCycleInterval',
      'calibrationCycleTypeCode',
    ]);

    const accepted = await request(app.getHttpServer())
      .post('/api/mdm/equipments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        ...body(`${PREFIX}-CAL2`),
        calibrationRequired: true,
        calibrationCycleTypeCode: 'MONTH',
        calibrationCycleInterval: 6,
      })
      .expect(201);
    expect(accepted.body.calibrationCycleInterval).toBe(6);
  });

  it('⛔ 정밀도 수치와 단위는 짝이다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/equipments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-PREC`), precisionValue: 0.01 })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'precisionUomId', code: 'PAIR' });

    // 둘을 함께 보내면 통과한다.
    const accepted = await request(app.getHttpServer())
      .post('/api/mdm/equipments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-PREC2`), precisionValue: 0.01, precisionUomId: uomId })
      .expect(201);
    expect(accepted.body.precisionUomId).toBe(uomId);
  });

  it('⛔ 마스터에 없는 설비 유형은 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/equipments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-BAD`), equipmentTypeCode: '없는유형' })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'equipmentTypeCode', code: 'INVALID' });
  });

  // ── 두 축: 사용 중지 vs 폐기 (B-16) ─────────────────────────────────────

  it('⭐ 사용 중지는 감추기만 한다 — 재개하면 다시 편집된다', async () => {
    const { id, etag } = await create(`${PREFIX}-D`);

    const off = await act(id, 'deactivate', etag);
    expect(off.body.isActive).toBe(false);
    expect(off.body.statusCode).toBe('IN_SERVICE');

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/equipments?q=${PREFIX}-D`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.items.map((e: { equipmentId: number }) => e.equipmentId)).not.toContain(id);

    const on = await act(id, 'activate', off.headers.etag);
    expect(on.body.isActive).toBe(true);

    // 중지했다 재개한 설비는 편집이 열려 있다 — 폐기와 갈리는 지점이다.
    await request(app.getHttpServer())
      .put(`/api/mdm/equipments/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', on.headers.etag)
      .send(updateBody(`${PREFIX}-D`))
      .expect(200);
  });

  it('⭐ 폐기는 자산이 끝난 것이다 — 뒤에는 편집이 풀리지 않는다', async () => {
    const { id, etag } = await create(`${PREFIX}-DISP`);

    const disposed = await act(id, 'dispose', etag);
    expect(disposed.body.statusCode).toBe('DISPOSED');
    // 폐기는 is_active 를 건드리지 않는다 — 다른 축이다.
    expect(disposed.body.isActive).toBe(true);

    const locked = await request(app.getHttpServer())
      .put(`/api/mdm/equipments/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', disposed.headers.etag)
      .send(updateBody(`${PREFIX}-DISP`))
      // ⛔ 400 이다 — 「업무 규칙 위반(상태 잠김)은 409 가 아니라 400」(계약).
      // 409 는 «재로드하면 풀리는» 저장 충돌 전용이다(G-1).
      .expect(400);
    expect(locked.body.errors[0].code).toBe('STATE_LOCKED');
  });

  it('⛔ 이미 폐기한 설비를 다시 폐기할 수 없다 — 상태기계가 가른다', async () => {
    const { id, etag } = await create(`${PREFIX}-TWICE`);
    const disposed = await act(id, 'dispose', etag);

    const rejected = await request(app.getHttpServer())
      .post(`/api/mdm/equipments/${id}:dispose`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', disposed.headers.etag)
      // ⛔ 이쪽은 409 다 — 계약 `:dispose` 가 409 를 «선언했다». 봉투도 ErrorResponse 가
      // 아니라 ConflictResponse 다.
      .expect(409);
    expect(rejected.body).toEqual({
      conflictCause: 'user',
      message: expect.stringContaining('상태'),
    });
  });

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await create(`${PREFIX}-V`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/equipments/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...updateBody(`${PREFIX}-V`), equipmentName: '고친 이름' })
      .expect(200);
    expect(updated.body.equipmentName).toBe('고친 이름');

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/equipments/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody(`${PREFIX}-V`))
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⭐ 참조가 붙으면 코드가 잠긴다', async () => {
    const { id } = await create(`${PREFIX}-REF`);
    await prisma.terminal.create({
      data: {
        plant_id: plantId,
        terminal_code: `${PREFIX}-T`,
        terminal_type_code: 'POP',
        status_code: 'RUNNING',
        equipment_id: id,
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipments/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.editability).toMatchObject({ codeEditable: false, reason: 'REFERENCED' });
  });

  it('⛔ 없는 설비는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/equipments/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function updateBody(equipmentCode: string, extra: Record<string, unknown> = {}): object {
    return {
      equipmentCode,
      equipmentName: equipmentCode,
      equipmentTypeCode: 'INJECTION_MOLDING',
      calibrationRequired: false,
      ...extra,
    };
  }

  function body(equipmentCode: string, extra: Record<string, unknown> = {}): object {
    return { plantId, ...updateBody(equipmentCode, extra) };
  }

  async function act(
    id: number,
    action: string,
    etag: string,
  ): Promise<{ body: { isActive: boolean; statusCode: string }; headers: Record<string, string> }> {
    const response = await request(app.getHttpServer())
      .post(`/api/mdm/equipments/${id}:${action}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    return { body: response.body, headers: response.headers };
  }

  async function create(
    equipmentCode: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/equipments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(equipmentCode, extra))
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipments/${created.body.equipmentId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { id: created.body.equipmentId, etag: detail.headers.etag };
  }

  async function createGroup(code: string, parent: number | null): Promise<number> {
    const created = await prisma.production_line.create({
      data: {
        plant_id: plantId,
        line_code: code,
        line_name: code,
        line_type_code: 'LINE',
        ...(parent === null ? {} : { parent_line_id: parent }),
      },
    });
    return Number(created.production_line_id);
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
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({
      where: { line_code: { startsWith: PREFIX }, NOT: { parent_line_id: null } },
    });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
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
