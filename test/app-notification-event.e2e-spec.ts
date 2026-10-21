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

const PREFIX = `E2E_I28_EVENT_${randomUUID().slice(0, 8)}`;
const PATH = '/api/app/notification-events';
const REMOVED_EVENTS = [
  'MOLD_RECOMMENDED_SHOTS_EXCEEDED',
  'CALIBRATION_EXPIRY_APPROACHING',
  'PURCHASE_ORDER_CHANGE_RECEIVED',
  'INTEGRATION_FAILED',
];

function responseValidator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) {
    ajv.addFormat(format, true);
  }
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({
    $ref: 'https://omf-mes.invalid/contract#/paths/~1app~1notification-events/get/responses/200/content/application~1json/schema',
  });
}

describe('알림 이벤트 정본 (I-28)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let userId: bigint;
  let roleId: bigint;
  let occurrenceId: bigint;
  let legacySubscriptionId: bigint;
  const validateResponse = responseValidator();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const user = await prisma.app_user.create({
      data: {
        login_id: `${PREFIX}_USER`,
        user_name: '알림 이벤트 시험 사용자',
        status_code: 'EMPLOYED',
      },
    });
    userId = user.app_user_id;
    const role = await prisma.role.create({
      data: { role_code: `${PREFIX}_ROLE`, role_name: '알림 설정 시험 역할' },
    });
    roleId = role.role_id;
    await prisma.role_permission.create({
      data: { role_id: roleId, permission_code: 'W-CO-11' },
    });
    await prisma.user_role.create({ data: { app_user_id: userId, role_id: roleId } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(userId), typ: 'session' })}`;

    const occurrence = await prisma.notification_event.create({
      data: {
        event_type_code: `${PREFIX}_OPAQUE`,
        aggregate_type_code: 'EQUIPMENT',
        aggregate_id: 991n,
        occurred_at: new Date('2026-09-09T00:00:00.000Z'),
      },
    });
    occurrenceId = occurrence.notification_event_id;
    const legacy = await prisma.notification_subscription.create({
      data: {
        app_user_id: userId,
        event_type_code: `${PREFIX}_LEGACY`,
        channel_code: 'IN_APP',
      },
    });
    legacySubscriptionId = legacy.notification_subscription_id;
  });

  afterAll(async () => {
    await prisma.notification_subscription.delete({
      where: { notification_subscription_id: legacySubscriptionId },
    });
    await prisma.notification_event.delete({ where: { notification_event_id: occurrenceId } });
    await prisma.user_role.deleteMany({ where: { app_user_id: userId } });
    await prisma.role_permission.deleteMany({ where: { role_id: roleId } });
    await prisma.role.delete({ where: { role_id: roleId } });
    await prisma.app_user.delete({ where: { app_user_id: userId } });
    await app.close();
  });

  it('US4-7 SC-010 이벤트는 정확히 6개이고 고정 순서·이름·계약 모양이다', async () => {
    const response = await request(app.getHttpServer()).get(PATH).set('Cookie', cookie).expect(200);

    expect(validateResponse(response.body)).toBe(true);
    expect(response.body.items.map((item: { eventCode: string }) => item.eventCode)).toEqual([
      'WORK_SESSION_STARTED',
      'WORK_SESSION_STOPPED',
      'WORK_SESSION_ENDED',
      'WORK_ORDER_CLOSED',
      'EQUIPMENT_BREAKDOWN_OCCURRED',
      'APPROVAL_ACTION_REQUIRED',
    ]);
    expect(response.body.items.map((item: { eventName: string }) => item.eventName)).toEqual([
      '생산 실행',
      '생산 중단',
      '작업 종료',
      '생산 마감',
      '설비 고장 발생',
      '승인 요청·결재 도착',
    ]);
  });

  it('US4-7 recipientMode 는 결재만 APPROVER 이고 나머지는 CONFIGURED 다', async () => {
    const response = await request(app.getHttpServer()).get(PATH).set('Cookie', cookie).expect(200);

    const modes = Object.fromEntries(
      response.body.items.map((item: { eventCode: string; recipientMode: string }) => [
        item.eventCode,
        item.recipientMode,
      ]),
    );
    expect(modes).toEqual({
      WORK_SESSION_STARTED: 'CONFIGURED',
      WORK_SESSION_STOPPED: 'CONFIGURED',
      WORK_SESSION_ENDED: 'CONFIGURED',
      WORK_ORDER_CLOSED: 'CONFIGURED',
      EQUIPMENT_BREAKDOWN_OCCURRED: 'CONFIGURED',
      APPROVAL_ACTION_REQUIRED: 'APPROVER',
    });
  });

  it.each(REMOVED_EVENTS)(
    'SC-010 뺀 코드 %s 는 기존 구독 조회에 안 나오고 저장은 400 이다',
    async (eventCode) => {
      // ⚠ 기존 구독 GET 은 목록에 없는 코드를 빈 목록으로 돌려준다(계약에 400 이 없다 · 동작 보존).
      const listed = await request(app.getHttpServer())
        .get('/api/app/notification-subscriptions')
        .query({ eventCode })
        .set('Cookie', cookie)
        .expect(200);
      expect(listed.body).toEqual({ items: [] });

      const saved = await request(app.getHttpServer())
        .put('/api/app/notification-subscriptions')
        .query({ eventCode })
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ recipients: [] })
        .expect(400);
      expect(saved.body.errors.map((e: { field: string }) => e.field)).toEqual(['eventCode']);
    },
  );

  it('발생 이력과 기존 사용자별 구독의 임의 코드를 이벤트 정본에 섞지 않는다', async () => {
    const response = await request(app.getHttpServer()).get(PATH).set('Cookie', cookie).expect(200);

    expect(response.body.items).toHaveLength(6);
    expect(JSON.stringify(response.body)).not.toContain(PREFIX);
  });
});
