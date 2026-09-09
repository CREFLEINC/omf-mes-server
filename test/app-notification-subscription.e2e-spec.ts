import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
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
const CONCURRENT_EVENT = 'PURCHASE_ORDER_CHANGE_RECEIVED';
const OTHER_EVENT = 'CALIBRATION_EXPIRY_APPROACHING';
const INVALID_REFERENCE_EVENT = 'APPROVAL_ACTION_REQUIRED';
const DENIED_EVENT = 'INTEGRATION_FAILED';
const HEADER_EVENTS = [
  EVENT,
  EMPTY_EVENT,
  CONCURRENT_EVENT,
  OTHER_EVENT,
  INVALID_REFERENCE_EVENT,
  DENIED_EVENT,
];

function validator(method: 'get' | 'put', status: 200 | 400 | 403 | 409): ValidateFunction {
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
    $ref: `https://omf-mes.invalid/contract#/paths/~1app~1notification-subscriptions/${method}/responses/${status}/content/application~1json/schema`,
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
  const idempotencyKeys: string[] = [];
  const newKey = (): string => {
    const value = randomUUID();
    idempotencyKeys.push(value);
    return value;
  };
  const validateOk = validator('get', 200);
  const validatePutOk = validator('put', 200);
  const validateBadRequest = validator('put', 400);
  const validateConflict = validator('put', 409);

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
    const headers = await prisma.notification_subscription.findMany({
      where: {
        app_user_id: null,
        channel_code: null,
        event_type_code: { in: HEADER_EVENTS },
      },
      select: { notification_subscription_id: true },
    });
    const headerIds = headers.map((row) => row.notification_subscription_id);
    await prisma.notification_subscription_recipient.deleteMany({
      where: { notification_subscription_id: { in: headerIds } },
    });
    await prisma.notification_subscription.deleteMany({
      where: { notification_subscription_id: { in: [...headerIds, legacyId] } },
    });
    await prisma.idempotency_record.deleteMany({
      where: { idempotency_key: { in: idempotencyKeys } },
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
    expect(validator('get', 403)(response.body)).toBe(true);
  });

  it('치환은 자식·Zalo·버전을 함께 저장하고 같은 키는 낡은 If-Match여도 재생한다', async () => {
    const key = newKey();
    const body = {
      recipients: [{ recipientTypeCode: 'USER', userId: Number(actorId) }],
      zaloEnabled: false,
    };
    const first = await put(app, cookie, EVENT, key, 7, body).expect(200);

    expect(validatePutOk(first.body)).toBe(true);
    expect(first.headers.etag).toBeUndefined();
    expect(first.body).toEqual({ eventCode: EVENT, ...body });
    const replay = await put(app, cookie, EVENT, key, 1, body).expect(200);
    expect(replay.body).toEqual(first.body);

    const stored = await getOne(app, cookie, EVENT);
    expect(stored.headers.etag).toBe('8');
    expect(stored.body.items[0]).toEqual(first.body);
  });

  it('결정 — 통보 100: 빈 수신자 저장과 zalo 생략은 허용하고 기존 값을 보존한다', async () => {
    const response = await put(app, cookie, EVENT, newKey(), 8, { recipients: [] }).expect(200);

    expect(response.body).toEqual({ eventCode: EVENT, recipients: [], zaloEnabled: false });
    const stored = await getOne(app, cookie, EVENT);
    expect(stored.headers.etag).toBe('9');
    expect(stored.body.items[0]).toEqual(response.body);
  });

  it('새 키의 낡은 If-Match는 409이며 기존 설정을 바꾸지 않는다', async () => {
    const response = await put(app, cookie, EVENT, newKey(), 8, {
      recipients: [{ recipientTypeCode: 'USER', userId: Number(actorId) }],
    }).expect(409);

    expect(validateConflict(response.body)).toBe(true);
    const stored = await getOne(app, cookie, EVENT);
    expect(stored.headers.etag).toBe('9');
    expect(stored.body.items[0].recipients).toEqual([]);
  });

  it('최초 저장은 토큰 1을 받아 헤더 version 2를 만들며 eventCode도 멱등 지문에 든다', async () => {
    const key = newKey();
    const body = { recipients: [{ recipientTypeCode: 'USER', userId: Number(actorId) }] };
    await put(app, cookie, EMPTY_EVENT, key, 1, body).expect(200);

    const stored = await getOne(app, cookie, EMPTY_EVENT);
    expect(stored.headers.etag).toBe('2');
    expect(stored.body.items[0]).toEqual({
      eventCode: EMPTY_EVENT,
      ...body,
      zaloEnabled: false,
    });
    const conflict = await put(app, cookie, OTHER_EVENT, key, 1, body).expect(409);
    expect(validateConflict(conflict.body)).toBe(true);
    expect(await headerCount(prisma, OTHER_EVENT)).toBe(0);
  });

  it('동시 최초 PUT 두 건은 한 건만 성공하고 헤더 하나와 version 2만 남긴다', async () => {
    const body = { recipients: [{ recipientTypeCode: 'USER', userId: Number(actorId) }] };
    const responses = await Promise.all([
      put(app, cookie, CONCURRENT_EVENT, newKey(), 1, body),
      put(app, cookie, CONCURRENT_EVENT, newKey(), 1, body),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const stored = await getOne(app, cookie, CONCURRENT_EVENT);
    expect(stored.headers.etag).toBe('2');
    expect(stored.body.items[0].recipients).toEqual(body.recipients);
    expect(await headerCount(prisma, CONCURRENT_EVENT)).toBe(1);
  });

  it('미등록 이벤트와 없는 수신자 참조는 400이고 헤더·멱등 기록을 남기지 않는다', async () => {
    const unknownKey = newKey();
    const unknown = await put(app, cookie, `${PREFIX}_UNKNOWN`, unknownKey, 1, {
      recipients: [],
    }).expect(400);
    expect(validateBadRequest(unknown.body)).toBe(true);
    expect(await prisma.idempotency_record.count({ where: { idempotency_key: unknownKey } })).toBe(0);

    const missingKey = newKey();
    const missing = await put(app, cookie, INVALID_REFERENCE_EVENT, missingKey, 1, {
      recipients: [{ recipientTypeCode: 'USER', userId: 9_999_999 }],
    }).expect(400);
    expect(validateBadRequest(missing.body)).toBe(true);
    expect(await headerCount(prisma, INVALID_REFERENCE_EVENT)).toBe(0);
    expect(await prisma.idempotency_record.count({ where: { idempotency_key: missingKey } })).toBe(0);
  });

  it('멱등 완료기록 실패는 헤더·자식·버전을 롤백하고 같은 키 재시도를 허용한다', async () => {
    const key = newKey();
    const body = { recipients: [{ recipientTypeCode: 'USER', userId: Number(actorId) }] };
    const runTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (work) =>
        runTransaction(async (tx) => {
          const completionSpy = jest
            .spyOn(tx.idempotency_record, 'update')
            .mockRejectedValueOnce(new Error('I28_SUBSCRIPTION_COMPLETION_FAILURE'));
          try {
            return await (work as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx);
          } finally {
            completionSpy.mockRestore();
          }
        }),
      );
    try {
      const failed = await put(app, cookie, OTHER_EVENT, key, 1, body).expect(500);
      expect(failed.text).not.toContain('I28_SUBSCRIPTION_COMPLETION_FAILURE');
    } finally {
      transactionSpy.mockRestore();
    }
    expect(await headerCount(prisma, OTHER_EVENT)).toBe(0);
    expect(await prisma.idempotency_record.findUnique({ where: { idempotency_key: key } })).toBeNull();

    await put(app, cookie, OTHER_EVENT, key, 1, body).expect(200);
    expect((await getOne(app, cookie, OTHER_EVENT)).headers.etag).toBe('2');
  });

  it('PUT 뒤에도 기존 사용자·채널 구독 원문은 보존되고 권한 없음은 403이다', async () => {
    const legacy = await prisma.notification_subscription.findUniqueOrThrow({
      where: { notification_subscription_id: legacyId },
    });
    expect(legacy).toMatchObject({
      app_user_id: actorId,
      event_type_code: `${PREFIX}_LEGACY`,
      channel_code: 'IN_APP',
      version_no: 1,
    });
    await put(app, deniedCookie, DENIED_EVENT, newKey(), 1, { recipients: [] }).expect(403);
    expect(await headerCount(prisma, DENIED_EVENT)).toBe(0);
  });
});

function counts(prisma: PrismaService): Promise<[number, number]> {
  return Promise.all([
    prisma.notification_subscription.count(),
    prisma.notification_subscription_recipient.count(),
  ]);
}

function put(
  app: INestApplication,
  cookie: string,
  eventCode: string,
  key: string,
  version: number,
  body: object,
) {
  return request(app.getHttpServer())
    .put(PATH)
    .query({ eventCode })
    .set('Cookie', cookie)
    .set('Idempotency-Key', key)
    .set('If-Match', String(version))
    .send(body);
}

function getOne(app: INestApplication, cookie: string, eventCode: string) {
  return request(app.getHttpServer()).get(PATH).query({ eventCode }).set('Cookie', cookie).expect(200);
}

function headerCount(prisma: PrismaService, eventCode: string): Promise<number> {
  return prisma.notification_subscription.count({
    where: { event_type_code: eventCode, app_user_id: null, channel_code: null },
  });
}
