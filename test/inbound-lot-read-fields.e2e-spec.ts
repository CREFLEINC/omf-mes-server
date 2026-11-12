/**
 * 피처 005 S5b — 재고 현황·LOT 생산 이력·LOT 현황의 입하 LOT 칸·조건(omf-all-around#254 · T122 · FR-035 · D-29).
 * 입하 LOT 은 도우미(발행 → `:receive` → 마감 → IQC 합격)로 만들고 입고는 입고 API 로 한다. 투입은 쓰기 경로가 무거워 직접 넣는다
 * (선례 `material-lot-read-switch-followups.e2e-spec.ts`). 응답은 ajv 로 계약 대조.
 */
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
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  InboundLotFixture, IssuedMaterialLot, ReceivedInboundLot, idempotencyKey, issueAndReceive, passInboundLotIqc, sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'E5RF';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
/** 기간 최대 366일 밖 — 기간을 주면 어떤 기간으로도 오늘과 함께 집을 수 없는 지난 입고·투입. */
const PAST = '2025-03-10';
const WORKER_NO = `${PREFIX}-W1`;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object, 'logistics');
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object, 'quality');
const schemaOf = (contract: string, path: string): ValidateFunction => ajv.compile({
  $ref: `${contract}#/paths/${path.replace(/\//g, '~1')}/get/responses/200/content/application~1json/schema`,
});

