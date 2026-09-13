/**
 * 작업 세션 조회 4건(I-11 PR ①) + **세션 열기·닫기**(PR ③) — `POST /production/work-sessions`
 * 와 `…/{id}:end`. 조회 픽스처는 직접 INSERT 하고, 쓰기 갈래는 API 로만 만든다.
 *
 * ⭐ 단말 토큰은 `POST /mdm/terminals/{terminalId}:issue-token` 으로 받는다 — 서명 코드를
 *    e2e 가 복제하지 않는다(§10-1). 403 셋(`can_start_work=false`·행 부재·토큰 부재)을 가른다.
 * ⛔ `TRUNCATE` 를 쓰지 않는다 — FK 역순 `DELETE` 로 정리한다(I-9 §7-2).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { parseIfMatch } from '../src/common/optimistic-lock';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-wse-probe';
const NOPERM_ID = 'e2e-wse-noperm';
const PASSWORD = 'WSE-작업세션-비밀번호';
const ROLE = 'E2E_WORK_SESSION';
/** 세션 열기 P-02-01 · `:end`·`:hold` P-02-10 · W/O 발행 W-02-02 · 배포 W-02-04 · 토큰 M-CO-01. */
const PERMISSIONS = ['P-02-01', 'P-02-10', 'W-02-02', 'W-02-03', 'W-02-04', 'M-CO-01'];
const PREFIX = 'WSE2E';
const BASE = '/api/production/work-sessions';
const WORK_ORDERS = '/api/production/work-orders';
const LOT_SOURCE = 'WORK_ORDER';

const T0 = '2026-09-07T01:00:00.000Z';
const T1 = '2026-09-07T02:00:00.000Z';
const T2 = '2026-09-07T03:00:00.000Z';
/** 공장 로컬(UTC+7) 09:00 — 픽스처 교대(08:00~17:00)에 든다. */
const START_AT = '2026-09-07T02:30:00.000Z';
const END_AT = '2026-09-07T07:30:00.000Z';
/** 공장 로컬 03:00 — 어느 교대에도 안 든다. */
const OUT_OF_SHIFT = '2026-09-07T20:00:00.000Z';

