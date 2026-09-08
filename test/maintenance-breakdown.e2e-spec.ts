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
import { NumberingService } from '../src/core/numbering';
import { BreakdownList } from '../src/maintenance/breakdown/breakdown-query.service';
import { BreakdownView } from '../src/maintenance/breakdown/breakdown-view';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-B-I30-BREAKDOWN';
const LOGIN_ID = `${PREFIX}-LOGIN`;
const OTHER_LOGIN_ID = `${PREFIX}-OTHER`;
const NO_PERMISSION_LOGIN_ID = `${PREFIX}-NO-PERMISSION`;
const ROLE = `${PREFIX}-ROLE`;
const PASSWORD = 'I30-고장-조회-비밀번호';
const WORKER_NO = `${PREFIX}-WORKER`;
const OTHER_WORKER_NO = `${PREFIX}-OTHER-WORKER`;
const QUALITY_CAUSE = `${PREFIX}-QUALITY-CAUSE`;
const BREAKDOWN_CAUSE_GROUP = 'EQUIPMENT_BREAKDOWN_CAUSE';
const BREAKDOWN_CAUSE = `${PREFIX}-CAUSE`;
const PATH = '/api/maintenance/breakdowns';
const PERIOD = { reportedFrom: '2026-09-01', reportedTo: '2026-09-01' };

