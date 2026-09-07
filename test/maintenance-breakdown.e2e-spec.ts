import { INestApplication } from '@nestjs/common';
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
import { hashPassword } from '../src/auth/password';
import { BreakdownList } from '../src/maintenance/breakdown/breakdown-query.service';
import { BreakdownView } from '../src/maintenance/breakdown/breakdown-view';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-B-I30-BREAKDOWN';
const LOGIN_ID = `${PREFIX}-LOGIN`;
const PASSWORD = 'I30-고장-조회-비밀번호';
const PATH = '/api/maintenance/breakdowns';
const PERIOD = { reportedFrom: '2026-09-01', reportedTo: '2026-09-01' };

function validator(path: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/equipment-05설비툴.json'), 'utf8'),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'double']) ajv.addFormat(format, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/i30-breakdown-contract');
  const pointer = path.replace(/~/g, '~0').replace(/\//g, '~1');
  return ajv.compile({
    $ref: `https://omf-mes.invalid/i30-breakdown-contract#/paths/${pointer}/get/responses/200/content/application~1json/schema`,
  });
}

describe('설비 고장 조회 I-30 ③ (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  const ids = {
    plant: 0n,
    seoulPlant: 0n,
    badPlant: 0n,
    equipment: 0n,
    otherEquipment: 0n,
    orderEquipment: 0n,
    invalidEquipment: 0n,
    seoulEquipment: 0n,
    badEquipment: 0n,
  };
  const records: Record<string, bigint> = {};
  const orders: Record<string, bigint> = {};
  const listValidator = validator('/maintenance/breakdowns');
  const detailValidator = validator('/maintenance/breakdowns/{breakdownId}');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await fixtures();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '고장 조회', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  });

  afterAll(async () => {
    try {
      if (prisma) await cleanup();
    } finally {
      if (app) await app.close();
    }
  });

  it('E-B01 기본 미처리 전건·경과일 긴 순과 equipmentId/statusCode/openOnly AND', async () => {
    const body = await list({ equipmentId: Number(ids.equipment) });
    expect(body.items.map((item) => item.breakdownId)).toEqual(
      [
        records.oldReceived,
        records.tieA,
        records.tieB,
        records.handling,
        records.fractional,
      ].map(Number),
    );
    expect(body.items.every((item) => item.statusCode !== 'DONE')).toBe(true);
    const handling = await list({
      equipmentId: Number(ids.equipment),
      statusCode: 'HANDLING',
    });
    expect(handling.items.map((item) => item.breakdownId)).toEqual([
      Number(records.handling),
    ]);
    const impossible = await list({
      equipmentId: Number(ids.equipment),
      statusCode: 'DONE',
    });
    expect(impossible.totalCount).toBe(0);
    const done = await list({
      ...PERIOD,
      equipmentId: Number(ids.equipment),
      statusCode: 'DONE',
      openOnly: false,
    });
    expect(done.items.map((item) => item.breakdownId)).toEqual([Number(records.done)]);
    expect((await list({ statusCode: 'NOT-REGISTERED' })).totalCount).toBe(0);
  });

  it('E-B02 openOnly=false 기간·unknown sort 거부·보고일 공장 로컬 경계 — 094', async () => {
    for (const query of [
      { openOnly: false },
      { openOnly: false, reportedFrom: '2026-09-01' },
      { openOnly: false, reportedTo: '2026-09-01', withoutMaintenanceOrder: true },
    ]) {
      const response = await request(app.getHttpServer())
        .get(PATH)
        .set('Cookie', cookie)
        .query(query)
        .expect(400);
      expect(response.body.errors.map((error: { code: string }) => error.code)).toContain(
        'REQUIRED',
      );
    }
    const invalidSort = await request(app.getHttpServer())
      .get(PATH)
      .set('Cookie', cookie)
      .query({ sort: 'reportedAtDesc' })
      .expect(400);
    expect(invalidSort.body.errors[0]).toMatchObject({ field: 'sort', code: 'INVALID' });
    await request(app.getHttpServer())
      .get(PATH)
      .set('Cookie', cookie)
      .query({
        sort: 'elapsedDesc',
        openOnly: true,
        equipmentId: Number(ids.orderEquipment),
      })
      .expect(200);
    for (const invalid of [
      { reportedFrom: '2026-02-30' },
      { reportedTo: '2026-9-01' },
      { openOnly: 'unknown' },
      { withoutMaintenanceOrder: 'unknown' },
      { equipmentId: 'text' },
      { page: 'text' },
      { size: 'text' },
    ]) {
      await request(app.getHttpServer())
        .get(PATH)
        .set('Cookie', cookie)
        .query(invalid)
        .expect(400);
    }

    const hanoi = await list({
      ...PERIOD,
      equipmentId: Number(ids.otherEquipment),
      openOnly: false,
    });
    expect(hanoi.items.map((item) => item.breakdownId)).toEqual(
      [records.startInclusive, records.endInside].map(Number),
    );
    expect(hanoi.items.map((item) => item.breakdownId)).not.toContain(
      Number(records.hanoiSameMoment),
    );
    const seoul = await list({
      ...PERIOD,
      equipmentId: Number(ids.seoulEquipment),
      openOnly: false,
    });
    expect(seoul.items.map((item) => item.breakdownId)).toEqual([
      Number(records.seoulSameMoment),
    ]);
    const reverse = await list({
      reportedFrom: '2026-09-02',
      reportedTo: '2026-09-01',
      equipmentId: Number(ids.badEquipment),
    });
    expect(reverse).toEqual({
      items: [],
      totalCount: 0,
      page: { page: 1, size: 50, total: 0 },
    });
    await request(app.getHttpServer())
      .get(PATH)
      .set('Cookie', cookie)
      .query({ ...PERIOD, equipmentId: Number(ids.badEquipment) })
      .expect(500);
    expect((await list({ equipmentId: Number(ids.badEquipment) })).totalCount).toBe(1);
  });

  it('E-B03 withoutMaintenanceOrder가 직접 FK와 BREAKDOWN source 양쪽을 읽고 openOnly와 독립이다', async () => {
    const body = await list({
      equipmentId: Number(ids.orderEquipment),
      withoutMaintenanceOrder: true,
      size: 1,
      page: 2,
    });
    expect(body.totalCount).toBe(2);
    expect(body.page).toEqual({ page: 2, size: 1, total: 2 });
    expect(body.items[0].breakdownId).toBe(Number(records.polymorphic));
    const all = await list({ equipmentId: Number(ids.orderEquipment) });
    expect(all.totalCount).toBe(7);
  });

  it('E-B04 취소 지시·다형 id 충돌·직접FK와 트리거 중복을 구분한다', async () => {
    const unissued = await list({
      equipmentId: Number(ids.orderEquipment),
      withoutMaintenanceOrder: true,
    });
    expect(unissued.items.map((item) => item.breakdownId)).toEqual(
      [records.unissued, records.polymorphic].map(Number),
    );
    expect((await detail(records.duplicate)).handling.maintenanceOrderId).toBe(
      Number(orders.duplicate),
    );
    expect((await detail(records.multiple)).handling.maintenanceOrderId).toBeNull();
    expect((await detail(records.cancelled)).handling.maintenanceOrderId).toBe(
      Number(orders.cancelled),
    );
  });

  it('E-B05 상세가 Breakdown 16칸·handling 5칸을 내리고 ETag만 version_no를 갖는다', async () => {
    await prisma.equipment.update({
      where: { equipment_id: ids.equipment },
      data: { equipment_code: `${PREFIX}-EQ-CURRENT` },
    });
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${records.oldReceived}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detailValidator(response.body)).toBe(true);
    expect(response.headers.etag).toBe('17');
    expect(Object.keys(response.body)).toHaveLength(16);
    expect(Object.keys(response.body.handling)).toHaveLength(5);
    expect(response.body).toMatchObject({
      breakdownId: Number(records.oldReceived),
      breakdownNo: `${PREFIX}-oldReceived`,
      equipmentId: Number(ids.equipment),
      equipmentCode: `${PREFIX}-EQ-CURRENT`,
      symptom: 'oldReceived symptom',
      occurrenceStateCode: 'STOPPED',
      stoppedAt: '2026-08-31T17:30:00.000Z',
      reportedAt: '2026-08-31T18:00:00.000Z',
      reporterWorkerNo: `${PREFIX}-WORKER`,
      statusCode: 'RECEIVED',
      notifyAssignee: true,
      handling: {
        causeCode: 'UNREGISTERED-CAUSE',
        handlingNote: '원문 처리',
        handledByUserId: null,
        maintenanceOrderId: null,
      },
      attachments: [],
    });
    expect(response.body.versionNo).toBeUndefined();
  });

  it('E-B06 목록 count=0이고 상세는 전체·열린·닫힌 합계를 구분한다', async () => {
    const listItem = (
      await list({ equipmentId: Number(ids.equipment), size: 1 })
    ).items[0];
    expect(listItem.linkedDowntimeCount).toBe(0);
    expect(listItem).not.toHaveProperty('linkedDowntimeMinutes');
    expect(listItem).not.toHaveProperty('openLinkedDowntimeCount');
    const item = await detail(records.oldReceived);
    expect(item).toMatchObject({
      linkedDowntimeCount: 3,
      linkedDowntimeMinutes: 3,
      openLinkedDowntimeCount: 1,
    });
  });

  it('E-B07 열린 구간을 now까지 더하지 않고 1µs 소수 분 합계는 null이다 — 095', async () => {
    const first = await detail(records.fractional);
    expect(first).toMatchObject({
      linkedDowntimeCount: 2,
      linkedDowntimeMinutes: null,
      openLinkedDowntimeCount: 1,
    });
    const second = await detail(records.fractional);
    expect(second.linkedDowntimeMinutes).toBeNull();
  });

  it('E-B08 다중 지시를 임의 최근 한 건으로 도출하지 않고 UNION 중복은 제거한다 — 095', async () => {
    expect((await detail(records.duplicate)).handling.maintenanceOrderId).toBe(
      Number(orders.duplicate),
    );
    expect((await detail(records.multiple)).handling.maintenanceOrderId).toBeNull();
  });

  it('E-B09 required 결손·unknown status를 보정하지 않고 root_cause를 처리값으로 바꾸지 않는다', async () => {
    for (const id of [records.missingOccurrence, records.missingReporter]) {
      const response = await request(app.getHttpServer())
        .get(`${PATH}/${id}`)
        .set('Cookie', cookie)
        .expect(500);
      expect(response.body.errors[0].code).toBe('INTERNAL_ERROR');
    }
    const invalid = await request(app.getHttpServer())
      .get(PATH)
      .set('Cookie', cookie)
      .query({ statusCode: `${PREFIX}-UNKNOWN` })
      .expect(500);
    expect(invalid.body.errors[0].code).toBe('INTERNAL_ERROR');
    const item = await detail(records.oldReceived);
    expect(item.handling.causeCode).toBe('UNREGISTERED-CAUSE');
    expect(JSON.stringify(item)).not.toContain('legacy root cause');
  });

  it('E-B10 없는 상세404·auth401·무권한 auth200이며 GET 전후 업무·멱등·version 쓰기는 0이다', async () => {
    const missing = await request(app.getHttpServer())
      .get(`${PATH}/999999999`)
      .set('Cookie', cookie)
      .expect(404);
    expect(missing.body.errors[0].code).toBe('NOT_FOUND');
    await request(app.getHttpServer()).get(PATH).expect(401);
    await request(app.getHttpServer()).get(`${PATH}/${records.oldReceived}`).expect(401);

    const before = await readOnlySnapshot();
    await request(app.getHttpServer())
      .get(PATH)
      .set('Cookie', cookie)
      .query({ equipmentId: Number(ids.equipment) })
      .expect(200);
    await request(app.getHttpServer())
      .get(`${PATH}/${records.oldReceived}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(await readOnlySnapshot()).toEqual(before);
  });

  async function list(query: Record<string, unknown>): Promise<BreakdownList> {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .set('Cookie', cookie)
      .query(query)
      .expect(200);
    expect(listValidator(response.body)).toBe(true);
    const body = response.body as BreakdownList;
    expect(body.totalCount).toBe(body.page.total);
    return body;
  }

  async function detail(id: bigint): Promise<BreakdownView> {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detailValidator(response.body)).toBe(true);
    return response.body as BreakdownView;
  }

  async function breakdown(
    suffix: string,
    reportedAt: string,
    status = 'RECEIVED',
    equipmentId = ids.equipment,
    overrides: Partial<Prisma.breakdownUncheckedCreateInput> = {},
  ): Promise<bigint> {
    const row = await prisma.breakdown.create({
      data: {
        breakdown_no: `${PREFIX}-${suffix}`,
        equipment_id: equipmentId,
        reported_at: new Date(reportedAt),
        description: `${suffix} symptom`,
        status_code: status,
        occurrence_state_code: 'ABNORMAL',
        reporter_worker_no: `${PREFIX}-WORKER`,
        notify_assignee: true,
        ...overrides,
      },
    });
    records[suffix] = row.breakdown_id;
    return row.breakdown_id;
  }

  async function order(
    suffix: string,
    breakdownId: bigint,
    direct: boolean,
    trigger: string | null,
    status = 'ISSUED',
  ): Promise<bigint> {
    const row = await prisma.maintenance_order.create({
      data: {
        maintenance_order_no: `${PREFIX}-ORDER-${suffix}`,
        target_type_code: 'EQUIPMENT',
        equipment_id: ids.orderEquipment,
        breakdown_id: direct ? breakdownId : null,
        order_type_code: 'CORRECTIVE',
        priority_code: 'NORMAL',
        status_code: status,
        ...(trigger === null
          ? {}
          : {
              maintenance_order_trigger: {
                create: { trigger_type_code: trigger, source_id: breakdownId },
              },
            }),
      },
    });
    orders[suffix] = row.maintenance_order_id;
    return row.maintenance_order_id;
  }

  async function fixtures(): Promise<void> {
    const legal = await prisma.legal_entity.create({
      data: {
        legal_entity_code: PREFIX,
        legal_entity_name: '고장 조회 법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const business = await prisma.business_unit.create({
      data: {
        business_unit_code: PREFIX,
        business_unit_name: '고장 조회 사업부',
        legal_entity_id: legal.legal_entity_id,
      },
    });
    const makePlant = async (suffix: string, timezone: string): Promise<bigint> =>
      (
        await prisma.plant.create({
          data: {
            legal_entity_id: legal.legal_entity_id,
            business_unit_id: business.business_unit_id,
            plant_code: `${PREFIX}-${suffix}`,
            plant_name: suffix,
            timezone_code: timezone,
          },
        })
      ).plant_id;
    ids.plant = await makePlant('HN', 'Asia/Ho_Chi_Minh');
    ids.seoulPlant = await makePlant('KR', 'Asia/Seoul');
    ids.badPlant = await makePlant('BAD', 'Bad/Timezone');
    const makeEquipment = async (suffix: string, plantId: bigint): Promise<bigint> =>
      (
        await prisma.equipment.create({
          data: {
            plant_id: plantId,
            equipment_code: `${PREFIX}-${suffix}`,
            equipment_name: suffix,
            equipment_type_code: 'MACHINE',
            status_code: 'ACTIVE',
          },
        })
      ).equipment_id;
    ids.equipment = await makeEquipment('EQ', ids.plant);
    ids.otherEquipment = await makeEquipment('EQ-DATE', ids.plant);
    ids.orderEquipment = await makeEquipment('EQ-ORDER', ids.plant);
    ids.invalidEquipment = await makeEquipment('EQ-INVALID', ids.plant);
    ids.seoulEquipment = await makeEquipment('EQ-KR', ids.seoulPlant);
    ids.badEquipment = await makeEquipment('EQ-BAD', ids.badPlant);

    await breakdown('oldReceived', '2026-08-31T18:00:00Z', 'RECEIVED', ids.equipment, {
      occurrence_state_code: 'STOPPED',
      stopped_at: new Date('2026-08-31T17:30:00Z'),
      cause_code: 'UNREGISTERED-CAUSE',
      handling_note: '원문 처리',
      root_cause: 'legacy root cause',
      version_no: 17,
    });
    await breakdown('tieA', '2026-08-31T19:00:00Z');
    await breakdown('tieB', '2026-08-31T19:00:00Z');
    await breakdown('handling', '2026-08-31T20:00:00Z', 'HANDLING');
    await breakdown('done', '2026-08-31T21:00:00Z', 'DONE');
    await breakdown('fractional', '2026-08-31T22:00:00Z');
    await breakdown(
      'missingOccurrence',
      '2026-08-31T23:00:00Z',
      'RECEIVED',
      ids.invalidEquipment,
      { occurrence_state_code: null },
    );
    await breakdown(
      'missingReporter',
      '2026-09-01T00:00:00Z',
      'RECEIVED',
      ids.invalidEquipment,
      { reporter_worker_no: null },
    );
    await breakdown(
      'unknownStatus',
      '2026-09-01T01:00:00Z',
      `${PREFIX}-UNKNOWN`,
      ids.invalidEquipment,
    );

    await breakdown('beforeStart', '2026-08-31T16:59:59.999Z', 'DONE', ids.otherEquipment);
    await breakdown('hanoiSameMoment', '2026-08-31T16:00:00Z', 'DONE', ids.otherEquipment);
    await breakdown('startInclusive', '2026-08-31T17:00:00Z', 'RECEIVED', ids.otherEquipment);
    await breakdown('endInside', '2026-09-01T16:59:59.999Z', 'DONE', ids.otherEquipment);
    await breakdown('endExcluded', '2026-09-01T17:00:00Z', 'RECEIVED', ids.otherEquipment);
    await breakdown('seoulSameMoment', '2026-08-31T16:00:00Z', 'DONE', ids.seoulEquipment);
    await breakdown('badZone', '2026-09-01T00:00:00Z', 'RECEIVED', ids.badEquipment);

    for (const [suffix, hour] of [
      ['unissued', 0],
      ['polymorphic', 1],
      ['direct', 2],
      ['trigger', 3],
      ['duplicate', 4],
      ['multiple', 5],
      ['cancelled', 6],
    ] as const) {
      await breakdown(
        suffix,
        `2026-09-01T0${hour}:00:00Z`,
        'RECEIVED',
        ids.orderEquipment,
      );
    }
    await order('polymorphic', records.polymorphic, false, 'INSPECTION_NG');
    await order('direct', records.direct, true, null);
    await order('trigger', records.trigger, false, 'BREAKDOWN');
    await order('duplicate', records.duplicate, true, 'BREAKDOWN');
    await order('multiple-direct', records.multiple, true, null);
    await order('multiple-trigger', records.multiple, false, 'BREAKDOWN');
    await order('cancelled', records.cancelled, false, 'BREAKDOWN', 'CANCELLED');

    await prisma.equipment_downtime.createMany({
      data: [
        {
          equipment_id: ids.equipment,
          breakdown_id: records.oldReceived,
          downtime_type_code: 'BREAKDOWN',
          started_at: new Date('2026-09-01T00:00:00Z'),
          ended_at: new Date('2026-09-01T00:01:00Z'),
        },
        {
          equipment_id: ids.equipment,
          breakdown_id: records.oldReceived,
          downtime_type_code: 'BREAKDOWN',
          started_at: new Date('2026-09-01T01:00:00Z'),
          ended_at: new Date('2026-09-01T01:02:00Z'),
        },
        {
          equipment_id: ids.equipment,
          breakdown_id: records.oldReceived,
          downtime_type_code: 'BREAKDOWN',
          started_at: new Date('2020-01-01T00:00:00Z'),
        },
        {
          equipment_id: ids.equipment,
          breakdown_id: records.fractional,
          downtime_type_code: 'BREAKDOWN',
          started_at: new Date('2020-01-01T00:00:00Z'),
        },
      ],
    });
    await prisma.$executeRaw`
      INSERT INTO maintenance.equipment_downtime
        (equipment_id, breakdown_id, downtime_type_code, started_at, ended_at)
      VALUES (${ids.equipment}, ${records.fractional}, 'BREAKDOWN',
              '2026-09-01T00:00:00.000000Z'::timestamptz,
              '2026-09-01T00:00:00.000001Z'::timestamptz)`;
  }

  async function readOnlySnapshot(): Promise<unknown> {
    const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    return {
      breakdowns: await prisma.breakdown.findMany({
        where: { breakdown_no: { startsWith: `${PREFIX}-` } },
        orderBy: { breakdown_id: 'asc' },
        select: { breakdown_id: true, version_no: true, updated_at: true },
      }),
      orders: await prisma.maintenance_order.count({
        where: { maintenance_order_no: { startsWith: `${PREFIX}-ORDER-` } },
      }),
      downtimes: await prisma.equipment_downtime.count({
        where: { breakdown_id: { in: Object.values(records) } },
      }),
      idempotency: await prisma.idempotency_record.count({
        where: { app_user_id: user.app_user_id },
      }),
      inventory: await prisma.inventory_transaction.count(),
    };
  }

  async function cleanup(): Promise<void> {
    const breakdowns = await prisma.breakdown.findMany({
      where: { breakdown_no: { startsWith: `${PREFIX}-` } },
      select: { breakdown_id: true },
    });
    const breakdownIds = breakdowns.map((row) => row.breakdown_id);
    await prisma.equipment_downtime.deleteMany({
      where: { breakdown_id: { in: breakdownIds } },
    });
    const maintenanceOrders = await prisma.maintenance_order.findMany({
      where: { maintenance_order_no: { startsWith: `${PREFIX}-ORDER-` } },
      select: { maintenance_order_id: true },
    });
    const orderIds = maintenanceOrders.map((row) => row.maintenance_order_id);
    await prisma.maintenance_order_trigger.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.maintenance_order.deleteMany({
      where: { maintenance_order_id: { in: orderIds } },
    });
    await prisma.breakdown.deleteMany({
      where: { breakdown_id: { in: breakdownIds } },
    });
    const plants = await prisma.plant.findMany({
      where: { plant_code: { startsWith: `${PREFIX}-` } },
      select: { plant_id: true },
    });
    const plantIds = plants.map((row) => row.plant_id);
    await prisma.equipment.deleteMany({
      where: {
        plant_id: { in: plantIds },
        equipment_code: { startsWith: `${PREFIX}-` },
      },
    });
    await prisma.plant.deleteMany({ where: { plant_id: { in: plantIds } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: PREFIX } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: PREFIX } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    expect(
      await prisma.breakdown.count({
        where: { breakdown_no: { startsWith: `${PREFIX}-` } },
      }),
    ).toBe(0);
    expect(
      await prisma.maintenance_order.count({
        where: { maintenance_order_no: { startsWith: `${PREFIX}-ORDER-` } },
      }),
    ).toBe(0);
    expect(
      await prisma.equipment.count({
        where: { equipment_code: { startsWith: `${PREFIX}-` } },
      }),
    ).toBe(0);
  }
});
