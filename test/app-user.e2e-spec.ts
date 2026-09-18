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
  let noPermUserId: number;
  let departmentId: number;
  let businessUnitId: number;
  let plantId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '사용자검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    noPermUserId = Number(other.app_user_id);
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
    businessUnitId = Number(
      (await prisma.business_unit.findFirstOrThrow({ select: { business_unit_id: true } }))
        .business_unit_id,
    );
    plantId = Number(
      (await prisma.plant.findFirstOrThrow({ select: { plant_id: true } })).plant_id,
    );
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
      .send({ loginId: '바꿔보기', userName: '이름', statusCode: 'EMPLOYED' })
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
    const others = await deactivateOtherAdmins();

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
      await restoreAdmins(others);
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

  it('⭐ 비밀번호를 안 보내면 임시 비밀번호가 응답에 실리고 그 값으로 바로 로그인된다', async () => {
    const loginId = `${PREFIX}-pw-temp`;
    const created = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId, userName: '임시 비밀번호' })
      .expect(201);

    const temporaryPassword = created.body.temporaryPassword as string;
    expect(typeof temporaryPassword).toBe('string');

    const session = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', key())
      .send({ loginId, password: temporaryPassword })
      .expect(200);
    // 서버가 뽑은 값은 관리자가 읽어 주고 작업자가 받아 적는 값이라 반드시 바꾸게 한다.
    expect(session.body.mustChangePassword).toBe(true);
  });

  it('⭐ 비밀번호를 보내면 그 값으로 로그인되고 강제 변경이 걸리지 않는다', async () => {
    const loginId = `${PREFIX}-pw-set`;
    const chosen = '관리자가-정한-비밀번호';
    const created = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId, userName: '지정 비밀번호', password: chosen })
      .expect(201);
    // ⛔ 보낸 값을 되돌려주지 않는다 — 응답에 실릴 이유가 없다.
    expect(created.body.temporaryPassword).toBeUndefined();

    const session = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', key())
      .send({ loginId, password: chosen })
      .expect(200);
    expect(session.body.mustChangePassword).toBe(false);
  });

  it('⛔ 8자 미만 비밀번호는 400 RANGE 이고 계정도 남지 않는다', async () => {
    const loginId = `${PREFIX}-pw-short`;
    const rejected = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId, userName: '짧다', password: '1234567' })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'password', code: 'RANGE' });
    expect(await prisma.app_user.findUnique({ where: { login_id: loginId } })).toBeNull();
  });

  it('⛔ 문자열이 아닌 비밀번호는 400 이다 — null 은 「안 보냈다」로 읽는다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId: `${PREFIX}-pw-type`, userName: '숫자', password: 12345678 })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'password', code: 'INVALID' });

    // null 을 400 으로 막지 않는다 — 안 보낸 것과 같이 임시 비밀번호를 뽑는다.
    const created = await request(app.getHttpServer())
      .post('/api/app/users')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ loginId: `${PREFIX}-pw-null`, userName: '널', password: null })
      .expect(201);
    expect(typeof created.body.temporaryPassword).toBe('string');
  });

  it('⛔ 낡은 If-Match 는 409 STALE_VERSION 이다', async () => {
    const created = await create(`${PREFIX}-i`);
    await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ userName: '한 번', statusCode: 'EMPLOYED' })
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ userName: '두 번', statusCode: 'EMPLOYED' })
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
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

  it('⛔ 사용자 상세는 본인 또는 W-CO-02 만 읽고, 이전 ETag 로 304 를 재사용하지 않는다', async () => {
    const managed = await create(`${PREFIX}-detail-guard`);

    const admin = await request(app.getHttpServer())
      .get(`/api/app/users/${managed.appUserId}`)
      .set('Cookie', cookie)
      .set('If-None-Match', '1')
      .expect(200);
    expect(admin.body.appUser.appUserId).toBe(managed.appUserId);
    expect(admin.headers.etag).toBe('1');
    expect(admin.headers['cache-control']).toBe('private, no-store');

    const denied = await request(app.getHttpServer())
      .get(`/api/app/users/${managed.appUserId}`)
      .set('Cookie', noPermCookie)
      .set('If-None-Match', '1')
      .expect(403);
    expect(denied.body.errors[0].code).toBe('PERMISSION_DENIED');

    const self = await request(app.getHttpServer())
      .get(`/api/app/users/${noPermUserId}`)
      .set('Cookie', noPermCookie)
      .expect(200);
    expect(self.body.appUser.appUserId).toBe(noPermUserId);

    await request(app.getHttpServer())
      .get(`/api/app/users/${managed.appUserId}`)
      .expect(401);
    const current = await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', noPermCookie)
      .expect(200);
    expect(current.body.userId).toBe(noPermUserId);
  });

  // ── 역할 배정 ───────────────────────────────────────────────────────────

  it('⭐ 역할을 통째로 교체한다 — 목록에 없는 역할은 해제된다', async () => {
    const created = await create(`${PREFIX}-r1`);
    const [first, second] = await Promise.all([spareRole('R1'), spareRole('R2')]);

    const saved = await putRoles(created.appUserId, [first, second]);
    const validate = validator('PUT /app/users/{appUserId}/roles');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(saved.body.items.map((i: { roleId: number }) => i.roleId).sort()).toEqual(
      [first, second].sort(),
    );

    const shrunk = await putRoles(created.appUserId, [first]);
    expect(shrunk.body.items).toHaveLength(1);

    const cleared = await putRoles(created.appUserId, []);
    expect(cleared.body.items).toEqual([]);
  });

  it('⭐ 배정은 집합이라 중복을 접어 받는다 — 경합을 유일 위반으로 거절하지 않는다', async () => {
    const created = await create(`${PREFIX}-r2`);
    const role = await spareRole('R3');

    const saved = await putRoles(created.appUserId, [role, role]);
    expect(saved.body.items).toHaveLength(1);

    // 같은 목록을 다시 보내도 「이미 반영된 상태」로 조용히 끝난다(계약 §6).
    const again = await putRoles(created.appUserId, [role]);
    expect(again.body.items).toHaveLength(1);
  });

  it('⛔ 없는 역할은 400 이고 몇 번째인지 짚는다', async () => {
    const created = await create(`${PREFIX}-r3`);

    const rejected = await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}/roles`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ roleIds: [999999999] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'roleIds[0]', code: 'INVALID' });
  });

  it('⭐ 마지막 관리자에게서 관리자 역할을 뺄 수 없다 — 400 LAST_ADMIN', async () => {
    const me = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    const others = await deactivateOtherAdmins();

    try {
      const rejected = await request(app.getHttpServer())
        .put(`/api/app/users/${Number(me.app_user_id)}/roles`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .send({ roleIds: [] })
        .expect(400);
      expect(rejected.body.errors[0].code).toBe('LAST_ADMIN');

      // ⛔ 막혔으면 배정이 그대로 남아 있어야 한다 — 치환은 「지우고 다시 넣기」다.
      const after = await request(app.getHttpServer())
        .get(`/api/app/users/${Number(me.app_user_id)}/roles`)
        .set('Cookie', cookie)
        .expect(200);
      expect(after.body.items).toHaveLength(1);
    } finally {
      await restoreAdmins(others);
    }
  });

  // ── 데이터 접근범위 ─────────────────────────────────────────────────────

  it('⭐ 접근범위를 통째로 교체한다 — 빈 축은 (전체)로 남는다', async () => {
    const created = await create(`${PREFIX}-s1`);

    const saved = await putScopes(created.appUserId, [
      { businessUnitId },
      { businessUnitId, plantId },
    ]);
    const validate = validator('PUT /app/users/{appUserId}/data-scopes');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // 「사업부만」 줄은 공장 축이 비어 있다 — 화면이 그것을 (전체)로 그린다.
    expect(saved.body.items[0]).toMatchObject({ businessUnitId, plantId: null });
    expect(saved.body.items[1]).toMatchObject({ businessUnitId, plantId });

    const cleared = await putScopes(created.appUserId, []);
    expect(cleared.body.items).toEqual([]);
  });

  it('⛔ 두 축이 다 비면 400 PAIR 다 — 「어디까지 보는가」가 없다', async () => {
    const created = await create(`${PREFIX}-s2`);

    const rejected = await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}/data-scopes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ scopes: [{}] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'scopes[0]', code: 'PAIR' });
  });

  it('⛔ 같은 범위를 두 번 넣으면 400 이다 — 유일 인덱스가 빈 축을 접는다', async () => {
    const created = await create(`${PREFIX}-s3`);

    const rejected = await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}/data-scopes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      // 둘 다 「사업부만」이라 COALESCE 로 접히면 같은 줄이다.
      .send({ scopes: [{ businessUnitId }, { businessUnitId, plantId: null }] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'scopes[1]',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['businessUnitId', 'plantId'],
    });
  });

  it('⛔ 없는 사업부·공장은 400 이다', async () => {
    const created = await create(`${PREFIX}-s4`);

    const rejected = await request(app.getHttpServer())
      .put(`/api/app/users/${created.appUserId}/data-scopes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ scopes: [{ businessUnitId: 999999999 }] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'scopes[0].businessUnitId',
      code: 'INVALID',
    });
  });

  // ── 비밀번호 관리자 초기화 ──────────────────────────────────────────────

  it('⭐ 초기화한 임시 비밀번호로 «실제로» 로그인된다', async () => {
    const created = await create(`${PREFIX}-p1`);

    const reset = await request(app.getHttpServer())
      .post(`/api/app/users/${created.appUserId}:reset-password`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    const validate = validator('POST /app/users/{appUserId}:reset-password');
    expect(validate(reset.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    // ⛔ 서버는 해시만 갖는다 — 응답의 값이 실제로 통해야 「한 번만 보인다」가 뜻을 갖는다.
    await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: `${PREFIX}-p1`, password: reset.body.temporaryPassword })
      .expect(200);

    const stored = await prisma.user_credential.findUniqueOrThrow({
      where: { app_user_id: created.appUserId },
    });
    expect(stored.password_hash).not.toContain(reset.body.temporaryPassword);
    expect(stored.must_change_password).toBe(true);
  });

  it('⭐ 잠긴 계정이 초기화로 풀린다 — 관리자가 푸는 경로가 이것뿐이다', async () => {
    const created = await create(`${PREFIX}-p2`);
    await request(app.getHttpServer())
      .post(`/api/app/users/${created.appUserId}:reset-password`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    await prisma.user_credential.update({
      where: { app_user_id: created.appUserId },
      data: { failed_attempt_count: 5, locked_until: new Date('9999-12-31T00:00:00.000Z') },
    });

    const reset = await request(app.getHttpServer())
      .post(`/api/app/users/${created.appUserId}:reset-password`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: `${PREFIX}-p2`, password: reset.body.temporaryPassword })
      .expect(200);
  });

  it('⭐ 초기화하면 그 계정의 기존 로그인이 끊기고, 관리자 자신의 세션은 그대로다', async () => {
    const created = await create(`${PREFIX}-p4`);
    const first = await request(app.getHttpServer())
      .post(`/api/app/users/${created.appUserId}:reset-password`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    const signedIn = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: `${PREFIX}-p4`, password: first.body.temporaryPassword })
      .expect(200);
    const targetCookie = signedIn.headers['set-cookie'] as unknown as string[];
    await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', targetCookie)
      .expect(200);

    // 발급 시각은 초 단위라 같은 초 안의 초기화는 가르지 못한다 — 초를 넘긴 뒤 초기화한다.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await request(app.getHttpServer())
      .post(`/api/app/users/${created.appUserId}:reset-password`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', targetCookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('⭐ 같은 멱등키로 다시 부르면 «같은» 임시 비밀번호를 준다', async () => {
    const created = await create(`${PREFIX}-p3`);
    const idempotencyKey = key();

    const first = await request(app.getHttpServer())
      .post(`/api/app/users/${created.appUserId}:reset-password`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .expect(200);
    const again = await request(app.getHttpServer())
      .post(`/api/app/users/${created.appUserId}:reset-password`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .expect(200);

    // 새로 뽑으면 앞에서 알려 준 값이 조용히 무효가 된다.
    expect(again.body.temporaryPassword).toBe(first.body.temporaryPassword);
  });

  it('⛔ 하위 자원도 권한을 보고, 없는 사용자는 404 다', async () => {
    await request(app.getHttpServer())
      .put(`/api/app/users/1/roles`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ roleIds: [] })
      .expect(403);

    for (const path of ['roles', 'data-scopes']) {
      await request(app.getHttpServer())
        .get(`/api/app/users/999999999/${path}`)
        .set('Cookie', cookie)
        .expect(404);
    }
    await request(app.getHttpServer())
      .post('/api/app/users/999999999:reset-password')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function spareRole(suffix: string): Promise<number> {
    const role = await prisma.role.upsert({
      where: { role_code: `${ROLE}_${suffix}` },
      update: {},
      create: { role_code: `${ROLE}_${suffix}`, role_name: suffix },
    });
    return Number(role.role_id);
  }

  async function putRoles(
    appUserId: number,
    roleIds: number[],
  ): Promise<{ body: { items: { roleId: number }[] } }> {
    const response = await request(app.getHttpServer())
      .put(`/api/app/users/${appUserId}/roles`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ roleIds })
      .expect(200);
    return { body: response.body };
  }

  async function putScopes(
    appUserId: number,
    scopes: object[],
  ): Promise<{ body: { items: object[] } }> {
    const response = await request(app.getHttpServer())
      .put(`/api/app/users/${appUserId}/data-scopes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ scopes })
      .expect(200);
    return { body: response.body };
  }

  /** 검사 사용자만 관리자인 상태를 만든다. API 를 거치지 않으므로 판정을 안 탄다. */
  async function deactivateOtherAdmins(): Promise<bigint[]> {
    const rows = await prisma.app_user.findMany({
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
    const ids = rows.map((row) => row.app_user_id);
    await prisma.app_user.updateMany({
      where: { app_user_id: { in: ids } },
      data: { is_active: false },
    });
    return ids;
  }

  async function restoreAdmins(ids: bigint[]): Promise<void> {
    await prisma.app_user.updateMany({
      where: { app_user_id: { in: ids } },
      data: { is_active: true },
    });
  }

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
    expect(response.body.statusCode).toBe('EMPLOYED');
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
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: ids } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: ids } } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: { in: ids } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: ids } } });

    await prisma.department.deleteMany({ where: { department_code: DEPARTMENT_CODE } });
    const roles = await prisma.role.findMany({
      where: { role_code: { startsWith: ROLE } },
      select: { role_id: true },
    });
    const roleIds = roles.map((row) => row.role_id);
    await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
  }
});