function validator(
  path: string,
  method = 'get',
  status = '200',
): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(
      join(__dirname, '../contracts/equipment-05설비툴.json'),
      'utf8',
    ),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'double']) ajv.addFormat(format, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/i30-breakdown-contract');
  const pointer = path.replace(/~/g, '~0').replace(/\//g, '~1');
  return ajv.compile({
    $ref: `https://omf-mes.invalid/i30-breakdown-contract#/paths/${pointer}/${method}/responses/${status}/content/application~1json/schema`,
  });
}

describe('설비 고장 I-30 ③·⑥~⑧ (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let otherCookie: string[];
  let noPermissionCookie: string[];
  let actorUserId = 0n;
  const ids = {
    plant: 0n,
    seoulPlant: 0n,
    badPlant: 0n,
    numberingRule: 0n,
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
  const createValidator = validator('/maintenance/breakdowns', 'post', '201');
  const updateValidator = validator(
    '/maintenance/breakdowns/{breakdownId}',
    'put',
    '200',
  );
  const startValidator = validator(
    '/maintenance/breakdowns/{breakdownId}:start-handling',
    'post',
    '200',
  );
  const completeValidator = validator(
    '/maintenance/breakdowns/{breakdownId}:complete',
    'post',
    '200',
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await fixtures();
    const user = await createUser(LOGIN_ID, '고장 보고');
    const other = await createUser(OTHER_LOGIN_ID, '다른 고장 보고');
    await createUser(NO_PERMISSION_LOGIN_ID, '고장 보고 권한 없음');
    actorUserId = user.app_user_id;
    const role = await prisma.role.create({
      data: { role_code: ROLE, role_name: '설비 고장 E2E' },
    });
    await prisma.role_permission.createMany({
      data: ['M-05-02', 'W-05-04'].map((permission_code) => ({
        role_id: role.role_id,
        permission_code,
      })),
    });
    await prisma.user_role.createMany({
      data: [user.app_user_id, other.app_user_id].map((app_user_id) => ({
        app_user_id,
        role_id: role.role_id,
      })),
    });
    cookie = await login(LOGIN_ID);
    otherCookie = await login(OTHER_LOGIN_ID);
    noPermissionCookie = await login(NO_PERMISSION_LOGIN_ID);
  });

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function createUser(loginId: string, userName: string) {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: userName, status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: {
        app_user_id: user.app_user_id,
        password_hash: await hashPassword(PASSWORD),
      },
    });
    return user;
  }

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
    expect(done.items.map((item) => item.breakdownId)).toEqual([
      Number(records.done),
    ]);
    expect((await list({ statusCode: 'NOT-REGISTERED' })).totalCount).toBe(0);
  });

  it('E-B02 openOnly=false 기간·unknown sort 거부·보고일 공장 로컬 경계 — 094', async () => {
    for (const query of [
      { openOnly: false },
      { openOnly: false, reportedFrom: '2026-09-01' },
      {
        openOnly: false,
        reportedTo: '2026-09-01',
        withoutMaintenanceOrder: true,
      },
    ]) {
      const response = await request(app.getHttpServer())
        .get(PATH)
        .set('Cookie', cookie)
        .query(query)
        .expect(400);
      expect(
        response.body.errors.map((error: { code: string }) => error.code),
      ).toContain('REQUIRED');
    }
    const invalidSort = await request(app.getHttpServer())
      .get(PATH)
      .set('Cookie', cookie)
      .query({ sort: 'reportedAtDesc' })
      .expect(400);
    expect(invalidSort.body.errors[0]).toMatchObject({
      field: 'sort',
      code: 'INVALID',
    });
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
    expect(
      (await list({ equipmentId: Number(ids.badEquipment) })).totalCount,
    ).toBe(1);
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
    expect(
      (await detail(records.multiple)).handling.maintenanceOrderId,
    ).toBeNull();
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
    expect(
      (await detail(records.multiple)).handling.maintenanceOrderId,
    ).toBeNull();
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
    await request(app.getHttpServer())
      .get(`${PATH}/${records.oldReceived}`)
      .expect(401);

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

  it('E-B11 별도 계정·미연결 작업자로201이고 원문·단말 시각·RECEIVED를 저장한다', async () => {
    const response = await postBreakdown(
      createBody({
        symptom: '유압 누유 · 실린더 하부',
        occurrenceStateCode: 'ABNORMAL',
        reportedAt: '2026-09-09T00:30:00.123+07:00',
        stoppedAt: '2026-09-09T01:00:00.654+07:00',
      }),
    ).expect(201);
    expect(createValidator(response.body)).toBe(true);
    expect(response.body).toMatchObject({
      breakdownNo: expect.stringMatching(/^MLF-20260908-\d{4,}$/),
      equipmentId: Number(ids.equipment),
      equipmentCode: `${PREFIX}-EQ-CURRENT`,
      symptom: '유압 누유 · 실린더 하부',
      occurrenceStateCode: 'ABNORMAL',
      reportedAt: '2026-09-08T17:30:00.123Z',
      stoppedAt: '2026-09-08T18:00:00.654Z',
      reporterWorkerNo: WORKER_NO,
      statusCode: 'RECEIVED',
      notifyAssignee: true,
      linkedDowntimeCount: 0,
      attachments: [],
    });
    const stored = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: BigInt(response.body.breakdownId) },
    });
    expect(stored).toMatchObject({
      reported_by: BigInt(actorUserId),
      reporter_worker_no: WORKER_NO,
      description: '유압 누유 · 실린더 하부',
      severity_code: null,
      status_code: 'RECEIVED',
      started_at: null,
      completed_at: null,
      root_cause: null,
      cause_code: null,
      handling_note: null,
      handled_by: null,
      handled_at: null,
      created_by: BigInt(actorUserId),
      updated_by: BigInt(actorUserId),
      version_no: 1,
    });
    const [times] = await prisma.$queryRaw<
      { reported: string; stopped: string | null }[]
    >`
      SELECT to_char(reported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS reported,
             to_char(stopped_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS stopped
      FROM maintenance.breakdown WHERE breakdown_id=${stored.breakdown_id}`;
    expect(times).toEqual({
      reported: '2026-09-08 17:30:00.123000',
      stopped: '2026-09-08 18:00:00.654000',
    });
    const counter = await prisma.numbering_counter.findUniqueOrThrow({
      where: {
        numbering_rule_id_period_key: {
          numbering_rule_id: ids.numberingRule,
          period_key: '20260908',
        },
      },
    });
    expect(counter.last_value).toBeGreaterThanOrEqual(1n);
  });

  it('E-B12 notifyAssignee 생략=true·명시 false를 유지하고 알림 행은 만들지 않는다', async () => {
    const before = await notificationCounts();
    const omitted = await postBreakdown(createBody()).expect(201);
    const disabled = await postBreakdown(
      createBody({ notifyAssignee: false }),
    ).expect(201);
    expect(omitted.body.notifyAssignee).toBe(true);
    expect(disabled.body.notifyAssignee).toBe(false);
    expect(await notificationCounts()).toEqual(before);
  });

  it('E-B13 stoppedAt은 선택이며 ABNORMAL 명시값도 startedAt으로 바꾸지 않는다', async () => {
    const absent = await postBreakdown(createBody()).expect(201);
    expect(absent.body.stoppedAt).toBeNull();
    const explicit = await postBreakdown(
      createBody({
        occurrenceStateCode: 'ABNORMAL',
        reportedAt: '2026-09-09T04:00:00+07:00',
        stoppedAt: '2026-09-09T05:00:00+07:00',
      }),
    ).expect(201);
    expect(explicit.body).toMatchObject({
      occurrenceStateCode: 'ABNORMAL',
      stoppedAt: '2026-09-08T22:00:00.000Z',
    });
    const stored = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: BigInt(explicit.body.breakdownId) },
    });
    expect(stored.started_at).toBeNull();
  });

  it('E-B14 같은 설비에 열린 고장이 있어도 새 보고를 별개로 만든다', async () => {
    const before = await prisma.breakdown.count({
      where: { equipment_id: ids.equipment, status_code: { not: 'DONE' } },
    });
    const created = await postBreakdown(
      createBody({ symptom: '동시 열린 고장' }),
    ).expect(201);
    expect(created.body.statusCode).toBe('RECEIVED');
    expect(
      await prisma.breakdown.count({
        where: { equipment_id: ids.equipment, status_code: { not: 'DONE' } },
      }),
    ).toBe(before + 1);
  });

  it('E-B15 STOPPED도 심각도와 설비 마스터 상태를 도출하지 않는다', async () => {
    const equipmentBefore = await prisma.equipment.findUniqueOrThrow({
      where: { equipment_id: ids.equipment },
    });
    const response = await postBreakdown(
      createBody({ occurrenceStateCode: 'STOPPED' }),
    ).expect(201);
    const stored = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: BigInt(response.body.breakdownId) },
    });
    const equipmentAfter = await prisma.equipment.findUniqueOrThrow({
      where: { equipment_id: ids.equipment },
    });
    expect(stored.severity_code).toBeNull();
    expect(equipmentAfter.status_code).toBe(equipmentBefore.status_code);
    expect(equipmentAfter.version_no).toBe(equipmentBefore.version_no);
  });

  it.each([
    [() => createBody(), null, 'X-Worker-No', 'REQUIRED'],
    [() => createBody(), '', 'X-Worker-No', 'REQUIRED'],
    [() => createBody(), ' ', 'X-Worker-No', 'REQUIRED'],
    [() => createBody(), 'W'.repeat(51), 'X-Worker-No', 'INVALID'],
    [() => createBody(), `${PREFIX}-UNKNOWN-WORKER`, 'X-Worker-No', 'INVALID'],
    [() => createBody({ symptom: ' ' }), WORKER_NO, 'symptom', 'REQUIRED'],
    [
      () => createBody({ equipmentId: -1 }),
      WORKER_NO,
      'equipmentId',
      'INVALID',
    ],
    [
      () => createBody({ occurrenceStateCode: 'RUNNING' }),
      WORKER_NO,
      'occurrenceStateCode',
      'INVALID',
    ],
  ])(
    'E-B16 사번·증상·설비·발생상태 오류를 검증한다: %#',
    async (makeBody, workerNo, field, code) => {
      const before = await prisma.breakdown.count();
      const response = await postBreakdown(makeBody(), { workerNo }).expect(
        400,
      );
      expect(response.body.errors[0]).toMatchObject({ field, code });
      expect(await prisma.breakdown.count()).toBe(before);
    },
  );

  it('E-B16 같은 주체·키·본문은 재생하고 다른 본문·계정·사번은 충돌한다', async () => {
    const key = randomUUID();
    const body = createBody({ symptom: '고장 멱등 재생' });
    const first = await postBreakdown(body, { key }).expect(201);
    const numbering = app.get(NumberingService);
    const numberSpy = jest
      .spyOn(numbering, 'next')
      .mockRejectedValueOnce(new Error('NUMBERING_MUST_NOT_RUN_ON_REPLAY'));
    let replay;
    try {
      replay = await postBreakdown(body, { key }).expect(201);
    } finally {
      numberSpy.mockRestore();
    }
    expect(replay.body).toEqual(first.body);
    expect(numberSpy).not.toHaveBeenCalled();
    expect(
      await prisma.breakdown.count({
        where: { breakdown_no: first.body.breakdownNo },
      }),
    ).toBe(1);
    for (const [changedBody, options] of [
      [{ ...body, symptom: '다른 본문' }, { key }],
      [{ ...body, symptom: ' ' }, { key }],
      [body, { key, authCookie: otherCookie }],
      [body, { key, workerNo: OTHER_WORKER_NO }],
    ] as const) {
      const conflict = await postBreakdown(changedBody, options).expect(409);
      expect(conflict.body).toMatchObject({ conflictCause: 'user' });
    }
    const missingWorker = await postBreakdown(body, {
      key,
      workerNo: null,
    }).expect(400);
    expect(missingWorker.body.errors[0]).toMatchObject({
      field: 'X-Worker-No',
      code: 'REQUIRED',
    });
  });

  it('E-B17 멱등 완료 저장 실패는 고장과 기록을 함께 롤백하고 재시도한다', async () => {
    const key = randomUUID();
    const marker = `ROLLBACK-${randomUUID()}`;
    const body = createBody({ symptom: marker });
    const runTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (work) =>
        runTransaction(async (tx) => {
          const completionSpy = jest
            .spyOn(tx.idempotency_record, 'update')
            .mockRejectedValueOnce(
              new Error('I30_BREAKDOWN_COMPLETION_FAILURE'),
            );
          try {
            return await (
              work as (client: Prisma.TransactionClient) => Promise<unknown>
            )(tx);
          } finally {
            completionSpy.mockRestore();
          }
        }),
      );
    try {
      const failed = await postBreakdown(body, { key }).expect(500);
      expect(failed.text).not.toContain('I30_BREAKDOWN_COMPLETION_FAILURE');
    } finally {
      transactionSpy.mockRestore();
    }
    expect(
      await prisma.breakdown.count({ where: { description: marker } }),
    ).toBe(0);
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
    await postBreakdown(body, { key }).expect(201);
    expect(
      await prisma.breakdown.count({ where: { description: marker } }),
    ).toBe(1);
  });

  it('E-B17 번호 유일 충돌만 전체 멱등 트랜잭션을 재시도한다', async () => {
    const body = createBody({ symptom: '번호 충돌 재시도' });
    const runTransaction = prisma.$transaction.bind(prisma);
    const duplicate = new Prisma.PrismaClientKnownRequestError('test', {
      code: 'P2002',
      clientVersion: '6.19.3',
      meta: { target: ['breakdown_no'] },
    });
    const transactionSpy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (work) =>
        runTransaction(async (tx) => {
          const createSpy = jest
            .spyOn(tx.breakdown, 'create')
            .mockRejectedValueOnce(duplicate);
          try {
            return await (
              work as (client: Prisma.TransactionClient) => Promise<unknown>
            )(tx);
          } finally {
            createSpy.mockRestore();
          }
        }),
      );
    try {
      await postBreakdown(body).expect(201);
    } finally {
      transactionSpy.mockRestore();
    }
    expect(
      await prisma.breakdown.count({
        where: { description: body.symptom as string },
      }),
    ).toBe(1);
  });

  it('E-B25 권한 없는 세션은403이고 세션 없이는401이다', async () => {
    const before = await prisma.breakdown.count();
    await postBreakdown(createBody(), {
      authCookie: noPermissionCookie,
    }).expect(403);
    await request(app.getHttpServer())
      .post(PATH)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', WORKER_NO)
      .send(createBody())
      .expect(401);
    expect(await prisma.breakdown.count()).toBe(before);
  });

  it('E-B18 PUT은 생략 유지·null 해제·메모 저장과 처리 감사를 기록한다', async () => {
    const id = await breakdown(
      'update-fields',
      '2026-09-02T00:00:00Z',
      'RECEIVED',
      ids.equipment,
      {
        cause_code: 'LEGACY-CAUSE',
        handling_note: '이전 메모',
        root_cause: '과거 원문',
        version_no: 4,
      },
    );
    const initial = await detailState(id);
    const note = await putBreakdown(id, initial.version, {
      handlingNote: '실린더 씰 교체',
    }).expect(200);
    expect(updateValidator(note.body)).toBe(true);
    expect(note.body.handling).toMatchObject({
      causeCode: 'LEGACY-CAUSE',
      handlingNote: '실린더 씰 교체',
      handledByUserId: Number(actorUserId),
      handledAt: expect.any(String),
    });
    const afterNote = await detailState(id);
    expect(afterNote.version).toBe(5);

    const cleared = await putBreakdown(id, afterNote.version, {
      causeCode: null,
    }).expect(200);
    expect(cleared.body.handling).toMatchObject({
      causeCode: null,
      handlingNote: '실린더 씰 교체',
    });
    const stored = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: id },
    });
    expect(stored).toMatchObject({
      cause_code: null,
      handling_note: '실린더 씰 교체',
      handled_by: actorUserId,
      updated_by: actorUserId,
      version_no: 6,
      root_cause: '과거 원문',
    });
    expect(stored.handled_at).not.toBeNull();
  });

  it('E-B18 빈 PUT도 열린 고장의 감사와 version을 한 번 갱신한다', async () => {
    const id = await breakdown('empty-update', '2026-09-02T01:00:00Z');
    const response = await putBreakdown(id, 1, {}).expect(200);
    expect(response.body.statusCode).toBe('RECEIVED');
    const stored = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: id },
    });
    expect(stored.version_no).toBe(2);
    expect(stored.handled_by).toBe(actorUserId);
    expect(stored.handled_at).not.toBeNull();
  });

  it('E-B19 품질 원인은 INVALID이고 설비 고장 원인은 PUT으로 저장한다', async () => {
    const rejectedId = await breakdown(
      'new-quality-cause',
      '2026-09-02T02:00:00Z',
      'RECEIVED',
      ids.equipment,
      { handling_note: '보존 메모' },
    );
    const rejected = await putBreakdown(rejectedId, 1, {
      causeCode: QUALITY_CAUSE,
    }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'causeCode',
      code: 'INVALID',
    });
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: rejectedId },
      }),
    ).toMatchObject({
      cause_code: null,
      handling_note: '보존 메모',
      handled_by: null,
      version_no: 1,
    });

    const acceptedId = await breakdown(
      'same-breakdown-cause',
      '2026-09-02T02:30:00Z',
      'RECEIVED',
      ids.equipment,
      { cause_code: BREAKDOWN_CAUSE },
    );
    const accepted = await putBreakdown(acceptedId, 1, {
      causeCode: BREAKDOWN_CAUSE,
    }).expect(200);
    expect(updateValidator(accepted.body)).toBe(true);
    expect(accepted.body.handling.causeCode).toBe(BREAKDOWN_CAUSE);
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: acceptedId },
      }),
    ).toMatchObject({ cause_code: BREAKDOWN_CAUSE, version_no: 2 });
  });

  it('E-B20 PUT→GET→start→GET은 현장 원문과 열린 비가동 경고를 보존한다', async () => {
    const id = await breakdown(
      'immutable-chain',
      '2026-09-02T03:00:00Z',
      'RECEIVED',
      ids.equipment,
      {
        description: '현장 증상 원문',
        occurrence_state_code: 'STOPPED',
        stopped_at: new Date('2026-09-02T02:30:00Z'),
        reporter_worker_no: OTHER_WORKER_NO,
        root_cause: '구버전 원인 원문',
      },
    );
    await prisma.equipment_downtime.create({
      data: {
        equipment_id: ids.equipment,
        breakdown_id: id,
        downtime_type_code: 'BREAKDOWN',
        started_at: new Date('2026-09-02T02:30:00Z'),
      },
    });
    const before = await immutableBreakdown(id);
    const first = await detailState(id);
    expect(first.body.openLinkedDowntimeCount).toBe(1);
    await putBreakdown(id, first.version, { handlingNote: '처리 준비' }).expect(
      200,
    );
    const afterPut = await detailState(id);
    const started = await startBreakdown(id, afterPut.version).expect(200);
    expect(startValidator(started.body)).toBe(true);
    expect(started.body).toMatchObject({
      statusCode: 'HANDLING',
      linkedDowntimeCount: 0,
    });
    const afterStart = await detailState(id);
    expect(afterStart.body.openLinkedDowntimeCount).toBe(1);
    expect(await immutableBreakdown(id)).toEqual(before);
    const stored = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: id },
    });
    expect(stored.started_at).not.toBeNull();
    expect(stored.handled_by).toBe(actorUserId);
    expect(stored.version_no).toBe(3);
  });

  it('E-B21 RECEIVED만 HANDLING이고 반복·미등록 상태는 STATE_LOCKED다', async () => {
    const received = await breakdown('start-once', '2026-09-02T04:00:00Z');
    await startBreakdown(received, 1).expect(200);
    const repeated = await startBreakdown(received, 2).expect(400);
    expect(repeated.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });

    const unknown = await breakdown(
      'start-unknown',
      '2026-09-02T05:00:00Z',
      `${PREFIX}-UNKNOWN-START`,
    );
    const rejected = await startBreakdown(unknown, 1).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('E-B22 대상404→version409→상태→원인 순서로 거절한다', async () => {
    await putBreakdown(999999999, 1, { causeCode: QUALITY_CAUSE }).expect(404);
    const done = await breakdown(
      'ordering-done',
      '2026-09-02T06:00:00Z',
      'DONE',
      ids.equipment,
      { version_no: 5 },
    );
    const stale = await putBreakdown(done, 4, {
      causeCode: QUALITY_CAUSE,
    }).expect(409);
    expect(stale.body.conflictCause).toBe('user');
    const locked = await putBreakdown(done, 5, {
      causeCode: QUALITY_CAUSE,
    }).expect(400);
    expect(locked.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });

    const open = await breakdown('ordering-open', '2026-09-02T07:00:00Z');
    const cause = await putBreakdown(open, 1, {
      causeCode: QUALITY_CAUSE,
    }).expect(400);
    expect(cause.body.errors[0]).toMatchObject({
      field: 'causeCode',
      code: 'INVALID',
    });
  });

  it('E-B23 같은 키 start는 재생하고 다른 키 경합은 한 요청만 성공한다', async () => {
    const replayId = await breakdown('start-replay', '2026-09-02T08:00:00Z');
    const key = randomUUID();
    const first = await startBreakdown(replayId, 1, { key }).expect(200);
    const replay = await startBreakdown(replayId, 1, { key }).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: replayId },
      }),
    ).toMatchObject({ status_code: 'HANDLING', version_no: 2 });

    const concurrentId = await breakdown(
      'start-concurrent',
      '2026-09-02T09:00:00Z',
    );
    const responses = await Promise.all([
      startBreakdown(concurrentId, 1),
      startBreakdown(concurrentId, 1),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: concurrentId },
      }),
    ).toMatchObject({ status_code: 'HANDLING', version_no: 2 });
  });

  it('E-B24 멱등 완료 기록 실패와 응답 매핑 실패는 상태·감사·version을 롤백한다', async () => {
    const id = await breakdown('start-rollback', '2026-09-02T10:00:00Z');
    const key = randomUUID();
    const runTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (work) =>
        runTransaction(async (tx) => {
          const completionSpy = jest
            .spyOn(tx.idempotency_record, 'update')
            .mockRejectedValueOnce(
              new Error('I30_HANDLING_COMPLETION_FAILURE'),
            );
          try {
            return await (
              work as (client: Prisma.TransactionClient) => Promise<unknown>
            )(tx);
          } finally {
            completionSpy.mockRestore();
          }
        }),
      );
    try {
      const failed = await startBreakdown(id, 1, { key }).expect(500);
      expect(failed.text).not.toContain('I30_HANDLING_COMPLETION_FAILURE');
    } finally {
      transactionSpy.mockRestore();
    }
    expect(
      await prisma.breakdown.findUniqueOrThrow({ where: { breakdown_id: id } }),
    ).toMatchObject({
      status_code: 'RECEIVED',
      started_at: null,
      handled_by: null,
      handled_at: null,
      version_no: 1,
    });
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
    await startBreakdown(id, 1, { key }).expect(200);

    const missingReporter = records.missingReporter;
    const beforeMissing = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: missingReporter },
    });
    await startBreakdown(missingReporter, beforeMissing.version_no).expect(500);
    const afterMissing = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: missingReporter },
    });
    expect(afterMissing).toMatchObject({
      status_code: beforeMissing.status_code,
      started_at: beforeMissing.started_at,
      handled_by: beforeMissing.handled_by,
      handled_at: beforeMissing.handled_at,
      version_no: beforeMissing.version_no,
    });
  });

  it('E-B25 관리웹 PUT/start는 사번이 불필요하고 권한 없는 계정은403이다', async () => {
    const allowed = await breakdown(
      'management-no-worker',
      '2026-09-02T11:00:00Z',
    );
    await putBreakdown(allowed, 1, { handlingNote: '사번 없이 저장' }).expect(
      200,
    );
    await startBreakdown(allowed, 2).expect(200);

    const denied = await breakdown('management-denied', '2026-09-02T12:00:00Z');
    await putBreakdown(
      denied,
      1,
      { handlingNote: '권한 없음' },
      { authCookie: noPermissionCookie },
    ).expect(403);
    await startBreakdown(denied, 1, {
      authCookie: noPermissionCookie,
    }).expect(403);
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: denied },
      }),
    ).toMatchObject({ status_code: 'RECEIVED', version_no: 1 });
  });

  it('E-C01 RECEIVED에서 DONE으로 직행하고 started_at은 null로 둔다', async () => {
    const id = await breakdown('complete-direct', '2026-09-03T00:00:00Z');
    const response = await completeBreakdown(id, 1, {
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '경미한 누유 조치',
    }).expect(200);
    expect(completeValidator(response.body)).toBe(true);
    expect(response.body).toMatchObject({
      statusCode: 'DONE',
      handling: {
        causeCode: BREAKDOWN_CAUSE,
        handlingNote: '경미한 누유 조치',
        handledByUserId: Number(actorUserId),
      },
    });
    const stored = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: id },
    });
    expect(stored).toMatchObject({
      status_code: 'DONE',
      started_at: null,
      cause_code: BREAKDOWN_CAUSE,
      handling_note: '경미한 누유 조치',
      handled_by: actorUserId,
      version_no: 2,
    });
    expect(stored.completed_at).not.toBeNull();
    expect(stored.handled_at).toEqual(stored.completed_at);
  });

  it('E-C02 HANDLING에서 DONE으로 가며 처리 시작 시각을 보존한다', async () => {
    const id = await breakdown('complete-handling', '2026-09-03T01:00:00Z');
    await startBreakdown(id, 1).expect(200);
    const started = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: id },
    });
    const response = await completeBreakdown(id, 2, {
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '씰 교체 완료',
    }).expect(200);
    expect(completeValidator(response.body)).toBe(true);
    const completed = await prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: id },
    });
    expect(completed.status_code).toBe('DONE');
    expect(completed.started_at).toEqual(started.started_at);
    expect(completed.completed_at).not.toBeNull();
    if (completed.completed_at === null || completed.started_at === null) {
      throw new Error('완료·처리 시작 시각이 저장되지 않았습니다.');
    }
    expect(completed.completed_at.getTime()).toBeGreaterThanOrEqual(
      completed.started_at.getTime(),
    );
    expect(completed.version_no).toBe(3);
  });

  it('E-C03 완료 뒤 complete·PUT·start 재전이는 STATE_LOCKED다', async () => {
    const id = await breakdown('complete-locked', '2026-09-03T02:00:00Z');
    await completeBreakdown(id, 1, {
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '완료',
    }).expect(200);
    for (const response of [
      await completeBreakdown(id, 2, {
        causeCode: BREAKDOWN_CAUSE,
        handlingNote: '재완료',
      }),
      await putBreakdown(id, 2, { handlingNote: '재수정' }),
      await startBreakdown(id, 2),
    ]) {
      expect(response.status).toBe(400);
      expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    }
    expect(
      await prisma.breakdown.findUniqueOrThrow({ where: { breakdown_id: id } }),
    ).toMatchObject({ status_code: 'DONE', version_no: 2 });
  });

  it('E-C04 활성 설비 고장 원인만 허용하고 품질·비활성 원인을 섞지 않는다', async () => {
    const qualityId = await breakdown(
      'complete-quality-cause',
      '2026-09-03T03:00:00Z',
    );
    const quality = await completeBreakdown(qualityId, 1, {
      causeCode: QUALITY_CAUSE,
      handlingNote: '품질 원인은 금지',
    }).expect(400);
    expect(quality.body.errors[0]).toMatchObject({
      field: 'causeCode',
      code: 'INVALID',
    });

    const cause = await prisma.code_value.findFirstOrThrow({
      where: {
        code: BREAKDOWN_CAUSE,
        code_group: { group_code: BREAKDOWN_CAUSE_GROUP },
      },
    });
    await prisma.code_value.update({
      where: { code_value_id: cause.code_value_id },
      data: { is_active: false },
    });
    try {
      const inactiveId = await breakdown(
        'complete-inactive-cause',
        '2026-09-03T03:30:00Z',
      );
      const inactive = await completeBreakdown(inactiveId, 1, {
        causeCode: BREAKDOWN_CAUSE,
        handlingNote: '비활성 원인은 금지',
      }).expect(400);
      expect(inactive.body.errors[0]).toMatchObject({
        field: 'causeCode',
        code: 'INVALID',
      });
    } finally {
      await prisma.code_value.update({
        where: { code_value_id: cause.code_value_id },
        data: { is_active: true },
      });
    }

    const group = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: BREAKDOWN_CAUSE_GROUP },
    });
    await prisma.code_group.update({
      where: { code_group_id: group.code_group_id },
      data: { is_active: false },
    });
    try {
      const inactiveGroupId = await breakdown(
        'complete-inactive-cause-group',
        '2026-09-03T03:45:00Z',
      );
      const inactiveGroup = await completeBreakdown(inactiveGroupId, 1, {
        causeCode: BREAKDOWN_CAUSE,
        handlingNote: '비활성 그룹은 금지',
      }).expect(400);
      expect(inactiveGroup.body.errors[0]).toMatchObject({
        field: 'causeCode',
        code: 'INVALID',
      });
    } finally {
      await prisma.code_group.update({
        where: { code_group_id: group.code_group_id },
        data: { is_active: true },
      });
    }
  });

  it('E-C05 동일키 완료는 재생하고 다른 키 경합은 한 요청만 성공한다', async () => {
    const replayId = await breakdown('complete-replay', '2026-09-03T04:00:00Z');
    const body = {
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '멱등 완료',
    };
    const key = randomUUID();
    const first = await completeBreakdown(replayId, 1, body, { key }).expect(
      200,
    );
    const replay = await completeBreakdown(replayId, 1, body, { key }).expect(
      200,
    );
    expect(replay.body).toEqual(first.body);
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: replayId },
      }),
    ).toMatchObject({ status_code: 'DONE', version_no: 2 });

    const concurrentId = await breakdown(
      'complete-concurrent',
      '2026-09-03T04:30:00Z',
    );
    const responses = await Promise.all([
      completeBreakdown(concurrentId, 1, body),
      completeBreakdown(concurrentId, 1, body),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: concurrentId },
      }),
    ).toMatchObject({ status_code: 'DONE', version_no: 2 });
  });

  it('E-C06 멱등 완료 기록 실패는 완료값·감사·version을 함께 롤백한다', async () => {
    const id = await breakdown('complete-rollback', '2026-09-03T05:00:00Z');
    const key = randomUUID();
    const runTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (work) =>
        runTransaction(async (tx) => {
          const completionSpy = jest
            .spyOn(tx.idempotency_record, 'update')
            .mockRejectedValueOnce(new Error('I30_COMPLETE_RECORD_FAILURE'));
          try {
            return await (
              work as (client: Prisma.TransactionClient) => Promise<unknown>
            )(tx);
          } finally {
            completionSpy.mockRestore();
          }
        }),
      );
    try {
      const failed = await completeBreakdown(
        id,
        1,
        { causeCode: BREAKDOWN_CAUSE, handlingNote: '롤백 대상' },
        { key },
      ).expect(500);
      expect(failed.text).not.toContain('I30_COMPLETE_RECORD_FAILURE');
    } finally {
      transactionSpy.mockRestore();
    }
    expect(
      await prisma.breakdown.findUniqueOrThrow({ where: { breakdown_id: id } }),
    ).toMatchObject({
      status_code: 'RECEIVED',
      completed_at: null,
      cause_code: null,
      handling_note: null,
      handled_by: null,
      handled_at: null,
      version_no: 1,
    });
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
  });

  it('E-C07 완료는 연결 지시·열린 비가동·알림·재고를 바꾸지 않는다', async () => {
    const id = await breakdown(
      'complete-no-side-effect',
      '2026-09-03T06:00:00Z',
    );
    const orderId = await order('complete-no-side-effect', id, true, null);
    const downtime = await prisma.equipment_downtime.create({
      data: {
        equipment_id: ids.equipment,
        breakdown_id: id,
        downtime_type_code: 'BREAKDOWN',
        started_at: new Date('2026-09-03T06:00:00Z'),
      },
    });
    const before = {
      order: await prisma.maintenance_order.findUniqueOrThrow({
        where: { maintenance_order_id: orderId },
      }),
      downtime: await prisma.equipment_downtime.findUniqueOrThrow({
        where: { equipment_downtime_id: downtime.equipment_downtime_id },
      }),
      notifications: await notificationCounts(),
      inventory: await prisma.inventory_transaction.count(),
      sessions: await prisma.work_session.count(),
    };
    await completeBreakdown(id, 1, {
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '부가 효과 없이 완료',
    }).expect(200);
    expect(
      await prisma.maintenance_order.findUniqueOrThrow({
        where: { maintenance_order_id: orderId },
      }),
    ).toEqual(before.order);
    expect(
      await prisma.equipment_downtime.findUniqueOrThrow({
        where: { equipment_downtime_id: downtime.equipment_downtime_id },
      }),
    ).toEqual(before.downtime);
    expect(await notificationCounts()).toEqual(before.notifications);
    expect(await prisma.inventory_transaction.count()).toBe(before.inventory);
    expect(await prisma.work_session.count()).toBe(before.sessions);
  });

  it('E-C08 지시·severity 없이도 완료하고 미래 처리시작 행은 RANGE로 거절한다', async () => {
    const direct = await breakdown(
      'complete-no-order',
      '2026-09-03T07:00:00Z',
      'RECEIVED',
      ids.equipment,
      { severity_code: null },
    );
    await completeBreakdown(direct, 1, {
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '지시 없이 완료',
    }).expect(200);

    const future = await breakdown(
      'complete-future-start',
      '2026-09-03T07:30:00Z',
      'HANDLING',
      ids.equipment,
      { started_at: new Date('2999-01-01T00:00:00Z') },
    );
    const rejected = await completeBreakdown(future, 1, {
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '미래 시작 행',
    }).expect(422);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'startedAt',
      code: 'RANGE',
    });
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: future },
      }),
    ).toMatchObject({
      status_code: 'HANDLING',
      completed_at: null,
      version_no: 1,
    });
  });

  it('E-C09 완료 응답은 새 처리값을 내리고 버전 ETag는 상세 GET에서 읽는다', async () => {
    const id = await breakdown('complete-response', '2026-09-03T08:00:00Z');
    const completed = await completeBreakdown(id, 1, {
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '응답 확인',
    }).expect(200);
    expect(completeValidator(completed.body)).toBe(true);
    expect(completed.body.versionNo).toBeUndefined();
    expect(completed.body.handling).toMatchObject({
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '응답 확인',
      handledByUserId: Number(actorUserId),
    });
    const detail = await detailState(id);
    expect(detail.version).toBe(2);
    expect(detail.body.statusCode).toBe('DONE');
    expect(detail.body.handling).toEqual(completed.body.handling);
  });

  it('E-C10 관리웹 완료는 사번 없이 성공하고 권한·필수본문을 검증한다', async () => {
    const denied = await breakdown(
      'complete-permission-denied',
      '2026-09-03T09:00:00Z',
    );
    await completeBreakdown(
      denied,
      1,
      { causeCode: BREAKDOWN_CAUSE, handlingNote: '권한 없음' },
      { authCookie: noPermissionCookie },
    ).expect(403);
    expect(
      await prisma.breakdown.findUniqueOrThrow({
        where: { breakdown_id: denied },
      }),
    ).toMatchObject({ status_code: 'RECEIVED', version_no: 1 });

    const noWorker = await breakdown(
      'complete-no-worker',
      '2026-09-03T09:30:00Z',
    );
    await completeBreakdown(noWorker, 1, {
      causeCode: BREAKDOWN_CAUSE,
      handlingNote: '관리웹 완료',
    }).expect(200);

    const missing = await breakdown(
      'complete-required',
      '2026-09-03T10:00:00Z',
    );
    await completeBreakdown(missing, 1, { handlingNote: '원인 누락' }).expect(
      400,
    );
    const blank = await completeBreakdown(missing, 1, {
      causeCode: ' ',
      handlingNote: ' ',
    }).expect(400);
    expect(blank.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'causeCode', code: 'REQUIRED' }),
        expect.objectContaining({ field: 'handlingNote', code: 'REQUIRED' }),
      ]),
    );
  });

  function createBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      equipmentId: Number(ids.equipment),
      symptom: '유압 누유',
      occurrenceStateCode: 'ABNORMAL',
      stoppedAt: null,
      reportedAt: '2026-09-09T00:30:00+07:00',
      ...overrides,
    };
  }

  function postBreakdown(
    body: Record<string, unknown>,
    options: {
      key?: string;
      workerNo?: string | null;
      authCookie?: string[];
    } = {},
  ) {
    const response = request(app.getHttpServer())
      .post(PATH)
      .set('Cookie', options.authCookie ?? cookie)
      .set('Idempotency-Key', options.key ?? randomUUID());
    if (options.workerNo !== null) {
      response.set('X-Worker-No', options.workerNo ?? WORKER_NO);
    }
    return response.send(body);
  }

  function putBreakdown(
    breakdownId: bigint | number,
    version: number,
    body: Record<string, unknown>,
    options: { key?: string; authCookie?: string[] } = {},
  ) {
    return request(app.getHttpServer())
      .put(`${PATH}/${breakdownId}`)
      .set('Cookie', options.authCookie ?? cookie)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', String(version))
      .send(body);
  }

  function startBreakdown(
    breakdownId: bigint | number,
    version: number,
    options: { key?: string; authCookie?: string[] } = {},
  ) {
    return request(app.getHttpServer())
      .post(`${PATH}/${breakdownId}:start-handling`)
      .set('Cookie', options.authCookie ?? cookie)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', String(version));
  }

  function completeBreakdown(
    breakdownId: bigint | number,
    version: number,
    body: Record<string, unknown>,
    options: { key?: string; authCookie?: string[] } = {},
  ) {
    return request(app.getHttpServer())
      .post(`${PATH}/${breakdownId}:complete`)
      .set('Cookie', options.authCookie ?? cookie)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', String(version))
      .send(body);
  }

  async function detailState(breakdownId: bigint): Promise<{
    body: BreakdownView;
    version: number;
  }> {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${breakdownId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detailValidator(response.body)).toBe(true);
    return {
      body: response.body as BreakdownView,
      version: Number(response.headers.etag),
    };
  }

  function immutableBreakdown(breakdownId: bigint) {
    return prisma.breakdown.findUniqueOrThrow({
      where: { breakdown_id: breakdownId },
      select: {
        description: true,
        occurrence_state_code: true,
        stopped_at: true,
        reported_at: true,
        reporter_worker_no: true,
        root_cause: true,
        notify_assignee: true,
      },
    });
  }

  function notificationCounts(): Promise<number[]> {
    return Promise.all([
      prisma.notification.count(),
      prisma.notification_event.count(),
      prisma.integration_message.count(),
    ]);
  }

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
    const breakdownCauseGroup = await prisma.code_group.upsert({
      where: { group_code: BREAKDOWN_CAUSE_GROUP },
      create: {
        group_code: BREAKDOWN_CAUSE_GROUP,
        group_name: '설비 고장 원인',
        description: PREFIX,
      },
      update: {},
    });
    await prisma.code_value.create({
      data: {
        code_group_id: breakdownCauseGroup.code_group_id,
        code: BREAKDOWN_CAUSE,
        code_name: '유압 계통 누유',
      },
    });
    await prisma.cause_code.create({
      data: { cause_code: QUALITY_CAUSE, cause_name: '품질 원인 대조용' },
    });
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
    const makePlant = async (
      suffix: string,
      timezone: string,
    ): Promise<bigint> =>
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
    ids.numberingRule = (
      await prisma.numbering_rule.create({
        data: {
          document_type_code: 'BREAKDOWN',
          plant_id: ids.plant,
          pattern: 'MLF-{YYYYMMDD}-{SEQ4}',
          reset_cycle_code: 'DAILY',
        },
      })
    ).numbering_rule_id;
    const makeEquipment = async (
      suffix: string,
      plantId: bigint,
    ): Promise<bigint> =>
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
    await prisma.worker.createMany({
      data: [WORKER_NO, OTHER_WORKER_NO].map((worker_no) => ({
        worker_no,
        worker_name: worker_no,
        business_unit_id: business.business_unit_id,
        plant_id: ids.plant,
        status_code: 'EMPLOYED',
      })),
    });

    await breakdown(
      'oldReceived',
      '2026-08-31T18:00:00Z',
      'RECEIVED',
      ids.equipment,
      {
        occurrence_state_code: 'STOPPED',
        stopped_at: new Date('2026-08-31T17:30:00Z'),
        cause_code: 'UNREGISTERED-CAUSE',
        handling_note: '원문 처리',
        root_cause: 'legacy root cause',
        version_no: 17,
      },
    );
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

    await breakdown(
      'beforeStart',
      '2026-08-31T16:59:59.999Z',
      'DONE',
      ids.otherEquipment,
    );
    await breakdown(
      'hanoiSameMoment',
      '2026-08-31T16:00:00Z',
      'DONE',
      ids.otherEquipment,
    );
    await breakdown(
      'startInclusive',
      '2026-08-31T17:00:00Z',
      'RECEIVED',
      ids.otherEquipment,
    );
    await breakdown(
      'endInside',
      '2026-09-01T16:59:59.999Z',
      'DONE',
      ids.otherEquipment,
    );
    await breakdown(
      'endExcluded',
      '2026-09-01T17:00:00Z',
      'RECEIVED',
      ids.otherEquipment,
    );
    await breakdown(
      'seoulSameMoment',
      '2026-08-31T16:00:00Z',
      'DONE',
      ids.seoulEquipment,
    );
    await breakdown(
      'badZone',
      '2026-09-01T00:00:00Z',
      'RECEIVED',
      ids.badEquipment,
    );

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
    await order(
      'cancelled',
      records.cancelled,
      false,
      'BREAKDOWN',
      'CANCELLED',
    );

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
    const user = await prisma.app_user.findUniqueOrThrow({
      where: { login_id: LOGIN_ID },
    });
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
    const plants = await prisma.plant.findMany({
      where: { plant_code: { startsWith: `${PREFIX}-` } },
      select: { plant_id: true },
    });
    const plantIds = plants.map((row) => row.plant_id);
    const equipment = await prisma.equipment.findMany({
      where: {
        plant_id: { in: plantIds },
        equipment_code: { startsWith: `${PREFIX}-` },
      },
      select: { equipment_id: true },
    });
    const equipmentIds = equipment.map((row) => row.equipment_id);
    const breakdowns = await prisma.breakdown.findMany({
      where: {
        OR: [
          { breakdown_no: { startsWith: `${PREFIX}-` } },
          { equipment_id: { in: equipmentIds } },
        ],
      },
      select: { breakdown_id: true },
    });
    const breakdownIds = breakdowns.map((row) => row.breakdown_id);
    await prisma.equipment_downtime.deleteMany({
      where: { breakdown_id: { in: breakdownIds } },
    });
    const maintenanceOrders = await prisma.maintenance_order.findMany({
      where: {
        OR: [
          { maintenance_order_no: { startsWith: `${PREFIX}-ORDER-` } },
          { breakdown_id: { in: breakdownIds } },
        ],
      },
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
    await prisma.cause_code.deleteMany({
      where: { cause_code: QUALITY_CAUSE },
    });
    const breakdownCauseGroup = await prisma.code_group.findUnique({
      where: { group_code: BREAKDOWN_CAUSE_GROUP },
    });
    if (breakdownCauseGroup !== null) {
      await prisma.code_value.deleteMany({
        where: {
          code_group_id: breakdownCauseGroup.code_group_id,
          code: BREAKDOWN_CAUSE,
        },
      });
      if (
        breakdownCauseGroup.description === PREFIX &&
        (await prisma.code_value.count({
          where: { code_group_id: breakdownCauseGroup.code_group_id },
        })) === 0
      ) {
        await prisma.code_group.delete({
          where: { code_group_id: breakdownCauseGroup.code_group_id },
        });
      }
    }
    const numberingRules = await prisma.numbering_rule.findMany({
      where: {
        document_type_code: 'BREAKDOWN',
        plant_id: { in: plantIds },
      },
      select: { numbering_rule_id: true },
    });
    const numberingRuleIds = numberingRules.map((row) => row.numbering_rule_id);
    await prisma.numbering_counter.deleteMany({
      where: { numbering_rule_id: { in: numberingRuleIds } },
    });
    await prisma.numbering_rule.deleteMany({
      where: { numbering_rule_id: { in: numberingRuleIds } },
    });
    await prisma.worker.deleteMany({
      where: { worker_no: { startsWith: PREFIX } },
    });
    await prisma.equipment.deleteMany({
      where: { equipment_id: { in: equipmentIds } },
    });
    await prisma.plant.deleteMany({ where: { plant_id: { in: plantIds } } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role !== null) {
      await prisma.user_role.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role_permission.deleteMany({
        where: { role_id: role.role_id },
      });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
    const users = await prisma.app_user.findMany({
      where: {
        login_id: { in: [LOGIN_ID, OTHER_LOGIN_ID, NO_PERMISSION_LOGIN_ID] },
      },
      select: { app_user_id: true },
    });
    const userIds = users.map((row) => row.app_user_id);
    await prisma.idempotency_record.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.user_credential.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.app_user.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
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
