import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-AA118-PQCOQC';
const SUMMARY = '/api/app/dashboard-summary';
// 누계 구간(하루 조회) = 09-01 ~ 09-20 · 일별 = 09-12 ~ 09-20
const BASE_DATE = '2026-09-20';

type Quality = {
  pqc: Record<string, unknown>;
  oqc: Record<string, unknown>;
};

/**
 * 품질 섹션의 PQC·OQC 추가 칸(omf-all-around#118 · 장부 P-59). 기존 대시보드 e2e 의 픽스처·기대값과 섞지 않으려고
 * 공장을 따로 세운다(사용자 제약 2026-10-19 — 기존 값에 영향 없음).
 */
describe('통합 대시보드 품질 PQC·OQC 추가 칸 (omf-all-around#118 · P-59)', () => {
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

  const quality = async (query: Record<string, string>) =>
    (
      (await request(app.getHttpServer()).get(SUMMARY).query(query).set('Cookie', cookie).expect(200)).body as {
        quality: Quality;
      }
    ).quality;

  it('PQC — 재검사 회차 합 · 품목별 불합격(최종 회차) · 가장 오래된 검사 대기', async () => {
    const { pqc } = await quality({ plantId: ids.plant.toString(), baseDate: BASE_DATE });

    // 재검사 2회차(09-06) 만 — 1회차는 재검사가 아니다.
    expect(pqc.fullReinspect).toEqual({ inputQty: 10, restoredQty: 6 });
    // 최종 회차(2회차) 불합격 4.
    expect(pqc.itemDefects).toEqual([{ itemId: Number(ids.item), itemCode: PREFIX, itemName: PREFIX, qty: 4 }]);
    // 요청 09-07 · 진행 09-08 → 가장 오래된 것. 끝난 의뢰(09-01)는 대기가 아니다.
    expect(pqc.oldestPendingSince).toBe('2026-09-07T03:00:00.000Z');
    // 재작업 요청 — 건수는 기존 reworkRequestCount 와 같고, LOT 은 대상 LOT 이 있는 부적합의 고유 LOT(LOT-2).
    expect(pqc.reworkRequestCounts).toEqual({ lotCount: 1, recordCount: 3 });
    expect((pqc.reworkRequestCounts as { recordCount: number }).recordCount).toBe(pqc.reworkRequestCount);
  });

  it('OQC — 반품 사유별 · 공급사 반품 출고 일별 · 처분 대기 반품 LOT · 고객별 불합격', async () => {
    const { oqc } = await quality({ plantId: ids.plant.toString(), baseDate: BASE_DATE });

    // 반품 입고 사유(CLAIM 5 · REWORK_RETURN 2, 08-25 반품은 전월) + 공급사 반품 출고(09-10 7 + 09-12 3, 취소분 제외).
    expect(oqc.returnReasons).toEqual([
      { reasonCode: 'SUPPLIER_RETURN_OUT', reasonName: '공급사반품', qty: 10 },
      { reasonCode: 'CLAIM', reasonName: '클레임', qty: 5 },
      { reasonCode: 'REWORK_RETURN', reasonName: '재작업후재입고', qty: 2 },
    ]);
    // 일별은 dailyPassRates 와 같은 9일 — 출고 기록 없는 날은 null.
    const daily = oqc.dailyReturnOutQty as { date: string; qty: number | null }[];
    expect(daily.map((row) => row.date)).toEqual(
      (oqc.dailyPassRates as { date: string }[]).map((row) => row.date),
    );
    expect(daily[0]).toEqual({ date: '2026-09-12', qty: 3 });
    expect(daily.slice(1).every((row) => row.qty === null)).toBe(true);
    // 불량창고 잔액이 남고 처분 판정이 없는 반품 LOT: LOT-1(반품 라인 2: 09-05 · 08-25). LOT-2 는 판정 있음, LOT-3 은 잔액 0.
    expect(oqc.pendingReturnLotCount).toEqual({ lotCount: 1, recordCount: 2 });
    expect(oqc.customerDefects).toEqual([
      { customerId: Number(ids.customer), customerName: `${PREFIX}-CUSTOMER`, rejectedQty: 3 },
    ]);
  });

  it('데이터 없는 공장 — 0 · 빈 배열 · null', async () => {
    const { pqc, oqc } = await quality({ plantId: '8999999999', baseDate: BASE_DATE });

    expect(pqc).toMatchObject({
      fullReinspect: { inputQty: 0, restoredQty: 0 },
      itemDefects: [],
      oldestPendingSince: null,
      reworkRequestCounts: { lotCount: 0, recordCount: 0 },
    });
    expect(oqc).toMatchObject({ returnReasons: [], pendingReturnLotCount: { lotCount: 0, recordCount: 0 }, customerDefects: [] });
    expect((oqc.dailyReturnOutQty as unknown[]).length).toBe(9);
  });

  async function fixtures(): Promise<void> {
    ids.user = (await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } }))
      .app_user_id;
    ids.role = (await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } })).role_id;
    await prisma.role_permission.create({ data: { role_id: ids.role, permission_code: 'W-CO-05' } });
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
    ids.worker = (
      await prisma.worker.create({
        data: { worker_no: PREFIX, worker_name: PREFIX, business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
      })
    ).worker_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    ids.item = (
      await prisma.item.create({
        data: { item_code: PREFIX, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: ids.uom, lot_controlled: true },
      })
    ).item_id;
    ids.customer = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-C`, partner_name: `${PREFIX}-CUSTOMER` } }))
      .partner_id;
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
          status_code: 'IN_PROGRESS',
        },
      })
    ).work_order_id;

    await pqcFixtures();
    await oqcFixtures();
    await returnFixtures();
  }

  async function request_(
    key: string,
    type: 'PQC' | 'OQC',
    status: string,
    requestedAt: string,
  ): Promise<bigint> {
    const target =
      type === 'PQC'
        ? { target_type_code: 'WORK_ORDER', target_id: ids.order, work_order_id: ids.order }
        : { target_type_code: 'SHIPMENT_REQUEST', target_id: ids.shipmentRequest };
    return (
      await prisma.inspection_request.create({
        data: {
          inspection_request_no: `${PREFIX}-${key}`,
          inspection_type_code: type,
          ...target,
          item_id: ids.item,
          target_qty: 10,
          uom_id: ids.uom,
          status_code: status,
          requested_at: new Date(requestedAt),
        },
      })
    ).inspection_request_id;
  }

  async function result(
    key: string,
    requestId: bigint,
    round: number,
    inspectedAt: string,
    accepted: number,
    rejected: number,
    previous: bigint | null,
  ): Promise<bigint> {
    return (
      await prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-${key}-${round}`,
          inspection_request_id: requestId,
          inspection_round: round,
          inspected_qty: accepted + rejected,
          accepted_qty: accepted,
          rejected_qty: rejected,
          held_qty: 0,
          uom_id: ids.uom,
          overall_judgment_code: rejected > 0 ? 'REJECTED' : 'ACCEPTED',
          inspector_id: ids.worker,
          inspected_at: new Date(inspectedAt),
          status_code: 'CONFIRMED',
          previous_result_id: previous,
          idempotency_key: `${PREFIX}-${key}-${round}`,
        },
      })
    ).inspection_result_id;
  }

  /** PQC: 1회차 불합격 10 → 재검사 2회차 합격 6·불합격 4. 대기 의뢰 둘(요청 09-07 · 진행 09-08)과 끝난 의뢰 하나. */
  async function pqcFixtures(): Promise<void> {
    const pqc = await request_('PQC', 'PQC', 'COMPLETED', '2026-09-05T02:00:00Z');
    const first = await result('PQC', pqc, 1, '2026-09-05T03:00:00Z', 0, 10, null);
    await result('PQC', pqc, 2, '2026-09-06T03:00:00Z', 6, 4, first);
    await request_('WAIT-1', 'PQC', 'REQUESTED', '2026-09-07T03:00:00Z');
    await request_('WAIT-2', 'PQC', 'IN_PROGRESS', '2026-09-08T03:00:00Z');
    await request_('DONE', 'PQC', 'COMPLETED', '2026-09-01T03:00:00Z');
  }

  /** OQC: 공장이 정해진 출하요청에 불합격 3. */
  async function oqcFixtures(): Promise<void> {
    ids.shipmentRequest = (
      await prisma.shipment_request.create({
        data: {
          shipment_request_no: `${PREFIX}-SR`,
          customer_id: ids.customer,
          ship_to_partner_id: ids.customer,
          requested_ship_date: new Date('2026-09-10'),
          status_code: 'REGISTERED',
          fulfillment_plant_id: ids.plant,
        },
      })
    ).shipment_request_id;
    const oqc = await request_('OQC', 'OQC', 'COMPLETED', '2026-09-09T02:00:00Z');
    await result('OQC', oqc, 1, '2026-09-09T03:00:00Z', 7, 3, null);
  }

  /**
   * 반품: 불량창고에 반품 입고 — LOT-1(CLAIM 5, 09-05 · 전월 08-25 CLAIM 1) · LOT-2(REWORK_RETURN 2, 처분 판정 있음) ·
   * LOT-3(취소된 반품 입고 · 잔액 0). 공급사 반품 출고 09-10 7 · 09-12 3 · 취소 09-13 9.
   */
  async function returnFixtures(): Promise<void> {
    const firstCode = async (groupCode: string) =>
      (await prisma.code_value.findFirstOrThrow({ where: { is_active: true, code_group: { group_code: groupCode } } })).code;
    ids.warehouse = (
      await prisma.warehouse.create({
        data: {
          plant_id: ids.plant,
          business_unit_id: ids.unit,
          warehouse_code: `${PREFIX}-DEF`,
          warehouse_name: PREFIX,
          warehouse_type_code: await firstCode('WAREHOUSE_TYPE'),
          management_level_code: await firstCode('MANAGEMENT_LEVEL'),
          is_defect: true,
        },
      })
    ).warehouse_id;
    ids.location = (
      await prisma.location.create({
        data: { warehouse_id: ids.warehouse, location_code: PREFIX, location_name: PREFIX, location_type_code: 'STORAGE' },
      })
    ).location_id;
    for (const n of [1, 2, 3]) {
      ids[`lot${n}`] = (
        await prisma.lot.create({
          data: {
            lot_no: `${PREFIX}-LOT-${n}`,
            item_id: ids.item,
            lot_type_code: 'PRODUCT',
            plant_id: ids.plant,
            initial_qty: 10,
            uom_id: ids.uom,
            source_type_code: 'PRODUCTION_RESULT',
            source_id: 0,
            status_code: 'DEFECTIVE',
          },
        })
      ).lot_id;
    }
    const receipt = async (key: string, lot: bigint, reason: string, qty: number, at: string, status = 'POSTED') => {
      const created = await prisma.goods_receipt.create({
        data: {
          goods_receipt_no: `${PREFIX}-GR-${key}`,
          receipt_type_code: 'RETURN',
          plant_id: ids.plant,
          warehouse_id: ids.warehouse,
          receipt_datetime: new Date(at),
          status_code: status,
          reason_code: reason,
        },
      });
      await prisma.goods_receipt_line.create({
        data: {
          goods_receipt_id: created.goods_receipt_id,
          line_no: 1,
          item_id: ids.item,
          lot_id: lot,
          receipt_qty: qty,
          uom_id: ids.uom,
          quality_status_code: 'DEFECTIVE',
          inventory_status_code: 'AVAILABLE',
          destination_location_id: ids.location,
        },
      });
      return created.goods_receipt_id;
    };
    ids.receipt = await receipt('1', ids.lot1, 'CLAIM', 5, '2026-09-05T03:00:00Z');
    await receipt('1-OLD', ids.lot1, 'CLAIM', 1, '2026-08-25T03:00:00Z');
    await receipt('2', ids.lot2, 'REWORK_RETURN', 2, '2026-09-06T03:00:00Z');
    await receipt('3', ids.lot3, 'CLAIM', 4, '2026-09-07T03:00:00Z', 'CANCELLED');
    const balance = (lot: bigint, qty: number) =>
      prisma.inventory_balance.create({
        data: {
          legal_entity_id: ids.legal,
          business_unit_id: ids.unit,
          plant_id: ids.plant,
          warehouse_id: ids.warehouse,
          location_id: ids.location,
          item_id: ids.item,
          lot_id: lot,
          quality_status_code: 'DEFECTIVE',
          inventory_status_code: 'AVAILABLE',
          ownership_type_code: 'OWNED',
          on_hand_qty: qty,
          uom_id: ids.uom,
        },
      });
    await balance(ids.lot1, 6);
    await balance(ids.lot2, 2);
    const nc = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC`,
        item_id: ids.item,
        severity_code: 'MAJOR',
        description: PREFIX,
        status_code: 'DECIDED',
        opened_at: new Date('2026-09-06T04:00:00Z'),
      },
    });
    await prisma.nonconformance_lot.create({
      data: {
        nonconformance_id: nc.nonconformance_id,
        lot_id: ids.lot2,
        affected_qty: 2,
        uom_id: ids.uom,
        quality_status_before_code: 'DEFECTIVE',
        quality_status_after_code: 'DEFECTIVE',
      },
    });
    await prisma.disposition_decision.create({
      data: {
        nonconformance_id: nc.nonconformance_id,
        disposition_type_code: 'SCRAP',
        decision_qty: 2,
        uom_id: ids.uom,
        reason: PREFIX,
        decided_by: ids.user,
        decided_at: new Date('2026-09-06T05:00:00Z'),
      },
    });
    // 재작업 판정: 반품 LOT-2 부적합에 2건(09-07 · 09-08) + 대상 LOT 없는 부적합에 1건(09-09) · 전월(08-30) 1건은 빠진다.
    const rework = (ncId: bigint, at: string) =>
      prisma.disposition_decision.create({
        data: {
          nonconformance_id: ncId,
          disposition_type_code: 'REWORK',
          decision_qty: 1,
          uom_id: ids.uom,
          reason: PREFIX,
          decided_by: ids.user,
          decided_at: new Date(at),
        },
      });
    await rework(nc.nonconformance_id, '2026-09-07T03:00:00Z');
    await rework(nc.nonconformance_id, '2026-09-08T03:00:00Z');
    await rework(nc.nonconformance_id, '2026-08-30T03:00:00Z');
    const lotless = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-NOLOT`,
        item_id: ids.item,
        work_order_id: ids.order,
        severity_code: 'MAJOR',
        description: PREFIX,
        status_code: 'DECIDED',
        opened_at: new Date('2026-09-09T02:00:00Z'),
      },
    });
    await rework(lotless.nonconformance_id, '2026-09-09T03:00:00Z');
    const issue = async (key: string, qty: number, at: string, status = 'POSTED') => {
      const created = await prisma.goods_issue.create({
        data: {
          goods_issue_no: `${PREFIX}-GI-${key}`,
          issue_type_code: 'SUPPLIER_RETURN',
          source_document_type_code: 'GOODS_RECEIPT',
          source_document_id: ids.receipt,
          source_warehouse_id: ids.warehouse,
          issued_at: new Date(at),
          status_code: status,
        },
      });
      await prisma.goods_issue_line.create({
        data: {
          goods_issue_id: created.goods_issue_id,
          line_no: 1,
          item_id: ids.item,
          lot_id: ids.lot1,
          issue_qty: qty,
          uom_id: ids.uom,
          source_location_id: ids.location,
        },
      });
    };
    await issue('1', 7, '2026-09-10T03:00:00Z');
    await issue('2', 3, '2026-09-12T03:00:00Z');
    await issue('3', 9, '2026-09-13T03:00:00Z', 'CANCELLED');
  }

  async function cleanup(): Promise<void> {
    const issueScope = { goods_issue_no: { startsWith: PREFIX } };
    await prisma.goods_issue_line.deleteMany({ where: { goods_issue: issueScope } });
    await prisma.goods_issue.deleteMany({ where: issueScope });
    const ncs = await prisma.nonconformance.findMany({ where: { nonconformance_no: { startsWith: PREFIX } } });
    const ncIds = ncs.map((row) => row.nonconformance_id);
    await prisma.disposition_decision.deleteMany({ where: { nonconformance_id: { in: ncIds } } });
    await prisma.nonconformance_lot.deleteMany({ where: { nonconformance_id: { in: ncIds } } });
    await prisma.nonconformance.deleteMany({ where: { nonconformance_id: { in: ncIds } } });
    await prisma.inventory_balance.deleteMany({ where: { lot: { lot_no: { startsWith: PREFIX } } } });
    const receiptScope = { goods_receipt_no: { startsWith: PREFIX } };
    await prisma.goods_receipt_line.deleteMany({ where: { goods_receipt: receiptScope } });
    await prisma.goods_receipt.deleteMany({ where: receiptScope });
    await prisma.inspection_result.deleteMany({ where: { inspection_result_no: { startsWith: PREFIX } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.shipment_request.deleteMany({ where: { shipment_request_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { location_code: PREFIX } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: PREFIX } });
    await prisma.routing_operation.deleteMany({ where: { operation_name: PREFIX } });
    await prisma.routing.deleteMany({ where: { routing_code: PREFIX } });
    await prisma.process.deleteMany({ where: { process_code: PREFIX } });
    await prisma.item.deleteMany({ where: { item_code: PREFIX } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
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
