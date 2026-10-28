/**
 * 인계작업 알림 설정(W-CO-14 · omf-all-around#190 · 장부 P-134).
 *
 * 공장 × 인계 작업 종류 10종. 행이 없으면 꺼짐·0명·판 1 로 읽고 GET 은 행을 만들지 않는다.
 * 기존 부서×이벤트 설정(W-CO-11)·이벤트 목록(6종)과 섞이지 않는다(FR-021).
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

const PREFIX = `E2E_HOSET_${randomUUID().slice(0, 8)}`;
const PATH = '/api/app/handover-alert-settings';
const TYPE = 'MATERIAL_PICKING_REQUESTED';
const TYPE_CODES = [
  'PUTAWAY_REQUESTED',
  'MATERIAL_PICKING_REQUESTED',
  'STOCK_TRANSFER_ARRIVAL_PENDING',
  'SHIPMENT_PICKING_REQUESTED',
  'SHIPMENT_PACKING_REQUESTED',
  'WORK_ORDER_RELEASED',
  'EMERGENCY_WORK_ORDER_RELEASED',
  'OQC_INSPECTION_REQUESTED',
  'REWORK_WORK_ORDER_CREATED',
  'IQC_INSPECTION_REQUESTED',
];

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');

function validator(path: string, method: string, status: number): ValidateFunction {
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('인계작업 알림 설정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let deniedCookie: string;
  let pickerOnlyCookie: string;
  let plantId: number;
  let otherPlantId: number;
  const users: Record<string, number> = {};
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const plant = await makePlant('A', base);
    const other = await makePlant('B', base);
    plantId = Number(plant.plant_id);
    otherPlantId = Number(other.plant_id);

    const admin = await makeUser('ADMIN', null);
    const denied = await makeUser('DENIED', null);
    const pickerOnly = await makeUser('W11', null);
    for (const key of ['U1', 'U2', 'U3', 'U4', 'U5', 'U6']) {
      users[key] = Number(await makeUser(key, key === 'U2' ? null : `8491234567${key.slice(1)}`));
    }
    users.GONE = Number(await makeUser('GONE', '84987654321', false));

    await prisma.user_data_scope.create({
      data: { app_user_id: admin, business_unit_id: plant.business_unit_id, plant_id: plant.plant_id },
    });
    await grant(admin, 'W-CO-14');
    await grant(pickerOnly, 'W-CO-11');

    const jwt = app.get(JwtService);
    const sign = (id: bigint) => `${SESSION_COOKIE}=${jwt.sign({ sub: Number(id), typ: 'session' })}`;
    cookie = sign(admin);
    deniedCookie = sign(denied);
    pickerOnlyCookie = sign(pickerOnly);
  });

  afterAll(async () => {
    const settings = await prisma.handover_alert_setting.findMany({
      where: { plant_id: { in: [BigInt(plantId), BigInt(otherPlantId)] } },
      select: { handover_alert_setting_id: true },
    });
    const settingIds = settings.map((row) => row.handover_alert_setting_id);
    await prisma.handover_alert_recipient.deleteMany({ where: { handover_alert_setting_id: { in: settingIds } } });
    await prisma.handover_alert_setting.deleteMany({ where: { handover_alert_setting_id: { in: settingIds } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plant_id: { in: [BigInt(plantId), BigInt(otherPlantId)] } } });
    await app.close();
  });

  it('FR-021 인계 종류 조회는 10종이고, 기존 알림 이벤트 목록은 6종 그대로다', async () => {
    const types = await request(app.getHttpServer())
      .get('/api/app/handover-alert-types')
      .set('Cookie', deniedCookie)
      .expect(200);
    const validate = validator('/app/handover-alert-types', 'get', 200);
    expect(validate(types.body)).toBe(true);
    expect(types.body.items.map((t: { alertTypeCode: string }) => t.alertTypeCode).sort()).toEqual([...TYPE_CODES].sort());
    for (const type of types.body.items) {
      expect(type.name).not.toBe('');
      expect(type.nameVi).not.toBe('');
    }

    const events = await request(app.getHttpServer())
      .get('/api/app/notification-events')
      .set('Cookie', cookie)
      .expect(200);
    const eventCodes = events.body.items.map((e: { eventCode: string }) => e.eventCode);
    expect(eventCodes).toHaveLength(6);
    expect(eventCodes.filter((code: string) => TYPE_CODES.includes(code))).toEqual([]);
  });

  it('US2-1 행이 없으면 10종 모두 꺼짐·Zalo 꺼짐·담당자 0명이고 GET 은 행을 만들지 않는다', async () => {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({ plantId })
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('/app/handover-alert-settings', 'get', 200);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.plantId).toBe(plantId);
    expect(response.body.items).toHaveLength(10);
    for (const item of response.body.items) {
      expect(item).toMatchObject({ enabled: false, zaloEnabled: false, recipientCount: 0, noPhoneCount: 0, inactiveCount: 0 });
    }

    const one = await detail(TYPE).expect(200);
    expect(one.headers.etag).toBe('1');
    expect(one.body).toEqual({ plantId, alertTypeCode: TYPE, enabled: false, zaloEnabled: false, recipients: [] });
    expect(await prisma.handover_alert_setting.count({ where: { plant_id: plantId } })).toBe(0);
  });

  it('US2-2 켜고 담당자를 저장하면 다시 열 때 그대로이고 ETag 가 하나 오른다', async () => {
    const body = { enabled: true, zaloEnabled: true, recipientUserIds: [users.U1, users.U2] };
    const saved = await replace(TYPE, '1', body).expect(200);
    expect(saved.headers.etag).toBe('2');
    const validate = validator('/app/handover-alert-settings/{plantId}/{alertTypeCode}', 'put', 200);
    expect(validate(saved.body)).toBe(true);

    const reopened = await detail(TYPE).expect(200);
    expect(reopened.headers.etag).toBe('2');
    expect(reopened.body).toEqual(saved.body);
    expect(reopened.body.recipients.map((r: { userId: number }) => r.userId).sort()).toEqual([users.U1, users.U2].sort());
    expect(JSON.stringify(reopened.body)).not.toContain('8491234567');
  });

  it('US2-2 판이 다르면 409 이고, 행이 있는데 If-Match 없이 저장해도 409 다', async () => {
    const stale = await replace(TYPE, '1', { enabled: false, zaloEnabled: false, recipientUserIds: [] }).expect(409);
    expect(stale.body.conflictCause).toBe('user');
    await replace(TYPE, undefined, { enabled: false, zaloEnabled: false, recipientUserIds: [] }).expect(409);
  });

  it('US2-2 행이 없는 종류는 If-Match 없이 첫 저장을 할 수 있다', async () => {
    const saved = await replace('PUTAWAY_REQUESTED', undefined, {
      enabled: true,
      zaloEnabled: false,
      recipientUserIds: [users.U3],
    }).expect(200);
    expect(saved.headers.etag).toBe('2');
  });

  it('US2-3 SC-004 담당자 6명은 400 RECIPIENT_LIMIT 이고 저장되지 않는다', async () => {
    const six = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'].map((key) => users[key]);
    const response = await replace(TYPE, '2', { enabled: true, zaloEnabled: true, recipientUserIds: six }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'recipientUserIds', code: 'RECIPIENT_LIMIT' });

    const five = six.slice(0, 5);
    const saved = await replace(TYPE, '2', { enabled: true, zaloEnabled: true, recipientUserIds: five }).expect(200);
    expect(saved.body.recipients).toHaveLength(5);
    expect(saved.headers.etag).toBe('3');
  });

  it('US2-3 사용 중지 계정·중복·없는 계정은 400 recipientUserIds INVALID 다', async () => {
    for (const ids of [[users.U1, users.GONE], [users.U1, users.U1], [users.U1, 999_999_999]]) {
      const response = await replace(TYPE, '3', { enabled: true, zaloEnabled: false, recipientUserIds: ids }).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'recipientUserIds', code: 'INVALID' });
    }
  });

  it('US2-3 알림이 꺼져 있으면 Zalo 를 켤 수 없다 — 400 zaloEnabled', async () => {
    const response = await replace(TYPE, '3', { enabled: false, zaloEnabled: true, recipientUserIds: [] }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'zaloEnabled', code: 'INVALID' });
  });

  it('US2-3 데이터 범위 밖 공장은 403, 없는 공장은 404, 목록에 없는 종류는 400 이다', async () => {
    await request(app.getHttpServer()).get(PATH).query({ plantId: otherPlantId }).set('Cookie', cookie).expect(403);
    await replace(TYPE, '1', { enabled: true, zaloEnabled: false, recipientUserIds: [] }, otherPlantId).expect(403);
    await request(app.getHttpServer()).get(PATH).query({ plantId: 999_999_999 }).set('Cookie', cookie).expect(404);
    const unknown = await detail('WORK_ORDER_CLOSED').expect(400);
    expect(unknown.body.errors[0]).toMatchObject({ field: 'alertTypeCode', code: 'INVALID' });
  });

  it('US2-4 상세는 전화번호 없는 담당자를 hasPhone=false 로, 요약은 noPhoneCount·inactiveCount 로 보인다', async () => {
    await prisma.app_user.update({ where: { app_user_id: users.U5 }, data: { is_active: false } });
    try {
      const one = await detail(TYPE).expect(200);
      const u2 = one.body.recipients.find((r: { userId: number }) => r.userId === users.U2);
      expect(u2).toMatchObject({ hasPhone: false, active: true });
      const u5 = one.body.recipients.find((r: { userId: number }) => r.userId === users.U5);
      expect(u5).toMatchObject({ active: false });

      const summary = await request(app.getHttpServer()).get(PATH).query({ plantId }).set('Cookie', cookie).expect(200);
      const item = summary.body.items.find((i: { alertTypeCode: string }) => i.alertTypeCode === TYPE);
      expect(item).toMatchObject({ enabled: true, zaloEnabled: true, recipientCount: 4, noPhoneCount: 1, inactiveCount: 1 });
    } finally {
      await prisma.app_user.update({ where: { app_user_id: users.U5 }, data: { is_active: true } });
    }
  });

  it('W-CO-14 가 없으면 설정 조회·저장은 403 이고, 수신자 후보는 W-CO-14 로도 열린다', async () => {
    await request(app.getHttpServer()).get(PATH).query({ plantId }).set('Cookie', deniedCookie).expect(403);
    await request(app.getHttpServer()).get(PATH).query({ plantId }).set('Cookie', pickerOnlyCookie).expect(403);
    const candidates = await request(app.getHttpServer())
      .get('/api/app/notification-settings/recipient-candidates')
      .query({ keyword: PREFIX })
      .set('Cookie', cookie)
      .expect(200);
    expect(candidates.body.page.total).toBeGreaterThanOrEqual(6);
    await request(app.getHttpServer())
      .get('/api/app/notification-settings/recipient-candidates')
      .set('Cookie', pickerOnlyCookie)
      .expect(200);
  });

  function detail(alertTypeCode: string) {
    return request(app.getHttpServer()).get(`${PATH}/${plantId}/${alertTypeCode}`).set('Cookie', cookie);
  }

  function replace(alertTypeCode: string, ifMatch: string | undefined, body: object, plant = plantId) {
    const call = request(app.getHttpServer())
      .put(`${PATH}/${plant}/${alertTypeCode}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID());
    return (ifMatch === undefined ? call : call.set('If-Match', ifMatch)).send(body);
  }

  async function makePlant(suffix: string, base: { legal_entity_id: bigint; business_unit_id: bigint | null }) {
    return prisma.plant.create({
      data: {
        plant_code: `${PREFIX}_${suffix}`,
        plant_name: `${PREFIX} 공장 ${suffix}`,
        legal_entity_id: base.legal_entity_id,
        business_unit_id: base.business_unit_id,
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
  }

  async function makeUser(suffix: string, phone: string | null, active = true): Promise<bigint> {
    const user = await prisma.app_user.create({
      data: {
        login_id: `${PREFIX}_${suffix}`,
        user_name: `${PREFIX} ${suffix}`,
        status_code: 'EMPLOYED',
        phone_number: phone,
        is_active: active,
      },
    });
    userIds.push(user.app_user_id);
    return user.app_user_id;
  }

  async function grant(appUserId: bigint, permission: string): Promise<void> {
    const role = await prisma.role.create({
      data: { role_code: `${PREFIX}_${permission}`, role_name: `인계 설정 시험 ${permission}` },
    });
    roleIds.push(role.role_id);
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
    await prisma.user_role.create({ data: { app_user_id: appUserId, role_id: role.role_id } });
  }
});
