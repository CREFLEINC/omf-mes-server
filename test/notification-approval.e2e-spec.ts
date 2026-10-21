/**
 * 결재 도착 알림 — 상신 때 1단계, 중간 승인 뒤 다음 단계 결재자 한 명에게(omf-all-around#160 · 장부 P-94).
 *
 * 상신 경로 둘로 본다: 재고 조정은 API(`:request-approval`)로, OQC 생략은 상신 코어(`ApprovalService.request`)로.
 * 알림은 코어 한 곳에 걸려 9 경로가 같은 자리를 지난다(research R-6).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { ApprovalService } from '../src/core/approval';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedRequest, seedRoute } from './approval-request.fixture';

const PREFIX = `NAPR${randomUUID().slice(0, 6)}`;
const ADJUSTMENT = 'INVENTORY_ADJUSTMENT';
const OQC_SKIP = 'OQC_SKIP';
const EVENT = 'APPROVAL_ACTION_REQUIRED';

describe('결재 알림 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const ids: Record<string, bigint> = {};
  const userIds: bigint[] = [];
  const routeIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    for (const key of ['deptOn', 'deptOff']) {
      ids[key] = (await prisma.department.create({ data: { department_code: `${PREFIX}-${key}`, department_name: `결재${key}` } })).department_id;
    }
    await makeUser('requester', '상신자', ['W-01-12', 'W-01-10']);
    await makeUser('first', '1단계결재자', ['W-03-09'], { department_id: ids.deptOn, phone_number: '84911111111' });
    await makeUser('second', '2단계결재자', ['W-03-09'], { department_id: ids.deptOn });
    await makeUser('offApprover', '꺼진부서결재자', ['W-03-09'], { department_id: ids.deptOff });
    await makeUser('noDept', '부서없는결재자', ['W-03-09']);
    await makeUser('gone', '비활성결재자', ['W-03-09'], { department_id: ids.deptOn, is_active: false });
    await makeUser('admin', '설정관리자', ['W-CO-11']);

    // 켜진 부서만 결재 알림을 켜고 Zalo 도 켠다 — 결재자 모드라 수신자 목록은 비운다.
    await request(app.getHttpServer())
      .put(`/api/app/notification-settings/${ids.deptOn}/${EVENT}`)
      .set('Cookie', cookieOf(ids.admin))
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ enabled: true, zaloEnabled: true, recipientUserIds: [] })
      .expect(200);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US3-1 SC-003 상신하면 1단계 결재자에게만 1건, 대상은 결재 요청이다', async () => {
    const routeId = await route(ADJUSTMENT, [ids.first, ids.second]);
    try {
      const response = await requestAdjustment('0001');
      const id = BigInt(response.body.approvalRequestId);

      const events = await eventsOf(id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ dispatch_status_code: 'NOTIFIED', department_id: ids.deptOn, aggregate_type_code: 'APPROVAL_REQUEST' });
      expect(await recipientsOf(events[0].notification_event_id)).toEqual([ids.first]);
      const payload = events[0].payload as Record<string, string>;
      expect(payload).toMatchObject({ approval_type: '재고 조정', requester: '상신자', step: '1/2', reason: '재고 차이를 닫습니다' });

      const inbox = await request(app.getHttpServer())
        .get('/api/app/notifications')
        .query({ occurredFrom: '2026-01-01T00:00:00.000Z', occurredTo: '2100-01-01T00:00:00.000Z', size: 100 })
        .set('Cookie', cookieOf(ids.first))
        .expect(200);
      expect(inbox.body.items.find((n: { targetId?: number }) => n.targetId === Number(id))).toMatchObject({
        eventCode: EVENT,
        targetTypeCode: 'APPROVAL_REQUEST',
      });
      const deliveries = await prisma.zalo_delivery.findMany({ where: { notification_event_id: events[0].notification_event_id } });
      expect(deliveries.map((d) => d.recipient_user_id)).toEqual([ids.first]);
    } finally {
      await deactivate(routeId);
    }
  });

  it('US3-2 US3-4 1단계 승인이면 2단계 결재자에게 1건, 마지막 승인 뒤에는 추가 0건', async () => {
    const routeId = await route(ADJUSTMENT, [ids.first, ids.second]);
    try {
      const response = await requestAdjustment('0002');
      const id = BigInt(response.body.approvalRequestId);

      await decide('approve', id, ids.first);
      let events = await eventsOf(id);
      expect(events).toHaveLength(2);
      expect(await recipientsOf(events[1].notification_event_id)).toEqual([ids.second]);
      expect(events[1].payload).toMatchObject({ step: '2/2' });

      await decide('approve', id, ids.second);
      events = await eventsOf(id);
      expect(events).toHaveLength(2);
    } finally {
      await deactivate(routeId);
    }
  });

  it('US3-4 반려 뒤에는 다음 단계에 알리지 않는다', async () => {
    const routeId = await route(ADJUSTMENT, [ids.first, ids.second]);
    try {
      const response = await requestAdjustment('0003');
      const id = BigInt(response.body.approvalRequestId);
      await decide('reject', id, ids.first, { comment: '다시 확인' });
      expect(await eventsOf(id)).toHaveLength(1);
    } finally {
      await deactivate(routeId);
    }
  });

  it.each([
    ['offApprover', 'EVENT_DISABLED'],
    ['noDept', 'DEPARTMENT_UNRESOLVED'],
    ['gone', 'APPROVER_INACTIVE'],
  ])('US3-3 SC-003 결재자 %s 이면 알리지 않고 %s 로 남는다 — OQC 생략 상신', async (approver, reason) => {
    const routeId = await route(OQC_SKIP, [ids[approver]]);
    try {
      const { approvalRequestId } = await seedRequest(prisma, app.get(ApprovalService), {
        approvalTypeCode: OQC_SKIP,
        requestedBy: ids.requester,
        targetTypeCode: 'SHIPMENT_REQUEST',
        targetId: BigInt(Math.floor(Math.random() * 1e9)),
        reason: `${PREFIX} OQC 생략`,
      });
      const [event] = await eventsOf(approvalRequestId);
      expect(event).toMatchObject({ dispatch_status_code: 'SKIPPED', skip_reason_code: reason });
      expect(await recipientsOf(event.notification_event_id)).toEqual([]);
      expect(event.payload).toMatchObject({ approval_type: 'OQC 생략', step: '1/1' });
    } finally {
      await deactivate(routeId);
    }
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function cookieOf(userId: bigint): string {
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(userId), typ: 'session' })}`;
  }

  async function route(approvalTypeCode: string, approvers: bigint[]): Promise<bigint> {
    const routeId = await seedRoute(prisma, approvalTypeCode, approvers);
    routeIds.push(routeId);
    return routeId;
  }

  /** 시험마다 결재선 하나만 살린다 — 같은 유형의 공통본이 둘이면 ROUTE_AMBIGUOUS 다. */
  async function deactivate(routeId: bigint): Promise<void> {
    await prisma.approval_route.update({ where: { approval_route_id: routeId }, data: { is_active: false } });
  }

  async function requestAdjustment(suffix: string): Promise<request.Response> {
    const adjustment = await prisma.inventory_adjustment.create({
      data: { inventory_adjustment_no: `IA-${PREFIX}-${suffix}`, reason_code: 'SYSTEM_ERROR_CORRECTION', status_code: 'REGISTERED' },
    });
    return request(app.getHttpServer())
      .post(`/api/inventory/adjustments/${adjustment.inventory_adjustment_id}:request-approval`)
      .set('Cookie', cookieOf(ids.requester))
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(adjustment.version_no))
      .send({ reason: '재고 차이를 닫습니다' })
      .expect(202);
  }

  async function decide(action: 'approve' | 'reject', id: bigint, approver: bigint, body: object = {}): Promise<void> {
    const cookie = cookieOf(approver);
    const detail = await request(app.getHttpServer()).get(`/api/app/approval-requests/${id}`).set('Cookie', cookie).expect(200);
    await request(app.getHttpServer())
      .post(`/api/app/approval-requests/${id}:${action}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', detail.headers.etag as string)
      .send(body)
      .expect(200);
  }

  function eventsOf(approvalRequestId: bigint) {
    return prisma.notification_event.findMany({
      where: { event_type_code: EVENT, aggregate_type_code: 'APPROVAL_REQUEST', aggregate_id: approvalRequestId },
      orderBy: { occurred_at: 'asc' },
    });
  }

  async function recipientsOf(eventId: bigint): Promise<bigint[]> {
    const rows = await prisma.notification.findMany({ where: { notification_event_id: eventId }, select: { recipient_user_id: true } });
    return rows.map((r) => r.recipient_user_id).sort();
  }

  async function makeUser(
    key: string,
    name: string,
    permissions: string[],
    data: { department_id?: bigint; phone_number?: string; is_active?: boolean } = {},
  ): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: `${PREFIX}-${key}`, user_name: name, status_code: 'EMPLOYED', ...data },
    });
    userIds.push(user.app_user_id);
    ids[key] = user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${key}`, role_name: `결재알림 ${key}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
  }

  async function cleanup(): Promise<void> {
    const requests = await prisma.approval_request.findMany({ where: { requested_by: { in: userIds } }, select: { approval_request_id: true } });
    const requestIds = requests.map((r) => r.approval_request_id);
    const eventScope = { aggregate_type_code: 'APPROVAL_REQUEST', aggregate_id: { in: requestIds } };
    await prisma.zalo_delivery.deleteMany({ where: { notification_event: eventScope } });
    await prisma.notification.deleteMany({ where: { notification_event: eventScope } });
    await prisma.notification_event.deleteMany({ where: eventScope });
    await prisma.inventory_adjustment.deleteMany({ where: { inventory_adjustment_no: { startsWith: `IA-${PREFIX}` } } });
    await prisma.approval_step.deleteMany({ where: { approval_request_id: { in: requestIds } } });
    await prisma.approval_request.deleteMany({ where: { approval_request_id: { in: requestIds } } });
    await prisma.approval_route_step.deleteMany({ where: { approval_route_id: { in: routeIds } } });
    await prisma.approval_route.deleteMany({ where: { approval_route_id: { in: routeIds } } });
    const settings = await prisma.notification_department_setting.findMany({
      where: { department: { department_code: { startsWith: PREFIX } } },
      select: { notification_department_setting_id: true },
    });
    await prisma.notification_department_recipient.deleteMany({
      where: { notification_department_setting_id: { in: settings.map((s) => s.notification_department_setting_id) } },
    });
    await prisma.notification_department_setting.deleteMany({ where: { department: { department_code: { startsWith: PREFIX } } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: { startsWith: PREFIX } } } });
    await prisma.role.deleteMany({ where: { role_code: { startsWith: PREFIX } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.department.deleteMany({ where: { department_code: { startsWith: PREFIX } } });
  }
});
