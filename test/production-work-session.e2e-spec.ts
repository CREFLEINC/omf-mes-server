/**
 * 작업 세션 조회 4건 — 목록 `GET /production/work-sessions` · 상세 `…/{id}` ·
 * 이벤트 `…/{id}/events` · 작업자 `…/{id}/workers`(I-11 PR ①).
 *
 * ⭐ 세션·이벤트·작업자는 **직접 INSERT** 한다 — 이 PR 에 `POST` 가 없다(PR ③·④ 몫).
 * ⛔ 단말 토큰·`terminal_process` 를 세우지 않는다 — 조회 전용이라 게이팅을 안 본다.
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
const PASSWORD = 'WSE-작업세션-비밀번호';
const PREFIX = 'WSE2E';
const BASE = '/api/production/work-sessions';

const T0 = '2026-09-07T01:00:00.000Z';
const T1 = '2026-09-07T02:00:00.000Z';
const T2 = '2026-09-07T03:00:00.000Z';

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
      data: { plant_id: plant.plant_id, shift_code: `${PREFIX}-SA`, shift_name: '주간A', start_time: new Date('1970-01-01T08:00:00.000Z'), end_time: new Date('1970-01-01T17:00:00.000Z') },
    });
    ids.shiftA = shiftA.shift_id;
    const shiftB = await prisma.shift.create({
      data: { plant_id: plant.plant_id, shift_code: `${PREFIX}-SB`, shift_name: '주간B', start_time: new Date('1970-01-01T08:00:00.000Z'), end_time: new Date('1970-01-01T17:00:00.000Z') },
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
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 만든 행을 FK 역순으로 지운다(§10-1 · ⛔ TRUNCATE 금지). */
  async function cleanup(): Promise<void> {
    await prisma.work_session_event.deleteMany({ where: { work_session: { idempotency_key: { startsWith: PREFIX } } } });
    await prisma.work_session_worker.deleteMany({ where: { work_session: { idempotency_key: { startsWith: PREFIX } } } });
    await prisma.work_session.deleteMany({ where: { idempotency_key: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: { production_plan: { plan_no: { startsWith: PREFIX } } } });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.shift.deleteMany({ where: { shift_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});
