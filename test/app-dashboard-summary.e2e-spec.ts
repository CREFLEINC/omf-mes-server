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

type Card = {
  cardCode: string;
  value: number;
  valueStatusCode: string;
  deltaRatio?: number;
  excludedCount?: number;
  notYetReasonCode?: string;
};

/**
 * 하노이 공장(+07) 하루 — 교대 08~17시(9h) − 계획 정지 12~13시 = 계획 8h.
 * 세션 08~16시(8h) − STOP 10~11시 − 계획 정지와 겹친 12~13시 = 실제 6h → 시간가동률 75%.
 * (실제는 계획과 같은 구간으로 자른다 — 계획 정지 중 작업은 세지 않는다. 사용자 결정 2026-10-19)
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
    const { production } = (await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() })) as unknown as {
      production: Record<string, number | null>;
    };
    // NG 100(불량 50 + 폐기 30 + 재작업 20) − 재작업 합격 10
    expect(production).toEqual({ totalQty: 1100, goodQty: 1010, ngQty: 90, holdQty: 0, defectRate: (90 / 1100) * 100 });
    expect(trend.points).toHaveLength(9);
    expect(trend.points[0]).toEqual({ label: '08-24', value: 0 });
    expect(trend.points.slice(-2)).toEqual([
      { label: '08-31', value: 500 },
      { label: '09-01', value: 1100 },
    ]);
  });

  it('시간가동률은 계획 가동시간 기준, 성능가동률은 C/T×수량÷캐비티 ÷ 실제 가동시간이다', async () => {
    const { cards } = await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() });

    expect(card(cards, 'AVAILABILITY_RATE')).toMatchObject({ value: 75, valueStatusCode: 'AVAILABLE' });
    // 10초 × (1100 + 재작업 10) ÷ 캐비티 2 = 5550초 ÷ 6h(21600초) — 성능률은 재작업 실적도 센다
    expect(card(cards, 'PERFORMANCE_RATE').value).toBeCloseTo((5550 / 21600) * 100, 6);
    expect(card(cards, 'OEE').value).toBeCloseTo(0.75 * (5550 / 21600) * (1010 / 1100) * 100, 6);
  });

  it('시간가동률은 근무 시간 밖 작업을 세지 않아 100% 를 넘지 않는다 — 성능률 분모도 같은 가동시간이다', async () => {
    const { cards } = await read({ baseDate: '2026-08-31', plantId: ids.plant.toString() });

    // 세션 16h 중 교대 안 9h ÷ 계획 9h — 분자를 자르지 않으면 177.8% 다.
    expect(card(cards, 'AVAILABILITY_RATE')).toMatchObject({ value: 100, valueStatusCode: 'AVAILABLE' });
    // 10초 × 500 ÷ 캐비티 2 = 2500초 ÷ 9h(32400초)
    expect(card(cards, 'PERFORMANCE_RATE').value).toBeCloseTo((2500 / 32400) * 100, 6);
    expect(card(cards, 'OEE').value).toBeCloseTo((2500 / 32400) * 100, 6);
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
    expect(card(cards, 'AVAILABILITY_RATE')).toMatchObject({ notYetReasonCode: 'NO_SESSION' });
    expect(card(cards, 'OEE')).not.toHaveProperty('notYetReasonCode');
  });

  it('기준일이 없으면 그 공장의 오늘로 정한다', async () => {
    const body = await read({ plantId: ids.plant.toString() });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

    expect(body.baseDate).toBe(today);
  });

  it('기간 조회 — 합계는 기간 안, 추이는 기간 안 일별, baseDate 는 종료일, 적용 기간을 함께 싣는다(P-59)', async () => {
    const query = { dateFrom: '2026-08-31', dateTo: BASE_DATE, plantId: ids.plant.toString() };
    const body = (await read(query)) as Awaited<ReturnType<typeof read>> & {
      dateFrom: string;
      dateTo: string;
      production: { totalQty: number };
    };

    expect(validateResponse(body)).toBe(true);
    expect(body).toMatchObject({ baseDate: BASE_DATE, dateFrom: '2026-08-31', dateTo: BASE_DATE });
    // 직전 같은 길이(08-29~08-30)는 실적이 없어 증감을 비운다.
    expect(card(body.cards, 'PRODUCTION_QTY').value).toBe(1600);
    expect(card(body.cards, 'PRODUCTION_QTY')).not.toHaveProperty('deltaRatio');
    expect(body.production.totalQty).toBe(1600);
    expect(body.trend.points).toEqual([
      { label: '08-31', value: 500 },
      { label: '09-01', value: 1100 },
    ]);
    // 계획 = 08-31 교대 9h + 09-01 8h(계획 정지 1h 제외) = 17h,
    // 실제 = 08-31 교대 안 9h(교대 밖 7h 제외) + 09-01 6h(계획 정지와 겹친 1h 제외) = 15h
    expect(card(body.cards, 'AVAILABILITY_RATE').value).toBeCloseTo((15 / 17) * 100, 6);
    expect(card(body.cards, 'AVAILABILITY_RATE')).not.toHaveProperty('notYetReasonCode');
    // 08-30 은 근무달력 날짜가 없다 — 기간에 하루라도 끼면 시간가동률 전체를 내지 않는다.
    const gap = await read({ ...query, dateFrom: '2026-08-30' });
    expect(card(gap.cards, 'AVAILABILITY_RATE')).toMatchObject({
      valueStatusCode: 'NOT_YET',
      notYetReasonCode: 'CALENDAR_UNRESOLVED',
    });
  });

  it('기간 조회 — 하루 기간은 baseDate 와 같은 값이다', async () => {
    const byBase = await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() });
    const byRange = await read({ dateFrom: BASE_DATE, dateTo: BASE_DATE, plantId: ids.plant.toString() });

    expect(byRange.cards).toEqual(byBase.cards);
    expect(byRange.trend.points).toEqual(byBase.trend.points);
  });

  it('기간 조회 — 계약 가드가 안 보는 쿼리라 여기서 400 을 낸다(같은 오류 모양)', async () => {
    const reject = async (query: Record<string, string>) =>
      ((await request(app.getHttpServer()).get(PATH).query(query).set('Cookie', cookie).expect(400)).body as {
        errors: { scope: string; field: string; code: string }[];
      }).errors.map(({ scope, field, code }) => ({ scope, field, code }));

    expect(await reject({ dateFrom: '2026-05-31', dateTo: BASE_DATE })).toEqual([
      { scope: 'field', field: 'dateTo', code: 'RANGE' },
    ]);
    expect(await reject({ dateFrom: BASE_DATE, dateTo: '2999-01-01' })).toEqual([
      { scope: 'field', field: 'dateTo', code: 'RANGE' },
    ]);
    expect(await reject({ dateFrom: BASE_DATE })).toEqual([{ scope: 'field', field: 'dateTo', code: 'REQUIRED' }]);
    expect(await reject({ baseDate: BASE_DATE, dateFrom: BASE_DATE, dateTo: BASE_DATE })).toEqual([
      { scope: 'field', field: 'baseDate', code: 'INVALID' },
    ]);
  });

  it('설비 현황은 기준일·기간과 무관하게 «지금» 상태와 공장 «오늘» 생산량이다', async () => {
    type Body = { equipment: { asOf: string; statusCounts: Record<string, number>; items: Record<string, unknown>[] } };
    const before = Date.now();
    const body = (await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() })) as unknown as Body;
    const item = body.equipment.items.find((row) => row.equipmentId === Number(ids.equipment));

    expect(Date.parse(body.equipment.asOf)).toBeGreaterThanOrEqual(before);
    // 세션은 09-01 09:00Z 에 끝났고 오늘은 근무달력이 없다(비근무로 단정하지 않는다) → 대기.
    expect(item).toMatchObject({
      equipmentId: Number(ids.equipment),
      statusCode: 'WAITING',
      statusSince: '2026-09-01T09:00:00.000Z',
      todayTotalQty: 100,
      todayNgQty: 10,
      defectRate: 10,
      standardCycleTimeSec: 10,
      currentWorkOrderNo: null,
    });
    // 이 설비·MACHINE 유형 설비 = 대기, 고장 2·비가동 섞임 1 = 정지, 교체 1(설비 현황 규칙 테스트의 설비들).
    expect(body.equipment.statusCounts).toEqual({ RUNNING: 0, STOPPED: 3, WAITING: 2, CHANGEOVER: 1, IDLE: 0 });

    const ranged = (await read({ dateFrom: '2026-08-31', dateTo: BASE_DATE, plantId: ids.plant.toString() })) as unknown as Body;
    expect(ranged.equipment.items).toEqual(body.equipment.items);
  });

  it('호기별 불량률은 설비 현황(오늘)이 아니라 품질 누계 구간이다 — 하루면 당월, 기간이면 그 기간', async () => {
    type Body = { quality: { pqc: { equipmentDefectRates: Record<string, unknown>[] } } };
    const rate = async (query: Record<string, string>) =>
      ((await read({ ...query, plantId: ids.plant.toString() })) as unknown as Body).quality.pqc.equipmentDefectRates;

    // 09-01 당월 = 09-01 하루: 총생산 1100(정정 원본·재작업 W/O 제외), NG 100. 오늘 실적(100·NG 10)은 들어가지 않는다.
    expect(await rate({ baseDate: BASE_DATE })).toEqual([
      { equipmentId: Number(ids.equipment), equipmentCode: PREFIX, defectRate: (100 / 1100) * 100, ngQty: 100 },
    ]);
    // 기간 08-31~09-01: 08-31 실적 500 이 더해진다.
    expect(await rate({ dateFrom: '2026-08-31', dateTo: BASE_DATE })).toEqual([
      { equipmentId: Number(ids.equipment), equipmentCode: PREFIX, defectRate: (100 / 1600) * 100, ngQty: 100 },
    ]);
  });

  it('품질 — 재검사 뒤 합격은 합격으로 센다(최종 회차), 없는 값은 null 이다', async () => {
    const body = (await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() })) as unknown as {
      quality: Record<string, Record<string, unknown>>;
      shipment: Record<string, unknown>;
    };
    const { pqc, iqc, nonconformance } = body.quality;

    expect(pqc).toMatchObject({
      monthPassRate: 100,
      monthLots: { accepted: 1, rejected: 0, held: 0 },
      todayLots: { accepted: 1, rejected: 0, held: 0 },
      monthDefectQty: 0,
      defectPhenomena: [],
    });
    expect(pqc.recentLots).toEqual([
      expect.objectContaining({ judgmentCode: 'ACCEPTED', equipmentCode: PREFIX, lotNo: null, counterpartName: null }),
    ]);
    expect(iqc).toMatchObject({ monthPassRate: 0, monthLots: { accepted: 0, rejected: 1, held: 0 }, fullReinspect: null });
    // 한 LOT 의 입하 줄 2개를 두 번 세지 않고, 취소된 입하의 공급사는 넣지 않는다.
    expect(iqc.vendorDefects).toEqual([{ partnerId: Number(ids.supplier), partnerName: `${PREFIX}-SUPPLIER`, rejectedQty: 5 }]);
    expect(nonconformance).toMatchObject({ overdueCount: null, openCount: 0, phenomena: [] });
  });

  it('출하 — 확정·대기·다음 출하·납기 경과, 공장 미지정 요청은 어느 공장을 골라도 넣는다', async () => {
    const body = (await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() })) as unknown as {
      shipment: Record<string, unknown>;
      quality: { oqc: { monthLots: Record<string, number> } };
    };

    expect(body.shipment).toEqual({
      // 09-01 에 실제 출하한 확정 출하 1건(10). 08-31 출하분(4)은 기준일이 아니다.
      todayShippedQty: 10,
      todayShipmentCount: 1,
      // 대기 = 요청일 ≤ 기준일인 미출하 요청: 출하 창고로 공장이 정해진 요청(08-30) + 공장 미지정 요청(09-01).
      // 다른 공장 요청(08-29)은 빠진다.
      waitingRequestCount: 2,
      oldestWaitingShipDate: '2026-08-30',
      nextShipment: {
        shipmentRequestId: Number(ids.nextRequest),
        shipmentRequestNo: `${PREFIX}-SR-NEXT`,
        customerName: `${PREFIX}-CUSTOMER`,
        requestedShipDate: '2026-09-03',
        requestedQty: 7,
      },
      // 납기 경과 수주 줄: 창고로 공장이 정해진 요청 줄 + 공장 미지정 요청 줄. 다른 공장 · 출하 완료 줄은 빠진다.
      overdueCount: 2,
    });
    // OQC — 공장 미지정 요청의 합격은 넣고, 다른 공장 요청의 합격은 뺀다.
    expect(body.quality.oqc.monthLots).toEqual({ accepted: 1, rejected: 0, held: 0 });

    const other = (await read({ baseDate: BASE_DATE, plantId: ids.otherPlant.toString() })) as unknown as typeof body;
    // 다른 공장을 골라도 공장 미지정 요청은 대기·납기 경과·OQC 에 들어간다.
    expect(other.shipment).toMatchObject({
      todayShippedQty: 0,
      waitingRequestCount: 2,
      oldestWaitingShipDate: '2026-08-29',
      nextShipment: null,
      overdueCount: 2,
    });
    expect(other.quality.oqc.monthLots).toEqual({ accepted: 2, rejected: 0, held: 0 });
  });

  it('공장에 데이터가 없어도 세 섹션을 빈 값으로 싣는다 — 키 없음은 「미지원」으로 읽힌다', async () => {
    const body = (await read({ baseDate: BASE_DATE, plantId: '8999999999' })) as unknown as Record<string, unknown>;

    expect(validateResponse(body)).toBe(true);
    expect(body.equipment).toMatchObject({
      items: [],
      statusCounts: { RUNNING: 0, STOPPED: 0, WAITING: 0, CHANGEOVER: 0, IDLE: 0 },
    });
    expect(body.shipment).toMatchObject({ todayShipmentCount: 0, nextShipment: null });
    expect(body.production).toEqual({ totalQty: 0, goodQty: 0, ngQty: 0, holdQty: 0, defectRate: null });
    expect(body.quality).toMatchObject({
      iqc: { monthPassRate: null, recentLots: [], fullReinspect: null },
      nonconformance: { overdueCount: null, monthQty: 0 },
    });
  });

  it('설비 현황 — 이상 상태 고장도 정지, 비가동 여럿은 하나라도 교체가 아니면 정지, 계측기는 뺀다', async () => {
    const body = (await read({ baseDate: BASE_DATE, plantId: ids.plant.toString() })) as unknown as {
      equipment: { statusCounts: Record<string, number>; items: { equipmentCode: string; statusCode: string }[] };
    };
    const status = Object.fromEntries(body.equipment.items.map((row) => [row.equipmentCode.slice(PREFIX.length), row]));

    // 계측기(INSTRUMENT_TYPE 계열 CALIPER · 옛 유형 INSPECTION)는 빠지고, 비활성·미등록 유형 코드(MACHINE)는 남는다.
    expect(Object.keys(status).sort()).toEqual(['', '-BRK-ABNORMAL', '-BRK-NULL', '-DT-MIXED', '-DT-MOLD', '-MACHINE']);
    expect(status['-BRK-ABNORMAL']).toMatchObject({ statusCode: 'STOPPED', statusReasonName: '유압 이상' });
    expect(status['-BRK-NULL']).toMatchObject({ statusCode: 'STOPPED' });
    expect(status['-DT-MIXED']).toMatchObject({ statusCode: 'STOPPED', statusReasonCode: 'MATERIAL_WAIT' });
    expect(status['-DT-MOLD']).toMatchObject({
      statusCode: 'CHANGEOVER',
      statusReasonCode: 'MOLD_CHANGE',
      statusSince: '2026-09-01T03:00:00.000Z',
    });
    expect(body.equipment.statusCounts).toMatchObject({ STOPPED: 3, CHANGEOVER: 1 });
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
    await equipmentFixtures();
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
    await prisma.work_calendar_day.createMany({
      data: [BASE_DATE, '2026-08-31'].map((date) => ({
        work_calendar_id: ids.calendar,
        calendar_date: new Date(date),
        day_type_code: 'WORKING',
      })),
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

    // 08-31 — 교대(08~17시 = 01~10Z) 밖으로 넘친 세션 03~19시(16h). 근무 시간 안 9h 만 가동으로 센다.
    await prisma.work_session.create({
      data: {
        work_order_id: ids.order,
        session_no: 2,
        equipment_id: ids.equipment,
        terminal_id: ids.terminal,
        started_at: new Date('2026-08-30T20:00:00Z'),
        ended_at: new Date('2026-08-31T12:00:00Z'),
        status_code: 'ENDED',
        idempotency_key: `${PREFIX}-SESSION-OFFSHIFT`,
      },
    });

    await addResult(ids.order, 1, '2026-09-01T02:00:00Z', { good_qty: 900, defect_qty: 50, scrap_qty: 30, rework_qty: 20 });
    await addResult(ids.order, 2, '2026-08-31T02:00:00Z', { good_qty: 500 });
    const original = await addResult(ids.order, 3, '2026-09-01T02:30:00Z', { good_qty: 777 });
    // 정정본만 센다 — 원본 777 은 빠지고 100 이 들어간다(수량 0 은 DB 제약이 막는다).
    await addResult(ids.order, 4, '2026-09-01T02:30:00Z', { good_qty: 100 }, original);
    await addResult(ids.rework, 1, '2026-09-01T07:00:00Z', { good_qty: 10 });
    // 설비 현황(공장 오늘)용 — 기준일 집계에는 들어가지 않는다.
    await addResult(ids.order, 5, new Date().toISOString(), { good_qty: 90, defect_qty: 10 });

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

    await shipmentFixtures();
    await iqcFixtures();

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

  /** 설비 현황 규칙용 설비 — 기록은 09-01 에 열려 아직 닫히지 않았다(판단 시각과 무관하게 걸려 있다). */
  async function equipmentFixtures(): Promise<void> {
    const add = async (suffix: string, typeCode = 'PRESS'): Promise<bigint> =>
      (
        await prisma.equipment.create({
          data: {
            plant_id: ids.plant,
            equipment_code: `${PREFIX}${suffix}`,
            equipment_name: PREFIX,
            equipment_type_code: typeCode,
            status_code: 'IN_SERVICE',
          },
        })
      ).equipment_id;
    const breakdown = async (equipmentId: bigint, no: string, occurrence: string | null) =>
      prisma.breakdown.create({
        data: {
          breakdown_no: `${PREFIX}-${no}`,
          equipment_id: equipmentId,
          reported_at: new Date('2026-09-01T02:00:00Z'),
          description: '유압 이상',
          status_code: 'RECEIVED',
          occurrence_state_code: occurrence,
        },
      });
    const downtime = async (equipmentId: bigint, reasonCode: string, startedAt: string) =>
      prisma.equipment_downtime.create({
        data: { equipment_id: equipmentId, started_at: new Date(startedAt), reason_code: reasonCode },
      });

    await breakdown(await add('-BRK-ABNORMAL'), 'ABNORMAL', 'ABNORMAL');
    await breakdown(await add('-BRK-NULL'), 'NULL', null);
    const mixed = await add('-DT-MIXED');
    await downtime(mixed, 'MATERIAL_WAIT', '2026-09-01T01:00:00Z');
    await downtime(mixed, 'MOLD_CHANGE', '2026-09-01T02:00:00Z');
    const mold = await add('-DT-MOLD');
    await downtime(mold, 'MOLD_CHANGE', '2026-09-01T01:00:00Z');
    await downtime(mold, 'MOLD_CHANGE', '2026-09-01T03:00:00Z');
    await add('-CALIPER', 'CALIPER');
    await add('-INSPECTION', 'INSPECTION');
    await add('-MACHINE', 'MACHINE');
  }

  /**
   * 출하 — 기준일 09-01. 공장 셋: 이 공장(창고 W) · 다른 공장(창고 W2) · 공장 미지정(fulfillment 없음 · 출하 없음).
   * | 요청 | 공장 | 요청일 | 요청/출하 | 수주 줄 |
   * | SR-CONF | 지정(이 공장) | 08-31 | 10/10 (09-01 출하 확정) | 출하 완료 |
   * | SR-WAIT | 비었음 → 출하 창고 W | 08-30 | 10/4 (08-31 출하) | 납기 08-30 미출하 |
   * | SR-NOPLANT | 미지정 | 09-01 | 10/0 | 납기 08-30 미출하 |
   * | SR-OTHER | 다른 공장 | 08-29 | 10/0 | 납기 08-30 미출하 |
   * | SR-NEXT | 지정(이 공장) | 09-03 | 7/0 | — |
   */
  async function shipmentFixtures(): Promise<void> {
    ids.otherPlant = (
      await prisma.plant.create({
        data: {
          legal_entity_id: ids.legal,
          business_unit_id: ids.unit,
          plant_code: `${PREFIX}-OTHER`,
          plant_name: PREFIX,
          timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })
    ).plant_id;
    const warehouse = async (plantId: bigint, code: string) =>
      (
        await prisma.warehouse.create({
          data: {
            plant_id: plantId,
            business_unit_id: ids.unit,
            warehouse_code: `${PREFIX}-${code}`,
            warehouse_name: PREFIX,
            warehouse_type_code: 'FINISHED_GOODS',
            management_level_code: 'LOCATION',
          },
        })
      ).warehouse_id;
    const mainWarehouse = await warehouse(ids.plant, 'W');
    await warehouse(ids.otherPlant, 'W2');
    ids.customer = (
      await prisma.partner.create({ data: { partner_code: `${PREFIX}-CUSTOMER`, partner_name: `${PREFIX}-CUSTOMER` } })
    ).partner_id;
    const order = await prisma.sales_order.create({
      data: {
        sales_order_no: PREFIX,
        customer_id: ids.customer,
        ship_to_partner_id: ids.customer,
        order_date: new Date('2026-08-20'),
        status_code: 'REGISTERED',
      },
    });
    let orderLineNo = 0;
    const orderLine = async (shippedQty: number) =>
      (
        await prisma.sales_order_line.create({
          data: {
            sales_order_id: order.sales_order_id,
            line_no: (orderLineNo += 1),
            item_id: ids.item,
            ordered_qty: 10,
            shipped_qty: shippedQty,
            uom_id: ids.uom,
            requested_delivery_date: new Date('2026-08-30'),
          },
        })
      ).sales_order_line_id;
    const addRequest = async (
      code: string,
      plantId: bigint | null,
      shipDate: string,
      qty: number,
      shippedQty: number,
      salesOrderLineId: bigint | null,
    ) => {
      const created = await prisma.shipment_request.create({
        data: {
          shipment_request_no: `${PREFIX}-${code}`,
          customer_id: ids.customer,
          ship_to_partner_id: ids.customer,
          requested_ship_date: new Date(shipDate),
          status_code: 'REGISTERED',
          fulfillment_plant_id: plantId,
        },
      });
      const line = await prisma.shipment_request_line.create({
        data: {
          shipment_request_id: created.shipment_request_id,
          line_no: 1,
          sales_order_line_id: salesOrderLineId,
          item_id: ids.item,
          requested_qty: qty,
          allocated_qty: shippedQty,
          shipped_qty: shippedQty,
          uom_id: ids.uom,
        },
      });
      return { requestId: created.shipment_request_id, lineId: line.shipment_request_line_id };
    };
    const ship = async (request: { requestId: bigint; lineId: bigint }, code: string, qty: number, shippedAt: string) => {
      const shipment = await prisma.shipment.create({
        data: {
          shipment_no: `${PREFIX}-${code}`,
          shipment_request_id: request.requestId,
          warehouse_id: mainWarehouse,
          shipped_at: new Date(shippedAt),
          status_code: 'CONFIRMED',
        },
      });
      await prisma.shipment_line.create({
        data: {
          shipment_id: shipment.shipment_id,
          line_no: 1,
          shipment_request_line_id: request.lineId,
          item_id: ids.item,
          shipped_qty: qty,
          uom_id: ids.uom,
        },
      });
    };

    await ship(await addRequest('SR-CONF', ids.plant, '2026-08-31', 10, 10, await orderLine(10)), 'S-CONF', 10, '2026-09-01T03:00:00Z');
    await ship(await addRequest('SR-WAIT', null, '2026-08-30', 10, 4, await orderLine(4)), 'S-WAIT', 4, '2026-08-31T03:00:00Z');
    ids.noPlantRequest = (await addRequest('SR-NOPLANT', null, BASE_DATE, 10, 0, await orderLine(0))).requestId;
    ids.otherRequest = (await addRequest('SR-OTHER', ids.otherPlant, '2026-08-29', 10, 0, await orderLine(0))).requestId;
    ids.nextRequest = (await addRequest('SR-NEXT', ids.plant, '2026-09-03', 7, 0, null)).requestId;

    // OQC 합격 — 공장 미지정 요청 1건 · 다른 공장 요청 1건(이 공장 조회에서는 빠진다).
    for (const [code, requestId] of [
      ['OQC-NOPLANT', ids.noPlantRequest],
      ['OQC-OTHER', ids.otherRequest],
    ] as const) {
      await addInspection(code, 'OQC', { target_type_code: 'SHIPMENT_REQUEST', target_id: requestId }, 'ACCEPTED', 0);
    }
  }

  /**
   * IQC 불합격 5 — LOT 하나가 입하 줄 2개에 실려 있고, 그보다 먼저 만든 «취소된» 입하에도 실려 있다.
   * 업체별 불합격은 취소 안 된 입하의 첫 줄 공급사로 한 번만 센다.
   */
  async function iqcFixtures(): Promise<void> {
    const partner = async (code: string) =>
      (await prisma.partner.create({ data: { partner_code: `${PREFIX}-${code}`, partner_name: `${PREFIX}-${code}` } }))
        .partner_id;
    ids.supplier = await partner('SUPPLIER');
    const cancelledSupplier = await partner('SUPPLIER-CANCELLED');
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: ids.item,
        lot_type_code: 'MATERIAL',
        plant_id: ids.plant,
        initial_qty: 20,
        uom_id: ids.uom,
        source_type_code: 'INBOUND_RECEIPT',
        source_id: 0,
        status_code: 'ACTIVE',
      },
    });
    const receipt = async (code: string, supplierId: bigint, statusCode: string, lines: number) => {
      const created = await prisma.inbound_receipt.create({
        data: {
          inbound_receipt_no: `${PREFIX}-${code}`,
          supplier_id: supplierId,
          plant_id: ids.plant,
          receipt_datetime: new Date('2026-09-01T01:00:00Z'),
          status_code: statusCode,
        },
      });
      for (let lineNo = 1; lineNo <= lines; lineNo += 1) {
        await prisma.inbound_receipt_line.create({
          data: {
            inbound_receipt_id: created.inbound_receipt_id,
            line_no: lineNo,
            item_id: ids.item,
            lot_id: lot.lot_id,
            received_qty: 10,
            uom_id: ids.uom,
            supplier_lot_label_attached: false,
            inspection_required: true,
            status_code: 'REGISTERED',
          },
        });
      }
    };
    await receipt('IR-CANCELLED', cancelledSupplier, 'CANCELLED', 1);
    await receipt('IR', ids.supplier, 'REGISTERED', 2);
    await addInspection('IQC', 'IQC', { target_type_code: 'LOT', target_id: lot.lot_id, lot_id: lot.lot_id }, 'REJECTED', 5);
  }

  async function addInspection(
    code: string,
    type: string,
    target: { target_type_code: string; target_id: bigint; lot_id?: bigint },
    judgment: 'ACCEPTED' | 'REJECTED',
    rejectedQty: number,
  ): Promise<void> {
    const created = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-${code}`,
        inspection_type_code: type,
        ...target,
        item_id: ids.item,
        target_qty: 10,
        uom_id: ids.uom,
        status_code: 'COMPLETED',
        requested_at: new Date('2026-09-01T02:00:00Z'),
      },
    });
    await prisma.inspection_result.create({
      data: {
        inspection_result_no: `${PREFIX}-${code}-1`,
        inspection_request_id: created.inspection_request_id,
        inspection_round: 1,
        inspected_qty: 10,
        accepted_qty: 10 - rejectedQty,
        rejected_qty: rejectedQty,
        held_qty: 0,
        uom_id: ids.uom,
        overall_judgment_code: judgment,
        inspector_id: ids.worker,
        inspected_at: new Date('2026-09-01T05:00:00Z'),
        status_code: 'CONFIRMED',
        idempotency_key: `${PREFIX}-${code}-1`,
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
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    const shipmentScope = { shipment_no: { startsWith: PREFIX } };
    await prisma.shipment_line.deleteMany({ where: { shipment: shipmentScope } });
    await prisma.shipment.deleteMany({ where: shipmentScope });
    const requestScope = { shipment_request_no: { startsWith: PREFIX } };
    await prisma.shipment_request_line.deleteMany({ where: { shipment_request: requestScope } });
    await prisma.shipment_request.deleteMany({ where: requestScope });
    await prisma.sales_order_line.deleteMany({ where: { sales_order: { sales_order_no: PREFIX } } });
    await prisma.sales_order.deleteMany({ where: { sales_order_no: PREFIX } });
    const receiptScope = { inbound_receipt_no: { startsWith: PREFIX } };
    await prisma.inbound_receipt_line.deleteMany({ where: { inbound_receipt: receiptScope } });
    await prisma.inbound_receipt.deleteMany({ where: receiptScope });
    await prisma.lot.deleteMany({ where: { lot_no: `${PREFIX}-LOT` } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
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
    const equipmentScope = { equipment: { equipment_code: { startsWith: PREFIX } } };
    await prisma.equipment_downtime.deleteMany({ where: equipmentScope });
    await prisma.breakdown.deleteMany({ where: equipmentScope });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.terminal.deleteMany({ where: { terminal_code: PREFIX } });
    await prisma.worker.deleteMany({ where: { worker_no: PREFIX } });
    await prisma.production_line.deleteMany({ where: { line_code: PREFIX } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: PREFIX } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: PREFIX } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: `${PREFIX}-USER` } });
  }
});
