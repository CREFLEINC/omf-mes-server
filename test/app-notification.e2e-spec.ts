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
import { NotificationWriteService } from '../src/app/notification/notification-write.service';
import { NotificationRow, NotificationView } from '../src/app/notification/notification-view';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PagedResponse } from '../src/common/pagination';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_I28_${randomUUID().slice(0, 8)}`;
// 발생 기록용 opaque 값이며 운영 이벤트 카탈로그나 시드가 아니다.
const EVENT_A = `${PREFIX}_A`;
const EVENT_B = `${PREFIX}_B`;
const PERIOD = {
  occurredFrom: '2026-09-06T00:00:00+07:00',
  occurredTo: '2026-09-07T00:00:00+07:00',
};

interface Fixtures {
  before: NotificationRow;
  from: NotificationRow;
  middle: NotificationRow;
  tieOlder: NotificationRow;
  tieNewer: NotificationRow;
  last: NotificationRow;
  to: NotificationRow;
  after: NotificationRow;
}

function validator(path: string, status = 200, method = 'get'): ValidateFunction {
  const contract: unknown = JSON.parse(
    readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
  );
  const pointer = path.startsWith('#')
    ? path.slice(1)
    : `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) {
    ajv.addFormat(format, true);
  }
  ajv.addSchema(contract as object, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('자기 알림 조회·읽음 (I-28 PR ①·② e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fixtures: Fixtures;
  let userId: bigint;
  let otherUserId: bigint;
  let cookie: string;
  let otherCookie: string;
  let inactiveCookie: string;
  let emptyCookie: string;
  let precisionCookie: string;
  let precisionUserId: bigint;
  let terminalToken: string;
  let otherNotification: NotificationRow;
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];
  const eventIds: bigint[] = [];
  const notificationIds: bigint[] = [];
  const idempotencyKeys: string[] = [];
  const precisionIds: number[] = [];
  let precisionSnapshot: unknown[];
  const validateList = validator('/app/notifications');
  const validateCount = validator('/app/notifications/unread-count');
  const validateError = validator('/app/notifications', 400);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);
    const users = [];
    for (const name of ['owner', 'other', 'inactive', 'empty', 'precision']) {
      const user = await prisma.app_user.create({
        data: {
          login_id: `${PREFIX}_${name}`,
          user_name: `알림 시험 ${name}`,
          status_code: 'EMPLOYED',
          is_active: name !== 'inactive',
        },
      });
      userIds.push(user.app_user_id);
      users.push(user);
    }
    [userId, otherUserId] = users.map((user) => user.app_user_id);
    precisionUserId = users[4].app_user_id;
    [cookie, otherCookie, inactiveCookie, emptyCookie, precisionCookie] = users.map(
      (user) => `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: 'session' })}`,
    );
    terminalToken = jwt.sign({ sub: Number(userId), typ: 'terminal' });
    const role = await prisma.role.create({
      data: { role_code: `${PREFIX}_ROLE`, role_name: '알림 조회 시험 역할' },
    });
    roleIds.push(role.role_id);
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-CO-03' },
    });
    await prisma.user_role.create({
      data: { app_user_id: userId, role_id: role.role_id },
    });

    fixtures = {
      before: await createNotification(userId, '2026-09-05T16:59:59.999Z'),
      from: await createNotification(userId, '2026-09-05T17:00:00.000Z'),
      middle: await createNotification(userId, '2026-09-06T01:00:00.000Z', {
        eventCode: EVENT_B,
        isRead: true,
        targetType: 'LEGACY_TARGET',
      }),
      tieOlder: await createNotification(userId, '2026-09-06T05:00:00.000Z'),
      tieNewer: await createNotification(userId, '2026-09-06T05:00:00.000Z', {
        isRead: true,
      }),
      last: await createNotification(userId, '2026-09-06T16:59:59.999Z', {
        eventCode: EVENT_B,
      }),
      to: await createNotification(userId, '2026-09-06T17:00:00.000Z'),
      after: await createNotification(userId, '2026-09-06T17:00:00.001Z', {
        eventCode: EVENT_B,
      }),
    };
    otherNotification = await createNotification(otherUserId, '2026-09-06T05:00:00.000Z');
    // 같은 발생 건을 받은 다른 사람도 자신의 수신 행으로만 조회한다.
    const shared = await prisma.notification.create({
      data: {
        notification_event_id: fixtures.from.notification_event_id,
        recipient_user_id: otherUserId,
        title: `${PREFIX} 다른 수신자`,
        message: '다른 수신자에게 저장된 문장',
      },
    });
    notificationIds.push(shared.notification_id);
    for (const timestamp of [
      '2026-12-31T16:59:59.000000Z',
      '2026-12-31T16:59:59.000001Z',
      '2026-12-31T16:59:59.000002Z',
      '2026-12-31T16:59:59.999999Z',
      '2026-12-31T17:00:00.000000Z',
      '2026-12-31T17:00:00.000001Z',
    ]) {
      precisionIds.push(await createPrecisionNotification(timestamp));
    }
    precisionSnapshot = await readPrecisionSnapshot();
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await prisma.idempotency_record.deleteMany({
          where: { idempotency_key: { in: idempotencyKeys } },
        });
        await prisma.notification.deleteMany({
          where: { notification_id: { in: notificationIds } },
        });
        await prisma.notification_event.deleteMany({
          where: { notification_event_id: { in: eventIds } },
        });
        await prisma.user_role.deleteMany({
          where: { app_user_id: { in: userIds } },
        });
        await prisma.role_permission.deleteMany({
          where: { role_id: { in: roleIds } },
        });
        await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
        await prisma.app_user.deleteMany({
          where: { app_user_id: { in: userIds } },
        });
      }
    } finally {
      await app?.close();
    }
  });

  it('목록과 unread-count는 권한과 무관하게 자기 recipient_user_id만 읽는다', async () => {
    const own = await list();
    expect(ids(own)).toEqual(expectedIds());
    const other = await list({}, otherCookie);
    expect(other.items).toHaveLength(2);
    expect(ids(other)).toContain(Number(otherNotification.notification_id));
    expect(ids(other).some((id) => ids(own).includes(id))).toBe(false);
    expect(await unreadCount()).toBe(6);
    expect(await unreadCount(otherCookie)).toBe(2);
  });

  it('클라이언트가 보낸 userId와 수신자·작업자 헤더는 조회 주체를 바꾸지 않는다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/app/notifications')
      .set('Cookie', otherCookie)
      .set('X-Worker-No', '100027')
      .set('X-User-Id', String(userId))
      .query({
        ...PERIOD,
        userId: Number(userId),
        recipientUserId: Number(userId),
      })
      .expect(200);
    expect(response.body).toEqual(await list({}, otherCookie));
    const count = await request(app.getHttpServer())
      .get('/api/app/notifications/unread-count')
      .set('Cookie', otherCookie)
      .query({ userId: Number(userId) })
      .expect(200);
    expect(count.body).toEqual({ unreadCount: 2 });
  });

  it('목록은 notification.created_at이 아닌 event.occurred_at의 from 이상·to 미만을 적용한다', async () => {
    const response = await list();
    expect(ids(response)).toEqual(expectedIds());
    expect(ids(response)).not.toContain(Number(fixtures.before.notification_id));
    expect(ids(response)).not.toContain(Number(fixtures.to.notification_id));
    expect(ids(response)).not.toContain(Number(fixtures.after.notification_id));
    expect(response.page).toEqual({ page: 1, size: 50, total: 5 });
    expect(fixtures.from.created_at.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(fixtures.before.created_at.toISOString()).toBe('2026-09-06T05:00:00.000Z');
  });

  it.each([
    [{}, 'occurredFrom', 'REQUIRED'],
    [{ occurredFrom: PERIOD.occurredFrom }, 'occurredTo', 'REQUIRED'],
    [{ occurredTo: PERIOD.occurredTo }, 'occurredFrom', 'REQUIRED'],
    [{ ...PERIOD, occurredFrom: 'not-a-date' }, 'occurredFrom', 'INVALID'],
    [{ ...PERIOD, occurredTo: '2026-09-07' }, 'occurredTo', 'INVALID'],
    [{ ...PERIOD, occurredFrom: '2026-09-06T00:00:00' }, 'occurredFrom', 'INVALID'],
    [{ ...PERIOD, unreadOnly: 'yes' }, 'unreadOnly', 'INVALID'],
    [{ ...PERIOD, page: 'first' }, 'page', 'INVALID'],
    [{ ...PERIOD, size: 1.5 }, 'size', 'INVALID'],
  ])(
    '기간 누락·질의 형식 위반은 400이고 기본 1주를 만들지 않는다 (%j)',
    async (query, field, code) => {
      const response = await request(app.getHttpServer())
        .get('/api/app/notifications')
        .set('Cookie', cookie)
        .query(query)
        .expect(400);
      expect(validateError(response.body)).toBe(true);
      expect(validateError.errors ?? []).toEqual([]);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field, code })]),
      );
    },
  );

  it('같은 시각은 notification_id 내림차순이며 page.total은 필터 전체 건수다', async () => {
    const first = await list({ size: 2 });
    const second = await list({ size: 2, page: 2 });
    const third = await list({ size: 2, page: 3 });
    expect([...ids(first), ...ids(second), ...ids(third)]).toEqual(expectedIds());
    expect(first.page).toEqual({ page: 1, size: 2, total: 5 });
    expect(second.page).toEqual({ page: 2, size: 2, total: 5 });
    expect(third.page).toEqual({ page: 3, size: 2, total: 5 });
    const emptyPage = await list({ page: 4, size: 2 });
    expect(emptyPage).toEqual({
      items: [],
      page: { page: 4, size: 2, total: 5 },
    });
  });

  it('공용 페이지 기본값·크기 상한을 적용한다', async () => {
    expect((await list()).page).toEqual({ page: 1, size: 50, total: 5 });
    expect((await list({ page: 0, size: 999 })).page).toEqual({
      page: 1,
      size: 200,
      total: 5,
    });
  });

  it('unreadOnly true만 미읽음이고 eventCode는 정확 일치 필터다', async () => {
    expect(ids(await list({ unreadOnly: false }))).toEqual(expectedIds());
    const unread = await list({ unreadOnly: true });
    expect(ids(unread)).toEqual(
      [fixtures.last, fixtures.tieOlder, fixtures.from].map((row) => Number(row.notification_id)),
    );
    expect(unread.items.every((item) => !item.read)).toBe(true);
    expect(unread.page.total).toBe(3);
    const filtered = await list({
      unreadOnly: true,
      eventCode: EVENT_A,
      size: 1,
    });
    expect(ids(filtered)).toEqual([Number(fixtures.tieOlder.notification_id)]);
    expect(filtered.page).toEqual({ page: 1, size: 1, total: 2 });
    expect((await list({ eventCode: EVENT_B })).page.total).toBe(2);
    expect((await list({ eventCode: EVENT_A.toLowerCase() })).page.total).toBe(0);
  });

  it('미등록 eventCode 이력 필터는 빈 결과다', async () => {
    expect(await list({ eventCode: `${PREFIX}_MISSING` })).toEqual({
      items: [],
      page: { page: 1, size: 50, total: 0 },
    });
  });

  it.each([PERIOD.occurredFrom, '2026-09-05T16:59:59.999Z'])(
    'from과 to가 같거나 역전이면 빈 목록이다 (%s)',
    async (occurredTo) => {
      expect(await list({ occurredTo })).toEqual({
        items: [],
        page: { page: 1, size: 50, total: 0 },
      });
    },
  );

  it('메시지·코드는 저장값 그대로, read는 read_at, 필수6칸과 optional 생략을 검증한다', async () => {
    const response = await list();
    const sourceRows = [
      fixtures.last,
      fixtures.tieNewer,
      fixtures.tieOlder,
      fixtures.middle,
      fixtures.from,
    ];
    for (const row of sourceRows) {
      const item = response.items.find(
        (candidate) => candidate.notificationId === Number(row.notification_id),
      );
      expect(item).toMatchObject({
        notificationId: Number(row.notification_id),
        eventCode: row.notification_event.event_type_code,
        message: row.message,
        occurredAt: row.notification_event.occurred_at.toISOString(),
        read: row.read_at !== null,
        openable: false,
      });
      expect(item).not.toHaveProperty('title');
      expect(item).not.toHaveProperty('screenId');
      expect(item).not.toHaveProperty('locationPath');
    }
  });

  it('화면 원천 없는 대상은 openable false이며 아는 대상 쌍을 보존한다', async () => {
    // 설계 미정 — 문의 102: payload에 비슷한 키가 있어도 화면·위치를 도출하지 않는다.
    const response = await list();
    const item = response.items.find(
      (candidate) => candidate.notificationId === Number(fixtures.from.notification_id),
    );
    expect(item).toMatchObject({
      openable: false,
      targetTypeCode: 'EQUIPMENT',
      targetId: Number(fixtures.from.notification_event.aggregate_id),
    });
    expect(item).not.toHaveProperty('screenId');
    expect(item).not.toHaveProperty('locationPath');
  });

  it('계약 enum 밖 과거 대상유형은 optional 대상 짝을 생략한다', async () => {
    // 설계 미정 — 문의 102
    const response = await list();
    const item = response.items.find(
      (candidate) => candidate.notificationId === Number(fixtures.middle.notification_id),
    );
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('targetTypeCode');
    expect(item).not.toHaveProperty('targetId');
    expect(Object.keys(item ?? {}).sort()).toEqual(
      ['notificationId', 'eventCode', 'message', 'occurredAt', 'read', 'openable'].sort(),
    );
  });

  it('하노이 날짜 마지막 밀리초를 포함하고 익일 자정은 제외하며 동등한 offset은 같은 목록이다', async () => {
    const hanoi = await list();
    const utc = await list({
      occurredFrom: '2026-09-05T17:00:00.000Z',
      occurredTo: '2026-09-06T17:00:00.000Z',
    });
    const seoul = await list({
      occurredFrom: '2026-09-06T02:00:00+09:00',
      occurredTo: '2026-09-07T02:00:00+09:00',
    });
    expect(utc).toEqual(hanoi);
    expect(seoul).toEqual(hanoi);
    expect(ids(hanoi)).toContain(Number(fixtures.last.notification_id));
    expect(ids(hanoi)).not.toContain(Number(fixtures.to.notification_id));
  });

  it('unread-count는 기간·이벤트·페이지 필터 밖 자기 미읽음도 센다', async () => {
    const filtered = await list({
      unreadOnly: true,
      eventCode: EVENT_B,
      size: 1,
    });
    expect(filtered.page.total).toBe(1);
    expect(await unreadCount()).toBe(6);
    const response = await request(app.getHttpServer())
      .get('/api/app/notifications/unread-count')
      .set('Cookie', cookie)
      .query({ ...PERIOD, eventCode: EVENT_B, unreadOnly: false, size: 1 })
      .expect(200);
    expect(response.body).toEqual({ unreadCount: 6 });
  });

  it('받은 알림이 없는 사용자는 빈 목록과 unreadCount 0이다', async () => {
    expect(await list({}, emptyCookie)).toEqual({
      items: [],
      page: { page: 1, size: 50, total: 0 },
    });
    expect(await unreadCount(emptyCookie)).toBe(0);
  });

  it.each(['/app/notifications', '/app/notifications/unread-count'])(
    '세션 없음·terminal-only·비활성 계정은 401이다 (%s)',
    async (path) => {
      const anonymous = await request(app.getHttpServer()).get(`/api${path}`).expect(401);
      expect(anonymous.body.errors[0]).toMatchObject({
        scope: 'screen',
        code: 'PERMISSION_DENIED',
      });
      await request(app.getHttpServer())
        .get(`/api${path}`)
        .query(PERIOD)
        .set('Authorization', `Bearer ${terminalToken}`)
        .set('X-Worker-No', '100027')
        .expect(401);
      await request(app.getHttpServer())
        .get(`/api${path}`)
        .query(PERIOD)
        .set('Cookie', `${SESSION_COOKIE}=${terminalToken}`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/api${path}`)
        .query(PERIOD)
        .set('Cookie', inactiveCookie)
        .expect(401);
    },
  );

  it('조회 뒤 자기·다른 사람의 알림과 발생 원문은 변하지 않는다', async () => {
    for (const row of [...Object.values(fixtures), otherNotification]) {
      const actual = await prisma.notification.findUniqueOrThrow({
        where: { notification_id: row.notification_id },
        include: { notification_event: true },
      });
      expect(actual).toEqual(row);
    }
  });

  it.each([
    ['000001', 1],
    ['0000001', 1],
    ['000000001', 1],
    ['0000000001', 1],
    ['0000010', 1],
    ['000001000', 1],
    ['0000010000', 1],
    ['0000011', 2],
    ['000001001', 2],
    ['0000010001', 2],
  ])(
    '소수 %s의 from 이상·to 미만은 저장된 마이크로초 격자와 정확히 비교한다',
    async (fraction, firstIndex) => {
      const boundary = `2026-12-31T16:59:59.${fraction}Z`;
      const lower = await precisionList(boundary, '2026-12-31T16:59:59.000003Z');
      const upper = await precisionList('2026-12-31T16:59:59.000000Z', boundary);
      expect(ids(lower)).toEqual(precisionIds.slice(firstIndex, 3).reverse());
      expect(lower.page.total).toBe(3 - firstIndex);
      expect(ids(upper)).toEqual(precisionIds.slice(0, firstIndex).reverse());
      expect(upper.page.total).toBe(firstIndex);
      expect((await precisionList(boundary, boundary)).page.total).toBe(0);
    },
  );

  it.each(['000001', '0000001', '000001001', '0000010001'])(
    '소수 %s의 UTC·+07:00·음수 offset은 동등한 순간의 결과다',
    async (fraction) => {
      const utc = await precisionList(
        `2026-12-31T16:59:59.${fraction}Z`,
        '2026-12-31T17:00:00.000001Z',
      );
      const hanoi = await precisionList(
        `2026-12-31T23:59:59.${fraction}+07:00`,
        '2027-01-01T00:00:00.000001+07:00',
      );
      const negativeOffset = await precisionList(
        `2026-12-31T11:29:59.${fraction}-05:30`,
        '2026-12-31T11:30:00.000001-05:30',
      );
      expect(hanoi).toEqual(utc);
      expect(negativeOffset).toEqual(utc);
    },
  );

  it.each(['999999', '9999991', '999999001', '9999990001'])(
    '.%s의 경계는 하노이 익년 자정으로 이월되어도 반열림을 지킨다',
    async (fraction) => {
      const boundary = `2026-12-31T23:59:59.${fraction}+07:00`;
      const lower = await precisionList(boundary, '2027-01-01T00:00:00.000002+07:00');
      const upper = await precisionList('2026-12-31T23:59:59.999998+07:00', boundary);
      const hasRemainder = fraction.length > 6;
      expect(ids(lower)).toEqual(precisionIds.slice(hasRemainder ? 4 : 3).reverse());
      expect(lower.page.total).toBe(hasRemainder ? 2 : 3);
      expect(ids(upper)).toEqual(hasRemainder ? [precisionIds[3]] : []);
      expect(upper.page.total).toBe(hasRemainder ? 1 : 0);
      const utc = await precisionList(
        `2026-12-31T16:59:59.${fraction}Z`,
        '2026-12-31T17:00:00.000002Z',
      );
      expect(utc).toEqual(lower);
    },
  );

  it.each(['T', 't', ' ', '\t', '\n', '\r'])(
    '구분자 %j와 offset 표기는 소수 없음·6자리·캐리 모두 같은 HTTP ID와 총수다',
    async (separator) => {
      for (const [fraction, firstIndex] of [
        ['', 0],
        ['.000001', 1],
        ['.9999991', 4],
      ] as const) {
        const utcBoundary = `2026-12-31T16:59:59${fraction}Z`;
        const expectedLower = await precisionList(utcBoundary, '2026-12-31T17:00:00.000002Z');
        const expectedUpper = await precisionList('2026-12-31T16:59:58Z', utcBoundary);
        expect(ids(expectedLower)).toEqual(precisionIds.slice(firstIndex).reverse());
        expect(expectedLower.page.total).toBe(6 - firstIndex);
        expect(ids(expectedUpper)).toEqual(precisionIds.slice(0, firstIndex).reverse());
        expect(expectedUpper.page.total).toBe(firstIndex);

        for (const [offset, time, nextTime, nextDate] of [
          ['Z', '16:59', '17:00', '2026-12-31'],
          ['z', '16:59', '17:00', '2026-12-31'],
          ['+07:00', '23:59', '00:00', '2027-01-01'],
          ['+0700', '23:59', '00:00', '2027-01-01'],
          ['+07', '23:59', '00:00', '2027-01-01'],
          ['-0530', '11:29', '11:30', '2026-12-31'],
          ['-05', '11:59', '12:00', '2026-12-31'],
        ]) {
          const boundary = `2026-12-31${separator}${time}:59${fraction}${offset}`;
          const lower = await precisionList(
            boundary,
            `${nextDate}${separator}${nextTime}:00.000002${offset}`,
          );
          const upper = await precisionList(`2026-12-31${separator}${time}:58${offset}`, boundary);
          expect(lower).toEqual(expectedLower);
          expect(upper).toEqual(expectedUpper);
        }
      }
    },
  );

  it('서로 다른 µs 경계가 같은 격자로 올려지면 빈 집합이고 역전도 빈 집합이다', async () => {
    for (const [from, to] of [
      ['0000001', '0000009'],
      ['0000009', '0000001'],
      ['0000011', '0000010'],
    ]) {
      const response = await precisionList(
        `2026-12-31T16:59:59.${from}Z`,
        `2026-12-31T16:59:59.${to}Z`,
      );
      expect(response.items).toEqual([]);
      expect(response.page.total).toBe(0);
    }
  });

  it('마이크로초 필터의 페이지 총수는 같은 조건이며 조회 뒤 저장 원문은 불변이다', async () => {
    const response = await list(
      {
        occurredFrom: '2026-12-31T16:59:59.0000000001Z',
        occurredTo: '2026-12-31T17:00:00.0000000001Z',
        size: 1,
      },
      precisionCookie,
    );
    expect(ids(response)).toEqual([precisionIds[4]]);
    expect(response.page).toEqual({ page: 1, size: 1, total: 4 });
    expect(await readPrecisionSnapshot()).toEqual(precisionSnapshot);
    const stored = await prisma.$queryRaw<{ microseconds: string }[]>`
      SELECT to_char(e.occurred_at, 'US') AS microseconds
        FROM app.notification_event e
        JOIN app.notification n USING (notification_event_id)
       WHERE n.recipient_user_id = ${precisionUserId}
       ORDER BY e.occurred_at`;
    expect(stored.map((row) => row.microseconds)).toEqual([
      '000000',
      '000001',
      '000002',
      '999999',
      '000000',
      '000001',
    ]);
  });

  describe('읽음 쓰기와 재전송', () => {
    let writerId: bigint;
    let foreignId: bigint;
    let writerCookie: string;
    let foreignCookie: string;
    let first: NotificationRow;
    let outside: NotificationRow;
    let alreadyRead: NotificationRow;
    let foreign: NotificationRow;
    const readPath = '/app/notifications/{notificationId}:read';
    const allPath = '/api/app/notifications:read-all';
    const validateReadAll = validator('/app/notifications:read-all', 200, 'post');
    const validateNotFound = validator(readPath, 404, 'post');
    const validateForbidden = validator(readPath, 403, 'post');
    const validateConflict = validator('#/components/schemas/ConflictResponse');

    beforeEach(async () => {
      const accounts = [];
      for (const name of ['writer', 'foreign']) {
        const user = await prisma.app_user.create({
          data: {
            login_id: `${PREFIX}_${name}_${userIds.length}`,
            user_name: `알림 읽음 ${name}`,
            status_code: 'EMPLOYED',
          },
        });
        userIds.push(user.app_user_id);
        accounts.push(user);
        await prisma.user_role.create({
          data: { app_user_id: user.app_user_id, role_id: roleIds[0] },
        });
      }
      [writerId, foreignId] = accounts.map((user) => user.app_user_id);
      [writerCookie, foreignCookie] = accounts.map(
        (user) =>
          `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`,
      );
      first = await createNotification(writerId, '2026-09-06T05:00:00.000Z');
      outside = await createNotification(writerId, '2026-09-07T05:00:00.000Z', {
        eventCode: EVENT_B,
      });
      alreadyRead = await createNotification(writerId, '2026-09-06T06:00:00.000Z', {
        isRead: true,
      });
      foreign = await createNotification(foreignId, '2026-09-06T05:00:00.000Z');
    });

    it('최초·같은 키 재전송·다른 키 이미 읽음은 204 무본문이며 최초 시각을 보존한다', async () => {
      const key = newKey();
      const initial = await read(first.notification_id, key).expect(204);
      expect(initial.text).toBe('');
      const stored = await storedNotification(first.notification_id);
      expect(stored.read_at).toBeInstanceOf(Date);
      expect(stored).toEqual({ ...first, read_at: stored.read_at });
      const record = await prisma.idempotency_record.findUniqueOrThrow({
        where: { idempotency_key: key },
      });
      expect(record).toMatchObject({
        app_user_id: writerId,
        status: 'COMPLETED',
        response_status: 204,
        response_body: null,
      });
      for (const nextKey of [key, newKey()]) {
        const replay = await read(first.notification_id, nextKey).expect(204);
        expect(replay.text).toBe('');
        expect(await storedNotification(first.notification_id)).toEqual(stored);
      }
      expect((await read(alreadyRead.notification_id).expect(204)).text).toBe('');
      expect(await storedNotification(alreadyRead.notification_id)).toEqual(alreadyRead);
    });

    it('openable false 알림도 읽음 뒤 미읽음 목록과 배지에서 빠지고 전체 목록에 남는다', async () => {
      expect((await list({ unreadOnly: true }, writerCookie)).items[0]).toMatchObject({
        notificationId: Number(first.notification_id),
        openable: false,
        read: false,
      });
      expect(await unreadCount(writerCookie)).toBe(2);
      await read(first.notification_id).expect(204);
      expect((await list({ unreadOnly: true }, writerCookie)).items).toEqual([]);
      expect(await unreadCount(writerCookie)).toBe(1);
      expect((await list({}, writerCookie)).items).toContainEqual(
        expect.objectContaining({ notificationId: Number(first.notification_id), read: true }),
      );
      expect(await storedNotification(foreign.notification_id)).toEqual(foreign);
    });

    it('권한 있는 사용자도 남의 알림과 없는 알림은 동일한 404이며 원문은 불변이다', async () => {
      const hidden = await read(foreign.notification_id).expect(404);
      const missing = await read(-1n).expect(404);
      expect(validateNotFound(hidden.body)).toBe(true);
      expect(hidden.body).toEqual(missing.body);
      expect(hidden.body.errors).toEqual([
        { scope: 'screen', code: 'NOT_FOUND', message: '알림을 찾을 수 없습니다.' },
      ]);
      expect(await storedNotification(foreign.notification_id)).toEqual(foreign);
      expect(await storedNotification(first.notification_id)).toEqual(first);
    });

    it('read-all은 필터 밖 자기 미읽음의 실제 2건만 바꾸고 새 키 0건도 200이다', async () => {
      expect((await list({ eventCode: EVENT_A }, writerCookie)).page.total).toBe(2);
      const response = await readAll()
        .query({ ...PERIOD, eventCode: EVENT_A, size: 1, userId: Number(foreignId) })
        .expect(200);
      expect(validateReadAll(response.body)).toBe(true);
      expect(response.body).toEqual({ readCount: 2 });
      for (const row of [first, outside]) {
        const actual = await storedNotification(row.notification_id);
        expect(actual.read_at).toBeInstanceOf(Date);
        expect(actual).toEqual({ ...row, read_at: actual.read_at });
      }
      expect(await storedNotification(alreadyRead.notification_id)).toEqual(alreadyRead);
      expect(await storedNotification(foreign.notification_id)).toEqual(foreign);
      expect(await unreadCount(writerCookie)).toBe(0);
      const empty = await readAll().expect(200);
      expect(validateReadAll(empty.body)).toBe(true);
      expect(empty.body).toEqual({ readCount: 0 });
    });

    it('같은 키 read-all은 최초 count를 재생하며 뒤의 새 알림은 배지·목록에 남는다', async () => {
      const key = newKey();
      expect((await readAll(key).expect(200)).body).toEqual({ readCount: 2 });
      const added = await createNotification(writerId, '2026-09-06T09:00:00.000Z');
      const replay = await readAll(key).set('If-Match', '999').expect(200);
      expect(validateReadAll(replay.body)).toBe(true);
      expect(replay.body).toEqual({ readCount: 2 });
      expect(await storedNotification(added.notification_id)).toEqual(added);
      expect(await unreadCount(writerCookie)).toBe(1);
      expect(ids(await list({ unreadOnly: true }, writerCookie))).toEqual([
        Number(added.notification_id),
      ]);
      expect((await readAll().expect(200)).body).toEqual({ readCount: 1 });
      expect(await unreadCount(writerCookie)).toBe(0);
      expect((await list({ unreadOnly: true }, writerCookie)).items).toEqual([]);
    });

    it.each(['read', 'read-all'] as const)(
      '%s 동일 키의 다른 세션 주체는 409이며 앞 응답을 노출하지 않는다',
      async (action) => {
        // 설계 미정 — 문의 103: 개별 계약 미선언 409도 공용 ConflictResponse다.
        const key = newKey();
        const initial = action === 'read' ? read(first.notification_id, key) : readAll(key);
        await initial.expect(action === 'read' ? 204 : 200);
        const retry =
          action === 'read'
            ? read(first.notification_id, key, foreignCookie)
            : readAll(key, foreignCookie);
        const response = await retry.expect(409);
        expect(validateConflict(response.body)).toBe(true);
        expect(Object.keys(response.body).sort()).toEqual(['conflictCause', 'message']);
        expect(response.body.conflictCause).toBe('user');
        expect(await storedNotification(foreign.notification_id)).toEqual(foreign);
        expect(await unreadCount(foreignCookie)).toBe(1);
      },
    );

    it('동일 키의 다른 알림·다른 operation·다른 본문은 409이며 새 알림은 남는다', async () => {
      const key = newKey();
      await read(first.notification_id, key).expect(204);
      for (const retry of [
        () => read(outside.notification_id, key),
        () => readAll(key),
        () => read(first.notification_id, key).send({ userId: Number(foreignId) }),
      ]) {
        const response = await retry().expect(409);
        expect(validateConflict(response.body)).toBe(true);
        expect(Object.keys(response.body).sort()).toEqual(['conflictCause', 'message']);
        expect(response.body.conflictCause).toBe('user');
      }
      expect(await storedNotification(outside.notification_id)).toEqual(outside);
    });

    it('입력 userId·수신자·작업자 헤더로 세션의 읽음 대상을 바꾸지 못한다', async () => {
      await read(first.notification_id)
        .set('X-Worker-No', '100027')
        .set('X-User-Id', String(foreignId))
        .send({ userId: Number(foreignId), recipientUserId: Number(foreignId) })
        .expect(204);
      expect((await storedNotification(first.notification_id)).read_at).toBeInstanceOf(Date);
      expect(await storedNotification(foreign.notification_id)).toEqual(foreign);
    });

    it('권한 없는 read는 403이며 같은 사용자의 GET·read-all은 추가 게이트가 없다', async () => {
      const row = await createNotification(otherUserId, '2026-09-06T08:00:00.000Z');
      const response = await read(row.notification_id, newKey(), otherCookie).expect(403);
      expect(validateForbidden(response.body)).toBe(true);
      expect(response.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(await storedNotification(row.notification_id)).toEqual(row);
      expect(ids(await list({}, otherCookie))).toContain(Number(row.notification_id));
      expect(await unreadCount(otherCookie)).toBe(3);
      expect((await readAll(newKey(), otherCookie).expect(200)).body).toEqual({ readCount: 3 });
      expect(await unreadCount(otherCookie)).toBe(0);
    });

    it.each(['read', 'read-all'] as const)(
      '%s 세션 없음·terminal-only·비활성 세션은 401이며 쓰기가 없다',
      async (action) => {
        const path = action === 'read' ? singlePath(first.notification_id) : allPath;
        for (const headers of [
          {},
          { Authorization: `Bearer ${terminalToken}`, 'X-Worker-No': '100027' },
          { Cookie: `${SESSION_COOKIE}=${terminalToken}` },
          { Cookie: inactiveCookie },
        ]) {
          const response = await request(app.getHttpServer())
            .post(path)
            .set('Idempotency-Key', newKey())
            .set(headers)
            .expect(401);
          expect(validateError(response.body)).toBe(true);
          expect(response.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
        }
        expect(await storedNotification(first.notification_id)).toEqual(first);
      },
    );

    it.each(['read', 'read-all'] as const)(
      '%s 멱등 헤더 누락·빈 값·잘못된 UUID는 공용 REQUIRED/INVALID 400이다',
      async (action) => {
        const path = action === 'read' ? singlePath(first.notification_id) : allPath;
        for (const [key, code] of [
          [undefined, 'REQUIRED'],
          ['', 'REQUIRED'],
          ['invalid', 'INVALID'],
        ]) {
          const call = request(app.getHttpServer()).post(path).set('Cookie', writerCookie);
          if (key !== undefined) call.set('Idempotency-Key', key);
          const response = await call.expect(400);
          expect(validateError(response.body)).toBe(true);
          expect(response.body.errors[0]).toMatchObject({ scope: 'screen', code });
          expect(response.body.errors[0].message).toContain('Idempotency-Key');
        }
        expect(await storedNotification(first.notification_id)).toEqual(first);
      },
    );

    it.each(['not-an-id', '1.5'])(
      'notificationId=%s는 정확한 필드의 INVALID 400이며 읽음 처리가 없다',
      async (id) => {
        const response = await request(app.getHttpServer())
          .post(`/api/app/notifications/${id}:read`)
          .set('Cookie', writerCookie)
          .set('Idempotency-Key', newKey())
          .expect(400);
        expect(validateError(response.body)).toBe(true);
        expect(response.body.errors).toEqual([
          expect.objectContaining({ scope: 'field', field: 'notificationId', code: 'INVALID' }),
        ]);
        expect(await storedNotification(first.notification_id)).toEqual(first);
      },
    );

    it('동시 단건 read·read-all은 잠긴 행을 다시 세지 않고 실제 변경 1건만 반환한다', async () => {
      const service = app.get(NotificationWriteService);
      const originalRead = service.readWithin.bind(service);
      const originalReadAll = service.readAllWithin.bind(service);
      let releaseRead = (): void => undefined;
      let signalLocked = (): void => undefined;
      let signalAllStarted = (): void => undefined;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const allStarted = new Promise<void>((resolve) => {
        signalAllStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const singleSpy = jest
        .spyOn(service, 'readWithin')
        .mockImplementationOnce(async (...args) => {
          await originalRead(...args);
          signalLocked();
          await released;
        });
      const allSpy = jest.spyOn(service, 'readAllWithin').mockImplementationOnce((...args) => {
        signalAllStarted();
        return originalReadAll(...args);
      });
      try {
        const single = read(first.notification_id)
          .expect(204)
          .then((response) => response);
        await locked;
        const all = readAll()
          .expect(200)
          .then((response) => response);
        await allStarted;
        releaseRead();
        const [singleResponse, allResponse] = await Promise.all([single, all]);
        expect(singleResponse.text).toBe('');
        expect(allResponse.body).toEqual({ readCount: 1 });
        expect(await unreadCount(writerCookie)).toBe(0);
        expect(await storedNotification(foreign.notification_id)).toEqual(foreign);
      } finally {
        releaseRead();
        singleSpy.mockRestore();
        allSpy.mockRestore();
      }
    });

    it('서로 다른 키의 동시 read-all은 실제 2건을 한 번만 센다', async () => {
      const responses = await Promise.all([readAll().expect(200), readAll().expect(200)]);
      expect(responses.map((response) => response.body.readCount).sort()).toEqual([0, 2]);
      expect(await unreadCount(writerCookie)).toBe(0);
      expect(await storedNotification(foreign.notification_id)).toEqual(foreign);
    });

    it.each(['read', 'read-all'] as const)(
      '%s 같은 키의 동시 HTTP 재전송은 완료 기록 하나와 같은 응답이다',
      async (action) => {
        const key = newKey();
        const send = (): request.Test =>
          action === 'read' ? read(first.notification_id, key) : readAll(key);
        const responses = await Promise.all([
          send().expect(action === 'read' ? 204 : 200),
          send().expect(action === 'read' ? 204 : 200),
        ]);
        expect(responses[0].text).toBe(responses[1].text);
        expect(responses[0].body).toEqual(action === 'read' ? {} : { readCount: 2 });
        expect(
          await prisma.idempotency_record.count({
            where: { idempotency_key: key, status: 'COMPLETED' },
          }),
        ).toBe(1);
      },
    );

    it.each(['read', 'read-all'] as const)(
      '%s 멱등 완료기록 실패는 read_at까지 롤백하고 같은 키 재시도가 실행된다',
      async (action) => {
        const key = newKey();
        const runTransaction = prisma.$transaction.bind(prisma);
        const transactionSpy = jest
          .spyOn(prisma, '$transaction')
          .mockImplementationOnce(async (work) =>
            runTransaction(async (tx) => {
              const completionSpy = jest
                .spyOn(tx.idempotency_record, 'update')
                .mockRejectedValueOnce(new Error('I28_TEST_COMPLETION_FAILURE'));
              try {
                return await (work as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx);
              } finally {
                expect(completionSpy).toHaveBeenCalledWith({
                  where: { idempotency_key: key },
                  data: expect.objectContaining({
                    status: 'COMPLETED',
                    response_status: action === 'read' ? 204 : 200,
                  }),
                });
                completionSpy.mockRestore();
              }
            }),
          );
        const send = (): request.Test =>
          action === 'read' ? read(first.notification_id, key) : readAll(key);
        try {
          const failure = await send().expect(500);
          expect(validateError(failure.body)).toBe(true);
          expect(failure.text).not.toContain('I28_TEST_COMPLETION_FAILURE');
        } finally {
          transactionSpy.mockRestore();
        }
        expect(await storedNotification(first.notification_id)).toEqual(first);
        expect(await storedNotification(outside.notification_id)).toEqual(outside);
        expect(await storedNotification(alreadyRead.notification_id)).toEqual(alreadyRead);
        expect(
          await prisma.idempotency_record.findUnique({
            where: { idempotency_key: key },
          }),
        ).toBeNull();
        const success = await send().expect(action === 'read' ? 204 : 200);
        expect(success.body).toEqual(action === 'read' ? {} : { readCount: 2 });
        const replay = await send().expect(action === 'read' ? 204 : 200);
        expect(replay.text).toBe(success.text);
        expect(await unreadCount(writerCookie)).toBe(action === 'read' ? 1 : 0);
      },
    );

    function singlePath(id: bigint): string {
      return `/api/app/notifications/${id}:read`;
    }

    function read(id: bigint, key = newKey(), sessionCookie = writerCookie): request.Test {
      return request(app.getHttpServer())
        .post(singlePath(id))
        .set('Cookie', sessionCookie)
        .set('Idempotency-Key', key);
    }

    function readAll(key = newKey(), sessionCookie = writerCookie): request.Test {
      return request(app.getHttpServer())
        .post(allPath)
        .set('Cookie', sessionCookie)
        .set('Idempotency-Key', key);
    }

    function storedNotification(id: bigint): Promise<NotificationRow> {
      return prisma.notification.findUniqueOrThrow({
        where: { notification_id: id },
        include: { notification_event: true },
      });
    }
  });

  function newKey(): string {
    const key = randomUUID();
    idempotencyKeys.push(key);
    return key;
  }

  async function createPrecisionNotification(timestamp: string): Promise<number> {
    const events = await prisma.$queryRaw<{ notification_event_id: bigint }[]>`
      INSERT INTO app.notification_event
        (event_type_code, aggregate_type_code, aggregate_id, occurred_at)
      VALUES (${`${PREFIX}_MICRO`}, 'EQUIPMENT', ${BigInt(eventIds.length + 1)}, ${timestamp}::timestamptz)
      RETURNING notification_event_id`;
    const eventId = events[0].notification_event_id;
    eventIds.push(eventId);
    const row = await prisma.notification.create({
      data: {
        notification_event_id: eventId,
        recipient_user_id: precisionUserId,
        title: `${PREFIX} 정밀도 시험`,
        message: `${PREFIX} 원문 ${timestamp}`,
      },
    });
    notificationIds.push(row.notification_id);
    return Number(row.notification_id);
  }

  function readPrecisionSnapshot(): Promise<unknown[]> {
    return prisma.$queryRaw`
      SELECT to_jsonb(n) AS notification, to_jsonb(e) AS event
        FROM app.notification n
        JOIN app.notification_event e USING (notification_event_id)
       WHERE n.recipient_user_id = ${precisionUserId}
       ORDER BY n.notification_id`;
  }

  function precisionList(from: string, to: string): Promise<PagedResponse<NotificationView>> {
    return list({ occurredFrom: from, occurredTo: to }, precisionCookie);
  }

  async function createNotification(
    recipientUserId: bigint,
    occurredAt: string,
    options: { eventCode?: string; isRead?: boolean; targetType?: string } = {},
  ): Promise<NotificationRow> {
    const event = await prisma.notification_event.create({
      data: {
        event_type_code: options.eventCode ?? EVENT_A,
        aggregate_type_code: options.targetType ?? 'EQUIPMENT',
        aggregate_id: BigInt(eventIds.length + 1),
        occurred_at: new Date(occurredAt),
        payload: {
          screenId: 'W-FAKE',
          locationPath: '추측 위치',
          message: '다른 메시지',
        },
      },
    });
    eventIds.push(event.notification_event_id);
    const isOutside =
      occurredAt < '2026-09-05T17:00:00.000Z' || occurredAt >= '2026-09-06T17:00:00.000Z';
    const row = await prisma.notification.create({
      data: {
        notification_event_id: event.notification_event_id,
        recipient_user_id: recipientUserId,
        title: `${PREFIX} 다시 조립하면 안 되는 제목`,
        message: `${PREFIX} 원문 · Nội dung ${eventIds.length}`,
        read_at: options.isRead ? new Date('2026-09-07T00:00:00.000Z') : null,
        created_at: new Date(isOutside ? '2026-09-06T05:00:00.000Z' : '2030-01-01T00:00:00.000Z'),
      },
      include: { notification_event: true },
    });
    notificationIds.push(row.notification_id);
    return row;
  }

  async function list(
    query: Record<string, string | number | boolean> = {},
    sessionCookie = cookie,
  ): Promise<PagedResponse<NotificationView>> {
    const response = await request(app.getHttpServer())
      .get('/api/app/notifications')
      .set('Cookie', sessionCookie)
      .query({ ...PERIOD, ...query })
      .expect(200);
    expect(validateList(response.body)).toBe(true);
    expect(validateList.errors ?? []).toEqual([]);
    return response.body as PagedResponse<NotificationView>;
  }

  async function unreadCount(sessionCookie = cookie): Promise<number> {
    const response = await request(app.getHttpServer())
      .get('/api/app/notifications/unread-count')
      .set('Cookie', sessionCookie)
      .expect(200);
    expect(validateCount(response.body)).toBe(true);
    expect(validateCount.errors ?? []).toEqual([]);
    return (response.body as { unreadCount: number }).unreadCount;
  }

  function ids(response: PagedResponse<NotificationView>): number[] {
    return response.items.map((item) => item.notificationId);
  }

  function expectedIds(): number[] {
    return [
      fixtures.last,
      fixtures.tieNewer,
      fixtures.tieOlder,
      fixtures.middle,
      fixtures.from,
    ].map((row) => Number(row.notification_id));
  }
});
