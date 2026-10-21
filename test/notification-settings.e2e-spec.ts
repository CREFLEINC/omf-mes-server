/**
 * 부서×이벤트 알림 설정(W-CO-11 · omf-all-around#160 · 장부 P-92).
 *
 * 행이 없으면 끔·끔·0명·판 1 로 읽고 GET 은 행을 만들지 않는다. 저장은 기존 구독 PUT 과 같은 순서다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_NSET_${randomUUID().slice(0, 8)}`;
const PATH = '/api/app/notification-settings';
const EVENT = 'WORK_ORDER_CLOSED';
const APPROVAL = 'APPROVAL_ACTION_REQUIRED';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');

function validator(path: string, method: string, status: number): ValidateFunction {
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('부서×이벤트 알림 설정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let deniedCookie: string;
  let departmentId: number;
  let withPhone: number;
  let noPhone: number;
  let inactive: number;
  const userIds: bigint[] = [];
  let roleId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const department = await prisma.department.create({
      data: { department_code: `${PREFIX}_D`, department_name: `${PREFIX} 생산1팀` },
    });
    departmentId = Number(department.department_id);

    const admin = await makeUser('ADMIN', { phone_number: null });
    const denied = await makeUser('DENIED', { phone_number: null });
    withPhone = Number(await makeUser('PHONE', { phone_number: '84912345678', department_id: department.department_id }));
    noPhone = Number(await makeUser('NOPHONE', { phone_number: null }));
    inactive = Number(await makeUser('GONE', { phone_number: '84987654321', is_active: false }));

    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_ROLE`, role_name: '알림 설정 시험' } });
    roleId = role.role_id;
    await prisma.role_permission.create({ data: { role_id: roleId, permission_code: 'W-CO-11' } });
    await prisma.user_role.create({ data: { app_user_id: admin, role_id: roleId } });

    const jwt = app.get(JwtService);
    cookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(admin), typ: 'session' })}`;
    deniedCookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(denied), typ: 'session' })}`;
  });

  afterAll(async () => {
    const settings = await prisma.notification_department_setting.findMany({
      where: { department_id: departmentId },
      select: { notification_department_setting_id: true },
    });
    const settingIds = settings.map((row) => row.notification_department_setting_id);
    await prisma.notification_department_recipient.deleteMany({
      where: { notification_department_setting_id: { in: settingIds } },
    });
    await prisma.notification_department_setting.deleteMany({ where: { department_id: departmentId } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { role_id: roleId } });
    await prisma.role_permission.deleteMany({ where: { role_id: roleId } });
    await prisma.role.delete({ where: { role_id: roleId } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.department.delete({ where: { department_id: departmentId } });
    await app.close();
  });

  it('US4-1 부서를 고르면 6개 이벤트 요약이 미설정 기본값(끔·끔·0명)으로 온다', async () => {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({ departmentId })
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('/app/notification-settings', 'get', 200);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body).toMatchObject({ departmentId, departmentName: `${PREFIX} 생산1팀` });
    expect(['NOT_CONFIGURED', 'ACTIVE', 'REAUTH_REQUIRED']).toContain(response.body.zaloStatus);
    expect(response.body.items).toHaveLength(6);
    for (const item of response.body.items) {
      expect(item).toMatchObject({ enabled: false, zaloEnabled: false, recipientCount: 0, noPhoneCount: 0 });
    }
  });

  it('US4-1 상세는 미설정이면 ETag "1" 이고 GET 은 행을 만들지 않는다', async () => {
    const response = await detail(EVENT);

    expect(response.headers.etag).toBe('1');
    expect(response.body).toEqual({ departmentId, eventCode: EVENT, enabled: false, zaloEnabled: false, recipients: [] });
    expect(await prisma.notification_department_setting.count({ where: { department_id: departmentId } })).toBe(0);
  });

  it('US4-2 저장한 뒤 다시 열면 그대로이고 ETag 가 하나 오른다', async () => {
    const body = { enabled: true, zaloEnabled: true, recipientUserIds: [noPhone, withPhone] };
    const saved = await replace(EVENT, '1', body).expect(200);
    expect(saved.headers.etag).toBe('2');
    const validate = validator('/app/notification-settings/{departmentId}/{eventCode}', 'put', 200);
    expect(validate(saved.body)).toBe(true);

    const reopened = await detail(EVENT);
    expect(reopened.headers.etag).toBe('2');
    expect(reopened.body).toEqual(saved.body);
    expect(reopened.body).toMatchObject({ enabled: true, zaloEnabled: true });
    expect(reopened.body.recipients.map((r: { appUserId: number }) => r.appUserId).sort()).toEqual(
      [noPhone, withPhone].sort(),
    );
    const phone = reopened.body.recipients.find((r: { appUserId: number }) => r.appUserId === withPhone);
    expect(phone).toMatchObject({ active: true, hasPhone: true, departmentName: `${PREFIX} 생산1팀` });
    expect(JSON.stringify(reopened.body)).not.toContain('84912345678');
  });

  it('US4-5 요약이 활성 수신자 수와 번호 없는 수신자 수를 센다', async () => {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({ departmentId })
      .set('Cookie', cookie)
      .expect(200);
    const item = response.body.items.find((i: { eventCode: string }) => i.eventCode === EVENT);
    expect(item).toEqual({ eventCode: EVENT, enabled: true, zaloEnabled: true, recipientCount: 2, noPhoneCount: 1 });
  });

  it('US4-6 같은 판으로 두 번째 저장하면 409 이고 앞 저장이 남는다', async () => {
    const response = await replace(EVENT, '1', { enabled: false, zaloEnabled: false, recipientUserIds: [] }).expect(409);
    expect(validator('/app/notification-settings/{departmentId}/{eventCode}', 'put', 409)(response.body)).toBe(true);
    expect((await detail(EVENT)).body.enabled).toBe(true);
  });

  it('US4-2 같은 Idempotency-Key 로 다시 보내면 결과가 같고 판이 한 번만 오른다', async () => {
    const key = randomUUID();
    const body = { enabled: true, zaloEnabled: false, recipientUserIds: [withPhone] };
    const first = await replace(EVENT, '2', body, key).expect(200);
    const again = await replace(EVENT, '2', body, key).expect(200);

    expect(again.body).toEqual(first.body);
    expect(again.headers.etag).toBe('3');
    expect((await detail(EVENT)).headers.etag).toBe('3');
  });

  it('US4-4 켜고 수신자 0명으로도 저장된다(경고는 화면 몫)', async () => {
    const saved = await replace('WORK_SESSION_STARTED', '1', { enabled: true, zaloEnabled: false, recipientUserIds: [] }).expect(200);
    expect(saved.body).toMatchObject({ enabled: true, recipients: [] });
  });

  it('결재 이벤트에 수신자를 보내면 400 RECIPIENTS_NOT_ALLOWED 다', async () => {
    const response = await replace(APPROVAL, '1', { enabled: true, zaloEnabled: true, recipientUserIds: [withPhone] }).expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field: 'recipientUserIds', code: 'RECIPIENTS_NOT_ALLOWED' }),
    ]);
    const saved = await replace(APPROVAL, '1', { enabled: true, zaloEnabled: true, recipientUserIds: [] }).expect(200);
    expect(saved.body.recipients).toEqual([]);
  });

  it.each([
    ['중복', () => [withPhone, withPhone]],
    ['없는 사용자', () => [987654321]],
    ['사용 중지된 사용자', () => [inactive]],
  ])('%s 는 400 recipientUserIds 이고 아무것도 쓰지 않는다', async (_label, ids) => {
    const response = await replace('WORK_SESSION_ENDED', '1', { enabled: true, zaloEnabled: false, recipientUserIds: ids() }).expect(400);
    expect(response.body.errors.map((e: { field: string }) => e.field)).toEqual(['recipientUserIds']);
    expect((await detail('WORK_SESSION_ENDED')).headers.etag).toBe('1');
  });

  it('목록에 없는 eventCode 는 400, 없는 부서는 404 다', async () => {
    const badEvent = await request(app.getHttpServer())
      .get(`${PATH}/${departmentId}/MOLD_RECOMMENDED_SHOTS_EXCEEDED`)
      .set('Cookie', cookie)
      .expect(400);
    expect(badEvent.body.errors.map((e: { field: string }) => e.field)).toEqual(['eventCode']);
    await request(app.getHttpServer()).get(`${PATH}/987654321/${EVENT}`).set('Cookie', cookie).expect(404);
    await request(app.getHttpServer()).get(PATH).query({ departmentId: 987654321 }).set('Cookie', cookie).expect(404);
    await request(app.getHttpServer()).get(PATH).set('Cookie', cookie).expect(400);
  });

  it('US4-3 후보는 활성 사용자 전체이고 hasPhone 만 있고 번호 원문은 없다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/recipient-candidates`)
      .query({ keyword: PREFIX, size: 100 })
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('/app/notification-settings/recipient-candidates', 'get', 200);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    const byId = new Map(response.body.items.map((i: { appUserId: number }) => [i.appUserId, i]));
    expect(byId.has(inactive)).toBe(false);
    expect(byId.get(withPhone)).toMatchObject({ hasPhone: true, departmentName: `${PREFIX} 생산1팀` });
    expect(byId.get(noPhone)).toMatchObject({ hasPhone: false });
    expect(response.body.page.total).toBe(4);
    expect(JSON.stringify(response.body)).not.toMatch(/phoneNumber|849\d{8}/);
  });

  it('W-CO-11 권한이 없으면 네 경로 모두 403 이다', async () => {
    const server = app.getHttpServer();
    await request(server).get(PATH).query({ departmentId }).set('Cookie', deniedCookie).expect(403);
    await request(server).get(`${PATH}/recipient-candidates`).set('Cookie', deniedCookie).expect(403);
    await request(server).get(`${PATH}/${departmentId}/${EVENT}`).set('Cookie', deniedCookie).expect(403);
    await request(server)
      .put(`${PATH}/${departmentId}/${EVENT}`)
      .set('Cookie', deniedCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ enabled: false, zaloEnabled: false, recipientUserIds: [] })
      .expect(403);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function detail(eventCode: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`${PATH}/${departmentId}/${eventCode}`)
      .set('Cookie', cookie)
      .expect(200);
  }

  function replace(eventCode: string, ifMatch: string, body: object, key: string = randomUUID()): request.Test {
    return request(app.getHttpServer())
      .put(`${PATH}/${departmentId}/${eventCode}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .set('If-Match', ifMatch)
      .send(body);
  }

  async function makeUser(
    suffix: string,
    data: { phone_number: string | null; department_id?: bigint; is_active?: boolean },
  ): Promise<bigint> {
    const user = await prisma.app_user.create({
      data: { login_id: `${PREFIX}_${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED', ...data },
    });
    userIds.push(user.app_user_id);
    return user.app_user_id;
  }
});
