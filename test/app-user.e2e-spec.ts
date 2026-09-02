/**
 * 사용자 마스터.
 *
 * ⭐ `loginId` 는 «언제나» 잠긴다 — 참조를 셀 수 없어 B-4 의 규칙을 적용할 수 없다.
 * ⭐ 계정을 쓸 수 있는가(`isActive`)와 인사 상태(`statusCode`)는 다른 축이다.
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

const LOGIN_ID = 'e2e-appuser-probe';
const NOPERM_ID = 'e2e-appuser-noperm';
const PASSWORD = '사용자-검사-비밀번호';
const PREFIX = 'e2e-appuser-made';
const ROLE = 'E2E_APPUSER';
const DEPARTMENT_CODE = 'E2E_APPUSER_DEPT';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const status = method === 'POST' && !path.includes(':') ? '201' : '200';
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('사용자 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let departmentId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '사용자검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '사용자검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-CO-02' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();

    // 시드에 부서가 없다 — 검사용으로 하나 세운다.
    const department = await prisma.department.create({
      data: { department_code: DEPARTMENT_CODE, department_name: '사용자검사부서' },
    });
    departmentId = Number(department.department_id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록·상세가 계약 스키마를 만족하고 상세가 ETag 를 준다', async () => {
    const created = await create(`${PREFIX}-a`);

    const list = await request(app.getHttpServer())
      .get(`/api/app/users?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /app/users');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/app/users/${created.appUserId}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /app/users/{appUserId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.headers.etag).toBe('1');
  });

  it('⭐ loginId 는 언제나 잠긴다 — 참조를 «셀 수 없어» 규칙을 적용할 수 없다', async () => {
    const created = await create(`${PREFIX}-b`);

    const detail = await request(app.getHttpServer())
      .get(`/api/app/users/${created.appUserId}`)
      .set('Cookie', cookie)
      .expect(200);

    // 아무도 안 쓰는 새 계정인데도 잠겨 있다 — REFERENCED 가 아니라 NOT_COUNTABLE 이다.
    expect(detail.body.editability).toEqual({
      codeEditable: false,
      reason: 'NOT_COUNTABLE',
      referenceCount: null,
    });
  });

  it('⭐ 수정 본문에 loginId 가 없다 — 보내도 안 바뀐다', async () => {
    const created = await create(`${PREFIX}-c`);

    const saved = await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ userName: '고친 이름', statusCode: 'ON_LEAVE', departmentId })
      .expect(200);
    expect(saved.body.userName).toBe('고친 이름');
    expect(saved.body.loginId).toBe(`${PREFIX}-c`);
    expect(saved.headers.etag).toBe('2');

    // ⛔ 계약 `AppUserUpdate` 에 `additionalProperties: false` 가 없어 검증기는 통과시킨다.
    // 그러니 «서버가» 읽지 않아야 한다 — 읽으면 잠갔다고 적어 놓고 바뀌는 칸이 된다.
    const ignored = await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '2')
      .send({ loginId: '바꿔보기', userName: '이름', statusCode: 'ACTIVE' })
      .expect(200);
    expect(ignored.body.loginId).toBe(`${PREFIX}-c`);
  });

  it('⭐ 인사 상태와 계정 사용 여부는 다른 축이다 — 휴직인데 계정은 살아 있다', async () => {
    const created = await create(`${PREFIX}-d`);
    await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ userName: '휴직자', statusCode: 'ON_LEAVE' })
      .expect(200);

    // `includeInactive` 를 안 줘도 나온다 — 그 필터는 is_active 를 본다.
    const alive = await request(app.getHttpServer())
      .get(`/api/app/users?q=${PREFIX}-d`)
      .set('Cookie', cookie)
      .expect(200);
    expect(alive.body.items).toHaveLength(1);
    expect(alive.body.items[0]).toMatchObject({ statusCode: 'ON_LEAVE', isActive: true });

    // statusCode 필터는 인사 상태를 가른다.
    const onLeave = await request(app.getHttpServer())
      .get(`/api/app/users?q=${PREFIX}&statusCode=ON_LEAVE`)
      .set('Cookie', cookie)
      .expect(200);
    expect(onLeave.body.items.map((u: { loginId: string }) => u.loginId)).toContain(`${PREFIX}-d`);
  });

  it('사용 중지하면 목록 기본값에서 빠지고 다시 사용하면 돌아온다', async () => {
    const created = await create(`${PREFIX}-e`);

    await request(app.getHttpServer())
      .post(`/api/app/users/${created.appUserId}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(200);

    const defaults = await request(app.getHttpServer())
      .get(`/api/app/users?q=${PREFIX}-e`)
      .set('Cookie', cookie)
      .expect(200);
    expect(defaults.body.items).toHaveLength(0);

    const included = await request(app.getHttpServer())
      .get(`/api/app/users?q=${PREFIX}-e&includeInactive=true`)
      .set('Cookie', cookie)
      .expect(200);
    expect(included.body.items[0].isActive).toBe(false);

    await request(app.getHttpServer())
      .post(`/api/app/users/${created.appUserId}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '2')
      .expect(200);
  });

  it('⭐ 마지막 관리자는 «자기 자신»도 중지하지 못한다 — 400 LAST_ADMIN', async () => {
    const me = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    const others = await prisma.app_user.findMany({
      where: {
        is_active: true,
        login_id: { not: LOGIN_ID },
        user_role: {
          some: {
            role: { is_active: true, role_permission: { some: { permission_code: 'W-CO-02' } } },
          },
        },
      },
      select: { app_user_id: true },
    });
    const ids = others.map((row) => row.app_user_id);
    await prisma.app_user.updateMany({
      where: { app_user_id: { in: ids } },
      data: { is_active: false },
    });

    try {
      const rejected = await request(app.getHttpServer())
        .post(`/api/app/users/${Number(me.app_user_id)}:deactivate`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .set('If-Match', String(me.version_no))
        .expect(400);
      expect(rejected.body.errors[0].code).toBe('LAST_ADMIN');

      // ⛔ 막혔으면 되돌아가 있어야 한다 — 안 그러면 자기 계정을 잠근 채 남는다.
      const after = await prisma.app_user.findUniqueOrThrow({
        where: { app_user_id: me.app_user_id },
      });
      expect(after.is_active).toBe(true);
      expect(after.version_no).toBe(me.version_no);
    } finally {
      await prisma.app_user.updateMany({
        where: { app_user_id: { in: ids } },
        data: { is_active: true },
      });
    }
  });

  it('⛔ 로그인ID 중복은 400 이고 유일키 범위를 담는다', async () => {
    await create(`${PREFIX}-f`);

    const rejected = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId: `${PREFIX}-f`, userName: '같은 아이디' })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'loginId',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['loginId'],
    });
  });

  it('⛔ 공백만·없는 상태코드·없는 부서는 400 이다', async () => {
    const blank = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId: '  ', userName: '\t' })
      .expect(400);
    expect(blank.body.errors.map((e: { field: string }) => e.field)).toEqual([
      'loginId',
      'userName',
    ]);

    const badStatus = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId: `${PREFIX}-g`, userName: '이름', statusCode: '없는상태' })
      .expect(400);
    expect(badStatus.body.errors[0]).toMatchObject({ field: 'statusCode', code: 'INVALID' });

    const badDepartment = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId: `${PREFIX}-h`, userName: '이름', departmentId: 999999999 })
      .expect(400);
    expect(badDepartment.body.errors[0]).toMatchObject({ field: 'departmentId', code: 'INVALID' });
  });

  it('⛔ 낡은 If-Match 는 409 STALE_VERSION 이다', async () => {
    const created = await create(`${PREFIX}-i`);
    await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ userName: '한 번', statusCode: 'ACTIVE' })
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ userName: '두 번', statusCode: 'ACTIVE' })
      .expect(409);
    expect(stale.body.errors[0].code).toBe('STALE_VERSION');
  });

  it('⛔ 권한이 없으면 목록·등록·수정이 403 이고, 없는 사용자는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/app/users')
      .set('Cookie', noPermCookie)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ loginId: `${PREFIX}-x`, userName: '막힘' })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/app/users/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/app/users/999999999:deactivate')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function create(loginId: string): Promise<{ appUserId: number }> {
    const response = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId, userName: loginId })
      .expect(201);
    const validate = validator('POST /app/users');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // 안 보낸 상태코드는 물리 모델 DEFAULT 가 채운다(계약).
    expect(response.body.statusCode).toBe('ACTIVE');
    return { appUserId: response.body.appUserId };
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
    const made = await prisma.app_user.findMany({
      where: { login_id: { in: [LOGIN_ID, NOPERM_ID] } },
      select: { app_user_id: true },
    });
    const generated = await prisma.app_user.findMany({
      where: { login_id: { startsWith: PREFIX } },
      select: { app_user_id: true },
    });
    const ids = [...made, ...generated].map((row) => row.app_user_id);
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: ids } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: ids } } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: { in: ids } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: ids } } });

    await prisma.department.deleteMany({ where: { department_code: DEPARTMENT_CODE } });
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
