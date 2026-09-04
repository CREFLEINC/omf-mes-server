/**
 * 툴(금형) 마스터 — 화면 `W-05-13`, 목록은 `W-05-02`(예방보전 도래 조회)가 함께 쓴다.
 *
 * 표준 마스터 패턴 위에 이 마스터만의 것 셋을 얹는다 — 저장하지 않는 도출값(예방보전
 * 도래·초과율), 필터 전체를 세는 요약, 라벨 발행이 코드를 잠그는 갈래.
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
import { MOLD_REFERRERS } from '../src/mdm/mold/mold.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-mdmmold-probe';
const NOPERM_ID = 'e2e-mdmmold-noperm';
const PASSWORD = '툴-검사-비밀번호';
const PREFIX = 'MDMMOLD';
const ROLE = 'E2E_MDMMOLD';
/** 목록·상세·쓰기가 서로 다른 화면 권한을 요구한다 — 가드는 「하나라도 있으면」이다. */
const PERMISSIONS = ['W-05-13', 'W-05-02', 'P-02-03'];

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

/** 공장 로컬 오늘에서 며칠 떨어진 날. 도래 판정이 서버 날짜가 아닌 공장 날짜를 본다. */
function daysFromToday(timezone: string, days: number): Date {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days));
}

describe('툴 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let timezone: string;
  let userId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const plant = await prisma.plant.findFirstOrThrow();
    plantId = Number(plant.plant_id);
    timezone = plant.timezone_code;

    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '툴검사', status_code: 'EMPLOYED' },
    });
    userId = user.app_user_id;
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '툴검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 참조 목록이 DB 의 FK 와 정확히 같다 — 일곱 곳이다', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table: string; column: string }[]>(`
      SELECT n.nspname || '.' || r.relname AS "table",
             (SELECT a.attname FROM unnest(c.conkey) k
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS "column"
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.confrelid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND tn.nspname = 'mdm' AND t.relname = 'mold'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(MOLD_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    await create(`${PREFIX}-LIST`);
    const list = await request(app.getHttpServer())
      .get(`/api/mdm/molds?plantId=${plantId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/molds');
    expect(validate(list.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(list.body.summary.pmNearThresholdPercent).toBe(90);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/molds')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-X`))
      .expect(403);
  });

  it('⭐ 등록하고 상세가 계약 스키마·ETag·editability 를 준다', async () => {
    const { id, etag } = await create(`${PREFIX}-A`);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/molds/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/molds/{moldId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    expect(detail.body.mold).toMatchObject({
      moldCode: `${PREFIX}-A`,
      toolTypeCode: 'MOLD',
      statusCode: 'IN_SERVICE',
      isActive: true,
    });
    expect(detail.body.labelIssueCount).toBe(0);
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⛔ 마스터에 없는 도구 유형은 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/molds')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-BADTYPE`), toolTypeCode: '없는유형' })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'toolTypeCode', code: 'INVALID' });
  });

  it('⛔ 날짜 주기는 간격과 단위가 짝이다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/molds')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-PAIR`), pmCycleInterval: 6 })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'pmCycleUnitCode', code: 'PAIR' });
  });

  it('⭐ 적정타수가 비면 사용가능타수·사용률이 null 이다 — 0 으로 채우지 않는다', async () => {
    const { id } = await create(`${PREFIX}-NOCRIT`);
    const mold = await moldOf(id);
    expect(mold.guaranteedShotCount).toBeNull();
    expect(mold.availableShotCount).toBeNull();
    expect(mold.shotUsageRatio).toBeNull();
    expect(mold.pmDue).toBe(false);
  });

  it('⭐ 타발수 축은 누계가 적정타수에 닿으면 도래한다 — pmDueAxisCode 가 SHOT 이다', async () => {
    const { id } = await create(`${PREFIX}-SHOT`, {
      guaranteedShotCount: 1000,
      pmTriggerTypeCode: 'SHOT',
    });
    const fresh = await moldOf(id);
    expect(fresh).toMatchObject({ pmDue: false, availableShotCount: 1000, shotUsageRatio: 0 });
    // 도래하지 않은 축은 칸째 빠진다 — 계약 스키마의 enum 이 null 을 받지 않는다.
    expect(fresh.pmDueAxisCode).toBeUndefined();

    // 누계는 실적이 정한다 — 계약이 쓰기로 받지 않으므로 표를 직접 민다.
    await prisma.mold.update({
      where: { mold_id: id },
      data: { current_shot_count: 1025 },
    });
    expect(await moldOf(id)).toMatchObject({
      pmDue: true,
      pmDueAxisCode: 'SHOT',
      availableShotCount: -25,
      shotUsageRatio: 102.5,
    });
  });

  it('⭐ 날짜 축은 다음 예정일이 공장 로컬 오늘을 지나면 도래한다 — pmDueAxisCode 가 DATE 다', async () => {
    const { id } = await create(`${PREFIX}-DATE`, {
      pmTriggerTypeCode: 'DATE',
      pmCycleInterval: 1,
      pmCycleUnitCode: 'MONTH',
    });
    // 기준일은 예방보전 실적이 정한다 — 아직 그 경로가 없어 표를 직접 민다.
    await prisma.mold.update({
      where: { mold_id: id },
      data: { last_pm_date: daysFromToday(timezone, -40) },
    });
    const due = await moldOf(id);
    expect(due).toMatchObject({ pmDue: true, pmDueAxisCode: 'DATE' });
    expect(due.nextPmDate).not.toBeNull();

    await prisma.mold.update({
      where: { mold_id: id },
      data: { last_pm_date: daysFromToday(timezone, -1) },
    });
    const notDue = await moldOf(id);
    expect(notDue.pmDue).toBe(false);
    expect(notDue.pmDueAxisCode).toBeUndefined();
  });

  it('⭐ 판정 기준이 NONE 이면 어떤 축도 도래하지 않는다', async () => {
    const { id } = await create(`${PREFIX}-NONE`, { guaranteedShotCount: 10 });
    await prisma.mold.update({
      where: { mold_id: id },
      data: { current_shot_count: 999, last_pm_date: daysFromToday(timezone, -400) },
    });
    const never = await moldOf(id);
    expect(never).toMatchObject({ pmTriggerTypeCode: 'NONE', pmDue: false });
    expect(never.pmDueAxisCode).toBeUndefined();
  });

  it('⭐ 요약은 페이지가 아니라 필터 전체를 센다 — pmDueOnly 는 요약에 걸지 않는다', async () => {
    const q = `${PREFIX}-SUM`;
    const overdue = await create(`${q}-1`, { guaranteedShotCount: 100, pmTriggerTypeCode: 'SHOT' });
    const near = await create(`${q}-2`, { guaranteedShotCount: 100, pmTriggerTypeCode: 'SHOT' });
    await create(`${q}-3`); // 적정타수·주기가 둘 다 비어 판정이 서지 않는다
    await prisma.mold.update({ where: { mold_id: overdue.id }, data: { current_shot_count: 120 } });
    await prisma.mold.update({ where: { mold_id: near.id }, data: { current_shot_count: 95 } });

    const all = await list(`q=${q}`);
    expect(all.summary).toEqual({
      pmDueCount: 1,
      // 도래한 것도 임계를 넘었으므로 함께 센다.
      pmNearCount: 2,
      criteriaMissingCount: 1,
      pmNearThresholdPercent: 90,
    });
    expect(all.items).toHaveLength(3);

    const dueOnly = await list(`q=${q}&pmDueOnly=true`);
    expect(dueOnly.items.map((m) => m.moldId)).toEqual([overdue.id]);
    // ⛔ 목록은 좁아져도 요약은 그대로다 — 걸면 「임박」이 항상 0 이 된다(계약).
    expect(dueOnly.summary).toEqual(all.summary);
  });

  it('⭐ 초과율 높은 순 정렬이 산출 불가를 뒤로 보낸다', async () => {
    const q = `${PREFIX}-SORT`;
    const low = await create(`${q}-1`, { guaranteedShotCount: 100 });
    const high = await create(`${q}-2`, { guaranteedShotCount: 100 });
    const unknown = await create(`${q}-3`);
    await prisma.mold.update({ where: { mold_id: low.id }, data: { current_shot_count: 10 } });
    await prisma.mold.update({ where: { mold_id: high.id }, data: { current_shot_count: 90 } });

    const sorted = await list(`q=${q}&sort=SHOT_USAGE_DESC`);
    expect(sorted.items.map((m) => m.moldId)).toEqual([high.id, low.id, unknown.id]);
  });

  it('⭐ 열린 보전오더로 거른다 — 완료·취소는 열린 것이 아니다', async () => {
    const q = `${PREFIX}-ORDER`;
    const open = await create(`${q}-1`);
    const closed = await create(`${q}-2`);
    await order(open.id, 'ISSUED');
    await order(closed.id, 'DONE');

    expect((await list(`q=${q}&withOpenMaintenanceOrder=true`)).items.map((m) => m.moldId)).toEqual([
      open.id,
    ]);
    expect(
      (await list(`q=${q}&withOpenMaintenanceOrder=false`)).items.map((m) => m.moldId),
    ).toEqual([closed.id]);
  });

  it('⭐ 라벨이 발행되면 참조가 0이어도 코드가 잠긴다 — LABEL_ISSUED', async () => {
    const { id, etag } = await create(`${PREFIX}-LABEL`);
    await prisma.document_issue_log.create({
      data: {
        document_type_code: 'TOOL_LABEL',
        target_type_code: 'MOLD',
        target_id: id,
        issued_by: userId,
      },
    });

    const detail = await detailOf(id);
    expect(detail.editability).toEqual({
      codeEditable: false,
      reason: 'LABEL_ISSUED',
      referenceCount: 0,
    });
    expect(detail.labelIssueCount).toBe(1);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/molds/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(body(`${PREFIX}-LABEL2`))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'moldCode', code: 'STATE_LOCKED' });
  });

  it('⭐ 참조가 붙으면 코드가 잠기고 코드 변경은 400, 이름 변경은 된다 — REFERENCED', async () => {
    const { id, etag } = await create(`${PREFIX}-REF`);
    await order(id, 'ISSUED');

    const detail = await detailOf(id);
    expect(detail.editability).toEqual({
      codeEditable: false,
      reason: 'REFERENCED',
      referenceCount: 1,
    });

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/molds/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(body(`${PREFIX}-REF2`))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'moldCode', code: 'STATE_LOCKED' });

    const renamed = await request(app.getHttpServer())
      .put(`/api/mdm/molds/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...body(`${PREFIX}-REF`), moldName: '이름만 고침' })
      .expect(200);
    expect(renamed.body.moldName).toBe('이름만 고침');
  });

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await create(`${PREFIX}-V`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/molds/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...body(`${PREFIX}-V2`), cavityCount: 8 })
      .expect(200);
    expect(updated.body).toMatchObject({ moldCode: `${PREFIX}-V2`, cavityCount: 8 });
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/molds/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(body(`${PREFIX}-V2`))
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⛔ 같은 공장에 같은 코드를 두 번 넣을 수 없다 — 409 가 아니라 400 이다', async () => {
    await create(`${PREFIX}-DUP`);
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/molds')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-DUP`))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'moldCode',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['plantId', 'moldCode'],
    });
  });

  it('⛔ 없는 툴은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/molds/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function body(moldCode: string, extra: object = {}): Record<string, unknown> {
    return {
      plantId,
      moldCode,
      moldName: moldCode,
      // 시드 TOOL_TYPE(MOLD·JIG·OTHER).
      toolTypeCode: 'MOLD',
      cavityCount: 4,
      ...extra,
    };
  }

  async function create(
    moldCode: string,
    extra: object = {},
  ): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/molds')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(moldCode, extra))
      .expect(201);
    const validate = validator('POST /mdm/molds', 201);
    expect(validate(created.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return { id: created.body.moldId, etag: (await detailOf(created.body.moldId)).etag };
  }

  async function detailOf(
    id: number,
  ): Promise<{ etag: string; editability: Record<string, unknown>; labelIssueCount: number }> {
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/molds/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return {
      etag: detail.headers.etag,
      editability: detail.body.editability,
      labelIssueCount: detail.body.labelIssueCount,
    };
  }

  async function moldOf(id: number): Promise<Record<string, unknown>> {
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/molds/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return detail.body.mold;
  }

  async function list(
    query: string,
  ): Promise<{ items: { moldId: number }[]; summary: Record<string, number> }> {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/molds?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /mdm/molds');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  /** 툴을 가리키는 보전오더 하나. 대상 다형이라 판별자와 mold_id 를 함께 넣는다. */
  async function order(moldId: number, statusCode: string): Promise<void> {
    await prisma.maintenance_order.create({
      data: {
        maintenance_order_no: `${PREFIX}-${moldId}-${statusCode}`,
        target_type_code: 'MOLD',
        mold_id: moldId,
        order_type_code: 'PREVENTIVE',
        priority_code: 'NORMAL',
        status_code: statusCode,
      },
    });
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
    await prisma.maintenance_order.deleteMany({
      where: { maintenance_order_no: { startsWith: PREFIX } },
    });
    const molds = await prisma.mold.findMany({
      where: { mold_code: { startsWith: PREFIX } },
      select: { mold_id: true },
    });
    await prisma.document_issue_log.deleteMany({
      where: { target_type_code: 'MOLD', target_id: { in: molds.map((m) => m.mold_id) } },
    });
    await prisma.mold.deleteMany({ where: { mold_code: { startsWith: PREFIX } } });
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