function expectShape(validate: ValidateFunction, body: unknown): void {
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

type InboundCells = { lotId: number; lotNo: string; inboundLotId: number | null; inboundLotNo: string | null };

interface Received {
  inboundLot: ReceivedInboundLot;
  lots: IssuedMaterialLot[];
}

describe('피처 005 S5b — 재고·LOT 조회의 입하 LOT 칸·조건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let terminalSeq = 0;
  let seq = 0;
  /** 오늘 입고·투입한 입하 LOT(LOT 둘). */
  let today: Received;
  /** 지난 날짜로 입고·투입한 입하 LOT(LOT 하나). */
  let past: Received;
  let productLot: { lotId: bigint; lotNo: string };
  let migratedLot: { lotId: bigint; lotNo: string; inboundLotNo: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code));
    await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W2`, worker_name: '조회검사자', business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: ids.user, status_code: 'EMPLOYED' },
    });
    fx = {
      app, issuer: terminalAuth(await terminalToken('POP'), WORKER_NO), receiver: terminalAuth(await terminalToken('MOBILE'), WORKER_NO),
      businessDate: DAY, keys, inspector: sessionAuth(cookie), prisma,
    };

    today = await passedInboundLot(2);
    for (const lot of today.lots) await receiveGoods(lot, today.inboundLot, `${DAY}T07:00:00.000Z`);
    await consume(BigInt(today.lots[0].lotId), 3, `${DAY}T08:00:00.000Z`);

    past = await passedInboundLot(1);
    await receiveGoods(past.lots[0], past.inboundLot, `${PAST}T03:00:00.000Z`);
    await consume(BigInt(past.lots[0].lotId), 4, `${PAST}T04:00:00.000Z`);

    productLot = await makeProductLot();
    migratedLot = await makeMigratedLot();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('FR-035 재고 현황 groupBy=LOT — inboundLotId 하나만으로 범위 검사를 통과하고 그 입하 LOT 의 자재 관리 LOT 만, 행에 입하 LOT 칸', async () => {
    const response = await get(`/api/inventory/balances?groupBy=LOT&inboundLotId=${String(today.inboundLot.inboundLotId)}`).expect(200);
    expectShape(schemaOf('logistics', '/inventory/balances'), response.body);
    const rows = response.body.items as InboundCells[];
    expect(rows.map((row) => row.lotId).sort()).toEqual(today.lots.map((lot) => lot.lotId).sort());
    for (const row of rows) expect(row).toMatchObject({ inboundLotId: today.inboundLot.inboundLotId, inboundLotNo: today.inboundLot.inboundLotNo });
    expect(response.body.summary).toMatchObject({ lotCount: 2 });

    const byNo = await get(`/api/inventory/balances?groupBy=LOT&inboundLotNo=${today.inboundLot.inboundLotNo}`).expect(200);
    expect((byNo.body.items as InboundCells[]).map((row) => row.lotId).sort()).toEqual(rows.map((row) => row.lotId).sort());
  });

  it('FR-035 재고 현황 — 생산 LOT 행은 입하 LOT 칸이 null, LOT 으로 묶지 않으면 칸이 없다, 없는 번호는 빈 목록, 범위 조건이 없으면 지금처럼 400', async () => {
    const response = await get(`/api/inventory/balances?groupBy=LOT&warehouseId=${String(ids.warehouse)}`).expect(200);
    expectShape(schemaOf('logistics', '/inventory/balances'), response.body);
    const rows = response.body.items as InboundCells[];
    expect(rows.find((row) => row.lotId === Number(productLot.lotId))).toMatchObject({ inboundLotId: null, inboundLotNo: null });
    expect(rows.find((row) => row.lotId === past.lots[0].lotId)).toMatchObject({ inboundLotNo: past.inboundLot.inboundLotNo });

    const byItem = await get(`/api/inventory/balances?groupBy=ITEM&warehouseId=${String(ids.warehouse)}`).expect(200);
    for (const row of byItem.body.items as object[]) {
      expect(row).not.toHaveProperty('inboundLotId');
      expect(row).not.toHaveProperty('inboundLotNo');
    }
    const none = await get(`/api/inventory/balances?groupBy=LOT&inboundLotNo=${PREFIX}-NONE`).expect(200);
    expect(none.body.items).toEqual([]);
    await get('/api/inventory/balances?groupBy=LOT').expect(400);
  });

  it('FR-035 자재 입고 줄 — 행에 입하 LOT 칸, inboundLotId·inboundLotNo 는 기간 없이 지난 입하 LOT 의 입고 줄을 집는다(입하번호와 함께 써도 됨)', async () => {
    const path = '/api/logistics/goods-receipt-lines?receiptTypeCode=MATERIAL';
    const byId = await get(`${path}&inboundLotId=${String(past.inboundLot.inboundLotId)}`).expect(200);
    expectShape(schemaOf('logistics', '/logistics/goods-receipt-lines'), byId.body);
    const rows = byId.body.items as (InboundCells & { receiptDatetime: string })[];
    expect(rows).toEqual([expect.objectContaining({
      lotId: past.lots[0].lotId, inboundLotId: past.inboundLot.inboundLotId, inboundLotNo: past.inboundLot.inboundLotNo,
      receiptDatetime: `${PAST}T03:00:00.000Z`,
    })]);

    const combined = await get(`${path}&inboundLotNo=${past.inboundLot.inboundLotNo}&inboundReceiptNo=${past.inboundLot.inboundReceiptNo}`).expect(200);
    expect((combined.body.items as InboundCells[]).map((row) => row.lotId)).toEqual([past.lots[0].lotId]);
    const todayRows = await get(`${path}&inboundLotNo=${today.inboundLot.inboundLotNo}`).expect(200);
    expect((todayRows.body.items as InboundCells[]).map((row) => row.lotId).sort()).toEqual(today.lots.map((lot) => lot.lotId).sort());

    // 기간을 주면 기간이 걸린다 — 오늘부터면 지난 입고는 빠진다.
    const bounded = await get(`${path}&receiptDateFrom=${DAY}&inboundLotId=${String(past.inboundLot.inboundLotId)}`).expect(200);
    expect(bounded.body.items).toEqual([]);
    const none = await get(`${path}&inboundLotNo=${PREFIX}-NONE`).expect(200);
    expect(none.body.items).toEqual([]);
  });

  it('FR-035 자재 입고 줄 — 조건도 기간도 없으면 400(기간 생략 조건에 입하 LOT 번호·입하 LOT 이 든 안내), 생산입고 행의 입하 LOT 칸은 null', async () => {
    const rejected = await get('/api/logistics/goods-receipt-lines?receiptTypeCode=MATERIAL').expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'receiptDateFrom', code: 'REQUIRED' });
    expect(rejected.body.errors[0].message).toContain(
      'LOT 번호(lotNo), 입하 번호(inboundReceiptNo), W/O 번호(workOrderNo), 입하 LOT 번호(inboundLotNo), 입하 LOT(inboundLotId)',
    );

    const product = await get(`/api/logistics/goods-receipt-lines?receiptTypeCode=PRODUCT&lotNo=${productLot.lotNo}`).expect(200);
    expectShape(schemaOf('logistics', '/logistics/goods-receipt-lines'), product.body);
    expect(product.body.items).toEqual([expect.objectContaining({ lotId: Number(productLot.lotId), inboundLotId: null, inboundLotNo: null })]);
  });

  it('FR-035 투입 줄 — 행에 입하 LOT 칸, inboundLotId·inboundLotNo 는 기간 없이 지난 투입을 집는다, 조건 없이 기간도 없으면 400', async () => {
    const path = '/api/trace/material-input-lines';
    const byNo = await get(`${path}?inboundLotNo=${past.inboundLot.inboundLotNo}`).expect(200);
    expectShape(schemaOf('logistics', '/trace/material-input-lines'), byNo.body);
    expect(byNo.body.items).toEqual([expect.objectContaining({
      lotId: past.lots[0].lotId, inputQty: 4, inboundLotId: past.inboundLot.inboundLotId, inboundLotNo: past.inboundLot.inboundLotNo,
    })]);

    const byId = await get(`${path}?inboundLotId=${String(today.inboundLot.inboundLotId)}&lotNo=${today.lots[0].lotNo}`).expect(200);
    expect(byId.body.items).toEqual([expect.objectContaining({ lotId: today.lots[0].lotId, inputQty: 3, inboundLotNo: today.inboundLot.inboundLotNo })]);
    const bounded = await get(`${path}?inputDateFrom=${DAY}&inboundLotNo=${past.inboundLot.inboundLotNo}`).expect(200);
    expect(bounded.body.items).toEqual([]);
    expect((await get(`${path}?inboundLotId=999999999999`).expect(200)).body.items).toEqual([]);

    const rejected = await get(path).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'inputDateFrom', code: 'REQUIRED' });
  });

  it('FR-035 LOT 현황 — 행에 입하 LOT 칸·두 조건, 요약의 수 = 목록 수', async () => {
    const list = await get(`/api/quality/lot-statuses?inboundLotId=${String(today.inboundLot.inboundLotId)}`).expect(200);
    expectShape(schemaOf('quality', '/quality/lot-statuses'), list.body);
    const rows = list.body.items as InboundCells[];
    expect(rows.map((row) => row.lotId).sort()).toEqual(today.lots.map((lot) => lot.lotId).sort());
    for (const row of rows) expect(row).toMatchObject({ inboundLotId: today.inboundLot.inboundLotId, inboundLotNo: today.inboundLot.inboundLotNo });
    expect(list.body.page.total).toBe(2);

    const summary = await get(`/api/quality/lot-status-summary?inboundLotId=${String(today.inboundLot.inboundLotId)}`).expect(200);
    expectShape(schemaOf('quality', '/quality/lot-status-summary'), summary.body);
    expect(lotCountOf(summary.body)).toBe(2);
    const summaryByNo = await get(`/api/quality/lot-status-summary?inboundLotNo=${today.inboundLot.inboundLotNo}`).expect(200);
    expect(lotCountOf(summaryByNo.body)).toBe(2);
    const byNo = await get(`/api/quality/lot-statuses?inboundLotNo=${today.inboundLot.inboundLotNo}`).expect(200);
    expect((byNo.body.items as InboundCells[]).map((row) => row.lotId).sort()).toEqual(rows.map((row) => row.lotId).sort());
  });

  it('FR-035 LOT 현황 — 이전 데이터 LOT 는 IL-MIG-…, 생산 LOT 는 null, 없는 번호는 빈 목록·요약 0', async () => {
    const migrated = await get(`/api/quality/lot-statuses?inboundLotNo=${migratedLot.inboundLotNo}`).expect(200);
    expect(migrated.body.items).toEqual([expect.objectContaining({ lotId: Number(migratedLot.lotId), inboundLotNo: migratedLot.inboundLotNo })]);
    expect(migratedLot.inboundLotNo).toMatch(/^IL-MIG-/);

    const product = await get(`/api/quality/lot-statuses?q=${productLot.lotNo}`).expect(200);
    expectShape(schemaOf('quality', '/quality/lot-statuses'), product.body);
    expect(product.body.items).toEqual([expect.objectContaining({ lotId: Number(productLot.lotId), inboundLotId: null, inboundLotNo: null })]);

    expect((await get(`/api/quality/lot-statuses?inboundLotNo=${PREFIX}-NONE`).expect(200)).body).toMatchObject({ items: [], page: { total: 0 } });
    expect(lotCountOf((await get(`/api/quality/lot-status-summary?inboundLotNo=${PREFIX}-NONE`).expect(200)).body)).toBe(0);
  });

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', cookie);
  }

  function lotCountOf(summary: { counts: { lotCount: number }[] }): number {
    return summary.counts.reduce((sum, count) => sum + count.lotCount, 0);
  }

  async function passedInboundLot(lotCount: number): Promise<Received> {
    const { inboundLot, lots } = await issueAndReceive(fx, {
      plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(ids.item), lotQty: 10, lotCount,
    });
    await passInboundLotIqc(fx, inboundLot.inboundLotId);
    return { inboundLot, lots };
  }

  async function receiveGoods(lot: IssuedMaterialLot, inboundLot: ReceivedInboundLot, at: string): Promise<void> {
    const line = await prisma.inbound_lot.findUniqueOrThrow({
      where: { inbound_lot_id: BigInt(inboundLot.inboundLotId) }, select: { inbound_receipt_line_id: true },
    });
    await postReceipt('MATERIAL', at, { inboundReceiptLineId: Number(line.inbound_receipt_line_id), itemId: Number(ids.item), lotId: lot.lotId, receiptQty: lot.lotQty });
  }

  async function postReceipt(receiptTypeCode: string, at: string, line: Record<string, unknown>): Promise<void> {
    await request(app.getHttpServer()).post('/api/logistics/goods-receipts').set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx))
      .send({
        receiptTypeCode, plantId: Number(ids.plant), warehouseId: Number(ids.warehouse), receiptDatetime: at, businessDate: DAY,
        lines: [{ uomId: Number(ids.ea), qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(ids.location), ...line }],
      })
      .expect(201);
  }

  async function consume(lotId: bigint, qty: number, at: string): Promise<void> {
    seq += 1;
    await prisma.material_consumption.create({
      data: {
        consumption_no: `${PREFIX}-MC-${String(seq)}`, work_order_id: ids.workOrder, item_id: ids.item, lot_id: lotId,
        consumption_type_code: 'NORMAL', input_qty: qty, uom_id: ids.ea, occurred_at: new Date(at),
        worker_id: ids.worker, status_code: 'RECORDED', idempotency_key: `${PREFIX}-MC-${String(seq)}`,
      },
    });
  }

  /** 생산 LOT — 입하 LOT 이 없다. 생산입고로 재고를 세운다. */
  async function makeProductLot(): Promise<{ lotId: bigint; lotNo: string }> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-FG1`, item_id: ids.product, lot_type_code: 'PRODUCTION', plant_id: ids.plant, initial_qty: 5, uom_id: ids.ea,
        source_type_code: 'WORK_ORDER', source_id: ids.workOrder, status_code: 'NORMAL',
      },
    });
    await postReceipt('PRODUCT', `${DAY}T09:00:00.000Z`, { itemId: Number(ids.product), lotId: Number(lot.lot_id), receiptQty: 5 });
    return { lotId: lot.lot_id, lotNo: lot.lot_no };
  }

  /** 이전 데이터 — 옛 입하 줄의 LOT 이 데이터 이전으로 `IL-MIG-<입하 줄 id>` 입하 LOT 에 속한다(데이터 이전 1). */
  async function makeMigratedLot(): Promise<{ lotId: bigint; lotNo: string; inboundLotNo: string }> {
    const header = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-MIG`, supplier_id: ids.supplier, plant_id: ids.plant, receipt_datetime: new Date(), status_code: 'REGISTERED' },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: { inbound_receipt_id: header.inbound_receipt_id, line_no: 1, item_id: ids.item, received_qty: 7, uom_id: ids.ea,
        supplier_lot_missing: false, supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED' },
    });
    const inbound = await prisma.inbound_lot.create({
      data: { inbound_lot_no: `IL-MIG-${String(line.inbound_receipt_line_id)}`, plant_id: ids.plant, item_id: ids.item, supplier_id: ids.supplier, uom_id: ids.ea,
        status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`), received_closed_at: new Date(),
        erp_send_mode_code: 'PER_RECEIPT', inbound_receipt_line_id: line.inbound_receipt_line_id },
    });
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-MIG1`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 7, uom_id: ids.ea,
        source_type_code: 'INBOUND_RECEIPT_LINE', source_id: line.inbound_receipt_line_id, status_code: 'NORMAL', inbound_lot_id: inbound.inbound_lot_id,
      },
    });
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id }, data: { lot_id: lot.lot_id } });
    return { lotId: lot.lot_id, lotNo: lot.lot_no, inboundLotNo: inbound.inbound_lot_no };
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    terminalSeq += 1;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T${String(terminalSeq)}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant),
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '입하조회법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '입하조회사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '입하조회공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '입하조회자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
    ids.product = (await prisma.item.create({
      data: { item_code: `${PREFIX}-FG`, item_name: '입하조회제품', item_type_code: 'FINISHED_GOOD', base_uom_id: ids.ea, lot_controlled: true, inspection_required: false },
    })).item_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-S`, partner_name: `${PREFIX} 공급사` } })).partner_id;
    ids.worker = (await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: '조회작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    })).worker_id;
    ids.warehouse = (await prisma.warehouse.create({
      data: { plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-WH`, warehouse_name: '입하조회창고',
        warehouse_type_code: 'MATERIAL', management_level_code: 'LOCATION' },
    })).warehouse_id;
    ids.location = (await prisma.location.create({
      data: { warehouse_id: ids.warehouse, location_code: `${PREFIX}-L1`, location_name: '입하조회위치' },
    })).location_id;
    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'PRODUCTION' } });
    const routing = await prisma.routing.create({ data: { item_id: ids.product, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    const operation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: PREFIX },
    });
    ids.workOrder = (await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`, routing_operation_id: operation.routing_operation_id, item_id: ids.product, order_qty: 100,
        uom_id: ids.ea, status_code: 'RELEASED',
      },
    })).work_order_id;
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `입하조회 ${suffix}`, status_code: 'EMPLOYED' } });
    ids.user ??= user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `입하조회 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const inboundLots = `SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants})`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (${items})`;
    const results = `SELECT inspection_result_id FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`;
    const goodsReceipts = `SELECT goods_receipt_id FROM logistics.goods_receipt WHERE plant_id IN (${plants})`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))
         OR (aggregate_type_code = 'GOODS_RECEIPT' AND aggregate_id IN (${goodsReceipts}))`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    await prisma.$executeRawUnsafe('TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM production.material_consumption WHERE consumption_no LIKE '${PREFIX}%'`,
      `DELETE FROM inventory.inventory_balance WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.putaway_task WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.lot_four_m_change WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.item_inspection_level_history WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM planning.routing_operation WHERE routing_id IN (SELECT routing_id FROM planning.routing WHERE routing_code LIKE '${PREFIX}%')`,
      `DELETE FROM planning.routing WHERE routing_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.process WHERE process_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM audit.audit_event WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      ...(keyList === '' ? [] : [`DELETE FROM app.idempotency_record WHERE idempotency_key IN (${keyList})`]),
      `DELETE FROM app.idempotency_record WHERE app_user_id IN (${users})`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (${roles})`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
