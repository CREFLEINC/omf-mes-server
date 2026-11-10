import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-AA251';
const SUMMARY = '/api/app/dashboard-summary';
const GROUP_DEFECTS = '/api/app/dashboard-item-group-defects';
// 하루 조회 → 생산은 그날, 품질 누계 구간은 09-01 ~ 09-10.
const BASE_DATE = '2026-09-10';
const AT = '2026-09-10T03:00:00Z';
const DETAIL = '/api/app/dashboard-equipment-detail';
const MIN = 60_000;
// 설비 상세는 공장 «오늘»·«지금» 기준이다 — 픽스처를 실행 시각에 맞춘다. 하노이는 +07 고정(서머타임 없음).
const NOW = Date.now();
const DAY_START = Math.floor((NOW + 7 * 60 * MIN) / (24 * 60 * MIN)) * (24 * 60 * MIN) - 7 * 60 * MIN;
const TODAY = new Date(DAY_START + 7 * 60 * MIN).toISOString().slice(0, 10);
const since = (minutes: number) => Math.max(DAY_START, NOW - minutes * MIN);

type ItemGroup = { itemGroupCode: string | null; itemGroupName: string | null; totalQty: number; goodQty: number; ngQty: number; defectRate: number | null };

/**
 * 고객 대시보드 자료 중 MES 데이터로 보이는 항목(omf-all-around#251). 다른 대시보드 e2e 와 섞지 않으려고 공장을 따로 세운다.
 * 품목 A(ADT)·B(ESL)·C(품목군 없음). 실적은 모두 09-10 이다.
 */
