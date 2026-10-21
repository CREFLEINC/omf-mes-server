/**
 * 설비 고장 알림 — 고장 보고 접수 때 설비 라인 담당 부서의 수신자에게(omf-all-around#160 · 장부 P-94).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `NBRK${randomUUID().slice(0, 6)}`;
const EVENT = 'EQUIPMENT_BREAKDOWN_OCCURRED';

describe('고장 알림 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reporter: string;
  const ids: Record<string, bigint> = {};
  const userIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);

    await makeFixtures();
    reporter = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(ids.reporter), typ: 'session' })}`;
    await request(app.getHttpServer())
      .put(`/api/app/notification-settings/${ids.dept}/${EVENT}`)
      .set('Cookie', `${SESSION_COOKIE}=${jwt.sign({ sub: Number(ids.admin), typ: 'session' })}`)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ enabled: true, zaloEnabled: true, recipientUserIds: [Number(ids.recipient)] })
      .expect(200);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US2-1 고장을 보고하면 라인 부서 수신자에게 1건, 대상은 설비이고 위치·라인·증상이 실린다', async () => {
    const response = await report(ids.equipment, {}).expect(201);

    const event = await eventOf(ids.equipment);
    expect(event).toMatchObject({ dispatch_status_code: 'NOTIFIED', department_id: ids.dept, aggregate_type_code: 'EQUIPMENT' });
    expect(event.payload).toMatchObject({ breakdownId: response.body.breakdownId });
    const notes = await prisma.notification.findMany({ where: { notification_event_id: event.notification_event_id } });
    expect(notes.map((n) => n.recipient_user_id)).toEqual([ids.recipient]);
    expect(notes[0].message).toBe(
      `${PREFIX}-EQ 사출기1 · 고장검사공장 > 성형동 > 고장라인 · 고장라인 · 유압 누유 · 고장작업자 · 09-09 07:30`,
    );

    const [delivery] = await prisma.zalo_delivery.findMany({ where: { notification_event_id: event.notification_event_id } });
    expect(delivery.template_data).toEqual({
      equipment: `${PREFIX}-EQ 사출기1`,
      location: '고장검사공장 > 성형동 > 고장라인',
      line: '고장라인',
      symptom: '유압 누유',
      event_time: '09/09/2026 07:30',
      actor: '고장작업자',
    });
  });

  it('보고 작업자(X-Worker-No) 이름이 actor 다 — 요청 계정 이름이 아니다', async () => {
    await report(ids.equipment, { reportedAt: '2026-09-09T01:00:00.000Z' }).expect(201);
    const event = await prisma.notification_event.findFirstOrThrow({
      where: { event_type_code: EVENT, aggregate_id: ids.equipment, occurred_at: new Date('2026-09-09T01:00:00.000Z') },
    });
    expect(event.payload).toMatchObject({ actor: '고장작업자' });
    expect(JSON.stringify(event.payload)).not.toContain('보고계정');
  });

  it('US2-2 「설비 담당에게 알림」을 끄면 0건이고 REPORTER_OPTED_OUT 이다', async () => {
    await report(ids.equipment, { reportedAt: '2026-09-09T02:00:00.000Z', notifyAssignee: false }).expect(201);
    const event = await prisma.notification_event.findFirstOrThrow({
      where: { event_type_code: EVENT, aggregate_id: ids.equipment, occurred_at: new Date('2026-09-09T02:00:00.000Z') },
    });
    expect(event).toMatchObject({ dispatch_status_code: 'SKIPPED', skip_reason_code: 'REPORTER_OPTED_OUT' });
    expect(await prisma.notification.count({ where: { notification_event_id: event.notification_event_id } })).toBe(0);
  });

  it('US2-3 라인 없는 설비는 보고 201 이고 DEPARTMENT_UNRESOLVED 다', async () => {
    await report(ids.orphan, {}).expect(201);
    expect(await eventOf(ids.orphan)).toMatchObject({
      dispatch_status_code: 'SKIPPED', skip_reason_code: 'DEPARTMENT_UNRESOLVED', department_id: null,
    });
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function report(equipmentId: bigint, extra: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/maintenance/breakdowns')
      .set('Cookie', reporter)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', `${PREFIX}-W`)
      .send({
        equipmentId: Number(equipmentId),
        symptom: '유압 누유',
        occurrenceStateCode: 'STOPPED',
        reportedAt: '2026-09-09T00:30:00.000Z',
        ...extra,
      });
  }

  function eventOf(equipmentId: bigint) {
    return prisma.notification_event.findFirstOrThrow({
      where: { event_type_code: EVENT, aggregate_type_code: 'EQUIPMENT', aggregate_id: equipmentId },
      orderBy: { notification_event_id: 'asc' },
    });
  }

  async function makeUser(key: string, name: string, permissions: string[], departmentId?: bigint, phone?: string) {
    const user = await prisma.app_user.create({
      data: { login_id: `${PREFIX}-${key}`, user_name: name, status_code: 'EMPLOYED', department_id: departmentId, phone_number: phone },
    });
    userIds.push(user.app_user_id);
    ids[key] = user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${key}`, role_name: `고장알림 ${key}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
  }

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '고장검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '고장검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '고장검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.plant = plant.plant_id;
    ids.dept = (await prisma.department.create({ data: { department_code: `${PREFIX}-D`, department_name: '설비보전팀' } })).department_id;
    // 상위 그룹에는 부서가 없다 — 라인 «자신»의 부서로 판정한다.
    const area = await prisma.production_line.create({
      data: { plant_id: plant.plant_id, line_code: `${PREFIX}-AREA`, line_name: '성형동', line_type_code: 'WORK_AREA' },
    });
    const line = await prisma.production_line.create({
      data: { plant_id: plant.plant_id, line_code: `${PREFIX}-LINE`, line_name: '고장라인', parent_line_id: area.production_line_id, department_id: ids.dept },
    });
    const equipment = (code: string, name: string, lineId: bigint | null) =>
      prisma.equipment.create({
        data: { plant_id: plant.plant_id, equipment_code: `${PREFIX}-${code}`, equipment_name: name, equipment_type_code: 'MACHINE', status_code: 'ACTIVE', production_line_id: lineId },
      });
    ids.equipment = (await equipment('EQ', '사출기1', line.production_line_id)).equipment_id;
    ids.orphan = (await equipment('ORPHAN', '떠돌이설비', null)).equipment_id;
    await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W`, worker_name: '고장작업자', business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
    });
    await makeUser('reporter', '보고계정', ['M-05-02']);
    await makeUser('recipient', '보전담당', ['W-CO-03'], ids.dept, '84922222222');
    await makeUser('admin', '설정관리자', ['W-CO-11']);
  }

  async function cleanup(): Promise<void> {
    const equipments = await prisma.equipment.findMany({ where: { equipment_code: { startsWith: PREFIX } }, select: { equipment_id: true } });
    const equipmentIds = equipments.map((e) => e.equipment_id);
    const eventScope = { aggregate_type_code: 'EQUIPMENT', aggregate_id: { in: equipmentIds } };
    await prisma.zalo_delivery.deleteMany({ where: { notification_event: eventScope } });
    await prisma.notification.deleteMany({ where: { notification_event: eventScope } });
    await prisma.notification_event.deleteMany({ where: eventScope });
    await prisma.breakdown.deleteMany({ where: { equipment_id: { in: equipmentIds } } });
    const settings = await prisma.notification_department_setting.findMany({ where: { department_id: ids.dept }, select: { notification_department_setting_id: true } });
    await prisma.notification_department_recipient.deleteMany({
      where: { notification_department_setting_id: { in: settings.map((s) => s.notification_department_setting_id) } },
    });
    await prisma.notification_department_setting.deleteMany({ where: { department_id: ids.dept } });
    await prisma.equipment.deleteMany({ where: { equipment_id: { in: equipmentIds } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX }, NOT: { parent_line_id: null } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: { startsWith: PREFIX } } } });
    await prisma.role.deleteMany({ where: { role_code: { startsWith: PREFIX } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.department.deleteMany({ where: { department_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
