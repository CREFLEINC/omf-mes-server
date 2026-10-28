/**
 * 단말 작업 수(omf-all-around#190 · 장부 P-137) — 배지 수 = 그 화면 목록 건수(SC-003).
 *
 * 각 키를 «같은 단말 토큰으로 그 화면이 부르는 목록 API» 의 `page.total` 과 대조한다. 단말에 창고가 있으면
 * 적치·피킹·이동(도착)·출하 포장 목록과 수가 그 창고로 걸리고(FR-017), 없으면 공장 전체다(US3-8).
 * ⚠ 같은 DB 를 다른 스위트와 쓰므로 접두어(`ROOT`)로 짚는다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';

const ROOT = 'E2EHOWC';
const PREFIX = `${ROOT}${randomUUID().slice(0, 6).toUpperCase()}`;
const TODAY = localDate(new Date(), 'Asia/Ho_Chi_Minh');

describe('단말 작업 수 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const ids: Record<string, bigint> = {};
  const tokens: Record<string, string> = {};
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await fixtures();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US3-1 US3-5 SC-003 모바일 M1(창고 A) — 네 키가 같은 단말로 부른 각 목록의 건수와 같다', async () => {
    const counts = await countsOf('M1');
    expect(Object.keys(counts).sort()).toEqual(['materialPicking', 'putaway', 'shipmentPicking', 'stockTransferArrival']);
    expect(contractValidator()(counts)).toBe(true);

    expect(counts.putaway).toBe(await total('M1', '/api/logistics/putaway-tasks', { statusCode: 'PENDING', size: 100 }));
    expect(counts.materialPicking).toBe(await materialPickingListed('M1'));
    expect(counts.stockTransferArrival).toBe(await total('M1', '/api/logistics/stock-transfers', { inTransitOnly: 'true', size: 100 }));
    // 확정 항목 5 — 목록은 피킹 끝난 지시도 보이지만 배지는 남은 일(피킹 미완료)만 센다.
    const requests = await list('M1', '/api/logistics/shipment-requests', { shipDateFrom: TODAY, shipDateTo: TODAY, size: 100 });
    expect(counts.shipmentPicking).toBe(requests.items.filter((r: { pickingStatusCode?: string; pickingProgressCode?: string }) => isPickingOpen(r)).length);

    // 고정값 — 창고 A 의 것만 센다(창고 B 의 같은 일은 세지 않는다).
    expect(counts).toMatchObject({ putaway: 1, materialPicking: 1, stockTransferArrival: 1, shipmentPicking: 1 });
  });

  it('FR-017 창고가 지정된 단말의 목록도 같은 창고로 걸리고, 창고 없는 단말 목록은 공장 전체다', async () => {
    const m1 = await list('M1', '/api/logistics/picking-orders', { statusCode: 'REGISTERED', size: 100 });
    expect(m1.items.every((p: { warehouseId: number }) => p.warehouseId === Number(ids.whA))).toBe(true);
    const m3 = await list('M3', '/api/logistics/picking-orders', { statusCode: 'REGISTERED', size: 100 });
    expect([...new Set(m3.items.map((p: { warehouseId: number }) => p.warehouseId))].sort()).toEqual([Number(ids.whA), Number(ids.whB)].sort());
    const arrivals = await list('M1', '/api/logistics/stock-transfers', { inTransitOnly: 'true', size: 100 });
    expect(arrivals.items.every((t: { toWarehouseId: number }) => t.toWarehouseId === Number(ids.whA))).toBe(true);
  });

  it('US3-8 FR-016 창고 없는 단말 M3 는 공장 전체 수다', async () => {
    const counts = await countsOf('M3');
    expect(counts).toMatchObject({ putaway: 2, materialPicking: 2, stockTransferArrival: 2, shipmentPicking: 1 });
    expect(counts.putaway).toBe(await total('M3', '/api/logistics/putaway-tasks', { statusCode: 'PENDING', size: 100 }));
  });

  it('US3-6 SC-003 POP P1 — 다섯 키가 같은 단말로 부른 각 목록의 건수와 같다', async () => {
    const counts = await countsOf('P1');
    expect(Object.keys(counts).sort()).toEqual(['emergencyWorkOrder', 'oqcInspection', 'reworkResult', 'shipmentPacking', 'workStart']);
    expect(counts.shipmentPacking).toBe(
      await total('P1', '/api/logistics/shipments', { pickedOnly: 'true', shipDateFrom: TODAY, shipDateTo: TODAY, size: 100 }),
    );
    expect(counts.workStart).toBe(
      await total('P1', '/api/production/work-orders', { open: 'true', withProgress: 'true', plannedEquipmentId: Number(ids.equipment), includeUnplannedEquipment: 'true', size: 20 }),
    );
    expect(counts.emergencyWorkOrder).toBe(await total('P1', '/api/production/work-orders', { workOrderTypeCode: 'EMERGENCY', open: 'true', size: 20 }));
    expect(counts.reworkResult).toBe(await total('P1', '/api/production/work-orders', { workOrderTypeCode: 'REWORK', open: 'true', size: 20 }));
    expect(counts.oqcInspection).toBe(await total('P1', '/api/quality/inspection-requests', { inspectionTypeCode: 'OQC', pendingOnly: 'true', size: 50 }));
    // 작업 시작 목록은 유형을 거르지 않는다 — 설비 E1·설비 미정의 일반·긴급·재작업 넷(다른 설비 W/O 는 빠진다).
    expect(counts).toMatchObject({ workStart: 4, emergencyWorkOrder: 1, reworkResult: 1, oqcInspection: 1 });
  });

  it('FR-019 인계작업 알림 설정을 모두 켜도 꺼도 수는 같다', async () => {
    const before = await countsOf('M1');
    const setting = await prisma.handover_alert_setting.create({
      data: { plant_id: ids.plant, alert_type_code: 'PUTAWAY_REQUESTED', is_enabled: true },
    });
    const after = await countsOf('M1');
    await prisma.handover_alert_setting.delete({ where: { handover_alert_setting_id: setting.handover_alert_setting_id } });
    expect(after).toEqual(before);
  });

  it('단말 토큰이 아니면 401, 질의를 실으면 401', async () => {
    await request(app.getHttpServer()).get('/api/app/terminal-work-counts').expect(401);
    await request(app.getHttpServer()).get('/api/app/terminal-work-counts').set('Cookie', cookie).expect(401);
    await request(app.getHttpServer()).get('/api/app/terminal-work-counts').query({ plantId: 1 }).set('Authorization', `Bearer ${tokens.M1}`).expect(401);
  });

  async function countsOf(terminal: string): Promise<Record<string, number>> {
    const response = await request(app.getHttpServer())
      .get('/api/app/terminal-work-counts')
      .set('Authorization', `Bearer ${tokens[terminal]}`)
      .expect(200);
    return response.body;
  }

  async function list(terminal: string, path: string, query: object) {
    const response = await request(app.getHttpServer()).get(path).query(query).set('Authorization', `Bearer ${tokens[terminal]}`).expect(200);
    return response.body;
  }

  async function total(terminal: string, path: string, query: object): Promise<number> {
    return (await list(terminal, path, query)).page.total;
  }

  /** 모바일 자재 출고·피킹 화면은 출처가 자재 출고 요청인 지시만 남긴다(화면 후처리). */
  async function materialPickingListed(terminal: string): Promise<number> {
    const body = await list(terminal, '/api/logistics/picking-orders', { statusCode: 'REGISTERED', size: 100 });
    return body.items.filter((p: { sourceDocumentTypeCode: string }) => p.sourceDocumentTypeCode === 'MATERIAL_ISSUE_REQUEST').length;
  }

  function isPickingOpen(row: Record<string, unknown>): boolean {
    const lines = (row.lines ?? []) as { allocatedQty: number; pickedQty: number }[];
    return lines.length === 0 || lines.some((line) => line.pickedQty < line.allocatedQty);
  }

  function contractValidator() {
    const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8')) as object;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
    ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
    return ajv.compile({ $ref: 'https://omf-mes.invalid/contract#/components/schemas/TerminalWorkCounts' });
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    ids.businessUnit = unit.business_unit_id;
    ids.plant = (
      await prisma.plant.create({
        data: { plant_code: `${PREFIX}-P`, plant_name: `${PREFIX} 공장`, legal_entity_id: base.legal_entity_id, business_unit_id: unit.business_unit_id, timezone_code: 'Asia/Ho_Chi_Minh' },
      })
    ).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    const item = async (code: string, type: string) =>
      (await prisma.item.create({ data: { item_code: `${PREFIX}${code}`, item_name: `${PREFIX} ${code}`, item_type_code: type, base_uom_id: ids.uom } })).item_id;
    ids.itemA = await item('A', 'RAW_MATERIAL');
    ids.itemFg = await item('FG', 'FINISHED');
    ids.itemOqc = await item('OQC', 'FINISHED');
    const plan = await prisma.inspection_plan.create({
      data: { inspection_plan_code: `${PREFIX}-OQC`, inspection_plan_name: `${PREFIX} OQC`, item_id: ids.itemOqc, inspection_type_code: 'OQC', is_active: true },
    });
    await prisma.inspection_plan_version.create({
      data: { inspection_plan_id: plan.inspection_plan_id, plan_version: 1, effective_from: new Date('2020-01-01'), sampling_method_code: 'FULL_INSPECTION', inspection_frequency_code: 'PRODUCTION_LOT', status_code: 'CONFIRMED' },
    });

    for (const name of ['A', 'B']) {
      const wh = await prisma.warehouse.create({
        data: { plant_id: ids.plant, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-${name}`, warehouse_name: `${PREFIX} 창고${name}`, warehouse_type_code: 'MATERIAL', management_level_code: 'LOCATION' },
      });
      ids[`wh${name}`] = wh.warehouse_id;
      ids[`loc${name}`] = (
        await prisma.location.create({ data: { warehouse_id: wh.warehouse_id, location_code: `${PREFIX}-L${name}`, location_name: name, location_type_code: 'BIN' } })
      ).location_id;
    }

    // 사람·권한 — 자료는 웹 세션으로 만든다.
    const admin = (await prisma.app_user.create({ data: { login_id: `${PREFIX}_A`, user_name: `${PREFIX} A`, status_code: 'EMPLOYED' } })).app_user_id;
    userIds.push(admin);
    await prisma.user_data_scope.create({ data: { app_user_id: admin, business_unit_id: unit.business_unit_id, plant_id: ids.plant } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_R`, role_name: '작업 수 시험' } });
    roleIds.push(role.role_id);
    await prisma.role_permission.createMany({ data: ['M-04-04', 'W-04-01'].map((code) => ({ role_id: role.role_id, permission_code: code })) });
    await prisma.user_role.create({ data: { app_user_id: admin, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(admin), typ: 'session' })}`;

    // 적치 — 창고 A·B 에 입고 1건씩(적치 지시 PENDING 1건씩).
    for (const name of ['A', 'B']) await receive(ids[`wh${name}`], ids[`loc${name}`]);

    // 피킹 지시 — A·B 에 자재 출고 요청 출처 1건씩 + A 에 제품 출하 출처 1건(화면이 거르는 것).
    for (const [name, source] of [['A', 'MATERIAL_ISSUE_REQUEST'], ['B', 'MATERIAL_ISSUE_REQUEST'], ['A', 'SHIPMENT_REQUEST']] as const) {
      await prisma.picking_order.create({
        data: {
          picking_order_no: `${PREFIX}-PK-${name}-${source.slice(0, 3)}`,
          picking_type_code: source === 'SHIPMENT_REQUEST' ? 'PRODUCT' : 'MATERIAL',
          source_document_type_code: source,
          source_document_id: 1,
          warehouse_id: ids[`wh${name}`],
          status_code: 'REGISTERED',
        },
      });
    }

    // 재고 이동 — 반출됐고 도착 안 한 것: B→A, A→B 각 1건 + 도착 끝난 A→B 1건.
    for (const [from, to, arrived] of [['B', 'A', false], ['A', 'B', false], ['A', 'B', true]] as const) {
      await prisma.stock_transfer.create({
        data: {
          stock_transfer_no: `${PREFIX}-ST-${from}${to}${arrived ? 'X' : ''}`,
          transfer_type_code: 'NORMAL',
          from_business_unit_id: unit.business_unit_id,
          to_business_unit_id: unit.business_unit_id,
          from_warehouse_id: ids[`wh${from}`],
          to_warehouse_id: ids[`wh${to}`],
          requested_at: new Date(),
          shipped_at: new Date(),
          received_at: arrived ? new Date() : null,
          status_code: arrived ? 'RECEIVED' : 'REGISTERED',
        },
      });
    }

    // 제품 출하 피킹 — 오늘 출하일·이 공장 출하지시 1건(OQC 품목이라 OQC 의뢰도 1건 선다).
    ids.customer = (await prisma.partner.create({ data: { partner_code: `${PREFIX}C`, partner_name: `${PREFIX} 고객` } })).partner_id;
    await request(app.getHttpServer())
      .post('/api/logistics/shipment-requests')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        customerId: Number(ids.customer),
        shipToPartnerId: Number(ids.customer),
        requestedShipDate: TODAY,
        fulfillmentPlantId: Number(ids.plant),
        lines: [{ itemId: Number(ids.itemOqc), requestedQty: 5, allocatedQty: 5, uomId: Number(ids.uom), shippingInspectionRequired: true }],
      })
      .expect(201);

    // POP — 설비 E1·공정(작업 시작·실적 입력), W/O: 일반(E1) · 일반(설비 미정) · 긴급 · 재작업 · 다른 설비 일반(세지 않음).
    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MACHINING' } });
    const routing = await prisma.routing.create({ data: { item_id: ids.itemFg, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'CONFIRMED' } });
    const operation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
    });
    const line = await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: `${PREFIX}-LN`, line_name: `${PREFIX} 라인` } });
    const equipmentType = await prisma.equipment.findFirst({ select: { equipment_type_code: true } });
    for (const key of ['equipment', 'otherEquipment']) {
      ids[key] = (
        await prisma.equipment.create({
          data: {
            equipment_code: `${PREFIX}-${key}`,
            equipment_name: `${PREFIX} ${key}`,
            plant_id: ids.plant,
            equipment_type_code: equipmentType?.equipment_type_code ?? 'INJECTION',
            status_code: 'RUNNING',
          },
        })
      ).equipment_id;
    }
    const order = await prisma.production_order.create({
      data: { production_order_no: `${PREFIX}-PO`, business_unit_id: unit.business_unit_id, plant_id: ids.plant, item_id: ids.itemFg, order_qty: 100, uom_id: ids.uom, status_code: 'RECEIVED' },
    });
    const bom = await prisma.bom.create({
      data: { parent_item_id: ids.itemFg, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'CONFIRMED', effective_from: new Date('2026-01-01'), base_qty: 1, base_uom_id: ids.uom },
    });
    const productionPlan = await prisma.production_plan.create({
      data: { production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP`, plan_date: new Date(`${TODAY}T00:00:00.000Z`), planned_qty: 100, uom_id: ids.uom, bom_id: bom.bom_id, routing_id: routing.routing_id, status_code: 'CONFIRMED' },
    });
    let seq = 0;
    for (const [type, equipment] of [['NORMAL', ids.equipment], ['NORMAL', null], ['EMERGENCY', ids.equipment], ['REWORK', null], ['NORMAL', ids.otherEquipment]] as const) {
      await prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-WO${++seq}`,
          production_plan_id: productionPlan.production_plan_id,
          routing_operation_id: operation.routing_operation_id,
          item_id: ids.itemFg,
          order_qty: 10,
          uom_id: ids.uom,
          work_order_type_code: type,
          status_code: 'RELEASED',
          released_at: new Date(),
          production_line_id: line.production_line_id,
          planned_equipment_id: equipment,
        },
      });
    }

    const jwt = app.get(JwtService);
    for (const [key, type, warehouse, equipment] of [
      ['M1', 'MOBILE', ids.whA, null],
      ['M3', 'MOBILE', null, null],
      ['P1', 'POP', ids.whA, ids.equipment],
    ] as const) {
      const terminal = await prisma.terminal.create({
        data: { terminal_code: `${PREFIX}-${key}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING', warehouse_id: warehouse, equipment_id: equipment },
      });
      if (type === 'POP') {
        await prisma.terminal_process.create({
          data: { terminal_id: terminal.terminal_id, process_id: process.process_id, can_start_work: true, can_input_result: true },
        });
      }
      tokens[key] = jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant) });
    }
  }

  async function receive(warehouseId: bigint, locationId: bigint): Promise<void> {
    const lot = await prisma.lot.create({
      data: { lot_no: `${PREFIX}-LOT-${randomUUID().slice(0, 6)}`, item_id: ids.itemA, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 10, uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 1, status_code: 'NORMAL' },
    });
    await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        receiptTypeCode: 'MATERIAL',
        plantId: Number(ids.plant),
        warehouseId: Number(warehouseId),
        receiptDatetime: new Date().toISOString(),
        businessDate: TODAY,
        lines: [{ itemId: Number(ids.itemA), lotId: Number(lot.lot_id), receiptQty: 10, uomId: Number(ids.uom), qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(locationId) }],
      })
      .expect(201);
  }

  /** 전역 목록에 끼어드는 전표는 지운다(이전 실행 찌꺼기 포함). ⛔ 원장·LOT·마스터는 남긴다. */
  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${ROOT}%'`;
    const wh = `SELECT warehouse_id FROM mdm.warehouse WHERE plant_id IN (${plants})`;
    const requests = `SELECT shipment_request_id FROM logistics.shipment_request WHERE fulfillment_plant_id IN (${plants})`;
    for (const statement of [
      `DELETE FROM quality.inspection_request WHERE target_type_code = 'SHIPMENT_REQUEST' AND target_id IN (${requests})`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (${requests})`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_id IN (${requests})`,
      `DELETE FROM logistics.stock_transfer WHERE from_warehouse_id IN (${wh})`,
      `DELETE FROM logistics.picking_order WHERE warehouse_id IN (${wh})`,
      `DELETE FROM logistics.putaway_task WHERE goods_receipt_line_id IN (SELECT goods_receipt_line_id FROM logistics.goods_receipt_line l JOIN logistics.goods_receipt g USING (goods_receipt_id) WHERE g.warehouse_id IN (${wh}))`,
      `DELETE FROM logistics.goods_receipt_line WHERE goods_receipt_id IN (SELECT goods_receipt_id FROM logistics.goods_receipt WHERE warehouse_id IN (${wh}))`,
      `DELETE FROM logistics.goods_receipt WHERE warehouse_id IN (${wh})`,
      `DELETE FROM mdm.terminal_process WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE plant_id IN (${plants}))`,
      `DELETE FROM production.work_order WHERE production_line_id IN (SELECT production_line_id FROM mdm.production_line WHERE plant_id IN (${plants}))`,
      `DELETE FROM mdm.terminal WHERE plant_id IN (${plants})`,
    ]) {
      await prisma.$executeRawUnsafe(statement);
    }
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    // 시험 계정은 사용 중지한다 — 활성 계정 전부를 세는 화면(공지 확인 현황 등)에 끼어든다.
    await prisma.app_user.updateMany({ where: { app_user_id: { in: userIds } }, data: { is_active: false } });
  }
});
