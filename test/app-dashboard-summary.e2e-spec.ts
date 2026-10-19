import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-AA118-DASHBOARD';
const PATH = '/api/app/dashboard-summary';
const BASE_DATE = '2026-09-01';

function responseValidator(): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8')) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({
    $ref: 'https://omf-mes.invalid/contract#/paths/~1app~1dashboard-summary/get/responses/200/content/application~1json/schema',
  });
}

type Card = { cardCode: string; value: number; valueStatusCode: string; deltaRatio?: number; excludedCount?: number };

/**
 * 하노이 공장(+07) 하루 — 교대 08~17시(9h) − 계획 정지 12~13시 = 계획 8h.
 * 세션 08~16시(8h) − STOP 10~11시 = 실제 7h → 시간가동률 87.5%.
 */
describe('통합 대시보드 집계 (omf-all-around#118)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const ids: Record<string, bigint> = {};
  const validateResponse = responseValidator();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await fixtures();
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(ids.user), typ: 'session' })}`;
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  const read = async (query: Record<string, string>) =>
    (await request(app.getHttpServer()).get(PATH).query(query).set('Cookie', cookie).expect(200)).body as {
      baseDate: string;
      plantId?: number;
      cards: Card[];
      alerts: { notificationId: number }[];
      trend: { points: { label: string; value: number }[] };
    };
  const card = (cards: Card[], code: string): Card => cards.find((item) => item.cardCode === code) as Card;

  it('계약 모양으로 여섯 카드·추이·알람을 낸다', async () => {
    const body = await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() });

    expect(validateResponse(body)).toBe(true);
    expect(body).toMatchObject({ baseDate: BASE_DATE, plantId: Number(ids.plant) });
    expect(body.cards.map((item) => item.cardCode).sort()).toEqual(
      ['AVAILABILITY_RATE', 'OEE', 'PERFORMANCE_RATE', 'PRODUCTION_QTY', 'UNHANDLED_ALARM', 'YIELD_RATE'],
    );
  });

  it('총생산은 정정된 원본과 재작업 W/O 실적을 빼고, 재작업 합격분은 양품으로 옮긴다', async () => {
    const { cards, trend } = await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() });

    expect(card(cards, 'PRODUCTION_QTY')).toMatchObject({ value: 1100, deltaRatio: 1.2, valueStatusCode: 'AVAILABLE' });
    // (양품 900 + 정정본 100 + 재작업 합격 10) ÷ 1100
    expect(card(cards, 'YIELD_RATE').value).toBeCloseTo((1010 / 1100) * 100, 6);
    expect(trend.points).toHaveLength(9);
    expect(trend.points[0]).toEqual({ label: '08-24', value: 0 });
    expect(trend.points.slice(-2)).toEqual([
      { label: '08-31', value: 500 },
      { label: '09-01', value: 1100 },
    ]);
  });

  it('시간가동률은 계획 가동시간 기준, 성능가동률은 C/T×수량÷캐비티 ÷ 실제 가동시간이다', async () => {
    const { cards } = await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() });

    expect(card(cards, 'AVAILABILITY_RATE')).toMatchObject({ value: 87.5, valueStatusCode: 'AVAILABLE' });
    // 10초 × (1100 + 재작업 10) ÷ 캐비티 2 = 5550초 ÷ 7h(25200초) — 성능률은 재작업 실적도 센다
    expect(card(cards, 'PERFORMANCE_RATE').value).toBeCloseTo((5550 / 25200) * 100, 6);
    expect(card(cards, 'OEE').value).toBeCloseTo(0.875 * (5550 / 25200) * (1010 / 1100) * 100, 6);
  });

  it('미처리 알람은 로그인 사용자의 안 읽은 알림이다', async () => {
    const { cards, alerts } = await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() });

    expect(card(cards, 'UNHANDLED_ALARM').value).toBe(1);
    expect(alerts.map((item) => item.notificationId)).toEqual([Number(ids.unread)]);
  });

  it('실적·세션이 없는 날은 생산 0 이고 비율 카드는 NOT_YET 이다', async () => {
    const { cards } = await read({ baseDate: '2026-08-20', plantId: ids.plant.toString() });

    expect(card(cards, 'PRODUCTION_QTY').value).toBe(0);
    for (const code of ['YIELD_RATE', 'AVAILABILITY_RATE', 'PERFORMANCE_RATE', 'OEE']) {
      expect(card(cards, code).valueStatusCode).toBe('NOT_YET');
    }
  });

  it('기준일이 없으면 그 공장의 오늘로 정한다', async () => {
    const body = await read({ plantId: ids.plant.toString() });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

    expect(body.baseDate).toBe(today);
  });

  async function fixtures(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' },
    });
    ids.user = user.app_user_id;
    ids.role = (await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } })).role_id;
    await prisma.role_permission.create({ data: { role_id: ids.role, permission_code: 'W-CO-05' } });
    await prisma.user_role.create({ data: { app_user_id: ids.user, role_id: ids.role } });

    const legal = await prisma.legal_entity.create({
      data: { legal_entity_code: PREFIX, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.legal = legal.legal_entity_id;
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: ids.legal, business_unit_code: PREFIX, business_unit_name: PREFIX },
    });
    ids.unit = unit.business_unit_id;
    ids.plant = (
      await prisma.plant.create({
        data: {
          legal_entity_id: ids.legal,
          business_unit_id: ids.unit,
          plant_code: PREFIX,
          plant_name: PREFIX,
          timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })
    ).plant_id;
    ids.line = (
      await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: PREFIX, line_name: PREFIX } })
    ).production_line_id;
    ids.equipment = (
      await prisma.equipment.create({
        data: {
          plant_id: ids.plant,
          production_line_id: ids.line,
          equipment_code: PREFIX,
          equipment_name: PREFIX,
          // 설비 현황은 EQUIPMENT_TYPE 공통코드 유형 · IN_SERVICE 만 담는다.
          equipment_type_code: 'PRESS',
          status_code: 'IN_SERVICE',
        },
      })
    ).equipment_id;
    ids.mold = (
      await prisma.mold.create({
        data: {
          plant_id: ids.plant,
          mold_code: PREFIX,
          mold_name: PREFIX,
          status_code: 'ACTIVE',
          tool_type_code: 'MOLD',
          cavity_count: 2,
        },
      })
    ).mold_id;
    ids.terminal = (
      await prisma.terminal.create({
        data: { terminal_code: PREFIX, plant_id: ids.plant, terminal_type_code: 'POP', status_code: 'ACTIVE' },
      })
    ).terminal_id;
    ids.worker = (
      await prisma.worker.create({
        data: {
          worker_no: PREFIX,
          worker_name: PREFIX,
          business_unit_id: ids.unit,
          plant_id: ids.plant,
          status_code: 'EMPLOYED',
        },
      })
    ).worker_id;

    await prisma.shift.create({
      data: {
        plant_id: ids.plant,
        shift_code: PREFIX,
        shift_name: PREFIX,
        start_time: new Date('1970-01-01T08:00:00Z'),
        end_time: new Date('1970-01-01T17:00:00Z'),
      },
    });
    ids.calendar = (
      await prisma.work_calendar.create({
        data: { plant_id: ids.plant, calendar_code: PREFIX, calendar_name: PREFIX },
      })
    ).work_calendar_id;
    await prisma.work_calendar_application.create({
      data: {
        work_calendar_id: ids.calendar,
        target_type_code: 'PLANT',
        target_id: ids.plant,
        effective_from: new Date('2026-01-01'),
      },
    });
    await prisma.work_calendar_day.create({
      data: { work_calendar_id: ids.calendar, calendar_date: new Date(BASE_DATE), day_type_code: 'WORKING' },
    });
    await prisma.planned_stop.create({
      data: {
        equipment_id: ids.equipment,
        stop_type_code: PREFIX,
        planned_start_at: new Date('2026-09-01T05:00:00Z'),
        planned_end_at: new Date('2026-09-01T06:00:00Z'),
      },
    });

    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    ids.item = (
      await prisma.item.create({
        data: {
          item_code: PREFIX,
          item_name: PREFIX,
          item_type_code: 'FINISHED_GOODS',
          base_uom_id: ids.uom,
          lot_controlled: false,
        },
      })
    ).item_id;
    ids.process = (
      await prisma.process.create({ data: { process_code: PREFIX, process_name: PREFIX, process_type_code: 'ASSEMBLY' } })
    ).process_id;
    ids.routing = (
      await prisma.routing.create({
        data: { item_id: ids.item, routing_code: PREFIX, routing_version: 1, status_code: 'ACTIVE' },
      })
    ).routing_id;
    ids.operation = (
      await prisma.routing_operation.create({
        data: {
          routing_id: ids.routing,
          process_id: ids.process,
          operation_seq: 10,
          operation_name: PREFIX,
          standard_cycle_time_sec: 10,
        },
      })
    ).routing_operation_id;
    ids.order = await addOrder('NORMAL');
    ids.rework = await addOrder('REWORK');

    ids.session = (
      await prisma.work_session.create({
        data: {
          work_order_id: ids.order,
          session_no: 1,
          equipment_id: ids.equipment,
          terminal_id: ids.terminal,
          started_at: new Date('2026-09-01T01:00:00Z'),
          ended_at: new Date('2026-09-01T09:00:00Z'),
          status_code: 'ENDED',
          idempotency_key: `${PREFIX}-SESSION`,
        },
      })
    ).work_session_id;
    await prisma.work_session_event.createMany({
      data: [
        { work_session_id: ids.session, event_type_code: 'STOP', occurred_at: new Date('2026-09-01T03:00:00Z') },
        { work_session_id: ids.session, event_type_code: 'RESUME', occurred_at: new Date('2026-09-01T04:00:00Z') },
      ],
    });

    await addResult(ids.order, 1, '2026-09-01T02:00:00Z', { good_qty: 900, defect_qty: 50, scrap_qty: 30, rework_qty: 20 });
    await addResult(ids.order, 2, '2026-08-31T02:00:00Z', { good_qty: 500 });
    const original = await addResult(ids.order, 3, '2026-09-01T02:30:00Z', { good_qty: 777 });
    // 정정본만 센다 — 원본 777 은 빠지고 100 이 들어간다(수량 0 은 DB 제약이 막는다).
    await addResult(ids.order, 4, '2026-09-01T02:30:00Z', { good_qty: 100 }, original);
    await addResult(ids.rework, 1, '2026-09-01T07:00:00Z', { good_qty: 10 });

    // PQC: 1회차 불합격 → 재검사 2회차 합격. 최종 회차만 센다.
    ids.request = (
      await prisma.inspection_request.create({
        data: {
          inspection_request_no: PREFIX,
          inspection_type_code: 'PQC',
          target_type_code: 'WORK_ORDER',
          target_id: ids.order,
          work_order_id: ids.order,
          item_id: ids.item,
          target_qty: 10,
          uom_id: ids.uom,
          status_code: 'COMPLETED',
          requested_at: new Date('2026-09-01T02:00:00Z'),
        },
      })
    ).inspection_request_id;
    for (const [round, judgment, inspectedAt] of [
      [1, 'REJECTED', '2026-09-01T03:00:00Z'],
      [2, 'ACCEPTED', '2026-09-01T04:00:00Z'],
    ] as const) {
      await prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-${round}`,
          inspection_request_id: ids.request,
          inspection_round: round,
          inspected_qty: 10,
          accepted_qty: judgment === 'ACCEPTED' ? 10 : 0,
          rejected_qty: judgment === 'REJECTED' ? 10 : 0,
          held_qty: 0,
          uom_id: ids.uom,
          overall_judgment_code: judgment,
          inspector_id: ids.worker,
          inspected_at: new Date(inspectedAt),
          status_code: 'CONFIRMED',
          idempotency_key: `${PREFIX}-${round}`,
        },
      });
    }

    const event = await prisma.notification_event.create({
      data: {
        event_type_code: 'EQUIPMENT_BREAKDOWN_OCCURRED',
        aggregate_type_code: 'EQUIPMENT',
        aggregate_id: ids.equipment,
        occurred_at: new Date('2026-09-01T03:00:00Z'),
      },
    });
    ids.event = event.notification_event_id;
    const otherEvent = await prisma.notification_event.create({
      data: {
        event_type_code: 'EQUIPMENT_BREAKDOWN_OCCURRED',
        aggregate_type_code: 'EQUIPMENT',
        aggregate_id: ids.equipment,
        occurred_at: new Date('2026-09-01T02:00:00Z'),
      },
    });
    ids.otherEvent = otherEvent.notification_event_id;
    ids.unread = (
      await prisma.notification.create({
        data: { notification_event_id: ids.event, recipient_user_id: ids.user, title: PREFIX, message: PREFIX },
      })
    ).notification_id;
    await prisma.notification.create({
      data: {
        notification_event_id: ids.otherEvent,
        recipient_user_id: ids.user,
        title: PREFIX,
        message: PREFIX,
        read_at: new Date(),
      },
    });
  }

  async function addOrder(type: string): Promise<bigint> {
    return (
      await prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-${type}`,
          routing_operation_id: ids.operation,
          item_id: ids.item,
          order_qty: 1000,
          uom_id: ids.uom,
          work_order_type_code: type,
          production_line_id: ids.line,
          status_code: 'IN_PROGRESS',
        },
      })
    ).work_order_id;
  }

  async function addResult(
    workOrderId: bigint,
    sequence: number,
    occurredAt: string,
    quantities: Partial<Record<'good_qty' | 'defect_qty' | 'scrap_qty' | 'rework_qty', number>>,
    corrects?: bigint,
  ): Promise<bigint> {
    const no = `${PREFIX}-${workOrderId}-${sequence}`;
    return (
      await prisma.production_result.create({
        data: {
          production_result_no: no,
          work_order_id: workOrderId,
          result_sequence: sequence,
          corrects_production_result_id: corrects ?? null,
          ...quantities,
          uom_id: ids.uom,
          result_source_code: 'MANUAL',
          occurred_at: new Date(occurredAt),
          worker_id: ids.worker,
          equipment_id: ids.equipment,
          mold_id: ids.mold,
          status_code: 'CONFIRMED',
          idempotency_key: no,
        },
      })
    ).production_result_id;
  }

  async function cleanup(): Promise<void> {
    const users = await prisma.app_user.findMany({ where: { login_id: `${PREFIX}-USER` } });
    const userIds = users.map((row) => row.app_user_id);
    const notifications = await prisma.notification.findMany({ where: { recipient_user_id: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { recipient_user_id: { in: userIds } } });
    await prisma.notification_event.deleteMany({
      where: { notification_event_id: { in: notifications.map((row) => row.notification_event_id) } },
    });
    await prisma.production_result.deleteMany({
      where: { production_result_no: { startsWith: PREFIX }, corrects_production_result_id: { not: null } },
    });
    await prisma.production_result.deleteMany({ where: { production_result_no: { startsWith: PREFIX } } });
    await prisma.inspection_result.deleteMany({ where: { inspection_result_no: { startsWith: PREFIX } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: PREFIX } });
    await prisma.work_session_event.deleteMany({ where: { work_session: { idempotency_key: { startsWith: PREFIX } } } });
    await prisma.work_session.deleteMany({ where: { idempotency_key: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { operation_name: PREFIX } });
    await prisma.routing.deleteMany({ where: { routing_code: PREFIX } });
    await prisma.process.deleteMany({ where: { process_code: PREFIX } });
    await prisma.item.deleteMany({ where: { item_code: PREFIX } });
    await prisma.planned_stop.deleteMany({ where: { stop_type_code: PREFIX } });
    const calendars = await prisma.work_calendar.findMany({ where: { calendar_code: PREFIX } });
    const calendarIds = calendars.map((row) => row.work_calendar_id);
    await prisma.work_calendar_day.deleteMany({ where: { work_calendar_id: { in: calendarIds } } });
    await prisma.work_calendar_application.deleteMany({ where: { work_calendar_id: { in: calendarIds } } });
    await prisma.work_calendar.deleteMany({ where: { calendar_code: PREFIX } });
    await prisma.shift.deleteMany({ where: { shift_code: PREFIX } });
    await prisma.mold.deleteMany({ where: { mold_code: PREFIX } });
    await prisma.equipment.deleteMany({ where: { equipment_code: PREFIX } });
    await prisma.terminal.deleteMany({ where: { terminal_code: PREFIX } });
    await prisma.worker.deleteMany({ where: { worker_no: PREFIX } });
    await prisma.production_line.deleteMany({ where: { line_code: PREFIX } });
    await prisma.plant.deleteMany({ where: { plant_code: PREFIX } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: PREFIX } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: PREFIX } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: `${PREFIX}-USER` } });
  }
});
