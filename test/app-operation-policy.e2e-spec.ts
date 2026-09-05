/**
 * 운영 정책 — 화면 `W-05-01`.
 *
 * ⭐ 이 스위트의 무게는 CRUD 가 아니라 **범위 해석**에 있다. 계약이 「범위 해석을 서버가
 * 한다 — 화면이 우선순위를 다시 구현하지 않는다」로 못 박은 자리다.
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
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-policy-probe';
const NOPERM_ID = 'e2e-policy-noperm';
const PASSWORD = '정책-검사-비밀번호';
const PREFIX = 'POLICY';
const ROLE = 'E2E_POLICY';
const PERMISSIONS = ['W-05-01'];

const FROM = '2026-01-01';
const ON = '2026-06-01';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
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

describe('운영 정책 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let itemId: number;
  let processId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUsers();

    plantId = Number((await prisma.plant.findFirstOrThrow()).plant_id);
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '정책검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
      },
    });
    itemId = Number(item.item_id);
    const process = await prisma.process.create({
      data: {
        process_code: `${PREFIX}-PR`,
        process_name: '정책검사공정',
        process_type_code: 'MACHINING',
      },
    });
    processId = Number(process.process_id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록·상세가 계약 스키마를 만족한다', async () => {
    const { id } = await create({ policyCode: 'FIFO_ENFORCEMENT_LEVEL', valueText: 'WARN' });

    const list = await request(app.getHttpServer())
      .get('/api/app/operation-policies?policyCode=FIFO_ENFORCEMENT_LEVEL')
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /app/operation-policies');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/app/operation-policies/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /app/operation-policies/{operationPolicyId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detail.headers.etag).toMatch(/^\d+$/);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/app/operation-policies')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ policyCode: 'FIFO_ENFORCEMENT_LEVEL', valueText: 'WARN', effectiveFrom: FROM })
      .expect(403);
  });

  it('⛔ 정책 코드가 목록 밖이면 400 이다', async () => {
    const rejected = await post({ policyCode: '없는정책', valueText: 'WARN' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'policyCode', code: 'INVALID' });
  });

  it('⛔ 코드가 요구하는 값 칸을 안 채우면 400 이다', async () => {
    // 환산 여부는 valueBoolean 으로 정한다 — 글자로 주면 두 칸이 다른 말을 하게 된다.
    const rejected = await post({
      policyCode: 'SHOT_CONVERSION_ENABLED',
      valueText: '참',
    }).expect(400);
    const fields = rejected.body.errors.map((e: { field: string }) => e.field);
    expect(fields).toContain('valueBoolean');
    expect(fields).toContain('valueText');
  });

  it('⛔ 환산 비율은 0 보다 커야 한다', async () => {
    const rejected = await post({
      policyCode: 'SHOT_CONVERSION_RATIO',
      valueNumeric: 0,
    }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'valueNumeric', code: 'RANGE' });
  });

  it('⛔ 통제 수준은 세 값 중 하나다', async () => {
    const rejected = await post({
      policyCode: 'PRECHECK_CONTROL_LEVEL',
      valueText: '아무거나',
    }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'valueText', code: 'INVALID' });
  });

  it('⭐ 좁은 범위가 이긴다 — 품목 정책이 공장 정책을 누른다', async () => {
    await create({ policyCode: 'MINOR_STOP_THRESHOLD_MINUTES', valueNumeric: 5, plantId });
    await create({ policyCode: 'MINOR_STOP_THRESHOLD_MINUTES', valueNumeric: 3, itemId });

    const wide = await effective(`policyCode=MINOR_STOP_THRESHOLD_MINUTES&plantId=${plantId}`);
    expect(wide).toMatchObject({ resolved: true, valueNumeric: 5, matchedScopeCode: 'PLANT' });

    const narrow = await effective(
      `policyCode=MINOR_STOP_THRESHOLD_MINUTES&plantId=${plantId}&itemId=${itemId}`,
    );
    expect(narrow).toMatchObject({ resolved: true, valueNumeric: 3, matchedScopeCode: 'ITEM' });
  });

  it('⭐ 전사 정책은 축을 안 줘도 맞는다 — matchedScopeCode 가 ALL 이다', async () => {
    await create({ policyCode: 'SHOT_CONVERSION_ENABLED', valueBoolean: true });

    const all = await effective('policyCode=SHOT_CONVERSION_ENABLED');
    expect(all).toMatchObject({ resolved: true, valueBoolean: true, matchedScopeCode: 'ALL' });
  });

  it('⭐ 공정 정책은 공정을 줄 때만 맞는다 — 축을 안 주면 그 정책은 후보가 아니다', async () => {
    await create({ policyCode: 'SHOT_CONVERSION_RATIO', valueNumeric: 2.5, processId });

    const without = await effective('policyCode=SHOT_CONVERSION_RATIO');
    expect(without.resolved).toBe(false);

    const with_ = await effective(`policyCode=SHOT_CONVERSION_RATIO&processId=${processId}`);
    expect(with_).toMatchObject({ resolved: true, valueNumeric: 2.5, matchedScopeCode: 'PROCESS' });
  });

  it('⭐ 맞는 정책이 없으면 resolved 가 거짓이고 값이 비어 있다', async () => {
    const none = await effective(`policyCode=PRECHECK_CONTROL_LEVEL&plantId=${plantId}`);
    expect(none).toEqual({
      policyCode: 'PRECHECK_CONTROL_LEVEL',
      resolved: false,
      operationPolicyId: null,
      valueText: null,
      valueNumeric: null,
      valueBoolean: null,
    });
    // ⛔ 칸째 뺀다 — 계약 스키마의 enum 이 null 을 받지 않는다(되돌림 §Y-1).
    expect(none.matchedScopeCode).toBeUndefined();
  });

  it('⭐ 유효기간 밖 정책은 안 고른다 — on 날짜로 가른다', async () => {
    await create({
      policyCode: 'PRECHECK_CONTROL_LEVEL',
      valueText: 'BLOCK',
      itemId,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-03-31',
    });

    const inside = await effective(
      `policyCode=PRECHECK_CONTROL_LEVEL&itemId=${itemId}&on=2026-02-01`,
    );
    expect(inside).toMatchObject({ resolved: true, valueText: 'BLOCK' });

    const after = await effective(`policyCode=PRECHECK_CONTROL_LEVEL&itemId=${itemId}&on=2026-05-01`);
    expect(after.resolved).toBe(false);
  });

  it('⭐ 겹치면 결정적으로 고른다 — 두 번 물어도 같은 답이다', async () => {
    // 같은 코드·같은 범위·겹치는 기간. 물리가 막지 않으므로 서버가 결정적으로 골라야 한다.
    await create({ policyCode: 'FIFO_ENFORCEMENT_LEVEL', valueText: 'WARN', itemId, effectiveFrom: '2026-01-01' });
    await create({ policyCode: 'FIFO_ENFORCEMENT_LEVEL', valueText: 'BLOCK', itemId, effectiveFrom: '2026-02-01' });

    const first = await effective(`policyCode=FIFO_ENFORCEMENT_LEVEL&itemId=${itemId}&on=${ON}`);
    const second = await effective(`policyCode=FIFO_ENFORCEMENT_LEVEL&itemId=${itemId}&on=${ON}`);
    // 늦게 시작한 것이 이긴다.
    expect(first).toMatchObject({ resolved: true, valueText: 'BLOCK' });
    expect(second).toEqual(first);
  });

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await create({ policyCode: 'FIFO_ENFORCEMENT_LEVEL', valueText: 'OFF', plantId });

    const updated = await request(app.getHttpServer())
      .put(`/api/app/operation-policies/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ valueText: 'BLOCK', effectiveFrom: FROM })
      .expect(200);
    expect(updated.body.valueText).toBe('BLOCK');
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);

    const stale = await request(app.getHttpServer())
      .put(`/api/app/operation-policies/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ valueText: 'WARN', effectiveFrom: FROM })
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⛔ 없는 정책은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/app/operation-policies/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function post(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/api/app/operation-policies')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ effectiveFrom: FROM, ...body });
  }

  async function create(body: Record<string, unknown>): Promise<{ id: number; etag: string }> {
    const created = await post(body).expect(201);
    const validate = validator('POST /app/operation-policies', 201);
    expect(validate(created.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/app/operation-policies/${created.body.operationPolicyId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { id: created.body.operationPolicyId, etag: detail.headers.etag };
  }

  async function effective(query: string): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer())
      .get(`/api/app/operation-policies/effective?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /app/operation-policies/effective');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '정책검사', status_code: 'EMPLOYED' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '정책검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();
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
    const items = await prisma.item.findMany({
      where: { item_code: { startsWith: PREFIX } },
      select: { item_id: true },
    });
    const processes = await prisma.process.findMany({
      where: { process_code: { startsWith: PREFIX } },
      select: { process_id: true },
    });
    // 정책은 코드로 못 가려 범위(품목·공정)와 시드에 없는 코드로 지운다.
    await prisma.operation_policy.deleteMany({
      where: {
        OR: [
          { item_id: { in: items.map((i) => i.item_id) } },
          { process_id: { in: processes.map((p) => p.process_id) } },
          { policy_code: { in: ['SHOT_CONVERSION_ENABLED', 'SHOT_CONVERSION_RATIO', 'MINOR_STOP_THRESHOLD_MINUTES', 'PRECHECK_CONTROL_LEVEL', 'FIFO_ENFORCEMENT_LEVEL'] } },
        ],
      },
    });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
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
