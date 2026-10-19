import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-AA118-QLOTS';
const PATH = '/api/app/dashboard-quality-lots';
const SUMMARY = '/api/app/dashboard-summary';
// 누계 구간(하루 조회) = 09-01 ~ 09-20
const BASE_DATE = '2026-09-20';

type Lots = { status: string; totalCount: number; items: Record<string, unknown>[] };
type Quality = {
  iqc: { monthLots: { held: number }; receiptHoldLotCount: number };
  pqc: { monthLots: { held: number }; pendingLotCount: number };
  oqc: { monthLots: { held: number } };
  nonconformance: { openCount: number };
};

/**
 * 품질 종합 「현재 현황」 상태별 LOT 목록(장부 P-58). ⭐ totalCount 가 대시보드 숫자와 같아야 한다.
 * ⛔ 계약 사본에 없는 경로라 가드 대신 컨트롤러가 인증·권한·질의를 막는다 — 401·403·400 을 여기서 고정한다.
 */
describe('품질 종합 상태별 LOT 목록 (omf-all-around#118 · P-58)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let outsider: string;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await fixtures();
    const jwt = app.get(JwtService);
    cookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(ids.user), typ: 'session' })}`;
    outsider = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(ids.outsider), typ: 'session' })}`;
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  const get = (path: string, query: Record<string, string>, as = cookie) =>
    request(app.getHttpServer()).get(path).query(query).set('Cookie', as);
  const lots = async (query: Record<string, string>) => (await get(PATH, query).expect(200)).body as Lots;
  const quality = async (query: Record<string, string>) =>
    ((await get(SUMMARY, query).expect(200)).body as { quality: Quality }).quality;
  const errors = async (query: Record<string, string>) =>
    ((await get(PATH, query).expect(400)).body as { errors: { scope: string; field: string; code: string }[] }).errors.map(
      ({ scope, field, code }) => ({ scope, field, code }),
    );

  it('⭐ 네 상태의 totalCount 가 대시보드 현재 현황 숫자와 같다(같은 조건)', async () => {
    const plant = { plantId: ids.plant.toString() };
    const q = await quality({ ...plant, baseDate: BASE_DATE });
    const held = q.iqc.monthLots.held + q.pqc.monthLots.held + q.oqc.monthLots.held;

    expect((await lots({ ...plant, baseDate: BASE_DATE, status: 'INSPECTION_HELD' })).totalCount).toBe(held);
    expect((await lots({ ...plant, status: 'RECEIPT_HOLD' })).totalCount).toBe(q.iqc.receiptHoldLotCount);
    expect((await lots({ ...plant, status: 'PQC_PENDING' })).totalCount).toBe(q.pqc.pendingLotCount);
    expect((await lots({ ...plant, status: 'NC_OPEN' })).totalCount).toBe(q.nonconformance.openCount);
    // 픽스처가 만든 수 — 0 끼리 같아서 통과하는 것을 막는다.
    expect([held, q.iqc.receiptHoldLotCount, q.pqc.pendingLotCount, q.nonconformance.openCount]).toEqual([2, 2, 2, 2]);
  });

  it('검사 보류는 누계 구간만 — 기간 조회도 대시보드와 같은 기간을 쓴다', async () => {
    const plant = { plantId: ids.plant.toString() };
    const range = { dateFrom: '2026-08-15', dateTo: BASE_DATE };
    const q = await quality({ ...plant, ...range });
    const body = await lots({ ...plant, ...range, status: 'INSPECTION_HELD' });

    expect(body.totalCount).toBe(q.iqc.monthLots.held + q.pqc.monthLots.held + q.oqc.monthLots.held);
    expect(body.totalCount).toBe(3);
    // 오래된 것부터
    expect(body.items.map((item) => item.occurredAt)).toEqual([
      '2026-08-20T03:00:00.000Z',
      '2026-09-10T03:00:00.000Z',
      '2026-09-15T03:00:00.000Z',
    ]);
  });

  it('검사 보류 줄 — IQC 는 LOT·공급사, PQC 는 호기, 보류 수량·단위·검사결과 번호', async () => {
    const body = await lots({ plantId: ids.plant.toString(), baseDate: BASE_DATE, status: 'INSPECTION_HELD' });

    expect(body).toMatchObject({ status: 'INSPECTION_HELD', totalCount: 2 });
    expect(body.items).toEqual([
      {
        key: expect.stringMatching(/^IR-\d+$/),
        lotNo: `${PREFIX}-LOT-1`,
        itemCode: PREFIX,
        itemName: PREFIX,
        qty: 100,
        unitCode: expect.any(String),
        occurredAt: '2026-09-10T03:00:00.000Z',
        refNo: `${PREFIX}-IQC-HELD`,
        inspectionType: 'IQC',
        counterpartName: `${PREFIX} 공급사`,
        equipmentCode: null,
        detail: null,
      },
      expect.objectContaining({
        lotNo: null,
        qty: 20,
        refNo: `${PREFIX}-PQC-HELD`,
        inspectionType: 'PQC',
        counterpartName: null,
        equipmentCode: PREFIX,
      }),
    ]);
  });

  it('입고 보류는 LOT 마다 한 줄(먼저 걸린 보류), 수량은 보류 수량이 없으면 입하 수량', async () => {
    const body = await lots({ plantId: ids.plant.toString(), status: 'RECEIPT_HOLD' });

    expect(body.totalCount).toBe(2);
    expect(body.items).toEqual([
      expect.objectContaining({
        lotNo: `${PREFIX}-LOT-1`,
        qty: 100,
        refNo: `${PREFIX}-IR`,
        counterpartName: `${PREFIX} 공급사`,
        occurredAt: '2026-09-09T03:00:00.000Z',
        inspectionType: null,
        detail: expect.any(String),
      }),
      expect.objectContaining({ lotNo: `${PREFIX}-LOT-2`, occurredAt: '2026-09-11T03:00:00.000Z' }),
    ]);
  });

  it('검사 대기는 판정 전 PQC 의뢰(요청·진행), 미종결 부적합은 기간과 무관하다', async () => {
    const pending = await lots({ plantId: ids.plant.toString(), status: 'PQC_PENDING', baseDate: '2026-01-01' });
    expect(pending.items.map((item) => item.refNo)).toEqual([`${PREFIX}-WAIT-1`, `${PREFIX}-WAIT-2`]);
    expect(pending.items[0]).toMatchObject({ qty: 20, equipmentCode: PREFIX, lotNo: null });

    const open = await lots({ plantId: ids.plant.toString(), status: 'NC_OPEN', baseDate: '2026-01-01' });
    expect(open.items.map((item) => item.refNo)).toEqual([`${PREFIX}-NC-1`, `${PREFIX}-NC-2`]);
    expect(open.items[0]).toMatchObject({ lotNo: `${PREFIX}-LOT-1`, qty: 15 });
  });

  it('로그인 없음 401 · 권한 없음 403 — 가드와 같은 오류 모양', async () => {
    const anonymous = await request(app.getHttpServer()).get(PATH).query({ status: 'NC_OPEN' }).expect(401);
    expect(anonymous.body).toEqual({
      errors: [{ scope: 'screen', code: 'PERMISSION_DENIED', message: '로그인이 필요합니다.' }],
    });
    const denied = await get(PATH, { status: 'NC_OPEN' }, outsider).expect(403);
    expect(denied.body).toEqual({
      errors: [{ scope: 'screen', code: 'PERMISSION_DENIED', message: '이 기능을 쓸 권한이 없습니다.' }],
    });
  });

  it('status 누락·잘못된 값, 날짜 오류는 400(field 오류)', async () => {
    expect(await errors({})).toEqual([{ scope: 'field', field: 'status', code: 'REQUIRED' }]);
    expect(await errors({ status: 'HELD' })).toEqual([{ scope: 'field', field: 'status', code: 'INVALID' }]);
    expect(await errors({ status: 'NC_OPEN', plantId: 'abc' })).toEqual([
      { scope: 'field', field: 'plantId', code: 'INVALID' },
    ]);
    expect(await errors({ status: 'NC_OPEN', baseDate: '2026-02-30' })).toEqual([
      { scope: 'field', field: 'baseDate', code: 'INVALID' },
    ]);
    expect(await errors({ status: 'INSPECTION_HELD', dateFrom: BASE_DATE })).toEqual([
      { scope: 'field', field: 'dateTo', code: 'REQUIRED' },
    ]);
    expect(await errors({ status: 'INSPECTION_HELD', dateFrom: BASE_DATE, dateTo: '2999-01-01' })).toEqual([
      { scope: 'field', field: 'dateTo', code: 'RANGE' },
    ]);
  });

  async function fixtures(): Promise<void> {
    ids.user = (await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } }))
      .app_user_id;
    ids.outsider = (
      await prisma.app_user.create({ data: { login_id: `${PREFIX}-OUT`, user_name: PREFIX, status_code: 'EMPLOYED' } })
    ).app_user_id;
    ids.role = (await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } })).role_id;
    await prisma.role_permission.create({ data: { role_id: ids.role, permission_code: 'W-CO-05' } });
    await prisma.user_role.create({ data: { app_user_id: ids.user, role_id: ids.role } });

    ids.legal = (
      await prisma.legal_entity.create({
        data: { legal_entity_code: PREFIX, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
      })
    ).legal_entity_id;
    ids.unit = (
      await prisma.business_unit.create({
        data: { legal_entity_id: ids.legal, business_unit_code: PREFIX, business_unit_name: PREFIX },
      })
    ).business_unit_id;
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
    ids.line = (await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: PREFIX, line_name: PREFIX } }))
      .production_line_id;
    ids.equipment = (
      await prisma.equipment.create({
        data: {
          plant_id: ids.plant,
          production_line_id: ids.line,
          equipment_code: PREFIX,
          equipment_name: PREFIX,
          equipment_type_code: 'PRESS',
          status_code: 'IN_SERVICE',
        },
      })
    ).equipment_id;
    ids.worker = (
      await prisma.worker.create({
        data: { worker_no: PREFIX, worker_name: PREFIX, business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
      })
    ).worker_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    ids.item = (
      await prisma.item.create({
        data: { item_code: PREFIX, item_name: PREFIX, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom, lot_controlled: true },
      })
    ).item_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: PREFIX, partner_name: `${PREFIX} 공급사` } })).partner_id;
    ids.process = (
      await prisma.process.create({ data: { process_code: PREFIX, process_name: PREFIX, process_type_code: 'ASSEMBLY' } })
    ).process_id;
    ids.routing = (
      await prisma.routing.create({ data: { item_id: ids.item, routing_code: PREFIX, routing_version: 1, status_code: 'ACTIVE' } })
    ).routing_id;
    ids.operation = (
      await prisma.routing_operation.create({
        data: { routing_id: ids.routing, process_id: ids.process, operation_seq: 10, operation_name: PREFIX },
      })
    ).routing_operation_id;
    ids.order = (
      await prisma.work_order.create({
        data: {
          work_order_no: PREFIX,
          routing_operation_id: ids.operation,
          item_id: ids.item,
          order_qty: 100,
          uom_id: ids.uom,
          production_line_id: ids.line,
          planned_equipment_id: ids.equipment,
          status_code: 'IN_PROGRESS',
        },
      })
    ).work_order_id;

    // 입하 LOT 2 — LOT-1 은 보류가 둘(먼저 걸린 것이 한 줄), LOT-2 는 하나. 해제된 보류는 세지 않는다.
    for (const n of [1, 2, 3]) {
      ids[`lot${n}`] = (
        await prisma.lot.create({
          data: {
            lot_no: `${PREFIX}-LOT-${n}`,
            item_id: ids.item,
            lot_type_code: 'MATERIAL',
            plant_id: ids.plant,
            initial_qty: 100,
            uom_id: ids.uom,
            source_type_code: 'INBOUND_RECEIPT_LINE',
            source_id: 0,
            status_code: 'INSPECTION_PENDING',
          },
        })
      ).lot_id;
    }
    ids.receipt = (
      await prisma.inbound_receipt.create({
        data: {
          inbound_receipt_no: `${PREFIX}-IR`,
          supplier_id: ids.supplier,
          plant_id: ids.plant,
          receipt_datetime: new Date('2026-09-09T02:00:00Z'),
          status_code: 'RECEIVED',
        },
      })
    ).inbound_receipt_id;
    await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: ids.receipt,
        line_no: 1,
        item_id: ids.item,
        received_qty: 100,
        uom_id: ids.uom,
        status_code: 'RECEIVED',
        lot_id: ids.lot1,
        inspection_required: true,
        supplier_lot_label_attached: true,
      },
    });
    const hold = (lot: bigint, heldAt: string, released = false) =>
      prisma.lot_hold.create({
        data: {
          lot_id: lot,
          reason_code: 'INCOMING_INSPECTION_WAIT',
          status_code: released ? 'RELEASED' : 'HELD',
          held_at: new Date(heldAt),
          held_by: ids.user,
          ...(released
            ? { released_at: new Date('2026-09-12T03:00:00Z'), released_by: ids.user, release_reason_code: 'RETEST_PASS' }
            : {}),
        },
      });
    await hold(ids.lot1, '2026-09-09T03:00:00Z');
    await hold(ids.lot1, '2026-09-12T03:00:00Z');
    await hold(ids.lot2, '2026-09-11T03:00:00Z');
    await hold(ids.lot3, '2026-09-11T03:00:00Z', true);

    // 검사 보류: IQC 09-10 · PQC 09-15(누계 구간 안) · PQC 08-20(전월 — 하루 조회엔 없고 기간 조회엔 있다).
    const inspection = async (key: string, type: 'IQC' | 'PQC', inspectedAt: string, status = 'COMPLETED', held = true) => {
      const qty = type === 'IQC' ? 100 : 20;
      const req = await prisma.inspection_request.create({
        data: {
          inspection_request_no: `${PREFIX}-${key}`,
          inspection_type_code: type,
          target_type_code: type === 'IQC' ? 'LOT' : 'WORK_ORDER',
          target_id: type === 'IQC' ? ids.lot1 : ids.order,
          ...(type === 'IQC' ? { lot_id: ids.lot1 } : { work_order_id: ids.order }),
          item_id: ids.item,
          target_qty: qty,
          uom_id: ids.uom,
          status_code: status,
          requested_at: new Date(inspectedAt),
        },
      });
      if (!held) return;
      await prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-${key}`,
          inspection_request_id: req.inspection_request_id,
          inspection_round: 1,
          inspected_qty: qty,
          accepted_qty: 0,
          rejected_qty: 0,
          held_qty: qty,
          uom_id: ids.uom,
          overall_judgment_code: 'HELD',
          inspector_id: ids.worker,
          inspected_at: new Date(inspectedAt),
          status_code: 'CONFIRMED',
          idempotency_key: `${PREFIX}-${key}`,
        },
      });
    };
    await inspection('IQC-HELD', 'IQC', '2026-09-10T03:00:00Z');
    await inspection('PQC-HELD', 'PQC', '2026-09-15T03:00:00Z');
    await inspection('PQC-OLD', 'PQC', '2026-08-20T03:00:00Z');
    // 검사 대기: 요청 · 진행 — 끝난 의뢰는 세지 않는다.
    await inspection('WAIT-1', 'PQC', '2026-09-05T03:00:00Z', 'REQUESTED', false);
    await inspection('WAIT-2', 'PQC', '2026-09-06T03:00:00Z', 'IN_PROGRESS', false);
    await inspection('DONE', 'PQC', '2026-09-04T03:00:00Z', 'COMPLETED', false);

    // 미종결 부적합 2(W/O 쪽 · LOT 쪽), 종결 1.
    const nc = async (n: number, openedAt: string, closed: boolean, withOrder: boolean) => {
      const row = await prisma.nonconformance.create({
        data: {
          nonconformance_no: `${PREFIX}-NC-${n}`,
          item_id: ids.item,
          ...(withOrder ? { work_order_id: ids.order } : {}),
          severity_code: 'MAJOR',
          description: PREFIX,
          status_code: 'DECIDED',
          opened_at: new Date(openedAt),
          ...(closed ? { closed_at: new Date('2026-09-18T03:00:00Z') } : {}),
        },
      });
      await prisma.nonconformance_lot.create({
        data: {
          nonconformance_id: row.nonconformance_id,
          lot_id: ids.lot1,
          affected_qty: 15,
          uom_id: ids.uom,
          quality_status_before_code: 'NORMAL',
          quality_status_after_code: 'DEFECTIVE',
        },
      });
    };
    await nc(1, '2026-09-02T03:00:00Z', false, false);
    await nc(2, '2026-09-03T03:00:00Z', false, true);
    await nc(3, '2026-09-01T03:00:00Z', true, true);
  }

  async function cleanup(): Promise<void> {
    const ncs = await prisma.nonconformance.findMany({ where: { nonconformance_no: { startsWith: PREFIX } } });
    await prisma.nonconformance_lot.deleteMany({ where: { nonconformance_id: { in: ncs.map((row) => row.nonconformance_id) } } });
    await prisma.nonconformance.deleteMany({ where: { nonconformance_no: { startsWith: PREFIX } } });
    await prisma.inspection_result.deleteMany({ where: { inspection_result_no: { startsWith: PREFIX } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.lot_hold.deleteMany({ where: { lot: { lot_no: { startsWith: PREFIX } } } });
    await prisma.inbound_receipt_line.deleteMany({ where: { inbound_receipt: { inbound_receipt_no: { startsWith: PREFIX } } } });
    await prisma.inbound_receipt.deleteMany({ where: { inbound_receipt_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: PREFIX } });
    await prisma.routing_operation.deleteMany({ where: { operation_name: PREFIX } });
    await prisma.routing.deleteMany({ where: { routing_code: PREFIX } });
    await prisma.process.deleteMany({ where: { process_code: PREFIX } });
    await prisma.item.deleteMany({ where: { item_code: PREFIX } });
    await prisma.partner.deleteMany({ where: { partner_code: PREFIX } });
    await prisma.worker.deleteMany({ where: { worker_no: PREFIX } });
    await prisma.equipment.deleteMany({ where: { equipment_code: PREFIX } });
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