describe('통합 대시보드 — 제품군별 생산·불량 · 선별 처분 LOT (omf-all-around#251)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const ids: Record<string, bigint> = {};

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

  const summary = async () =>
    (
      await request(app.getHttpServer())
        .get(SUMMARY)
        .query({ plantId: ids.plant.toString(), baseDate: BASE_DATE })
        .set('Cookie', cookie)
        .expect(200)
    ).body as {
      production: { totalQty: number; goodQty: number; ngQty: number; byItemGroup: ItemGroup[] };
      quality: { iqc: { sortedLotCount: number } };
    };

  it('⭐ 제품군별 생산은 총생산 많은 순이고 미분류는 맨 끝, 합하면 공장 생산 합이다', async () => {
    const { production } = await summary();

    expect(production.byItemGroup.map(({ itemGroupCode, itemGroupName, totalQty, goodQty, ngQty }) => ({
      itemGroupCode, itemGroupName, totalQty, goodQty, ngQty,
    }))).toEqual([
      // A: 양품 180 + 불량 20 + 정정본 50(원본 999 제외) · 양품에 재작업 W/O 합격 7 을 더한다
      { itemGroupCode: 'ADT', itemGroupName: 'ADT 그룹', totalQty: 250, goodQty: 237, ngQty: 20 },
      { itemGroupCode: 'ESL', itemGroupName: 'ESL 그룹', totalQty: 100, goodQty: 95, ngQty: 5 },
      { itemGroupCode: null, itemGroupName: null, totalQty: 50, goodQty: 40, ngQty: 10 },
    ]);
    expect(production.byItemGroup[0].defectRate).toBeCloseTo(8, 9);
    const sum = (key: 'totalQty' | 'goodQty' | 'ngQty') => production.byItemGroup.reduce((total, row) => total + row[key], 0);
    expect({ totalQty: sum('totalQty'), goodQty: sum('goodQty'), ngQty: sum('ngQty') }).toEqual({
      totalQty: production.totalQty,
      goodQty: production.goodQty,
      ngQty: production.ngQty,
    });
  });

  it('⭐ 선별 처분 LOT 은 원래 IQC 검사 LOT 으로 센다 — 떼어 낸 LOT 의 재선별과 폐기 처분은 늘리지 않는다', async () => {
    const { quality } = await summary();

    expect(quality.iqc.sortedLotCount).toBe(1);
  });

  it('⭐ 상태별 LOT 목록 IQC_SORTED — 선별 처분마다 한 줄, LOT 수는 원래 검사 LOT 하나(sortedLotCount 와 같다)', async () => {
    const body = (
      await request(app.getHttpServer())
        .get('/api/app/dashboard-quality-lots')
        .query({ status: 'IQC_SORTED', plantId: ids.plant.toString(), baseDate: BASE_DATE })
        .set('Cookie', cookie)
        .expect(200)
    ).body as { totalCount: number; lotCount: number; recordCount: number; items: { lotNo: string; refNo: string; inspectionType: string }[] };

    expect(body).toMatchObject({ totalCount: 2, lotCount: 1, recordCount: 2 });
    expect(body.items.map((row) => row.lotNo)).toEqual([`${PREFIX}-LOT-1`, `${PREFIX}-LOT-1`]);
    expect(body.items.map((row) => row.refNo).sort()).toEqual([`${PREFIX}-NC-1`, `${PREFIX}-NC-1-SPLIT`]);
    expect(body.items[0].inspectionType).toBe('IQC');
  });

  it('제품군별 불량 경로는 로그인이 필요하다', async () => {
    await request(app.getHttpServer()).get(GROUP_DEFECTS).query({ baseDate: BASE_DATE }).expect(401);
  });

  it('⭐ 제품군별 불량은 요약과 같은 생산 합에 Worst 5 · 유형 미입력을 붙인다 — 정정 원본의 기록은 빠진다', async () => {
    const body = (
      await request(app.getHttpServer())
        .get(GROUP_DEFECTS)
        .query({ plantId: ids.plant.toString(), baseDate: BASE_DATE })
        .set('Cookie', cookie)
        .expect(200)
    ).body as {
      dateFrom: string;
      dateTo: string;
      groups: (Omit<ItemGroup, 'goodQty'> & { topDefects: { defectCode: string; qty: number }[]; untypedNgQty: number })[];
    };
    const { production } = await summary();

    expect(body).toMatchObject({ dateFrom: BASE_DATE, dateTo: BASE_DATE });
    expect(body.groups.map(({ itemGroupCode, totalQty, ngQty, defectRate }) => ({ itemGroupCode, totalQty, ngQty, defectRate }))).toEqual(
      production.byItemGroup.map(({ itemGroupCode, totalQty, ngQty, defectRate }) => ({ itemGroupCode, totalQty, ngQty, defectRate })),
    );
    expect(body.groups[0].topDefects.map(({ defectCode, qty }) => ({ defectCode, qty }))).toEqual([
      { defectCode: `${PREFIX}-D1`, qty: 12 },
      { defectCode: `${PREFIX}-D2`, qty: 5 },
    ]);
    expect(body.groups[0].untypedNgQty).toBe(20 - 17);
    expect(body.groups[1]).toMatchObject({ itemGroupCode: 'ESL', topDefects: [], untypedNgQty: 5 });
  });

  it('설비 상세는 로그인이 필요하고, 없는 설비는 404 다', async () => {
    await request(app.getHttpServer()).get(DETAIL).query({ equipmentId: ids.equipment.toString() }).expect(401);
    await request(app.getHttpServer()).get(DETAIL).query({ equipmentId: '999999999999' }).set('Cookie', cookie).expect(404);
  });

  it('⭐ 설비 상세 — 진행 중 작업지시의 금형·진도, 오늘 수량·불량 유형, 가동 + 작업 중 정지 = 세션, 정지 사유별 시간', async () => {
    const body = (
      await request(app.getHttpServer())
        .get(DETAIL)
        .query({ equipmentId: ids.equipment.toString() })
        .set('Cookie', cookie)
        .expect(200)
    ).body as {
      mold: unknown;
      workOrder: { workOrderNo: string; orderQty: number; producedQty: number; progressRate: number };
      output: { totalQty: number; goodQty: number; ngQty: number };
      time: { plannedMs: number; runningMs: number; stoppedMs: number; noWorkMs: number; availabilityRate: number };
      standardOutput: { expectedQty: number; differenceQty: number; excludedSessionCount: number };
      defectTypes: { defectCode: string; qty: number }[];
      untypedNgQty: number;
      stopReasons: { reasonCode: string; reasonName: string; durationMs: number }[];
    };

    expect(body.mold).toEqual({ moldCode: PREFIX, moldName: PREFIX, cavityCount: 2 });
    // 누적 실적 = 정정 원본을 뺀 모든 실적(180+20 · 50 · 오늘 30+2) — 조회 기간과 무관하다.
    expect(body.workOrder).toMatchObject({ workOrderNo: `${PREFIX}-A`, orderQty: 1000, producedQty: 282 });
    expect(body.workOrder.progressRate).toBeCloseTo(28.2, 9);
    expect(body.output).toMatchObject({ totalQty: 32, goodQty: 30, ngQty: 2 });
    expect(body.defectTypes.map(({ defectCode, qty }) => ({ defectCode, qty }))).toEqual([{ defectCode: `${PREFIX}-D1`, qty: 2 }]);
    expect(body.untypedNgQty).toBe(0);

    const stopped = since(10) - since(20);
    const session = body.time.runningMs + body.time.stoppedMs;
    expect(body.time.stoppedMs).toBe(stopped);
    // 진행 중 세션은 서버의 «지금»까지라 몇 ms 다를 수 있다.
    expect(Math.abs(session - (NOW - since(30)))).toBeLessThan(MIN);
    expect(body.time.noWorkMs).toBe(body.time.plannedMs - session);
    expect(body.time.availabilityRate).toBeCloseTo((body.time.runningMs / body.time.plannedMs) * 100, 6);
    // 가동 초 ÷ C/T 10 × 캐비티 2
    expect(Math.abs(body.standardOutput.expectedQty - (body.time.runningMs / 1000 / 10) * 2)).toBeLessThanOrEqual(1);
    expect(body.standardOutput).toMatchObject({
      differenceQty: 32 - body.standardOutput.expectedQty,
      excludedSessionCount: 0,
    });
    // 공통코드에 없는 사유는 코드값을 이름으로 싣는다.
    expect(body.stopReasons).toEqual(stopped > 0 ? [{ reasonCode: `${PREFIX}-R`, reasonName: `${PREFIX}-R`, durationMs: stopped }] : []);
  });

  async function fixtures(): Promise<void> {
    ids.user = (await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } }))
      .app_user_id;
    ids.role = (await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } })).role_id;
    // 기능 권한을 주지 않는다 — 대시보드는 로그인만 본다(omf-all-around#229).
    await prisma.user_role.create({ data: { app_user_id: ids.user, role_id: ids.role } });
    ids.legal = (
      await prisma.legal_entity.create({
        data: { legal_entity_code: PREFIX, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
      })
    ).legal_entity_id;
    ids.unit = (
      await prisma.business_unit.create({ data: { legal_entity_id: ids.legal, business_unit_code: PREFIX, business_unit_name: PREFIX } })
    ).business_unit_id;
    ids.plant = (
      await prisma.plant.create({
        data: {
          legal_entity_id: ids.legal, business_unit_id: ids.unit, plant_code: PREFIX, plant_name: PREFIX,
          timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })
    ).plant_id;
    ids.line = (await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: PREFIX, line_name: PREFIX } }))
      .production_line_id;
    ids.worker = (
      await prisma.worker.create({
        data: { worker_no: PREFIX, worker_name: PREFIX, business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
      })
    ).worker_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    ids.process = (
      await prisma.process.create({ data: { process_code: PREFIX, process_name: PREFIX, process_type_code: 'ASSEMBLY' } })
    ).process_id;

    const itemA = await addItem('A', 'ADT');
    const itemB = await addItem('B', 'ESL');
    const itemC = await addItem('C', null);
    const orderA = await addOrder('A', itemA, 'NORMAL');
    const orderB = await addOrder('B', itemB, 'NORMAL');
    const orderC = await addOrder('C', itemC, 'NORMAL');
    const reworkA = await addOrder('A-RW', itemA, 'REWORK');
    await equipmentFixtures(orderA);
    const resultA = await addResult(orderA, 1, { good_qty: 180, defect_qty: 20 });
    const original = await addResult(orderA, 2, { good_qty: 990, defect_qty: 9 });
    await addResult(orderA, 3, { good_qty: 50 }, original);
    await addDefect('D1', resultA, 12);
    await addDefect('D2', resultA, 5);
    // 정정된 원본 실적의 기록 — 세지 않는다.
    await addDefect('D3', original, 9);
    await addResult(orderB, 1, { good_qty: 95, scrap_qty: 5 });
    await addResult(orderC, 1, { good_qty: 40, rework_qty: 10 });
    await addResult(reworkA, 1, { good_qty: 7 });

    // IQC — LOT 1 은 선별 → 떼어 낸 불량분을 다시 선별(같은 검사 결과를 물려받는다). LOT 2 는 폐기.
    const sorted = await addIqc('1', itemA);
    const first = await addNonconformance('1', itemA, sorted);
    await addDecision(first, 'SORT');
    const split = await addNonconformance('1-SPLIT', itemA, sorted);
    await addDecision(split, 'SORT');
    const scrapped = await addIqc('2', itemB);
    await addDecision(await addNonconformance('2', itemB, scrapped), 'SCRAP');
  }

  async function equipmentFixtures(orderA: bigint): Promise<void> {
    ids.equipment = (
      await prisma.equipment.create({
        data: {
          plant_id: ids.plant, production_line_id: ids.line, equipment_code: PREFIX, equipment_name: PREFIX,
          equipment_type_code: 'PRESS', status_code: 'IN_SERVICE',
        },
      })
    ).equipment_id;
    const mold = await prisma.mold.create({
      data: { plant_id: ids.plant, mold_code: PREFIX, mold_name: PREFIX, status_code: 'ACTIVE', tool_type_code: 'MOLD', cavity_count: 2 },
    });
    await prisma.work_order.update({
      where: { work_order_id: orderA },
      data: { planned_mold_id: mold.mold_id, planned_equipment_id: ids.equipment },
    });
    const terminal = await prisma.terminal.create({
      data: { terminal_code: PREFIX, plant_id: ids.plant, terminal_type_code: 'POP', status_code: 'ACTIVE' },
    });
    // 근무 00:00~23:59 — 계획 시간 = 오늘 0시 ~ 지금.
    await prisma.shift.create({
      data: {
        plant_id: ids.plant, shift_code: PREFIX, shift_name: PREFIX,
        start_time: new Date('1970-01-01T00:00:00Z'), end_time: new Date('1970-01-01T23:59:00Z'),
      },
    });
    const calendar = await prisma.work_calendar.create({ data: { plant_id: ids.plant, calendar_code: PREFIX, calendar_name: PREFIX } });
    await prisma.work_calendar_application.create({
      data: { work_calendar_id: calendar.work_calendar_id, target_type_code: 'PLANT', target_id: ids.plant, effective_from: new Date('2026-01-01') },
    });
    await prisma.work_calendar_day.create({
      data: { work_calendar_id: calendar.work_calendar_id, calendar_date: new Date(TODAY), day_type_code: 'WORKING' },
    });
    // 30분 전 시작 · 20~10분 전 정지(사유 코드는 공통코드에 없다) · 지금도 진행 중.
    const session = await prisma.work_session.create({
      data: {
        work_order_id: orderA, session_no: 1, equipment_id: ids.equipment, terminal_id: terminal.terminal_id,
        started_at: new Date(since(30)), status_code: 'RUNNING', idempotency_key: `${PREFIX}-SESSION`,
      },
    });
    await prisma.work_session_event.createMany({
      data: [
        { work_session_id: session.work_session_id, event_type_code: 'STOP', occurred_at: new Date(since(20)), reason_code: `${PREFIX}-R` },
        { work_session_id: session.work_session_id, event_type_code: 'RESUME', occurred_at: new Date(since(10)) },
      ],
    });
    const today = await addResult(orderA, 4, { good_qty: 30, defect_qty: 2 }, undefined, {
      occurred_at: new Date(since(5)), equipment_id: ids.equipment, mold_id: mold.mold_id,
    });
    await addDefect('D1', today, 2);
  }

  async function addItem(suffix: string, group: string | null): Promise<bigint> {
    return (
      await prisma.item.create({
        data: {
          item_code: `${PREFIX}-${suffix}`, item_name: `${PREFIX}-${suffix}`, item_type_code: 'FINISHED_GOODS',
          base_uom_id: ids.uom, lot_controlled: true,
          erp_item_group_code: group, erp_item_group_name: group === null ? null : `${group} 그룹`,
        },
      })
    ).item_id;
  }

  async function addOrder(suffix: string, itemId: bigint, type: string): Promise<bigint> {
    const routing = await prisma.routing.upsert({
      where: { item_id_routing_code_routing_version: { item_id: itemId, routing_code: PREFIX, routing_version: 1 } },
      update: {},
      create: { item_id: itemId, routing_code: PREFIX, routing_version: 1, status_code: 'ACTIVE' },
    });
    const operation =
      (await prisma.routing_operation.findFirst({ where: { routing_id: routing.routing_id } })) ??
      (await prisma.routing_operation.create({
        data: { routing_id: routing.routing_id, process_id: ids.process, operation_seq: 10, operation_name: PREFIX, standard_cycle_time_sec: 10 },
      }));
    return (
      await prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-${suffix}`, routing_operation_id: operation.routing_operation_id, item_id: itemId,
          order_qty: 1000, uom_id: ids.uom, work_order_type_code: type, production_line_id: ids.line, status_code: 'IN_PROGRESS',
        },
      })
    ).work_order_id;
  }

  async function addResult(
    workOrderId: bigint,
    sequence: number,
    quantities: Partial<Record<'good_qty' | 'defect_qty' | 'scrap_qty' | 'rework_qty', number>>,
    corrects?: bigint,
    extra: { occurred_at?: Date; equipment_id?: bigint; mold_id?: bigint } = {},
  ): Promise<bigint> {
    const no = `${PREFIX}-${workOrderId}-${sequence}`;
    return (
      await prisma.production_result.create({
        data: {
          production_result_no: no, work_order_id: workOrderId, result_sequence: sequence,
          corrects_production_result_id: corrects ?? null, ...quantities, uom_id: ids.uom, result_source_code: 'MANUAL',
          occurred_at: new Date(AT), worker_id: ids.worker, status_code: 'CONFIRMED', idempotency_key: no, ...extra,
        },
      })
    ).production_result_id;
  }

  async function addDefect(suffix: string, productionResultId: bigint, qty: number): Promise<void> {
    const code = `${PREFIX}-${suffix}`;
    const defect =
      (await prisma.defect_code.findFirst({ where: { defect_code: code } })) ??
      (await prisma.defect_code.create({ data: { defect_code: code, defect_name: code } }));
    await prisma.defect_record.create({
      data: {
        production_result_id: productionResultId, source_type_code: 'FIELD', defect_code_id: defect.defect_code_id,
        defect_qty: qty, uom_id: ids.uom, occurrence_process_id: ids.process, detection_process_id: ids.process,
        detected_at: new Date(AT), worker_id: ids.worker,
      },
    });
  }

  async function addIqc(suffix: string, itemId: bigint): Promise<bigint> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${suffix}`, item_id: itemId, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 100,
        uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 990001n, status_code: 'DEFECTIVE',
      },
    });
    const req = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-IRQ-${suffix}`, inspection_type_code: 'IQC', target_type_code: 'LOT',
        target_id: lot.lot_id, item_id: itemId, lot_id: lot.lot_id, target_qty: 100, uom_id: ids.uom, status_code: 'COMPLETED',
        requested_at: new Date(AT),
      },
    });
    return (
      await prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-IRS-${suffix}`, inspection_request_id: req.inspection_request_id, inspection_round: 1,
          inspected_qty: 100, accepted_qty: 0, rejected_qty: 100, held_qty: 0, uom_id: ids.uom,
          overall_judgment_code: 'REJECTED', inspector_id: ids.worker, inspected_at: new Date(AT), confirmed_at: new Date(AT),
          status_code: 'CONFIRMED', idempotency_key: `${PREFIX}-IRS-${suffix}`,
        },
      })
    ).inspection_result_id;
  }

  async function addNonconformance(suffix: string, itemId: bigint, inspectionResultId: bigint): Promise<bigint> {
    return (
      await prisma.nonconformance.create({
        data: {
          nonconformance_no: `${PREFIX}-NC-${suffix}`, item_id: itemId, inspection_result_id: inspectionResultId,
          severity_code: 'MINOR', description: PREFIX, status_code: 'CLOSED', opened_at: new Date(AT), closed_at: new Date(AT),
        },
      })
    ).nonconformance_id;
  }

  async function addDecision(nonconformanceId: bigint, type: string): Promise<void> {
    await prisma.disposition_decision.create({
      data: {
        nonconformance_id: nonconformanceId, disposition_type_code: type, decision_qty: 50, uom_id: ids.uom,
        reason: PREFIX, decided_by: ids.user, decided_at: new Date(AT),
      },
    });
  }

  async function cleanup(): Promise<void> {
    await prisma.defect_record.deleteMany({ where: { defect_code: { defect_code: { startsWith: PREFIX } } } });
    await prisma.defect_code.deleteMany({ where: { defect_code: { startsWith: PREFIX } } });
    const ncScope = { nonconformance_no: { startsWith: PREFIX } };
    await prisma.disposition_decision.deleteMany({ where: { nonconformance: ncScope } });
    await prisma.nonconformance.deleteMany({ where: ncScope });
    await prisma.inspection_result.deleteMany({ where: { inspection_result_no: { startsWith: PREFIX } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.production_result.deleteMany({
      where: { production_result_no: { startsWith: PREFIX }, corrects_production_result_id: { not: null } },
    });
    await prisma.production_result.deleteMany({ where: { production_result_no: { startsWith: PREFIX } } });
    await prisma.work_session_event.deleteMany({ where: { work_session: { idempotency_key: { startsWith: PREFIX } } } });
    await prisma.work_session.deleteMany({ where: { idempotency_key: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { operation_name: PREFIX } });
    await prisma.routing.deleteMany({ where: { routing_code: PREFIX } });
    await prisma.process.deleteMany({ where: { process_code: PREFIX } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
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
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: users.map((row) => row.app_user_id) } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
