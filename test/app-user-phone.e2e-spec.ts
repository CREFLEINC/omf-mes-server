/**
 * 사용자 휴대폰 번호(omf-all-around#160 · 장부 P-89).
 *
 * ⛔ 노출 범위가 이 검사의 뼈대다. `GET /app/users` 는 결재선·결재함 권한으로도 열리므로
 * 번호는 `W-CO-02` 가 있는 요청자에게만 보인다(FR-019).
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

const ADMIN_ID = 'e2e-userphone-admin';
const ROUTE_ID = 'e2e-userphone-route';
const INBOX_ID = 'e2e-userphone-inbox';
const PASSWORD = '전화번호-검사-비밀번호';
const PREFIX = 'e2e-userphone-made';
const ROLE = 'E2E_USERPHONE';

function validator(operation: string, status: number): ValidateFunction {
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

describe('사용자 휴대폰 번호 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUser(ADMIN_ID, 'W-CO-02');
    await makeUser(ROUTE_ID, 'W-06-15');
    await makeUser(INBOX_ID, 'W-CO-09');
    admin = await login(ADMIN_ID);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US5-1 등록·수정으로 번호를 저장하고 응답에 표준형이 온다', async () => {
    const created = await create(`${PREFIX}-1`, '0912 345-678');
    expect(created.body.phoneNumber).toBe('84912345678');
    const validate = validator('POST /app/users', 201);
    expect(validate(created.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const saved = await update(created.body.appUserId, { phoneNumber: '+84387654321' });
    expect(saved.body.phoneNumber).toBe('84387654321');
    const row = await prisma.app_user.findUniqueOrThrow({
      where: { app_user_id: created.body.appUserId },
    });
    expect(row.phone_number).toBe('84387654321');
  });

  it('US5-1 수정에서 생략하면 유지하고 null 이면 지운다', async () => {
    const created = await create(`${PREFIX}-2`, '0987654321');

    let saved = await update(created.body.appUserId, {});
    expect(saved.body.phoneNumber).toBe('84987654321');

    saved = await update(created.body.appUserId, { phoneNumber: null });
    expect(saved.body.phoneNumber).toBeNull();
  });

  it('US5-2 형식이 틀리면 400 phoneNumber 다 — 등록·수정 모두', async () => {
    for (const phoneNumber of ['0212345678', '091234567', 'abc']) {
      const rejected = await request(app.getHttpServer())
        .post('/api/app/users')
        .set('Cookie', admin)
        .set('Idempotency-Key', key())
        .send({ loginId: `${PREFIX}-bad`, userName: '형식오류', phoneNumber })
        .expect(400);
      expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual(['phoneNumber']);
    }

    const created = await create(`${PREFIX}-3`, null);
    const current = await detail(created.body.appUserId);
    const rejected = await request(app.getHttpServer())
      .put(`/api/app/users/${created.body.appUserId}`)
      .set('Cookie', admin)
      .set('Idempotency-Key', key())
      .set('If-Match', current.headers.etag)
      .send({ userName: '형식오류', statusCode: 'EMPLOYED', phoneNumber: '0912' })
      .expect(400);
    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual(['phoneNumber']);
  });

  it('US5-1 W-CO-02 권한 사용자는 목록에서 phoneNumber 를 본다', async () => {
    await create(`${PREFIX}-4`, '0911111111');
    const list = await listAs(admin, `${PREFIX}-4`);
    expect(list.body.items[0].phoneNumber).toBe('84911111111');
    const validate = validator('GET /app/users', 200);
    expect(validate(list.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it.each([
    [ROUTE_ID, 'W-06-15'],
    [INBOX_ID, 'W-CO-09'],
  ])('US5-1 %s(%s 권한만)가 같은 목록을 부르면 phoneNumber 칸이 없다', async (loginId, permission) => {
    const target = `${PREFIX}-${permission}`;
    await create(target, '0922222222');
    const list = await listAs(await login(loginId), target);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].loginId).toBe(target);
    expect(list.body.items[0]).not.toHaveProperty('phoneNumber');
  });

  it('US5-1 W-CO-02 가 없으면 본인 상세에서도 phoneNumber 칸이 없다', async () => {
    const own = await prisma.app_user.findUniqueOrThrow({ where: { login_id: ROUTE_ID } });
    await prisma.app_user.update({ where: { app_user_id: own.app_user_id }, data: { phone_number: '84933333333' } });
    const response = await request(app.getHttpServer())
      .get(`/api/app/users/${own.app_user_id}`)
      .set('Cookie', await login(ROUTE_ID))
      .expect(200);
    expect(response.body.appUser).not.toHaveProperty('phoneNumber');
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function create(loginId: string, phoneNumber: string | null): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', admin)
      .set('Idempotency-Key', key())
      .send({ loginId, userName: '전화번호검사', phoneNumber })
      .expect(201);
  }

  function detail(appUserId: number): Promise<request.Response> {
    return request(app.getHttpServer()).get(`/api/app/users/${appUserId}`).set('Cookie', admin).expect(200);
  }

  async function update(appUserId: number, extra: Record<string, unknown>): Promise<request.Response> {
    const current = await detail(appUserId);
    return request(app.getHttpServer())
      .put(`/api/app/users/${appUserId}`)
      .set('Cookie', admin)
      .set('Idempotency-Key', key())
      .set('If-Match', current.headers.etag)
      .send({ userName: current.body.appUser.userName, statusCode: 'EMPLOYED', ...extra })
      .expect(200);
  }

  function listAs(cookie: string[], loginId: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/app/users?q=${loginId}`)
      .set('Cookie', cookie)
      .expect(200);
  }

  async function makeUser(loginId: string, permission: string): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: loginId, status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({
      data: { role_code: `${ROLE}_${permission.replace(/-/g, '_')}`, role_name: `전화번호검사 ${permission}` },
    });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const users = await prisma.app_user.findMany({
      where: {
        OR: [{ login_id: { in: [ADMIN_ID, ROUTE_ID, INBOX_ID] } }, { login_id: { startsWith: PREFIX } }],
      },
      select: { app_user_id: true },
    });
    const ids = users.map((row) => row.app_user_id);
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: ids } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: ids } } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: { in: ids } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: ids } } });
    const roles = await prisma.role.findMany({ where: { role_code: { startsWith: ROLE } }, select: { role_id: true } });
    const roleIds = roles.map((row) => row.role_id);
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
  }
});