/** 계약 스키마로 응답 본문을 대조한다(`production-work-order.e2e-spec.ts` 사본). */
function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('작업 세션 조회 4건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let terminalToken: string;
  let staleToken: string;
  let blockedToken: string;
  let unmappedToken: string;

  const ids: Record<string, bigint> = {};
  let workOrderAId: number;
  let s1Id: number;
  let s2Id: number;
  let s3Id: number;
  let sOtherId: number;
  let e1Id: number;
  let e2Id: number;
  let e3Id: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
    await makeTokens();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록 기본은 열린 세션만 낸다 — ended_at 이 찍힌 세션이 빠진다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(validator('GET /production/work-sessions')(response.body)).toBe(true);
    const returnedIds = response.body.items.map((item: { workSessionId: number }) => item.workSessionId);
    expect(returnedIds).not.toContain(s2Id);
    expect(returnedIds).toEqual([s3Id, s1Id]);
  });

  it('open=false 는 끝난 세션만 낸다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}&open=false`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items.map((item: { workSessionId: number }) => item.workSessionId)).toEqual([s2Id]);
  });

  it('목록이 workOrderId·terminalId·shiftId 로 걸러진다', async () => {
    const byTerminal = await request(app.getHttpServer())
      .get(`${BASE}?terminalId=${ids.terminalB}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byTerminal.body.items.map((item: { workSessionId: number }) => item.workSessionId)).toEqual([sOtherId]);

    const byShift = await request(app.getHttpServer())
      .get(`${BASE}?shiftId=${ids.shiftB}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byShift.body.items.map((item: { workSessionId: number }) => item.workSessionId)).toEqual([sOtherId]);

    const byWorkOrder = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}`)
      .set('Cookie', cookie)
      .expect(200);
    const workOrderIds = byWorkOrder.body.items.map((item: { workOrderId: number }) => item.workOrderId);
    expect(new Set(workOrderIds)).toEqual(new Set([workOrderAId]));
  });

  it('목록이 startedFrom 이상 startedTo 미만으로 걸러진다', async () => {
    // 반개구간(L-3) — 하한 T0 는 포함(s1), 상한 T2 는 미포함(s3 는 빠진다).
    const response = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}&startedFrom=${T0}&startedTo=${T2}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items.map((item: { workSessionId: number }) => item.workSessionId)).toEqual([s1Id]);
  });

  it('⛔ 목록이 status_code 로 거르지 않는다 — STOPPED 도 열린 것으로 나온다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}`)
      .set('Cookie', cookie)
      .expect(200);

    const stopped = response.body.items.find((item: { workSessionId: number }) => item.workSessionId === s3Id);
    expect(stopped).toMatchObject({ statusCode: 'STOPPED' });
    expect(stopped.endedAt).toBeUndefined();
  });

  it('상세가 없는 세션이면 404', async () => {
    await request(app.getHttpServer()).get(`${BASE}/999999999`).set('Cookie', cookie).expect(404);
  });

  it('events 목록이 occurred_at 오름차순이고 eventTypeCode 로 걸러진다', async () => {
    const all = await request(app.getHttpServer()).get(`${BASE}/${s1Id}/events`).set('Cookie', cookie).expect(200);
    expect(all.body.map((item: { workSessionEventId: number }) => item.workSessionEventId)).toEqual([
      e1Id,
      e2Id,
      e3Id,
    ]);
    // ⭐ 파생 칸 `reasonName` — `mdm.code_value.code_name` 을 그룹 대응표로 찾는다(§8 ⭐).
    const stopEvent = all.body.find((item: { workSessionEventId: number }) => item.workSessionEventId === e2Id);
    expect(stopEvent).toMatchObject({ reasonCode: 'MOLD_CHANGE', reasonName: '금형 교체' });

    const filtered = await request(app.getHttpServer())
      .get(`${BASE}/${s1Id}/events?eventTypeCode=STOP`)
      .set('Cookie', cookie)
      .expect(200);
    expect(filtered.body.map((item: { workSessionEventId: number }) => item.workSessionEventId)).toEqual([e2Id]);
  });

  it('events 응답이 배열이다 — page 봉투가 없다', async () => {
    const response = await request(app.getHttpServer()).get(`${BASE}/${s1Id}/events`).set('Cookie', cookie).expect(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.page).toBeUndefined();
    expect(validator('GET /production/work-sessions/{workSessionId}/events')(response.body)).toBe(true);
  });

  it('없는 세션의 events 는 404', async () => {
    await request(app.getHttpServer()).get(`${BASE}/999999999/events`).set('Cookie', cookie).expect(404);
  });

  it('workers 기본은 left_at 이 빈 사람만이고 active=false 는 떠난 사람만이다', async () => {
    const active = await request(app.getHttpServer()).get(`${BASE}/${s1Id}/workers`).set('Cookie', cookie).expect(200);
    expect(Array.isArray(active.body)).toBe(true);
    expect(active.body.map((item: { workerId: number }) => item.workerId)).toEqual([Number(ids.worker1)]);

    const left = await request(app.getHttpServer())
      .get(`${BASE}/${s1Id}/workers?active=false`)
      .set('Cookie', cookie)
      .expect(200);
    expect(left.body.map((item: { workerId: number }) => item.workerId)).toEqual([Number(ids.worker2)]);
    expect(validator('GET /production/work-sessions/{workSessionId}/workers')(active.body)).toBe(true);
  });

  it('⛔ 조회 5건 응답에 ETag 가 없다', async () => {
    // 계약이 5건 어디에도 헤더를 선언하지 않았다 — `setEtag` 를 부르지 않는다(I-9 ①-1 선례).
    const list = await request(app.getHttpServer()).get(`${BASE}?workOrderId=${workOrderAId}`).set('Cookie', cookie).expect(200);
    expect(parseIfMatch(String(list.headers.etag ?? ''))).toBeNull();

    const detail = await request(app.getHttpServer()).get(`${BASE}/${s1Id}`).set('Cookie', cookie).expect(200);
    expect(parseIfMatch(String(detail.headers.etag ?? ''))).toBeNull();

    const events = await request(app.getHttpServer()).get(`${BASE}/${s1Id}/events`).set('Cookie', cookie).expect(200);
    expect(parseIfMatch(String(events.headers.etag ?? ''))).toBeNull();

    const workers = await request(app.getHttpServer()).get(`${BASE}/${s1Id}/workers`).set('Cookie', cookie).expect(200);
    expect(parseIfMatch(String(workers.headers.etag ?? ''))).toBeNull();
  });

  /**
   * ⭐ M2 「… 투입 → **세션** → 실적 …」의 세션 마디(PR ③). 열기·닫기는 전부 API 를 탄다 —
   * 직접 INSERT 하면 보려는 마디가 사라진다.
   */
  describe('세션 열기 · 닫기', () => {
    // ⚠ 계약 `IdempotencyKey` 는 `format: uuid` 다 — 접두어를 붙이면 검증 가드가 400 을 낸다.
    const idem = () => randomUUID();

    /** 배포된 W/O 하나. 기본은 직접 INSERT 다 — `:release` 를 타는 자리는 M2 마디뿐이다. */
    let serial = 0;
    const workOrder = async (statusCode: string, typeCode = 'NORMAL') => {
      serial += 1;
      const row = await prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-P${serial}`,
          production_plan_id: ids.plan,
          routing_operation_id: ids.routingOperation,
          item_id: ids.item,
          order_qty: 100,
          uom_id: ids.uom,
          status_code: statusCode,
          work_order_type_code: typeCode,
        },
      });
      return Number(row.work_order_id);
    };

    /** ⭐ 발행·배포를 API 로 탄다 — 선발행 LOT 까지 붙는 진짜 `RELEASED` 다. */
    async function releasedByApi(): Promise<number> {
      const created = await request(app.getHttpServer())
        .post(WORK_ORDERS)
        .set('Cookie', cookie)
        .set('Idempotency-Key', idem())
        .send({
          productionPlanId: Number(ids.plan),
          routingOperationId: Number(ids.routingOperation),
          itemId: Number(ids.item),
          orderQty: 100,
          uomId: Number(ids.uom),
        })
        .expect(201);
      const configured = await request(app.getHttpServer())
        .put(`${WORK_ORDERS}/${created.body.workOrderId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', idem())
        .set('If-Match', created.headers.etag as string)
        .send({
          defaultWipLocationId: Number(ids.wipLocation),
          defaultFgLocationId: Number(ids.fgLocation),
          defaultScrapLocationId: Number(ids.scrapLocation),
        })
        .expect(200);
      expect(configured.body).toMatchObject({
        defaultWipLocationId: Number(ids.wipLocation),
        defaultFgLocationId: Number(ids.fgLocation),
        defaultScrapLocationId: Number(ids.scrapLocation),
        versionNo: Number(created.body.versionNo) + 1,
      });
      const released = await request(app.getHttpServer())
        .post(`${WORK_ORDERS}/${created.body.workOrderId}:release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', idem())
        .set('If-Match', String(configured.body.versionNo))
        .send({ lotSize: 50 })
        .expect(200);
      expect(released.body).toMatchObject({
        statusCode: 'RELEASED',
        versionNo: Number(configured.body.versionNo) + 1,
      });
      return created.body.workOrderId as number;
    }

    function openSession(
      payload: Record<string, unknown>,
      options: { token?: string | null; workerNo?: string | null; auth?: string[]; key?: string } = {},
    ) {
      const call = request(app.getHttpServer())
        .post(BASE)
        .set('Cookie', options.auth ?? cookie)
        .set('Idempotency-Key', options.key ?? idem());
      const token = options.token === undefined ? terminalToken : options.token;
      if (token !== null) call.set('Authorization', `Bearer ${token}`);
      const workerNo = options.workerNo === undefined ? `${PREFIX}-W1` : options.workerNo;
      if (workerNo !== null) call.set('X-Worker-No', workerNo);
      return call.send(payload);
    }

    function endSession(workSessionId: number, payload: Record<string, unknown>) {
      return request(app.getHttpServer())
        .post(`${BASE}/${workSessionId}:end`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', idem())
        .set('Authorization', `Bearer ${terminalToken}`)
        .set('X-Worker-No', `${PREFIX}-W1`)
        .send(payload);
    }

    const eventsOf = (workSessionId: number) =>
      prisma.work_session_event.findMany({
        where: { work_session_id: BigInt(workSessionId) },
        orderBy: { work_session_event_id: 'asc' },
      });

    it('⭐ M2 마디 — RELEASED W/O 에 세션이 열리고 W/O 가 IN_PROGRESS 가 된다', async () => {
      const workOrderId = await releasedByApi();
      const response = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      expect(validator('POST /production/work-sessions', 201)(response.body)).toBe(true);
      expect(response.body).toMatchObject({
        workOrderId,
        sessionNo: 1,
        statusCode: 'RUNNING',
        terminalId: Number(ids.terminalA),
      });
      const after = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: BigInt(workOrderId) } });
      expect(after.status_code).toBe('IN_PROGRESS');
      expect(await prisma.lot.count({ where: { source_type_code: LOT_SOURCE, source_id: BigInt(workOrderId) } })).toBeGreaterThan(0);
    });

    it('세션 열기가 START 이벤트를 같은 트랜잭션으로 만든다', async () => {
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      const events = await eventsOf(response.body.workSessionId as number);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type_code: 'START',
        occurred_at: new Date(START_AT),
        terminal_id: ids.terminalA,
        reason_code: null,
      });
      expect(events[0].performed_by).not.toBeNull();
    });

    it('workerIds 가 work_session_worker 로 들어가고 역할이 OPERATOR 다', async () => {
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({
        workOrderId,
        startedAt: START_AT,
        workerIds: [Number(ids.worker1), Number(ids.worker2)],
      }).expect(201);
      const rows = await prisma.work_session_worker.findMany({
        where: { work_session_id: BigInt(response.body.workSessionId as number) },
        orderBy: { work_session_worker_id: 'asc' },
      });
      expect(rows.map((row) => row.worker_role_code)).toEqual(['OPERATOR', 'OPERATOR']);
      expect(rows.map((row) => row.joined_at.toISOString())).toEqual([START_AT, START_AT]);
    });

    it('workerIds 없이 연 세션은 workers 가 0건이다', async () => {
      // 설계 미정 — 문의 057
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      const workers = await request(app.getHttpServer())
        .get(`${BASE}/${response.body.workSessionId}/workers`)
        .set('Cookie', cookie)
        .expect(200);
      expect(workers.body).toEqual([]);
    });

    it('controlOverride 를 보내면 CONTROL_OVERRIDE 이벤트가 함께 선다', async () => {
      const workOrderId = await workOrder('RELEASED', 'EMERGENCY');
      const response = await openSession({
        workOrderId,
        startedAt: START_AT,
        controlOverride: { reasonCode: 'EMERGENCY_WORK_ORDER', note: '설비 이상' },
      }).expect(201);
      const events = await eventsOf(response.body.workSessionId as number);
      expect(events.map((row) => row.event_type_code)).toEqual(['START', 'CONTROL_OVERRIDE']);
      expect(events[1]).toMatchObject({ reason_code: 'EMERGENCY_WORK_ORDER', occurred_at: new Date(START_AT) });
    });

    it('controlOverride 인데 긴급 W/O 가 아니면 400 INVALID', async () => {
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({
        workOrderId,
        startedAt: START_AT,
        controlOverride: { reasonCode: 'EMERGENCY_WORK_ORDER' },
      }).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'controlOverride.reasonCode', code: 'INVALID' });
      expect(await prisma.work_session.count({ where: { work_order_id: BigInt(workOrderId) } })).toBe(0);
    });

    it('shiftId 를 안 보내면 서버가 단말의 공장 교대로 채운다', async () => {
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      expect(response.body.shiftId).toBe(Number(ids.shiftA));
    });

    it('어느 교대에도 안 드는 시각이면 shift_id 가 비고 201 이다', async () => {
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({ workOrderId, startedAt: OUT_OF_SHIFT }).expect(201);
      expect(response.body.shiftId).toBeUndefined();
      expect(validator('POST /production/work-sessions', 201)(response.body)).toBe(true);
    });

    it('같은 W/O 에 열린 세션이 있으면 409 OPEN_SESSION_EXISTS', async () => {
      const response = await openSession({ workOrderId: workOrderAId, startedAt: START_AT }).expect(409);
      expect(response.body).toMatchObject({ conflictCause: 'user', code: 'OPEN_SESSION_EXISTS' });
    });

    it('can_start_work 가 false 인 단말이면 403', async () => {
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({ workOrderId, startedAt: START_AT }, { token: blockedToken }).expect(403);
      expect(response.body.errors[0]).toMatchObject({ scope: 'screen', code: 'PERMISSION_DENIED' });
      expect(response.body.errors[0].message).toContain('이 공정의 작업을 시작할 수 없습니다');
    });

    it('terminal_process 행이 없는 단말이면 403', async () => {
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({ workOrderId, startedAt: START_AT }, { token: unmappedToken }).expect(403);
      expect(response.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('단말 토큰이 없으면 403 — 게이팅을 판정할 수 없다', async () => {
      // 설계 미정 — 문의 054
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({ workOrderId, startedAt: START_AT }, { token: null }).expect(403);
      expect(response.body.errors[0].message).toContain('단말을 확인할 수 없어');
      expect(await prisma.work_session.count({ where: { work_order_id: BigInt(workOrderId) } })).toBe(0);
    });

    it('재발급으로 낡아진 단말 토큰이면 400 INVALID', async () => {
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({ workOrderId, startedAt: START_AT }, { token: staleToken }).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'Authorization', code: 'INVALID' });
    });

    it('SUSPENDED W/O 면 400 STATE_LOCKED', async () => {
      const workOrderId = await workOrder('SUSPENDED');
      const response = await openSession({ workOrderId, startedAt: START_AT }).expect(400);
      expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('X-Worker-No 가 없으면 400 REQUIRED', async () => {
      const workOrderId = await workOrder('RELEASED');
      const response = await openSession({ workOrderId, startedAt: START_AT }, { workerNo: null }).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'X-Worker-No', code: 'REQUIRED' });
    });

    it('무권한 사용자는 403', async () => {
      const workOrderId = await workOrder('RELEASED');
      await openSession({ workOrderId, startedAt: START_AT }, { auth: noPermCookie }).expect(403);
    });

    it('같은 Idempotency-Key 재전송이 세션을 두 벌 만들지 않는다', async () => {
      const workOrderId = await workOrder('RELEASED');
      const key = idem();
      const first = await openSession({ workOrderId, startedAt: START_AT }, { key }).expect(201);
      const again = await openSession({ workOrderId, startedAt: START_AT }, { key }).expect(201);
      expect(again.body.workSessionId).toBe(first.body.workSessionId);
      expect(await prisma.work_session.count({ where: { work_order_id: BigInt(workOrderId) } })).toBe(1);
    });

    it(':end 가 ended_at·ENDED·END 이벤트를 만들고 work_order 는 IN_PROGRESS 그대로다', async () => {
      const workOrderId = await workOrder('RELEASED');
      const opened = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      const workSessionId = opened.body.workSessionId as number;
      const ended = await endSession(workSessionId, { endedAt: END_AT }).expect(200);
      expect(validator('POST /production/work-sessions/{workSessionId}:end')(ended.body)).toBe(true);
      expect(ended.body).toMatchObject({ statusCode: 'ENDED', endedAt: END_AT, versionNo: 2 });
      const events = await eventsOf(workSessionId);
      expect(events.map((row) => row.event_type_code)).toEqual(['START', 'END']);
      expect(events[1]).toMatchObject({ occurred_at: new Date(END_AT), terminal_id: ids.terminalA });
      const after = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: BigInt(workOrderId) } });
      expect(after.status_code).toBe('IN_PROGRESS');
      // 이미 종료된 세션은 다시 닫히지 않는다.
      const again = await endSession(workSessionId, { endedAt: END_AT }).expect(400);
      expect(again.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('⭐ :end 뒤 둘째 세션이 열리고 session_no 가 2 다', async () => {
      const workOrderId = await workOrder('RELEASED');
      const first = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      await endSession(first.body.workSessionId as number, { endedAt: END_AT }).expect(200);
      const second = await openSession({ workOrderId, startedAt: END_AT }).expect(201);
      expect(second.body.sessionNo).toBe(2);
      // R-4 — 상태가 이미 `IN_PROGRESS` 라 W/O 를 다시 UPDATE 하지 않는다.
      const after = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: BigInt(workOrderId) } });
      expect(after.version_no).toBe(2);
    });

    it(':end 의 endedAt 이 startedAt 보다 앞서면 400 RANGE', async () => {
      const workOrderId = await workOrder('RELEASED');
      const opened = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      const response = await endSession(opened.body.workSessionId as number, { endedAt: T0 }).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'endedAt', code: 'RANGE' });
    });

    it(':end 는 stopReasonCode 를 받되 저장하지 않는다', async () => {
      const workOrderId = await workOrder('RELEASED');
      const opened = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      const workSessionId = opened.body.workSessionId as number;
      await endSession(workSessionId, { endedAt: END_AT, stopReasonCode: 'MOLD_CHANGE' }).expect(200);
      const row = await prisma.work_session.findUniqueOrThrow({ where: { work_session_id: BigInt(workSessionId) } });
      expect(row.stop_reason_code).toBeNull();
    });

    it('SUSPENDED 로 남은 W/O 는 :end 뒤 둘째 세션을 못 연다', async () => {
      // 문의 035 — [재개] 한 버튼이 W/O 층 «중단»과 세션 층 «중단»을 묶어 본다.
      const workOrderId = await workOrder('RELEASED');
      const opened = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      await endSession(opened.body.workSessionId as number, { endedAt: END_AT }).expect(200);
      await request(app.getHttpServer())
        .post(`${WORK_ORDERS}/${workOrderId}:hold`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', idem())
        .send({ reasonCode: 'MATERIAL_SHORTAGE', occurredAt: END_AT })
        .expect(200);
      const blocked = await openSession({ workOrderId, startedAt: END_AT }).expect(400);
      expect(blocked.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('⛔ 201·200 응답에 ETag 가 없다', async () => {
      const workOrderId = await workOrder('RELEASED');
      const opened = await openSession({ workOrderId, startedAt: START_AT }).expect(201);
      expect(parseIfMatch(String(opened.headers.etag ?? ''))).toBeNull();
      const ended = await endSession(opened.body.workSessionId as number, { endedAt: END_AT }).expect(200);
      expect(parseIfMatch(String(ended.headers.etag ?? ''))).toBeNull();
    });

    /**
     * 세션 «구간 안»의 사건과 작업자 참여·이탈(PR ④). 전이 둘을 타는 자리라 열기·닫기와 같은
     * 픽스처 위에서 본다 — 세션은 API 로만 연다.
     */
    describe('사건 적재 · 작업자 참여·이탈', () => {
      const STOP_AT = '2026-09-07T03:30:00.000Z';
      const RESUME_AT = '2026-09-07T04:00:00.000Z';
      const LEAVE_AT = '2026-09-07T05:00:00.000Z';

      function postEvent(
        workSessionId: number,
        payload: Record<string, unknown>,
        options: { auth?: string[] } = {},
      ) {
        return request(app.getHttpServer())
          .post(`${BASE}/${workSessionId}/events`)
          .set('Cookie', options.auth ?? cookie)
          .set('Idempotency-Key', idem())
          .set('Authorization', `Bearer ${terminalToken}`)
          .set('X-Worker-No', `${PREFIX}-W1`)
          .send(payload);
      }

      // ⛔ `X-Worker-No` 를 안 싣는다 — 계약이 이 둘에 사번 헤더를 안 걸었다(R-13 ⓠ).
      function joinWorker(workSessionId: number, payload: Record<string, unknown>, ifMatch?: string) {
        const call = request(app.getHttpServer())
          .post(`${BASE}/${workSessionId}/workers`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', idem());
        if (ifMatch !== undefined) call.set('If-Match', ifMatch);
        return call.send(payload);
      }

      function leaveWorker(workSessionId: number, workSessionWorkerId: number, payload: Record<string, unknown>) {
        return request(app.getHttpServer())
          .post(`${BASE}/${workSessionId}/workers/${workSessionWorkerId}:leave`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', idem())
          .send(payload);
      }

      /** 열린 세션 하나 — 되돌아온 W/O 로 W/O 축 단언까지 한다. */
      async function running(payload: Record<string, unknown> = {}): Promise<{ id: number; workOrderId: number }> {
        const workOrderId = await workOrder('RELEASED');
        const opened = await openSession({ workOrderId, startedAt: START_AT, ...payload }).expect(201);
        return { id: opened.body.workSessionId as number, workOrderId };
      }

      const sessionOf = (workSessionId: number) =>
        prisma.work_session.findUniqueOrThrow({ where: { work_session_id: BigInt(workSessionId) } });

      const workersOf = async (workSessionId: number, active?: boolean) =>
        (
          await request(app.getHttpServer())
            .get(`${BASE}/${workSessionId}/workers${active === undefined ? '' : `?active=${active}`}`)
            .set('Cookie', cookie)
            .expect(200)
        ).body as { workSessionWorkerId: number; workerId: number; leftAt?: string }[];

      it('STOP 이 세션을 STOPPED 로 옮기고 RESUME 이 되돌린다 — session_no 는 그대로다', async () => {
        const { id } = await running();
        const stopped = await postEvent(id, {
          eventTypeCode: 'STOP',
          occurredAt: STOP_AT,
          reasonCode: 'MOLD_CHANGE',
        }).expect(201);
        expect(validator('POST /production/work-sessions/{workSessionId}/events', 201)(stopped.body)).toBe(true);
        expect(stopped.body).toMatchObject({
          eventTypeCode: 'STOP',
          occurredAt: STOP_AT,
          reasonCode: 'MOLD_CHANGE',
          reasonName: '금형 교체',
          terminalId: Number(ids.terminalA),
        });
        expect(stopped.body.recordedAt).toBeDefined();
        const afterStop = await sessionOf(id);
        expect(afterStop).toMatchObject({ status_code: 'STOPPED', session_no: 1, version_no: 2 });

        const resumed = await postEvent(id, { eventTypeCode: 'RESUME', occurredAt: RESUME_AT }).expect(201);
        // `RESUME` 은 사유를 안 쓴다 — 파생 표시명도 키가 없다(널 금지).
        expect(resumed.body.reasonCode).toBeUndefined();
        expect(resumed.body.reasonName).toBeUndefined();
        const afterResume = await sessionOf(id);
        expect(afterResume).toMatchObject({ status_code: 'RUNNING', session_no: 1, version_no: 3 });
      });

      it('STOP 에 사유가 없으면 400 REQUIRED', async () => {
        const { id } = await running();
        const response = await postEvent(id, { eventTypeCode: 'STOP', occurredAt: STOP_AT }).expect(400);
        expect(response.body.errors[0]).toMatchObject({ field: 'reasonCode', code: 'REQUIRED' });
        expect((await sessionOf(id)).status_code).toBe('RUNNING');
      });

      it('RESUME 에 사유를 보내면 400 INVALID', async () => {
        const { id } = await running();
        const response = await postEvent(id, {
          eventTypeCode: 'RESUME',
          occurredAt: RESUME_AT,
          reasonCode: 'MOLD_CHANGE',
        }).expect(400);
        expect(response.body.errors[0]).toMatchObject({ field: 'reasonCode', code: 'INVALID' });
      });

      it('START·END·CONTROL_OVERRIDE 를 보내면 400 INVALID', async () => {
        const { id } = await running();
        for (const eventTypeCode of ['START', 'END', 'CONTROL_OVERRIDE']) {
          const response = await postEvent(id, { eventTypeCode, occurredAt: STOP_AT }).expect(400);
          expect(response.body.errors[0]).toMatchObject({ field: 'eventTypeCode', code: 'INVALID' });
          expect(response.body.errors[0].message).toContain('세션을 열고 닫는 오퍼레이션');
        }
        // 그룹 밖 문자열도 같은 400 `INVALID` 다 — 코드값 검사가 가른다.
        const unknown = await postEvent(id, { eventTypeCode: 'PAUSE', occurredAt: STOP_AT }).expect(400);
        expect(unknown.body.errors[0]).toMatchObject({ field: 'eventTypeCode', code: 'INVALID' });
      });

      it('종료된 세션에 STOP 이면 400 STATE_LOCKED', async () => {
        const { id } = await running();
        await endSession(id, { endedAt: END_AT }).expect(200);
        const response = await postEvent(id, {
          eventTypeCode: 'STOP',
          occurredAt: STOP_AT,
          reasonCode: 'MOLD_CHANGE',
        }).expect(400);
        expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      });

      it('⛔ events 가 work_order.status_code 를 건드리지 않는다', async () => {
        const { id, workOrderId } = await running();
        const before = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: BigInt(workOrderId) } });
        await postEvent(id, { eventTypeCode: 'STOP', occurredAt: STOP_AT, reasonCode: 'MOLD_CHANGE' }).expect(201);
        const after = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: BigInt(workOrderId) } });
        expect(after.status_code).toBe(before.status_code);
        expect(after.version_no).toBe(before.version_no);
      });

      it('W/O :hold 뒤 화면 [재개](events RESUME)가 400 STATE_LOCKED 다', async () => {
        // 문의 035 — `:hold` 는 세션에 손대지 않아 세션이 `RUNNING` 그대로다. 화면의 유일한
        // 재개 버튼이 `work-session-resume`(from: ['STOPPED'])에 막힌다 — 그대로 둔다(R-7 ⓐ).
        const { id, workOrderId } = await running();
        await request(app.getHttpServer())
          .post(`${WORK_ORDERS}/${workOrderId}:hold`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', idem())
          .send({ reasonCode: 'MATERIAL_SHORTAGE', occurredAt: STOP_AT })
          .expect(200);
        expect((await sessionOf(id)).status_code).toBe('RUNNING');
        const response = await postEvent(id, { eventTypeCode: 'RESUME', occurredAt: RESUME_AT }).expect(400);
        expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      });

      it('무권한 사용자는 events 를 적재하지 못한다 — 403', async () => {
        const { id } = await running();
        await postEvent(
          id,
          { eventTypeCode: 'STOP', occurredAt: STOP_AT, reasonCode: 'MOLD_CHANGE' },
          { auth: noPermCookie },
        ).expect(403);
      });

      it('작업자 참여 뒤 workers 목록에 뜬다', async () => {
        const { id } = await running();
        const response = await joinWorker(id, {
          workerId: Number(ids.worker1),
          workerRoleCode: 'MAIN',
          joinedAt: START_AT,
        }).expect(201);
        expect(validator('POST /production/work-sessions/{workSessionId}/workers', 201)(response.body)).toBe(true);
        expect(response.body).toMatchObject({
          workerId: Number(ids.worker1),
          workerRoleCode: 'MAIN',
          joinedAt: START_AT,
        });
        expect(response.body.leftAt).toBeUndefined();
        expect((await workersOf(id)).map((row) => row.workerId)).toEqual([Number(ids.worker1)]);
      });

      it('POST …/workers 는 If-Match 를 받되 version_no 를 올리지 않는다', async () => {
        const { id } = await running();
        expect((await sessionOf(id)).version_no).toBe(1);
        await joinWorker(id, { workerId: Number(ids.worker1), joinedAt: START_AT }, '"1"').expect(201);
        // 세션 행을 UPDATE 하지 않으므로 화면의 If-Match 토큰이 낡지 않는다(알려둘 것 ⓘ).
        expect((await sessionOf(id)).version_no).toBe(1);
      });

      it('이미 참여 중인 작업자를 다시 넣으면 400 STATE_LOCKED', async () => {
        const { id } = await running();
        await joinWorker(id, { workerId: Number(ids.worker1), joinedAt: START_AT }).expect(201);
        const response = await joinWorker(id, { workerId: Number(ids.worker1), joinedAt: RESUME_AT }).expect(400);
        expect(response.body.errors[0]).toMatchObject({ field: 'workerId', code: 'STATE_LOCKED' });
        expect(await prisma.work_session_worker.count({ where: { work_session_id: BigInt(id) } })).toBe(1);
      });

      it('떠난 작업자는 다시 참여할 수 있다', async () => {
        const { id } = await running();
        const first = await joinWorker(id, { workerId: Number(ids.worker1), joinedAt: START_AT }).expect(201);
        await leaveWorker(id, first.body.workSessionWorkerId as number, { leftAt: LEAVE_AT }).expect(200);
        const again = await joinWorker(id, { workerId: Number(ids.worker1), joinedAt: LEAVE_AT }).expect(201);
        expect(again.body.workSessionWorkerId).not.toBe(first.body.workSessionWorkerId);
        expect(await prisma.work_session_worker.count({ where: { work_session_id: BigInt(id) } })).toBe(2);
      });

      it('종료된 세션에 참여하면 400 STATE_LOCKED', async () => {
        const { id } = await running();
        await endSession(id, { endedAt: END_AT }).expect(200);
        const response = await joinWorker(id, { workerId: Number(ids.worker1), joinedAt: START_AT }).expect(400);
        expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      });

      it(':leave 가 left_at 만 찍고 행을 지우지 않는다', async () => {
        const { id } = await running({ workerIds: [Number(ids.worker1)] });
        const [joined] = await workersOf(id);
        const response = await leaveWorker(id, joined.workSessionWorkerId, { leftAt: LEAVE_AT }).expect(200);
        expect(
          validator('POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave')(response.body),
        ).toBe(true);
        expect(response.body).toMatchObject({ workSessionWorkerId: joined.workSessionWorkerId, leftAt: LEAVE_AT });
        expect(await prisma.work_session_worker.count({ where: { work_session_id: BigInt(id) } })).toBe(1);
        expect(await workersOf(id)).toEqual([]);
        expect((await workersOf(id, false)).map((row) => row.workSessionWorkerId)).toEqual([
          joined.workSessionWorkerId,
        ]);
        // 세션 축은 그대로다 — `:leave` 는 세션 행을 UPDATE 하지 않는다.
        expect((await sessionOf(id)).version_no).toBe(1);
      });

      it('이미 떠난 사람을 다시 :leave 하면 400 STATE_LOCKED', async () => {
        const { id } = await running({ workerIds: [Number(ids.worker1)] });
        const [joined] = await workersOf(id);
        await leaveWorker(id, joined.workSessionWorkerId, { leftAt: LEAVE_AT }).expect(200);
        const response = await leaveWorker(id, joined.workSessionWorkerId, { leftAt: END_AT }).expect(400);
        expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      });

      it('leftAt 이 joinedAt 보다 앞서면 400 RANGE', async () => {
        const { id } = await running({ workerIds: [Number(ids.worker1)] });
        const [joined] = await workersOf(id);
        const response = await leaveWorker(id, joined.workSessionWorkerId, { leftAt: T0 }).expect(400);
        expect(response.body.errors[0]).toMatchObject({ field: 'leftAt', code: 'RANGE' });
      });

      it('남의 세션의 참여 행을 경로로 물으면 404', async () => {
        const mine = await running({ workerIds: [Number(ids.worker1)] });
        const other = await running();
        const [joined] = await workersOf(mine.id);
        await leaveWorker(other.id, joined.workSessionWorkerId, { leftAt: LEAVE_AT }).expect(404);
      });

      it('종료된 세션의 참여자도 :leave 할 수 있다', async () => {
        // 설계 미정 — 문의 058. `:end` 가 `left_at` 을 자동으로 안 찍으므로 이 길을 닫으면
        // 「영원히 참여 중」이 확정된다 — 참여(400)와 이탈(200)이 비대칭인 이유다.
        const { id } = await running({ workerIds: [Number(ids.worker1)] });
        const [joined] = await workersOf(id);
        await endSession(id, { endedAt: END_AT }).expect(200);
        const response = await leaveWorker(id, joined.workSessionWorkerId, { leftAt: LEAVE_AT }).expect(200);
        expect(response.body.leftAt).toBe(LEAVE_AT);
      });
    });
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '작업세션검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '작업세션검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '작업세션검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: PREFIX + '-WH',
        warehouse_name: '작업세션검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    const [wip, fg, scrap] = await Promise.all(
      ['WIP', 'FG', 'SCRAP'].map((suffix) => prisma.location.create({
        data: {
          warehouse_id: warehouse.warehouse_id,
          location_code: PREFIX + '-' + suffix,
          location_name: '작업세션검사' + suffix + '위치',
          location_type_code: 'BIN',
        },
      })),
    );
    ids.wipLocation = wip.location_id;
    ids.fgLocation = fg.location_id;
    ids.scrapLocation = scrap.location_id;
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '작업세션검사품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    const operation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
    });
    const bom = await prisma.bom.create({
      data: { parent_item_id: item.item_id, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'ACTIVE', effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: uom.uom_id },
    });
    const shiftA = await prisma.shift.create({
      data: { plant_id: plant.plant_id, shift_code: `${PREFIX}-SA`, shift_name: '주간A', start_time: new Date('1970-01-01T08:00:00.000Z'), end_time: new Date('1970-01-01T17:00:00.000Z'), crosses_midnight: false },
    });
    ids.shiftA = shiftA.shift_id;
    // ⚠ 비활성이다 — 도출은 활성 교대만 본다(`shift-resolver.ts`). 이 공장에서 «드는» 교대를
    //    하나로 두어 「서버가 단말의 공장 교대로 채운다」가 결정론이 된다.
    const shiftB = await prisma.shift.create({
      data: { plant_id: plant.plant_id, shift_code: `${PREFIX}-SB`, shift_name: '주간B', start_time: new Date('1970-01-01T08:00:00.000Z'), end_time: new Date('1970-01-01T17:00:00.000Z'), crosses_midnight: false, is_active: false },
    });
    ids.shiftB = shiftB.shift_id;
    const terminalA = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-TA`, plant_id: plant.plant_id, terminal_type_code: 'POP', status_code: 'RUNNING' },
    });
    ids.terminalA = terminalA.terminal_id;
    const terminalB = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-TB`, plant_id: plant.plant_id, terminal_type_code: 'POP', status_code: 'RUNNING' },
    });
    ids.terminalB = terminalB.terminal_id;
    // 셋째 단말은 `terminal_process` 행이 **없다** — 부재도 403 이다(`P-02-01` §5-1).
    const terminalC = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-TC`, plant_id: plant.plant_id, terminal_type_code: 'POP', status_code: 'RUNNING' },
    });
    ids.terminalC = terminalC.terminal_id;
    await prisma.terminal_process.createMany({
      data: [
        { terminal_id: terminalA.terminal_id, process_id: process.process_id, can_start_work: true },
        { terminal_id: terminalB.terminal_id, process_id: process.process_id, can_start_work: false },
      ],
    });
    const worker1 = await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W1`, worker_name: '작업세션검사작업자1', business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
    });
    ids.worker1 = worker1.worker_id;
    const worker2 = await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W2`, worker_name: '작업세션검사작업자2', business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
    });
    ids.worker2 = worker2.worker_id;

    const order = await prisma.production_order.create({
      data: { production_order_no: `${PREFIX}-PO`, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, item_id: item.item_id, order_qty: 100, uom_id: uom.uom_id, status_code: 'CONFIRMED' },
    });
    const plan = await prisma.production_plan.create({
      data: { production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP`, plan_date: new Date('2026-09-07T00:00:00.000Z'), planned_qty: 100, uom_id: uom.uom_id, bom_id: bom.bom_id, routing_id: routing.routing_id, status_code: 'CONFIRMED' },
    });
    const workOrder = async (suffix: string) =>
      prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-${suffix}`,
          production_plan_id: plan.production_plan_id,
          routing_operation_id: operation.routing_operation_id,
          item_id: item.item_id,
          order_qty: 100,
          uom_id: uom.uom_id,
          status_code: 'IN_PROGRESS',
        },
      });
    const woA = await workOrder('WOA');
    workOrderAId = Number(woA.work_order_id);
    const woB = await workOrder('WOB');
    ids.plan = plan.production_plan_id;
    ids.routingOperation = operation.routing_operation_id;
    ids.item = item.item_id;
    ids.uom = uom.uom_id;

    const session = (data: {
      workOrderId: bigint;
      sessionNo: number;
      terminalId: bigint;
      shiftId: bigint;
      startedAt: string;
      endedAt: string | null;
      statusCode: string;
    }) =>
      prisma.work_session.create({
        data: {
          work_order_id: data.workOrderId,
          session_no: data.sessionNo,
          shift_id: data.shiftId,
          terminal_id: data.terminalId,
          started_at: new Date(data.startedAt),
          ended_at: data.endedAt === null ? null : new Date(data.endedAt),
          status_code: data.statusCode,
          idempotency_key: `${PREFIX}-${randomUUID()}`,
        },
      });
    const s1 = await session({ workOrderId: woA.work_order_id, sessionNo: 1, terminalId: terminalA.terminal_id, shiftId: shiftA.shift_id, startedAt: T0, endedAt: null, statusCode: 'RUNNING' });
    s1Id = Number(s1.work_session_id);
    const s2 = await session({ workOrderId: woA.work_order_id, sessionNo: 2, terminalId: terminalA.terminal_id, shiftId: shiftA.shift_id, startedAt: T1, endedAt: T2, statusCode: 'ENDED' });
    s2Id = Number(s2.work_session_id);
    const s3 = await session({ workOrderId: woA.work_order_id, sessionNo: 3, terminalId: terminalA.terminal_id, shiftId: shiftA.shift_id, startedAt: T2, endedAt: null, statusCode: 'STOPPED' });
    s3Id = Number(s3.work_session_id);
    const sOther = await session({ workOrderId: woB.work_order_id, sessionNo: 1, terminalId: terminalB.terminal_id, shiftId: shiftB.shift_id, startedAt: T0, endedAt: null, statusCode: 'RUNNING' });
    sOtherId = Number(sOther.work_session_id);

    const e1 = await prisma.work_session_event.create({
      data: { work_session_id: s1.work_session_id, event_type_code: 'START', occurred_at: new Date(T0) },
    });
    e1Id = Number(e1.work_session_event_id);
    const e2 = await prisma.work_session_event.create({
      data: { work_session_id: s1.work_session_id, event_type_code: 'STOP', occurred_at: new Date('2026-09-07T01:10:00.000Z'), reason_code: 'MOLD_CHANGE' },
    });
    e2Id = Number(e2.work_session_event_id);
    const e3 = await prisma.work_session_event.create({
      data: { work_session_id: s1.work_session_id, event_type_code: 'RESUME', occurred_at: new Date('2026-09-07T01:20:00.000Z') },
    });
    e3Id = Number(e3.work_session_event_id);

    await prisma.work_session_worker.create({
      data: { work_session_id: s1.work_session_id, worker_id: worker1.worker_id, joined_at: new Date(T0), left_at: null },
    });
    await prisma.work_session_worker.create({
      data: { work_session_id: s1.work_session_id, worker_id: worker2.worker_id, joined_at: new Date(T0), left_at: new Date('2026-09-07T01:30:00.000Z') },
    });
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '작업세션검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // 권한 0건 계정 — 계약이 403 을 «선언한» 쓰기 둘의 계정 권한 갈래를 이 계정으로 본다.
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '작업세션권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // ⚠ 역할을 «먼저» 붙이고 로그인한다 — 세션이 그때의 권한을 담는다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '작업세션검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 단말 토큰은 계정 세션으로 발급 API 를 불러 받는다 — 서명 코드를 복제하지 않는다(§10-1). */
  async function issueToken(terminalId: bigint): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/mdm/terminals/${Number(terminalId)}:issue-token`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return response.body.token as string;
  }

  async function makeTokens(): Promise<void> {
    // 한 번 더 발급하면 `token_version` 이 올라 앞의 토큰이 낡는다(공유계약 F-4).
    staleToken = await issueToken(ids.terminalA);
    terminalToken = await issueToken(ids.terminalA);
    blockedToken = await issueToken(ids.terminalB);
    unmappedToken = await issueToken(ids.terminalC);
  }

  /** 만든 행을 FK 역순으로 지운다(§10-1 · ⛔ TRUNCATE 금지). */
  async function cleanup(): Promise<void> {
    const plantScope = { plant: { plant_code: { startsWith: PREFIX } } };
    // ⚠ API 로 연 세션의 `idempotency_key` 는 UUID 라 접두어로 못 잡는다 — W/O 축으로 지운다.
    const sessionScope = { work_order: { production_plan: { plan_no: { startsWith: PREFIX } } } };
    await prisma.work_session_event.deleteMany({ where: { work_session: sessionScope } });
    await prisma.work_session_worker.deleteMany({ where: { work_session: sessionScope } });
    await prisma.work_session.deleteMany({ where: sessionScope });
    // API 로 배포한 W/O 는 선발행 LOT 을 달고 나온다 — 그 사슬을 먼저 지운다.
    await prisma.lot_lifecycle_history.deleteMany({ where: { lot: plantScope } });
    await prisma.lot.deleteMany({ where: plantScope });
    await prisma.work_order.deleteMany({ where: { production_plan: { plan_no: { startsWith: PREFIX } } } });
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
    await prisma.shift.deleteMany({ where: { shift_code: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const users = await prisma.app_user.findMany({ where: { login_id: { in: [LOGIN_ID, NOPERM_ID] } } });
    const ownerIds = users.map((row) => row.app_user_id);
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: ownerIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: ownerIds } } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: { in: ownerIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: ownerIds } } });
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (!role) return;
    await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
    await prisma.role.delete({ where: { role_id: role.role_id } });
  }
});
