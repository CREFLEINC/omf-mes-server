/**
 * 생산 4종 알림 — 작업 시작·중단·종료와 W/O 마감(omf-all-around#160 · 장부 P-93).
 *
 * 설정은 PUT API 로 넣는다. 부서는 W/O 라인 «자신»의 담당 부서다. 생성기는 업무 tx 안에서 돈다 —
 * 업무가 롤백되면 알림도 없다(FR-008).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { SecretBox } from '../src/core/crypto/secret-box';
import { NotificationEmitter, formatEventTime } from '../src/core/notification';
import { SyncLease } from '../src/integration/erp/sync-lease';
import { ZaloClient } from '../src/integration/zalo/zalo-client';
import { ZaloDeliveryRunner } from '../src/integration/zalo/zalo-delivery.runner';
import { ZaloTokenService } from '../src/integration/zalo/zalo-token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { startZaloStub } from './support/zalo-stub';

const PREFIX = `NPRD${randomUUID().slice(0, 6)}`;
const SESSIONS = '/api/production/work-sessions';
const WORK_ORDERS = '/api/production/work-orders';
const PERMISSIONS = ['P-02-01', 'P-02-10', 'W-02-05', 'M-CO-01', 'W-CO-11', 'W-CO-03'];

type Fixture = Record<string, bigint>;

describe('생산 알림 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let admin: string;
  let token: string;
  const ids: Fixture = {};
  const userIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    await makeFixtures();
    admin = cookieOf(ids.admin);
    token = await issueToken();
    // 부서 A — 시작·중단·종료·마감을 켜고 Zalo 도 켠다. 부서 B — 아무것도 안 켠다.
    for (const eventCode of ['WORK_SESSION_STARTED', 'WORK_SESSION_STOPPED', 'WORK_SESSION_ENDED', 'WORK_ORDER_CLOSED']) {
      await putSetting(ids.deptA, eventCode, { enabled: true, zaloEnabled: true, recipientUserIds: [Number(ids.rPhone), Number(ids.rNoPhone)] });
    }
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  afterEach(() => jest.restoreAllMocks());

  it('US1-1 US6-2 SC-001 작업을 시작하면 라인 부서의 수신자마다 알림센터에 1건씩, 대상은 W/O 다', async () => {
    const wo = await workOrder('A1', ids.lineA);
    await start(wo, '2026-10-21T01:00:00.000Z').expect(201);

    const event = await eventOf('WORK_SESSION_STARTED', wo);
    expect(event).toMatchObject({ dispatch_status_code: 'NOTIFIED', department_id: ids.deptA, skip_reason_code: null });

    const inbox = await request(app.getHttpServer())
      .get('/api/app/notifications')
      .query({ occurredFrom: '2026-10-21T00:00:00.000Z', occurredTo: '2026-10-22T00:00:00.000Z', size: 100 })
      .set('Cookie', cookieOf(ids.rPhone))
      .expect(200);
    const mine = inbox.body.items.filter((n: { targetId?: number }) => n.targetId === Number(wo));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ eventCode: 'WORK_SESSION_STARTED', targetTypeCode: 'WORK_ORDER', occurredAt: '2026-10-21T01:00:00.000Z' });
    expect(mine[0].message).toBe(`${PREFIX}-A1 · ${PREFIX}-IT 알림검사품목 · 사출공정 · 알림라인A · 알림관리자 · 10-21 08:00`);
    expect(await recipientsOf(event.notification_event_id)).toEqual([ids.rPhone, ids.rNoPhone].sort());
  });

  it('US1-2 Zalo 켬 — 번호 있는 수신자만 PENDING 1건, template_data 키가 data-model §6 과 같다', async () => {
    const wo = await workOrder('A2', ids.lineA);
    await start(wo, '2026-10-21T02:00:00.000Z').expect(201);

    const deliveries = await deliveriesOf('WORK_SESSION_STARTED', wo);
    expect(deliveries.map((d) => d.recipient_user_id)).toEqual([ids.rPhone]);
    expect(deliveries[0]).toMatchObject({ status_code: 'PENDING', phone_number: '84912345678', attempt_count: 0 });
    expect(deliveries[0].tracking_id).toBe(`zd-${deliveries[0].zalo_delivery_id}`);
    expect(Object.keys(deliveries[0].template_data as object).sort()).toEqual(
      ['wo_no', 'item', 'process', 'line', 'event_time', 'actor'].sort(),
    );
    expect(deliveries[0].template_data).toMatchObject({ wo_no: `${PREFIX}-A2`, event_time: '21/10/2026 09:00' });
  });

  it('US1-7 SC-003 다른 부서 수신자는 받지 않는다', async () => {
    const wo = await workOrder('A3', ids.lineA);
    await start(wo, '2026-10-21T03:00:00.000Z').expect(201);
    const event = await eventOf('WORK_SESSION_STARTED', wo);
    expect(await prisma.notification.count({ where: { notification_event_id: event.notification_event_id, recipient_user_id: ids.rOther } })).toBe(0);
  });

  it('US1-6 SC-003 꺼진 이벤트는 0건이고 EVENT_DISABLED 로 남는다', async () => {
    const wo = await workOrder('B1', ids.lineB);
    await start(wo, '2026-10-21T04:00:00.000Z').expect(201);

    const event = await eventOf('WORK_SESSION_STARTED', wo);
    expect(event).toMatchObject({ dispatch_status_code: 'SKIPPED', skip_reason_code: 'EVENT_DISABLED', department_id: ids.deptB });
    expect(await prisma.notification.count({ where: { notification_event_id: event.notification_event_id } })).toBe(0);
  });

  it('US6-4 담당 부서가 없는 라인은 DEPARTMENT_UNRESOLVED 이고 업무는 성공한다', async () => {
    const wo = await workOrder('N1', ids.lineNone);
    await start(wo, '2026-10-21T05:00:00.000Z').expect(201);
    expect(await eventOf('WORK_SESSION_STARTED', wo)).toMatchObject({
      dispatch_status_code: 'SKIPPED', skip_reason_code: 'DEPARTMENT_UNRESOLVED', department_id: null,
    });
  });

  it('US6-3 라인 부서를 바꾸면 다음 발생부터 새 부서로 판정한다', async () => {
    const wo = await workOrder('C1', ids.lineChange);
    const first = await start(wo, '2026-10-21T06:00:00.000Z').expect(201);
    expect(await eventOf('WORK_SESSION_STARTED', wo)).toMatchObject({ department_id: ids.deptB, skip_reason_code: 'EVENT_DISABLED' });
    await end(first.body.workSessionId, '2026-10-21T06:10:00.000Z').expect(200);

    await prisma.production_line.update({ where: { production_line_id: ids.lineChange }, data: { department_id: ids.deptA } });
    await start(wo, '2026-10-21T06:20:00.000Z').expect(201);
    const events = await prisma.notification_event.findMany({
      where: { event_type_code: 'WORK_SESSION_STARTED', aggregate_id: wo },
      orderBy: { occurred_at: 'asc' },
    });
    expect(events.map((e) => [e.department_id, e.dispatch_status_code])).toEqual([
      [ids.deptB, 'SKIPPED'],
      [ids.deptA, 'NOTIFIED'],
    ]);
  });

  it('US1-3 SC-004 중단(STOP)은 사유를 싣고, 같은 Idempotency-Key 재전송은 추가 0건', async () => {
    const wo = await workOrder('S1', ids.lineA);
    const session = await start(wo, '2026-10-21T07:00:00.000Z').expect(201);
    const key = randomUUID();
    const body = { eventTypeCode: 'STOP', occurredAt: '2026-10-21T07:10:00.000Z', reasonCode: stopReason };
    await stop(session.body.workSessionId, body, key).expect(201);
    await stop(session.body.workSessionId, body, key).expect(201);

    const events = await prisma.notification_event.findMany({ where: { event_type_code: 'WORK_SESSION_STOPPED', aggregate_id: wo } });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ reason: stopReasonName });
    const notes = await prisma.notification.findMany({ where: { notification_event_id: events[0].notification_event_id } });
    expect(notes).toHaveLength(2);
    expect(notes[0].message).toContain(`중단 사유: ${stopReasonName}`);
  });

  it('US1-8 SC-004 :hold 다음 STOP 두 호출이면 중단 알림 1건, :hold 단독이면 0건', async () => {
    const wo = await workOrder('H1', ids.lineA);
    const session = await start(wo, '2026-10-21T08:00:00.000Z').expect(201);
    await hold(wo).expect(200);
    await stop(session.body.workSessionId, { eventTypeCode: 'STOP', occurredAt: '2026-10-21T08:05:00.000Z', reasonCode: stopReason }).expect(201);
    expect(await prisma.notification_event.count({ where: { event_type_code: 'WORK_SESSION_STOPPED', aggregate_id: wo } })).toBe(1);

    // :hold 는 열린 세션이 있어야 된다(장부 P-111) — 세션을 열고 STOP 없이 :hold 만 보낸다.
    const alone = await workOrder('H2', ids.lineA);
    await start(alone, '2026-10-21T08:00:00.000Z').expect(201);
    await hold(alone).expect(200);
    const events = await prisma.notification_event.findMany({ where: { aggregate_id: alone, aggregate_type_code: 'WORK_ORDER' } });
    expect(events.map((event) => event.event_type_code)).toEqual(['WORK_SESSION_STARTED']);
  });

  it('늦게 도착한 STOP 은 보낸 조작 시각으로 알린다 — 서버 수신 시각이 아니다', async () => {
    const wo = await workOrder('L1', ids.lineA);
    const session = await start(wo, new Date(Date.now() - 60 * 60 * 1000).toISOString()).expect(201);
    const sentAt = new Date(Date.now() - 30 * 60 * 1000);
    sentAt.setUTCMilliseconds(0);
    await stop(session.body.workSessionId, { eventTypeCode: 'STOP', occurredAt: sentAt.toISOString(), reasonCode: stopReason }).expect(201);

    const event = await eventOf('WORK_SESSION_STOPPED', wo);
    expect(event.occurred_at.toISOString()).toBe(sentAt.toISOString());
    const [delivery] = await deliveriesOf('WORK_SESSION_STOPPED', wo);
    expect((delivery.template_data as Record<string, string>).event_time).toBe(formatEventTime(sentAt));
  });

  it('US1-4 US1-5 종료는 계획·양품 누계 스냅샷을, 마감은 마감 때 누계를 싣는다(정정 원본 제외)', async () => {
    const wo = await workOrder('E1', ids.lineA);
    const session = await start(wo, '2026-10-21T09:00:00.000Z').expect(201);
    // 40 + (30 을 25 로 정정) = 65 — 정정된 원본은 누계에서 빠진다(ACTIVE_RESULT_WHERE).
    await result(wo, 1, 40);
    const original = await result(wo, 2, 30);
    await result(wo, 3, 25, original);
    await end(session.body.workSessionId, '2026-10-21T10:00:00.000Z').expect(200);

    const ended = await eventOf('WORK_SESSION_ENDED', wo);
    expect(ended.payload).toMatchObject({ plan_qty: '100', good_qty: '65' });
    const endedNote = await prisma.notification.findFirstOrThrow({ where: { notification_event_id: ended.notification_event_id } });
    expect(endedNote.message).toContain('계획 100 · 양품 65');

    await result(wo, 4, 5);
    await close(wo, 200);
    const closed = await prisma.notification_event.findMany({ where: { event_type_code: 'WORK_ORDER_CLOSED', aggregate_id: wo } });
    expect(closed).toHaveLength(1);
    expect(closed[0].payload).toMatchObject({ plan_qty: '100', good_qty: '70', actor: '알림관리자' });
    expect(await recipientsOf(closed[0].notification_event_id)).toEqual([ids.rPhone, ids.rNoPhone].sort());
  });

  it('US5-4 번호를 지우면 그 뒤로는 알림센터만 받고 Zalo 는 0건이다', async () => {
    await prisma.app_user.update({ where: { app_user_id: ids.rPhone }, data: { phone_number: null } });
    try {
      const wo = await workOrder('P1', ids.lineA);
      await start(wo, '2026-10-21T11:00:00.000Z').expect(201);
      expect(await recipientsOf((await eventOf('WORK_SESSION_STARTED', wo)).notification_event_id)).toHaveLength(2);
      expect(await deliveriesOf('WORK_SESSION_STARTED', wo)).toEqual([]);
    } finally {
      await prisma.app_user.update({ where: { app_user_id: ids.rPhone }, data: { phone_number: '84912345678' } });
    }
  });

  it('US1-9 SC-005 Zalo 연결이 없어도 업무는 성공하고 알림센터가 생기며 발송 건은 대기로 남는다', async () => {
    const connection = await prisma.zalo_connection.findUnique({ where: { zalo_connection_id: 1 } });
    expect(connection?.status_code ?? 'NOT_CONFIGURED').not.toBe('ACTIVE');
    const wo = await workOrder('Z1', ids.lineA);
    await start(wo, '2026-10-21T12:00:00.000Z').expect(201);
    expect(await recipientsOf((await eventOf('WORK_SESSION_STARTED', wo)).notification_event_id)).toHaveLength(2);
    expect((await deliveriesOf('WORK_SESSION_STARTED', wo)).map((d) => d.status_code)).toEqual(['PENDING']);
  });

  it('US1-9 SC-005 Zalo 연결은 켜졌지만 대역이 멈춰 있어도 업무는 성공하고, 러너는 그 건을 재시도 대기로 둔다', async () => {
    // 대역을 띄웠다 닫아 «응답하지 않는» 주소를 얻는다 — 실제 Zalo 장애 흉내.
    const stub = await startZaloStub();
    const deadUrl = stub.url;
    await stub.close();
    const box = new SecretBox(process.env.ZALO_CREDENTIAL_KEY as string);
    await prisma.zalo_connection.deleteMany();
    await prisma.zalo_connection.create({
      data: {
        zalo_connection_id: 1, app_id: 'APP-1', secret_key_enc: box.seal('s'), refresh_token_enc: box.seal('r'),
        access_token_enc: box.seal('a'), access_token_expires_at: new Date(Date.now() + 20 * 60 * 60 * 1000), last_refreshed_at: new Date(), status_code: 'ACTIVE',
      },
    });
    await prisma.zalo_template.upsert({
      where: { event_type_code: 'WORK_SESSION_STARTED' }, create: { event_type_code: 'WORK_SESSION_STARTED', template_id: 'TPL' }, update: {},
    });
    try {
      const wo = await workOrder('Z2', ids.lineA);
      const startedAt = new Date();
      startedAt.setUTCMilliseconds(0);
      // 업무 경로는 Zalo 를 부르지 않는다 — 대역이 죽어 있어도 바로 201 이다.
      await start(wo, startedAt.toISOString()).expect(201);
      expect(await recipientsOf((await eventOf('WORK_SESSION_STARTED', wo)).notification_event_id)).toHaveLength(2);

      const client = new ZaloClient({ apiBaseUrl: deadUrl, oauthBaseUrl: deadUrl, timeoutMs: 1000 });
      const runner = new ZaloDeliveryRunner(true, prisma, new SyncLease(prisma, `${PREFIX}-lease`), client, new ZaloTokenService(prisma, box, client));
      await runner.tick(new Date());
      const [delivery] = await deliveriesOf('WORK_SESSION_STARTED', wo);
      expect(delivery).toMatchObject({ status_code: 'PENDING', attempt_count: 1, last_error_code: 'NETWORK' });
      expect((await prisma.zalo_connection.findUniqueOrThrow({ where: { zalo_connection_id: 1 } })).status_code).toBe('ACTIVE');
    } finally {
      await prisma.$executeRaw`DELETE FROM integration.sync_lease WHERE lease_name = ${`${PREFIX}-lease`}`;
      await prisma.zalo_template.deleteMany();
      await prisma.zalo_connection.deleteMany();
    }
  });

  it('FR-008 마감에서 생성기를 부른 «뒤»에 실패하면 알림·발송·W/O 변경이 모두 롤백된다', async () => {
    const wo = await workOrder('R1', ids.lineA);
    await result(wo, 1, 100);
    const emitter = app.get(NotificationEmitter);
    const original = emitter.emit.bind(emitter);
    jest.spyOn(emitter, 'emit').mockImplementation(async (tx, input) => {
      const emitted = await original(tx, input);
      expect(emitted.notificationCount).toBe(2);
      throw new Error('주입한 실패 — 생성기 뒤');
    });

    await close(wo, 500, {});

    expect(await prisma.notification_event.count({ where: { aggregate_id: wo, event_type_code: 'WORK_ORDER_CLOSED' } })).toBe(0);
    expect(await prisma.zalo_delivery.count({ where: { notification_event: { aggregate_id: wo } } })).toBe(0);
    const row = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: wo } });
    expect(row.status_code).toBe('IN_PROGRESS');
    expect(row.closed_at).toBeNull();
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  let stopReason: string;
  let stopReasonName: string;
  let varianceReason: string;
  let resultSeq = 0;

  function cookieOf(userId: bigint): string {
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(userId), typ: 'session' })}`;
  }

  function putSetting(departmentId: bigint, eventCode: string, body: object) {
    return request(app.getHttpServer())
      .put(`/api/app/notification-settings/${departmentId}/${eventCode}`)
      .set('Cookie', admin)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send(body)
      .expect(200);
  }

  function start(workOrderId: bigint, startedAt: string) {
    return request(app.getHttpServer())
      .post(SESSIONS)
      .set('Cookie', admin)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${token}`)
      .set('X-Worker-No', `${PREFIX}-W1`)
      .send({ workOrderId: Number(workOrderId), startedAt });
  }

  function stop(workSessionId: number, body: object, key: string = randomUUID()) {
    return request(app.getHttpServer())
      .post(`${SESSIONS}/${workSessionId}/events`)
      .set('Cookie', admin)
      .set('Idempotency-Key', key)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Worker-No', `${PREFIX}-W1`)
      .send(body);
  }

  function end(workSessionId: number, endedAt: string) {
    return request(app.getHttpServer())
      .post(`${SESSIONS}/${workSessionId}:end`)
      .set('Cookie', admin)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${token}`)
      .set('X-Worker-No', `${PREFIX}-W1`)
      .send({ endedAt });
  }

  function hold(workOrderId: bigint) {
    return request(app.getHttpServer())
      .post(`${WORK_ORDERS}/${workOrderId}:hold`)
      .set('Cookie', admin)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'EQUIPMENT_FAULT', occurredAt: '2026-10-21T08:05:00.000Z' });
  }

  async function close(workOrderId: bigint, status: number, body?: object): Promise<request.Response> {
    const current = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } });
    return request(app.getHttpServer())
      .post(`${WORK_ORDERS}/${workOrderId}:close`)
      .set('Cookie', admin)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(current.version_no))
      .send(body ?? { remainderDispositionCode: 'WRITE_OFF', reasonCode: varianceReason })
      .expect(status);
  }

  async function result(workOrderId: bigint, seq: number, goodQty: number, corrects?: bigint): Promise<bigint> {
    resultSeq += 1;
    const row = await prisma.production_result.create({
      data: {
        production_result_no: `${PREFIX}-PR${resultSeq}`,
        work_order_id: workOrderId,
        result_sequence: seq,
        corrects_production_result_id: corrects ?? null,
        good_qty: goodQty,
        uom_id: ids.uom,
        result_source_code: 'MANUAL',
        occurred_at: new Date('2026-10-21T09:30:00.000Z'),
        worker_id: ids.worker,
        status_code: 'CONFIRMED',
        idempotency_key: `${PREFIX}-${randomUUID()}`,
      },
    });
    return row.production_result_id;
  }

  async function workOrder(suffix: string, lineId: bigint): Promise<bigint> {
    const row = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-${suffix}`,
        production_plan_id: ids.plan,
        routing_operation_id: ids.operation,
        item_id: ids.item,
        order_qty: 100,
        uom_id: ids.uom,
        status_code: 'IN_PROGRESS',
        production_line_id: lineId,
      },
    });
    return row.work_order_id;
  }

  function eventOf(eventCode: string, workOrderId: bigint) {
    return prisma.notification_event.findFirstOrThrow({
      where: { event_type_code: eventCode, aggregate_type_code: 'WORK_ORDER', aggregate_id: workOrderId },
      orderBy: { notification_event_id: 'desc' },
    });
  }

  async function recipientsOf(eventId: bigint): Promise<bigint[]> {
    const rows = await prisma.notification.findMany({ where: { notification_event_id: eventId }, select: { recipient_user_id: true } });
    return rows.map((r) => r.recipient_user_id).sort();
  }

  function deliveriesOf(eventCode: string, workOrderId: bigint) {
    return prisma.zalo_delivery.findMany({
      where: { event_type_code: eventCode, notification_event: { aggregate_id: workOrderId, aggregate_type_code: 'WORK_ORDER' } },
      orderBy: { zalo_delivery_id: 'asc' },
    });
  }

  async function issueToken(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/mdm/terminals/${Number(ids.terminal)}:issue-token`)
      .set('Cookie', admin)
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return response.body.token as string;
  }

  async function makeUser(key: string, name: string, data: { phone_number?: string; department_id?: bigint } = {}) {
    const user = await prisma.app_user.create({
      data: { login_id: `${PREFIX}-${key}`, user_name: name, status_code: 'EMPLOYED', ...data },
    });
    userIds.push(user.app_user_id);
    ids[key] = user.app_user_id;
  }

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '알림검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '알림검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '알림검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    for (const key of ['deptA', 'deptB']) {
      ids[key] = (await prisma.department.create({ data: { department_code: `${PREFIX}-${key}`, department_name: `알림${key}` } })).department_id;
    }
    const line = async (key: string, name: string, departmentId: bigint | null) => {
      ids[key] = (
        await prisma.production_line.create({
          data: { plant_id: plant.plant_id, line_code: `${PREFIX}-${key}`, line_name: name, department_id: departmentId },
        })
      ).production_line_id;
    };
    await line('lineA', '알림라인A', ids.deptA);
    await line('lineB', '알림라인B', ids.deptB);
    await line('lineNone', '알림라인무', null);
    await line('lineChange', '알림라인변경', ids.deptB);

    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '알림검사품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item = item.item_id;
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    ids.operation = (
      await prisma.routing_operation.create({
        data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
      })
    ).routing_operation_id;
    const bom = await prisma.bom.create({
      data: { parent_item_id: item.item_id, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'ACTIVE', effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: uom.uom_id },
    });
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T`, plant_id: plant.plant_id, terminal_type_code: 'POP', status_code: 'RUNNING' },
    });
    ids.terminal = terminal.terminal_id;
    await prisma.terminal_process.create({ data: { terminal_id: terminal.terminal_id, process_id: process.process_id, can_start_work: true } });
    ids.worker = (
      await prisma.worker.create({
        data: { worker_no: `${PREFIX}-W1`, worker_name: '알림작업자', business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
      })
    ).worker_id;
    const order = await prisma.production_order.create({
      data: { production_order_no: `${PREFIX}-PO`, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, item_id: item.item_id, order_qty: 100, uom_id: uom.uom_id, status_code: 'CONFIRMED' },
    });
    ids.plan = (
      await prisma.production_plan.create({
        data: { production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP`, plan_date: new Date('2026-10-21T00:00:00.000Z'), planned_qty: 100, uom_id: uom.uom_id, bom_id: bom.bom_id, routing_id: routing.routing_id, status_code: 'CONFIRMED' },
      })
    ).production_plan_id;

    await makeUser('admin', '알림관리자');
    await makeUser('rPhone', '수신자번호', { phone_number: '84912345678', department_id: ids.deptA });
    await makeUser('rNoPhone', '수신자무번호', { department_id: ids.deptA });
    await makeUser('rOther', '다른부서수신자', { phone_number: '84987654321', department_id: ids.deptB });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_ROLE`, role_name: '알림생산검사' } });
    ids.role = role.role_id;
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    for (const key of ['admin', 'rPhone']) await prisma.user_role.create({ data: { app_user_id: ids[key], role_id: role.role_id } });

    const reason = await prisma.code_value.findFirstOrThrow({ where: { code_group: { group_code: 'WORK_SESSION_EVENT_REASON' } } });
    stopReason = reason.code;
    stopReasonName = reason.code_name;
    varianceReason = (
      await prisma.code_value.findFirstOrThrow({ where: { code_group: { group_code: 'WORK_ORDER_COMPLETION_VARIANCE_REASON' } } })
    ).code;
  }

  /** 만든 행을 FK 역순으로 지운다. 알림·발송은 이 W/O 들의 사건으로 잡는다. */
  async function cleanup(): Promise<void> {
    const workOrders = await prisma.work_order.findMany({ where: { work_order_no: { startsWith: PREFIX } }, select: { work_order_id: true } });
    const woIds = workOrders.map((w) => w.work_order_id);
    const eventScope = { aggregate_type_code: 'WORK_ORDER', aggregate_id: { in: woIds } };
    await prisma.zalo_delivery.deleteMany({ where: { notification_event: eventScope } });
    await prisma.notification.deleteMany({ where: { notification_event: eventScope } });
    await prisma.notification_event.deleteMany({ where: eventScope });
    const settings = await prisma.notification_department_setting.findMany({
      where: { department: { department_code: { startsWith: PREFIX } } },
      select: { notification_department_setting_id: true },
    });
    await prisma.notification_department_recipient.deleteMany({
      where: { notification_department_setting_id: { in: settings.map((s) => s.notification_department_setting_id) } },
    });
    await prisma.notification_department_setting.deleteMany({ where: { department: { department_code: { startsWith: PREFIX } } } });
    const sessionScope = { work_order_id: { in: woIds } };
    await prisma.work_session_event.deleteMany({ where: { work_session: sessionScope } });
    await prisma.work_session_worker.deleteMany({ where: { work_session: sessionScope } });
    await prisma.production_result.updateMany({ where: sessionScope, data: { corrects_production_result_id: null } });
    await prisma.production_result.deleteMany({ where: sessionScope });
    await prisma.work_session.deleteMany({ where: sessionScope });
    await prisma.integration_message.deleteMany({ where: { message_key: { contains: PREFIX } } });
    await prisma.lot_lifecycle_history.deleteMany({ where: { lot: { plant: { plant_code: { startsWith: PREFIX } } } } });
    await prisma.lot.deleteMany({ where: { plant: { plant_code: { startsWith: PREFIX } } } });
    await prisma.work_order.deleteMany({ where: { work_order_id: { in: woIds } } });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.terminal_process.deleteMany({ where: { terminal: { terminal_code: { startsWith: PREFIX } } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    if (ids.role !== undefined) {
      await prisma.role_permission.deleteMany({ where: { role_id: ids.role } });
      await prisma.role.delete({ where: { role_id: ids.role } });
    }
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.department.deleteMany({ where: { department_code: { startsWith: PREFIX } } });
  }
});
