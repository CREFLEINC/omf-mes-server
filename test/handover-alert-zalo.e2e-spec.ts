/**
 * 인계 작업 알림 — Zalo 우선순위·인계 템플릿·발송 이력(omf-all-around#190 · 장부 P-135).
 *
 * 러너를 직접 만들어 대역에 `tick` 한다(e2e 전역 설정이 앱 안의 러너는 끈다 — `zalo-delivery-runner` 선례).
 * ⚠ 러너는 표 전체의 대기 건을 잡으므로 `zalo_delivery`·`zalo_template`·`zalo_connection` 을 비우고 시작한다
 *   (러너 e2e 와 같은 방식 — 스위트는 차례로 돈다).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { SecretBox } from '../src/core/crypto/secret-box';
import { HANDOVER_ALERT_TYPES, NotificationEmitter } from '../src/core/notification';
import { SyncLease } from '../src/integration/erp/sync-lease';
import { ZaloClient } from '../src/integration/zalo/zalo-client';
import { BATCH_SIZE, ZaloDeliveryRunner } from '../src/integration/zalo/zalo-delivery.runner';
import { ZaloTokenService } from '../src/integration/zalo/zalo-token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ZaloStub, startZaloStub } from './support/zalo-stub';

const PREFIX = `E2EHOZ${randomUUID().slice(0, 6)}`;
const HOUR = 60 * 60 * 1000;

/** specs/002-terminal-task-alerts zalo-templates.md 의 파라미터 칸 그대로. */
const TEMPLATE_PARAMS: Record<string, string[]> = {
  PUTAWAY_REQUESTED: ['receipt_no', 'warehouse', 'task_count', 'event_time', 'actor'],
  MATERIAL_PICKING_REQUESTED: ['picking_no', 'wo_no', 'item_count', 'warehouse', 'required_at', 'event_time'],
  STOCK_TRANSFER_ARRIVAL_PENDING: ['transfer_no', 'from_warehouse', 'to_warehouse', 'item_count', 'event_time', 'actor'],
  SHIPMENT_PICKING_REQUESTED: ['request_no', 'customer', 'item_count', 'ship_date', 'event_time'],
  SHIPMENT_PACKING_REQUESTED: ['shipment_no', 'warehouse', 'ship_date', 'event_time', 'actor'],
  WORK_ORDER_RELEASED: ['wo_no', 'item', 'plan_qty', 'process', 'equipment', 'event_time'],
  EMERGENCY_WORK_ORDER_RELEASED: ['wo_no', 'item', 'plan_qty', 'process', 'equipment', 'event_time'],
  OQC_INSPECTION_REQUESTED: ['request_no', 'request_count', 'ship_date', 'event_time'],
  REWORK_WORK_ORDER_CREATED: ['wo_no', 'item', 'qty', 'ncr_no', 'process', 'event_time', 'actor'],
  IQC_INSPECTION_REQUESTED: ['receipt_no', 'lot_count', 'supplier', 'event_time'],
};

