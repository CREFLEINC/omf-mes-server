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

const PREFIX = `E2E_I28_SUB_${randomUUID().slice(0, 8)}`;
const PATH = '/api/app/notification-subscriptions';
const EVENT = 'EQUIPMENT_BREAKDOWN_OCCURRED';
const EMPTY_EVENT = 'MOLD_RECOMMENDED_SHOTS_EXCEEDED';

function validator(status: 200 | 403): ValidateFunction {
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
    $ref: `https://omf-mes.invalid/contract#/paths/~1app~1notification-subscriptions/get/responses/${status}/content/application~1json/schema`,
  });
}

describe('알림 구독 조회 (I-28)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let deniedCookie: string;
  let actorId: bigint;
  let deniedId: bigint;
  let permissionRoleId: bigint;
  let recipientRoleId: bigint;
  let businessUnitId: bigint;
  let legalEntityId: bigint;
  let headerId: bigint;
  let legacyId: bigint;
  const validateOk = validator(200);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    const [actor, denied] = await Promise.all([
      prisma.app_user.create({
        data: { login_id: `${PREFIX}_ACTOR`, user_name: '구독 조회 사용자', status_code: 'EMPLOYED' },
      }),
      prisma.app_user.create({
        data: { login_id: `${PREFIX}_DENIED`, user_name: '구독 권한 없음', status_code: 'EMPLOYED' },
      }),
    ]);
    [actorId, deniedId] = [actor.app_user_id, denied.app_user_id];
    cookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(actorId), typ: 'session' })}`;
    deniedCookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(deniedId), typ: 'session' })}`;

    const [permissionRole, recipientRole] = await Promise.all([
      prisma.role.create({
        data: { role_code: `${PREFIX}_PERM`, role_name: '구독 조회 권한' },
      }),
      prisma.role.create({
        data: { role_code: `${PREFIX}_RECIPIENT`, role_name: '설비 담당' },
      }),
    ]);
    [permissionRoleId, recipientRoleId] = [permissionRole.role_id, recipientRole.role_id];
    await prisma.role_permission.create({
      data: { role_id: permissionRoleId, permission_code: 'W-CO-11' },
    });
    await prisma.user_role.create({
      data: { app_user_id: actorId, role_id: permissionRoleId },
    });

    const legalEntity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}_LE`,
        legal_entity_name: '구독 조회 법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    legalEntityId = legalEntity.legal_entity_id;
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: legalEntityId,
        business_unit_code: `${PREFIX}_BU`,
        business_unit_name: '구독 조회 사업부',
      },
    });
    businessUnitId = unit.business_unit_id;

    const header = await prisma.notification_subscription.create({
      data: { event_type_code: EVENT, zalo_enabled: true, version_no: 7 },
    });
    headerId = header.notification_subscription_id;
    await prisma.notification_subscription_recipient.createMany({
      data: [
        {
          notification_subscription_id: headerId,
          recipient_type_code: 'ROLE',
          business_unit_id: businessUnitId,
          role_id: recipientRoleId,
        },
        {
          notification_subscription_id: headerId,
          recipient_type_code: 'USER',
          app_user_id: actorId,
        },
      ],
    });
    const legacy = await prisma.notification_subscription.create({
      data: {
        app_user_id: actorId,
        event_type_code: `${PREFIX}_LEGACY`,
        channel_code: 'IN_APP',
      },
    });
    legacyId = legacy.notification_subscription_id;
  });

  afterAll(async () => {
    await prisma.notification_subscription_recipient.deleteMany({
      where: { notification_subscription_id: headerId },
    });
    await prisma.notification_subscription.deleteMany({
      where: { notification_subscription_id: { in: [headerId, legacyId] } },
    });
    await prisma.user_role.deleteMany({ where: { app_user_id: actorId } });
    await prisma.role_permission.deleteMany({ where: { role_id: permissionRoleId } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: [actorId, deniedId] } } });
    await prisma.role.deleteMany({ where: { role_id: { in: [permissionRoleId, recipientRoleId] } } });
    await prisma.business_unit.delete({ where: { business_unit_id: businessUnitId } });
    await prisma.legal_entity.delete({ where: { legal_entity_id: legalEntityId } });
    await app.close();
  });

  it('전체 조회는 정본 6개와 설정을 반환하되 ETag와 legacy 행을 노출하지 않는다', async () => {
    const before = await counts(prisma);
    const response = await request(app.getHttpServer()).get(PATH).set('Cookie', cookie).expect(200);

    expect(validateOk(response.body)).toBe(true);
    expect(response.headers.etag).toBeUndefined();
    expect(response.body.items).toHaveLength(6);
    expect(response.body.items[0]).toEqual({
      eventCode: EVENT,
      recipients: [
        { recipientTypeCode: 'ROLE', businessUnitId: Number(businessUnitId), roleId: Number(recipientRoleId) },
        { recipientTypeCode: 'USER', userId: Number(actorId) },
      ],
      zaloEnabled: true,
    });
    expect(JSON.stringify(response.body)).not.toContain(PREFIX);
    expect(await counts(prisma)).toEqual(before);
  });

  it('결정 — 통보 100: 미설정 단일 이벤트는 빈 값과 초기 ETag 1이며 GET은 쓰지 않는다', async () => {
    const before = await counts(prisma);
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({ eventCode: EMPTY_EVENT })
      .set('Cookie', cookie)
      .expect(200);

    expect(response.headers.etag).toBe('1');
    expect(response.body).toEqual({
      items: [{ eventCode: EMPTY_EVENT, recipients: [], zaloEnabled: false }],
    });
    expect(await counts(prisma)).toEqual(before);
  });

  it('설정된 단일 이벤트는 헤더 version과 수신자 스냅샷을 함께 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({ eventCode: EVENT })
      .set('Cookie', cookie)
      .expect(200);

    expect(response.headers.etag).toBe('7');
    expect(response.body.items).toEqual([
      expect.objectContaining({ eventCode: EVENT, zaloEnabled: true }),
    ]);
  });

  it('정본에 없는 eventCode는 빈 목록과 ETag 없음으로 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({ eventCode: `${PREFIX}_UNKNOWN` })
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body).toEqual({ items: [] });
    expect(response.headers.etag).toBeUndefined();
  });

  it('W-CO-11 권한이 없으면 403 계약 봉투다', async () => {
    const response = await request(app.getHttpServer()).get(PATH).set('Cookie', deniedCookie).expect(403);
    expect(validator(403)(response.body)).toBe(true);
  });
});

function counts(prisma: PrismaService): Promise<[number, number]> {
  return Promise.all([
    prisma.notification_subscription.count(),
    prisma.notification_subscription_recipient.count(),
  ]);
}
