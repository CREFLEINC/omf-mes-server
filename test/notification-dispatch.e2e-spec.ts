/**
 * 알림 발송 이력(W-CO-13 · omf-all-around#160 · 장부 P-98).
 *
 * 사건은 생성기(`NotificationEmitter`)로 만든다 — 만든 건수와 조회 건수가 같아야 한다(SC-007).
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
import { EmitInput, NotificationEmitter } from '../src/core/notification';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `NDSP${randomUUID().slice(0, 6)}`;
// 다른 e2e 와 겹치지 않는 먼 과거 한 주를 쓴다.
const FROM = '2030-01-01T00:00:00.000Z';
const TO = '2030-01-08T00:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(FROM) + minutes * 60_000);

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
const validator = (path: string): ValidateFunction =>
  ajv.compile({ $ref: `https://omf-mes.invalid/contract#/paths/${path.replace(/\//g, '~1')}/get/responses/200/content/application~1json/schema` });

describe('알림 발송 이력 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let deniedCookie: string;
  const ids: Record<string, bigint> = {};
  const userIds: bigint[] = [];
  const created: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    ids.dept = (await prisma.department.create({ data: { department_code: `${PREFIX}-D`, department_name: '이력검사부' } })).department_id;
    ids.other = (await prisma.department.create({ data: { department_code: `${PREFIX}-O`, department_name: '다른부' } })).department_id;
    ids.viewer = await makeUser('VIEW', ['W-CO-13']);
    ids.denied = await makeUser('DENY', ['W-CO-11']);
    ids.phone = await makeUser('PHONE', [], '84912345678');
    ids.nophone = await makeUser('NOPHONE', []);
    cookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(ids.viewer), typ: 'session' })}`;
    deniedCookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(ids.denied), typ: 'session' })}`;

    const setting = await prisma.notification_department_setting.create({
      data: { department_id: ids.dept, event_type_code: 'WORK_ORDER_CLOSED', is_enabled: true, zalo_enabled: true },
    });
    await prisma.notification_department_recipient.createMany({
      data: [ids.phone, ids.nophone].map((app_user_id) => ({ notification_department_setting_id: setting.notification_department_setting_id, app_user_id })),
    });

    // 알림됨 2건(Zalo 각 1건), 부서 미확인 1건, 꺼짐 1건(다른 부서), 기간 밖 1건.
    await emit({ occurredAt: at(10), aggregateId: 9001n, values: { wo_no: 'WO-A' } });
    await emit({ occurredAt: at(20), aggregateId: 9002n, values: { wo_no: 'WO-B' } });
    await emit({ occurredAt: at(30), aggregateId: 9003n, departmentId: null, values: { wo_no: 'WO-C' } });
    await emit({ occurredAt: at(40), aggregateId: 9004n, departmentId: ids.other, values: { wo_no: 'WO-D' } });
    await emit({ occurredAt: new Date('2030-02-01T00:00:00.000Z'), aggregateId: 9005n, values: { wo_no: 'WO-OUT' } });
    // 둘째 사건의 Zalo 건은 실패로 둔다.
    await prisma.zalo_delivery.updateMany({
      where: { notification_event: { aggregate_id: 9002n, event_type_code: 'WORK_ORDER_CLOSED' } },
      data: { status_code: 'FAILED', attempt_count: 1, last_error_code: '-108', last_error_message: 'Phone number is invalid' },
    });
  });

  afterAll(async () => {
    await prisma.zalo_delivery.deleteMany({ where: { notification_event_id: { in: created } } });
    await prisma.notification.deleteMany({ where: { notification_event_id: { in: created } } });
    await prisma.notification_event.deleteMany({ where: { notification_event_id: { in: created } } });
    await prisma.notification_department_recipient.deleteMany({ where: { setting: { department_id: ids.dept } } });
    await prisma.notification_department_setting.deleteMany({ where: { department_id: { in: [ids.dept, ids.other] } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: { startsWith: PREFIX } } } });
    await prisma.role.deleteMany({ where: { role_code: { startsWith: PREFIX } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.department.deleteMany({ where: { department_code: { startsWith: PREFIX } } });
    await app.close();
  });

  it('US8-1 US8-3 SC-007 기간 안의 사건이 모두 나오고 결과·이유·건수·Zalo 집계·대상이 맞다', async () => {
    const response = await dispatches({}).expect(200);
    const validate = validator('/app/notification-dispatches');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    expect(response.body.page.total).toBe(4);
    const byLabel = Object.fromEntries(response.body.items.map((item: { targetLabel: string }) => [item.targetLabel, item]));
    expect(byLabel['WO-A']).toMatchObject({
      dispatchStatus: 'NOTIFIED', skipReasonCode: null, notificationCount: 2, departmentName: '이력검사부', targetTypeCode: 'WORK_ORDER', targetId: 9001,
      zalo: { pending: 1, sent: 0, failed: 0, expired: 0, skippedNoPhone: 1 },
    });
    expect(byLabel['WO-B'].zalo).toMatchObject({ pending: 0, failed: 1, skippedNoPhone: 1 });
    expect(byLabel['WO-C']).toMatchObject({ dispatchStatus: 'SKIPPED', skipReasonCode: 'DEPARTMENT_UNRESOLVED', departmentId: null, notificationCount: 0 });
    expect(byLabel['WO-D']).toMatchObject({ dispatchStatus: 'SKIPPED', skipReasonCode: 'EVENT_DISABLED', departmentName: '다른부' });
    // 최근 발생 순.
    expect(response.body.items.map((item: { targetLabel: string }) => item.targetLabel)).toEqual(['WO-D', 'WO-C', 'WO-B', 'WO-A']);
  });

  it('US8-3 결과·부서·이벤트로 거른다', async () => {
    expect((await dispatches({ status: 'SKIPPED' }).expect(200)).body.page.total).toBe(2);
    expect((await dispatches({ departmentId: Number(ids.dept) }).expect(200)).body.page.total).toBe(2);
    expect((await dispatches({ eventCode: 'WORK_SESSION_STARTED' }).expect(200)).body.page.total).toBe(0);
  });

  it('기간은 필수이고 31일을 넘거나 거꾸로면 400 이다', async () => {
    await request(app.getHttpServer()).get('/api/app/notification-dispatches').set('Cookie', cookie).expect(400);
    const over = await dispatches({ to: '2030-02-02T00:00:00.000Z' }).expect(400);
    expect(over.body.errors[0]).toMatchObject({ field: 'to', code: 'RANGE' });
    await dispatches({ from: TO, to: FROM }).expect(400);
    await deliveries({ to: '2030-02-02T00:00:00.000Z' }).expect(400);
  });

  it('US8-1 SC-007 수신자 단위 Zalo 이력 — 번호는 가려져 나오고 원문이 없다', async () => {
    const response = await deliveries({}).expect(200);
    const validate = validator('/app/zalo-deliveries');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    expect(response.body.page.total).toBe(2);
    expect(response.body.items.every((item: { phoneMasked: string }) => item.phoneMasked === '091*****78')).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('84912345678');
    expect(JSON.stringify(response.body)).not.toContain('0912345678');
    const failed = response.body.items.find((item: { status: string }) => item.status === 'FAILED');
    expect(failed).toMatchObject({
      targetLabel: 'WO-B', recipientName: `${PREFIX}-PHONE`, attemptCount: 1, lastErrorCode: '-108', trackingId: expect.stringMatching(/^zd-\d+$/),
    });
  });

  it('Zalo 이력을 사건·상태로 거른다', async () => {
    const all = await deliveries({}).expect(200);
    const eventId = all.body.items[0].notificationEventId;
    const one = await deliveries({ notificationEventId: eventId }).expect(200);
    expect(one.body.items.map((item: { notificationEventId: number }) => item.notificationEventId)).toEqual([eventId]);
    expect((await deliveries({ status: 'FAILED' }).expect(200)).body.page.total).toBe(1);
  });

  it('W-CO-13 권한이 없으면 403 이다', async () => {
    const query = { from: FROM, to: TO };
    await request(app.getHttpServer()).get('/api/app/notification-dispatches').query(query).set('Cookie', deniedCookie).expect(403);
    await request(app.getHttpServer()).get('/api/app/zalo-deliveries').query(query).set('Cookie', deniedCookie).expect(403);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function dispatches(query: Record<string, unknown>) {
    return request(app.getHttpServer()).get('/api/app/notification-dispatches').query({ from: FROM, to: TO, ...query }).set('Cookie', cookie);
  }

  function deliveries(query: Record<string, unknown>) {
    return request(app.getHttpServer()).get('/api/app/zalo-deliveries').query({ from: FROM, to: TO, ...query }).set('Cookie', cookie);
  }

  async function emit(input: Partial<EmitInput> & Pick<EmitInput, 'occurredAt' | 'aggregateId' | 'values'>): Promise<void> {
    const emitter = app.get(NotificationEmitter);
    const result = await prisma.$transaction((tx) =>
      emitter.emit(tx, { eventCode: 'WORK_ORDER_CLOSED', aggregateTypeCode: 'WORK_ORDER', departmentId: ids.dept, ...input }),
    );
    if (result.notificationEventId !== null) created.push(result.notificationEventId);
  }

  async function makeUser(key: string, permissions: string[], phone?: string): Promise<bigint> {
    const user = await prisma.app_user.create({
      data: { login_id: `${PREFIX}-${key}`, user_name: `${PREFIX}-${key}`, status_code: 'EMPLOYED', phone_number: phone },
    });
    userIds.push(user.app_user_id);
    if (permissions.length > 0) {
      const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${key}`, role_name: `이력 ${key}` } });
      await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
      await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    }
    return user.app_user_id;
  }
});