describe('인계 작업 알림 — Zalo (e2e · 대역)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stub: ZaloStub;
  let box: SecretBox;
  let runner: ZaloDeliveryRunner;
  let cookie: string;
  let plantId: bigint;
  let recipientId: bigint;
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];
  const eventIds: bigint[] = [];
  let sequence = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    stub = await startZaloStub();
    box = new SecretBox(process.env.ZALO_CREDENTIAL_KEY as string);
    const client = new ZaloClient({ apiBaseUrl: stub.url, oauthBaseUrl: stub.url, timeoutMs: 2000 });
    runner = new ZaloDeliveryRunner(true, prisma, new SyncLease(prisma, `${PREFIX}-lease`), client, new ZaloTokenService(prisma, box, client));

    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    plantId = (
      await prisma.plant.create({
        data: { plant_code: `${PREFIX}-P`, plant_name: `${PREFIX} 공장`, legal_entity_id: base.legal_entity_id, business_unit_id: base.business_unit_id, timezone_code: 'Asia/Ho_Chi_Minh' },
      })
    ).plant_id;
    recipientId = await user('R', '84912345678');
    const admin = await user('ADMIN', null);
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_R`, role_name: '인계 Zalo 시험' } });
    roleIds.push(role.role_id);
    await prisma.role_permission.createMany({
      data: ['W-CO-12', 'W-CO-13'].map((code) => ({ role_id: role.role_id, permission_code: code })),
    });
    await prisma.user_role.create({ data: { app_user_id: admin, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(admin), typ: 'session' })}`;
  });

  beforeEach(async () => {
    stub.reset();
    await wipeZalo();
    await prisma.zalo_connection.create({
      data: {
        zalo_connection_id: 1,
        app_id: 'APP-1',
        secret_key_enc: box.seal('secret'),
        refresh_token_enc: box.seal('refresh'),
        access_token_enc: box.seal('access'),
        access_token_expires_at: new Date(Date.now() + 20 * HOUR),
        last_refreshed_at: new Date(),
        status_code: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    await wipeZalo();
    await prisma.$executeRaw`DELETE FROM integration.sync_lease WHERE lease_name = ${`${PREFIX}-lease`}`;
    await prisma.notification.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    await prisma.notification_event.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    const settings = await prisma.handover_alert_setting.findMany({ where: { plant_id: plantId }, select: { handover_alert_setting_id: true } });
    await prisma.handover_alert_recipient.deleteMany({ where: { handover_alert_setting_id: { in: settings.map((s) => s.handover_alert_setting_id) } } });
    await prisma.handover_alert_setting.deleteMany({ where: { plant_id: plantId } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.plant.delete({ where: { plant_id: plantId } });
    await stub.close();
    await app.close();
  });

  it('SC-008 FR-023 인계 대기 120건이 먼저 쌓여도 뒤에 생긴 기존 「생산 실행」 건이 맨 먼저, 1분 안에 나간다', async () => {
    await prisma.zalo_template.createMany({
      data: [
        { event_type_code: 'WORK_SESSION_STARTED', template_id: 'TPL-START' },
        { event_type_code: 'MATERIAL_PICKING_REQUESTED', template_id: 'TPL-PICK' },
      ],
    });
    const now = new Date();
    for (let index = 0; index < 120; index += 1) {
      await delivery('MATERIAL_PICKING_REQUESTED', 1, new Date(now.getTime() - 60_000 + index));
    }
    const existing = await delivery('WORK_SESSION_STARTED', 0, now);

    const started = Date.now();
    await runner.tick(new Date(now.getTime() + 1000));
    const elapsed = Date.now() - started;

    const sent = sends();
    expect(sent).toHaveLength(121);
    expect(JSON.parse(sent[0].body)).toMatchObject({ template_id: 'TPL-START', tracking_id: `zd-${existing}` });
    expect(elapsed).toBeLessThan(60_000);
    expect((await prisma.zalo_delivery.findUniqueOrThrow({ where: { zalo_delivery_id: existing } })).status_code).toBe('SENT');
  });

  it('FR-020 기존 6종만 있는 대기열은 지금처럼 next_attempt_at·id 순서다', async () => {
    await prisma.zalo_template.create({ data: { event_type_code: 'WORK_SESSION_STARTED', template_id: 'TPL-START' } });
    const now = new Date();
    const late = await delivery('WORK_SESSION_STARTED', 0, new Date(now.getTime() - 1000));
    const early = await delivery('WORK_SESSION_STARTED', 0, new Date(now.getTime() - 5000));
    const middle = await delivery('WORK_SESSION_STARTED', 0, new Date(now.getTime() - 3000));

    await runner.tick(now);

    expect(sends().map((r) => JSON.parse(r.body).tracking_id)).toEqual([`zd-${early}`, `zd-${middle}`, `zd-${late}`]);
    expect(BATCH_SIZE).toBe(20);
  });

  it('SC-006 FR-022 인계 템플릿 10종을 연결 설정에 저장하면 기존 6종은 그대로이고, 대역이 받은 template_data 키가 템플릿 표와 같다', async () => {
    const before = await request(app.getHttpServer()).get('/api/app/zalo-connection').set('Cookie', cookie).expect(200);
    expect(before.body.templates).toHaveLength(6);
    expect(before.body.handoverTemplates).toHaveLength(10);
    expect(before.body.handoverTemplates.every((t: { templateId: string | null }) => t.templateId === null)).toBe(true);

    const handoverTemplates = HANDOVER_ALERT_TYPES.map((type, index) => ({ alertTypeCode: type.alertTypeCode, templateId: `TPL-HO-${index}` }));
    const saved = await request(app.getHttpServer())
      .put('/api/app/zalo-connection')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', before.headers.etag as string)
      .send({ appId: 'APP-1', paramMaxLength: 100, templates: [{ eventCode: 'WORK_SESSION_STARTED', templateId: 'TPL-START' }], handoverTemplates })
      .expect(200);
    expect(saved.body.templates).toHaveLength(6);
    expect(saved.body.templates.find((t: { eventCode: string }) => t.eventCode === 'WORK_SESSION_STARTED').templateId).toBe('TPL-START');
    expect(saved.body.handoverTemplates).toEqual(handoverTemplates);
    const validate = contractValidator('ZaloConnection');
    expect(validate(saved.body)).toBe(true);

    const kept = await request(app.getHttpServer())
      .put('/api/app/zalo-connection')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', saved.headers.etag as string)
      .send({ appId: 'APP-1', paramMaxLength: 100, templates: [] })
      .expect(200);
    expect(kept.body.handoverTemplates).toEqual(handoverTemplates);

    const cleared = await request(app.getHttpServer())
      .put('/api/app/zalo-connection')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', kept.headers.etag as string)
      .send({ appId: 'APP-1', paramMaxLength: 100, templates: [], handoverTemplates: [{ alertTypeCode: 'PUTAWAY_REQUESTED', templateId: null }] })
      .expect(200);
    const putaway = cleared.body.handoverTemplates.find((t: { alertTypeCode: string }) => t.alertTypeCode === 'PUTAWAY_REQUESTED');
    expect(putaway.templateId).toBeNull();
    const restored = await request(app.getHttpServer())
      .put('/api/app/zalo-connection')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', cleared.headers.etag as string)
      .send({ appId: 'APP-1', paramMaxLength: 100, templates: [], handoverTemplates })
      .expect(200);

    const bad = await request(app.getHttpServer())
      .put('/api/app/zalo-connection')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', restored.headers.etag as string)
      .send({ appId: 'APP-1', paramMaxLength: 100, templates: [], handoverTemplates: [{ alertTypeCode: 'WORK_SESSION_STARTED', templateId: 'X' }] })
      .expect(400);
    expect(bad.body.errors[0]).toMatchObject({ field: 'handoverTemplates', code: 'INVALID' });

    // 10종을 생성기로 실제로 만든 뒤 보낸다 — 키는 생성기가 짓는다.
    const emitter = app.get(NotificationEmitter);
    for (const type of HANDOVER_ALERT_TYPES) {
      await configure(type.alertTypeCode);
      const aggregateId = BigInt(Date.now()) * 100n + BigInt(++sequence);
      const result = await prisma.$transaction((tx) =>
        emitter.emitHandover(tx, {
          alertTypeCode: type.alertTypeCode,
          plantId,
          aggregateTypeCode: type.aggregateTypeCode,
          aggregateId,
          occurredAt: new Date(),
          values: {},
        }),
      );
      eventIds.push(result.notificationEventId as bigint);
    }
    await runner.tick(new Date(Date.now() + 1000));

    const byTemplate = new Map(sends().map((r) => [JSON.parse(r.body).template_id as string, JSON.parse(r.body).template_data]));
    HANDOVER_ALERT_TYPES.forEach((type, index) => {
      expect(Object.keys(byTemplate.get(`TPL-HO-${index}`) ?? {}).sort()).toEqual([...TEMPLATE_PARAMS[type.alertTypeCode]].sort());
    });
  });

  it('FR-022 발송 이력에 인계 사건이 대상 유형·번호·창고와 부서 없음으로 보이고, eventCode 로 걸러진다', async () => {
    await configure('MATERIAL_PICKING_REQUESTED');
    const aggregateId = BigInt(Date.now()) * 100n + BigInt(++sequence);
    const result = await prisma.$transaction((tx) =>
      app.get(NotificationEmitter).emitHandover(tx, {
        alertTypeCode: 'MATERIAL_PICKING_REQUESTED',
        plantId,
        aggregateTypeCode: 'PICKING_ORDER',
        aggregateId,
        occurredAt: new Date(),
        values: { picking_no: `${PREFIX}-PK`, warehouse: '자재창고 A', item_count: 2 },
      }),
    );
    eventIds.push(result.notificationEventId as bigint);
    const period = { from: new Date(Date.now() - HOUR).toISOString(), to: new Date(Date.now() + HOUR).toISOString() };

    const dispatches = await request(app.getHttpServer())
      .get('/api/app/notification-dispatches')
      .query({ ...period, eventCode: 'MATERIAL_PICKING_REQUESTED', size: 100 })
      .set('Cookie', cookie)
      .expect(200);
    expect(contractValidator('NotificationDispatchPage')(dispatches.body)).toBe(true);
    const row = dispatches.body.items.find((r: { notificationEventId: number }) => r.notificationEventId === Number(result.notificationEventId));
    expect(row).toMatchObject({
      eventCode: 'MATERIAL_PICKING_REQUESTED',
      departmentId: null,
      departmentName: null,
      targetTypeCode: 'PICKING_ORDER',
      targetLabel: `${PREFIX}-PK · 자재창고 A`,
      dispatchStatus: 'NOTIFIED',
      notificationCount: 1,
      zalo: { pending: 1 },
    });
    expect(dispatches.body.items.every((r: { eventCode: string }) => r.eventCode === 'MATERIAL_PICKING_REQUESTED')).toBe(true);

    const deliveries = await request(app.getHttpServer())
      .get('/api/app/zalo-deliveries')
      .query({ ...period, eventCode: 'MATERIAL_PICKING_REQUESTED', notificationEventId: Number(result.notificationEventId) })
      .set('Cookie', cookie)
      .expect(200);
    expect(deliveries.body.items).toHaveLength(1);
    expect(deliveries.body.items[0]).toMatchObject({ departmentName: null, targetLabel: `${PREFIX}-PK · 자재창고 A`, phoneMasked: '091*****78' });
  });

  async function configure(alertTypeCode: string): Promise<void> {
    const setting = await prisma.handover_alert_setting.upsert({
      where: { plant_id_alert_type_code: { plant_id: plantId, alert_type_code: alertTypeCode } },
      create: { plant_id: plantId, alert_type_code: alertTypeCode, is_enabled: true, zalo_enabled: true },
      update: { is_enabled: true, zalo_enabled: true },
    });
    await prisma.handover_alert_recipient.upsert({
      where: { handover_alert_setting_id_app_user_id: { handover_alert_setting_id: setting.handover_alert_setting_id, app_user_id: recipientId } },
      create: { handover_alert_setting_id: setting.handover_alert_setting_id, app_user_id: recipientId },
      update: {},
    });
  }

  async function delivery(eventCode: string, priority: number, nextAttemptAt: Date): Promise<bigint> {
    sequence += 1;
    const id = BigInt(Date.now()) * 1000n + BigInt(sequence);
    const event = await prisma.notification_event.create({
      data: { event_type_code: eventCode, aggregate_type_code: 'WORK_ORDER', aggregate_id: id, occurred_at: nextAttemptAt },
    });
    eventIds.push(event.notification_event_id);
    await prisma.zalo_delivery.create({
      data: {
        zalo_delivery_id: id,
        notification_event_id: event.notification_event_id,
        recipient_user_id: recipientId,
        phone_number: '84912345678',
        event_type_code: eventCode,
        template_data: { wo_no: 'WO-1' },
        tracking_id: `zd-${id}`,
        priority,
        next_attempt_at: nextAttemptAt,
        expires_at: new Date(nextAttemptAt.getTime() + 24 * HOUR),
      },
    });
    return id;
  }

  function sends() {
    return stub.requests.filter((r) => r.path === '/message/template');
  }

  async function wipeZalo(): Promise<void> {
    await prisma.zalo_delivery.deleteMany();
    await prisma.zalo_template.deleteMany();
    await prisma.zalo_connection.deleteMany();
  }

  async function user(suffix: string, phone: string | null): Promise<bigint> {
    const row = await prisma.app_user.create({
      data: { login_id: `${PREFIX}_${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED', phone_number: phone },
    });
    userIds.push(row.app_user_id);
    return row.app_user_id;
  }

  function contractValidator(schema: string) {
    const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8')) as object;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
    ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
    return ajv.compile({ $ref: `https://omf-mes.invalid/contract#/components/schemas/${schema}` });
  }
});
