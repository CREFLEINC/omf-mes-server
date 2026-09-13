/**
 * 단말 마스터.
 *
 * ⭐ 이 자원은 «토큰»을 낸다. 세션 쿠키와 같은 비밀키로 서명되므로, 종류를 구분하지
 * 않으면 단말 토큰이 같은 번호의 사용자 세션으로 풀린다 — 그 성질을 검사가 직접 친다.
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

const LOGIN_ID = 'e2e-mdmterm-probe';
const NOPERM_ID = 'e2e-mdmterm-noperm';
const PASSWORD = '단말-마스터-검사-비밀번호';
const PREFIX = 'MDMTERM';
const ROLE = 'E2E_MDMTERM';

function validator(operation: string, status = '200'): ValidateFunction {
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

describe('단말 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let equipmentId: number;
  let processIds: number[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '단말검사', status_code: 'EMPLOYED' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '단말검사용' } });
    for (const permission of ['W-CO-06', 'M-CO-01']) {
      await prisma.role_permission.create({
        data: { role_id: role.role_id, permission_code: permission },
      });
    }
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    plantId = Number((await prisma.plant.findFirstOrThrow()).plant_id);
    const equipment = await prisma.equipment.create({
      data: {
        plant_id: plantId,
        equipment_code: `${PREFIX}-EQ`,
        equipment_name: '프레스 1호기',
        equipment_type_code: 'PRESS',
        status_code: 'IN_SERVICE',
      },
    });
    equipmentId = Number(equipment.equipment_id);
    // 공정은 시드에 없다 — 검사 대상을 직접 세운다.
    processIds = [];
    for (const n of [1, 2]) {
      const created = await prisma.process.create({
        data: {
          process_code: `${PREFIX}-P${n}`,
          process_name: `공정${n}`,
          process_type_code: 'ASSEMBLY',
        },
      });
      processIds.push(Number(created.process_id));
    }
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/terminals?plantId=${plantId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/terminals');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/terminals')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-X`))
      .expect(403);
  });

  it('⛔ 없는 단말 유형·상태 코드는 400 INVALID 다 — 두 그룹 다 시스템 소유다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/terminals')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-BAD`, { terminalTypeCode: 'ADMIN_WEB', statusCode: 'NORMAL' }))
      .expect(400);

    // ADMIN_WEB·NORMAL 은 옛 시드 값이다 — 사전에서 빠진 뒤로는 is_active=false 라 같이 걸린다.
    expect(rejected.body.errors).toEqual([
      { scope: 'field', field: 'terminalTypeCode', code: 'INVALID', message: expect.any(String) },
      { scope: 'field', field: 'statusCode', code: 'INVALID', message: expect.any(String) },
    ]);
  });

  it('⭐ 설비를 달면 코드·명이 함께 온다 — 헤더가 왕복 없이 그린다', async () => {
    const { id, etag } = await create(`${PREFIX}-A`, { equipmentId });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/terminals/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/terminals/{terminalId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    // 「헤더가 «PRS-01 · 프레스 1호기»로 그리므로 함께 내린다」(계약).
    expect(detail.body.equipmentCode).toBe(`${PREFIX}-EQ`);
    expect(detail.body.equipmentName).toBe('프레스 1호기');
    expect(detail.body.tokenVersion).toBe(1);
    expect(detail.body.tokenIssuedAt).toBeUndefined();
  });

  it('⭐ 단말 코드는 수정 본문에 자리가 없다 — 키다', async () => {
    const { id, etag } = await create(`${PREFIX}-KEY`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/terminals/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      // 계약이 안 받는 칸을 억지로 실어 보낸다 — 구조로 막히는지 본다.
      .send({ ...updateBody(), terminalCode: `${PREFIX}-CHANGED` })
      .expect(200);

    expect(updated.body.terminalCode).toBe(`${PREFIX}-KEY`);
  });

  // ── 토큰 (F-4) ──────────────────────────────────────────────────────────

  it('⭐ 토큰을 발급하면 세대가 오르고 발급 시각이 남는다', async () => {
    const { id } = await create(`${PREFIX}-TK`);

    const issued = await request(app.getHttpServer())
      .post(`/api/mdm/terminals/${id}:issue-token`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(201);

    const validate = validator('POST /mdm/terminals/{terminalId}:issue-token', '201');
    expect(validate(issued.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(issued.body.token.length).toBeGreaterThan(20);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/terminals/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.tokenVersion).toBe(2);
    expect(detail.body.tokenIssuedAt).toEqual(expect.any(String));
  });

  it('⭐ 재발급하면 세대가 또 오른다 — 이전 기기 전부가 끊긴다 (F-4)', async () => {
    const { id } = await create(`${PREFIX}-TK2`);

    const first = await issueToken(id);
    const second = await issueToken(id);

    const claims = (token: string): { tv: number; sub: number; typ: string } =>
      JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

    expect(claims(second.body.token).tv).toBe(claims(first.body.token).tv + 1);
    expect(claims(second.body.token).sub).toBe(id);
  });

  it('⛔ 단말 토큰을 세션 쿠키로 들이밀 수 없다 — 같은 비밀키로 서명된다', async () => {
    // sub 가 «단말 번호»라, 종류를 안 보면 같은 번호의 «사용자»로 풀린다.
    const { id } = await create(`${PREFIX}-CONFUSE`);
    const issued = await issueToken(id);

    const response = await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', [`omf_session=${issued.body.token}`])
      .expect(401);
    expect(response.body.errors[0].scope).toBe('screen');
  });

  it('⭐ 같은 멱등키로 다시 발급하면 세대가 오르지 않는다', async () => {
    const { id } = await create(`${PREFIX}-IDEM`);
    const idempotencyKey = key();

    const first = await request(app.getHttpServer())
      .post(`/api/mdm/terminals/${id}:issue-token`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/api/mdm/terminals/${id}:issue-token`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .expect(201);

    expect(second.body.token).toBe(first.body.token);
    const row = await prisma.terminal.findUniqueOrThrow({ where: { terminal_id: id } });
    expect(row.token_version).toBe(2);
  });

  it('FR-007 MOBILE 등록 확인은 현재 토큰 세대만 기록하고 재발급 뒤 미등록으로 돌아간다', async () => {
    const { id } = await create(`${PREFIX}-REG`, { terminalTypeCode: 'MOBILE' });
    const path = `/api/mdm/terminals/${id}:confirm-registration`;
    const detail = async () => request(app.getHttpServer())
      .get(`/api/mdm/terminals/${id}`).set('Cookie', cookie).expect(200);

    expect((await detail()).body).toMatchObject({
      registrationStatusCode: 'UNREGISTERED', registrationConfirmedAt: null,
    });
    const firstToken = (await issueToken(id)).body.token;
    expect((await detail()).body.registrationStatusCode).toBe('UNREGISTERED');

    // A valid admin cookie is not a device registration confirmation.
    await request(app.getHttpServer()).post(path).set('Cookie', cookie)
      .set('Idempotency-Key', key()).send({}).expect(401);
    await request(app.getHttpServer()).post(path)
      .set('Authorization', `Bearer ${firstToken}`).send({}).expect(400);
    await request(app.getHttpServer()).post(path)
      .set('Authorization', `Bearer ${firstToken}`).set('Idempotency-Key', key())
      .send({ registered: true }).expect(400);
    await request(app.getHttpServer()).post(`/api/mdm/terminals/${id + 1}:confirm-registration`)
      .set('Authorization', `Bearer ${firstToken}`).set('Idempotency-Key', key())
      .send({}).expect(401);
    expect((await detail()).body.registrationStatusCode).toBe('UNREGISTERED');

    const confirmed = await request(app.getHttpServer()).post(path)
      .set('Authorization', `Bearer ${firstToken}`).set('Idempotency-Key', key())
      .send({}).expect(200);
    expect(confirmed.body).toMatchObject({
      terminalId: id, tokenVersion: 2, registrationStatusCode: 'REGISTERED',
      registrationConfirmedAt: expect.any(String),
    });
    const registered = await detail();
    expect(registered.body.registrationConfirmedAt).toBe(confirmed.body.registrationConfirmedAt);
    expect(registered.body.registrationStatusCode).toBe('REGISTERED');
    const list = await request(app.getHttpServer())
      .get(`/api/mdm/terminals?q=${PREFIX}-REG`).set('Cookie', cookie).expect(200);
    expect(list.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ terminalId: id, registrationStatusCode: 'REGISTERED' }),
    ]));

    const repeated = await request(app.getHttpServer()).post(path)
      .set('Authorization', `Bearer ${firstToken}`).set('Idempotency-Key', key())
      .send({}).expect(200);
    expect(repeated.body.registrationConfirmedAt).toBe(confirmed.body.registrationConfirmedAt);
    expect((await detail()).headers.etag).toBe(registered.headers.etag);

    const secondToken = (await issueToken(id)).body.token;
    expect((await detail()).body).toMatchObject({
      tokenVersion: 3, registrationStatusCode: 'UNREGISTERED', registrationConfirmedAt: null,
    });
    await request(app.getHttpServer()).post(path)
      .set('Authorization', `Bearer ${firstToken}`).set('Idempotency-Key', key())
      .send({}).expect(401);
    const newConfirmation = await request(app.getHttpServer()).post(path)
      .set('Authorization', `Bearer ${secondToken}`).set('Idempotency-Key', key())
      .send({}).expect(200);
    expect(newConfirmation.body.registrationStatusCode).toBe('REGISTERED');
  });

  it('FR-007 POP token cannot confirm a MOBILE registration', async () => {
    const { id } = await create(`${PREFIX}-REG-POP`);
    const token = (await issueToken(id)).body.token;
    await request(app.getHttpServer())
      .post(`/api/mdm/terminals/${id}:confirm-registration`)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key())
      .send({}).expect(401);
    const row = await prisma.terminal.findUniqueOrThrow({ where: { terminal_id: id } });
    expect(row.registration_confirmed_at).toBeNull();
  });

  // ── 공정 구성 ───────────────────────────────────────────────────────────

  it('⭐ 공정 구성을 통째로 바꾼다 — 안 보낸 권한은 닫힌다', async () => {
    const { id } = await create(`${PREFIX}-PROC`);

    const saved = await request(app.getHttpServer())
      .put(`/api/mdm/terminals/${id}/processes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await processEtag(id))
      .send({ items: [{ processId: processIds[0], canStartWork: true }] })
      .expect(200);

    const validate = validator('GET /mdm/terminals/{terminalId}/processes');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(saved.body.items[0].canStartWork).toBe(true);
    // 「기본은 닫힘이다」(계약) — 안 보낸 권한이 열려 있으면 오조작이 열린다.
    expect(saved.body.items[0].canCompleteWork).toBe(false);
    expect(saved.body.items[0].canPrintLabel).toBe(false);
  });

  it('⭐ 빠진 공정은 지워진다', async () => {
    const { id } = await create(`${PREFIX}-PROC2`);
    if (processIds.length < 2) return;

    await putProcesses(id, [{ processId: processIds[0] }, { processId: processIds[1] }]);
    const shrunk = await putProcesses(id, [{ processId: processIds[1] }]);

    expect(shrunk.body.items).toHaveLength(1);
    expect(shrunk.body.items[0].processId).toBe(processIds[1]);
  });

  it('⛔ 같은 공정을 두 줄 보내면 몇 번째인지 짚는다', async () => {
    const { id } = await create(`${PREFIX}-PROC3`);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/terminals/${id}/processes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await processEtag(id))
      .send({ items: [{ processId: processIds[0] }, { processId: processIds[0] }] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'items[1].processId',
      code: 'UNIQUE_VIOLATION',
    });
  });

  it('⭐ 창고 전용 단말은 공정 0건이 정상이다 — F-1 적용 범위', async () => {
    const { id } = await create(`${PREFIX}-WH`);

    const empty = await putProcesses(id, []);
    expect(empty.body.items).toEqual([]);
  });

  it('⛔ 중지는 지우지 않는다 — 기록이 참조로 남아 있다', async () => {
    const { id, etag } = await create(`${PREFIX}-D`);

    const off = await request(app.getHttpServer())
      .post(`/api/mdm/terminals/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    expect(off.body.isActive).toBe(false);

    // 행은 남아 있다 — 상세로 여전히 읽힌다.
    await request(app.getHttpServer())
      .get(`/api/mdm/terminals/${id}`)
      .set('Cookie', cookie)
      .expect(200);
  });

  it('⛔ 낡은 If-Match 는 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await create(`${PREFIX}-V`);

    await request(app.getHttpServer())
      .put(`/api/mdm/terminals/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody())
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/terminals/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody())
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⛔ 없는 단말은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/terminals/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function updateBody(extra: Record<string, unknown> = {}): object {
    return { plantId, terminalTypeCode: 'POP', statusCode: 'RUNNING', ...extra };
  }

  function body(terminalCode: string, extra: Record<string, unknown> = {}): object {
    return { terminalCode, ...updateBody(extra) };
  }

  async function issueToken(id: number): Promise<{ body: { token: string } }> {
    const response = await request(app.getHttpServer())
      .post(`/api/mdm/terminals/${id}:issue-token`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(201);
    return { body: response.body };
  }

  async function processEtag(id: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/terminals/${id}/processes`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function putProcesses(
    id: number,
    items: unknown[],
  ): Promise<{ body: { items: { processId: number }[] } }> {
    const response = await request(app.getHttpServer())
      .put(`/api/mdm/terminals/${id}/processes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await processEtag(id))
      .send({ items })
      .expect(200);
    return { body: response.body };
  }

  async function create(
    terminalCode: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/terminals')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(terminalCode, extra))
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/terminals/${created.body.terminalId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { id: created.body.terminalId, etag: detail.headers.etag };
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
    const terminals = await prisma.terminal.findMany({
      where: { terminal_code: { startsWith: PREFIX } },
      select: { terminal_id: true },
    });
    await prisma.terminal_process.deleteMany({
      where: { terminal_id: { in: terminals.map((t) => t.terminal_id) } },
    });
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
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
