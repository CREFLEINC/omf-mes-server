/**
 * 입하~출고 추적 화면의 입고·출고 현황(장부 P-119) — 입고 줄·출하 줄 목록.
 * 기간은 공장 현지 날짜다: 현지 자정 직후(UTC 로는 전날)의 입고가 그날에 들고, 현지 전날 밤 입고는 빠진다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'TFLE2E';
const DAY = '2026-08-10';
const SCREEN = 'W-01-14';
const USERS = { allowed: `${PREFIX}-allowed`, denied: `${PREFIX}-denied` };
const PASSWORD = 'TF-추적-비밀번호';

interface Totals {
  lineCount: number;
  qtyByUom: { uomId: number; uomCode: string; qty: number }[];
}
interface Paged<T> {
  items: T[];
  page: { page: number; size: number; total: number };
  totals: Totals;
}
interface ReceiptLine {
  goodsReceiptNo: string;
  receiptTypeCode: string;
  statusCode: string;
  item: { id: number; code: string };
  lotNo: string;
  receiptQty: number;
  supplier: { id: number; code: string; name: string } | null;
  workOrder: { workOrderId: number; workOrderNo: string } | null;
}
interface ShipmentLine {
  shipmentNo: string;
  statusCode: string;
  customer: { id: number; code: string };
  item: { id: number; code: string };
  shippedQty: number;
  lots: { lotId: number; lotNo: string; qty: number }[];
  lotCount: number;
}

function validator(file: string, path: string): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts', file), 'utf8')) as object;
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/get/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('입고 줄·출하 줄 현황 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cookies: Record<keyof typeof USERS, string[]> = { allowed: [], denied: [] };
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeReceipts();
    await makeShipments();
    cookies.allowed = await login(USERS.allowed, [SCREEN]);
    cookies.denied = await login(USERS.denied, ['W-01-07']);
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const get = (path: string, query: Record<string, string | number>, who: keyof typeof USERS = 'allowed') =>
    request(app.getHttpServer()).get(`/api/logistics/${path}`).query(query).set('Cookie', cookies[who]);

  describe('GET /logistics/goods-receipt-lines', () => {
    const window = { receiptDateFrom: DAY, receiptDateTo: DAY, q: PREFIX };

    it('현지 날짜로 고른다 — 현지 자정 직후(UTC 전날) 입고는 들고, 현지 전날 밤 입고·취소 입고는 빠진다', async () => {
      const response = await get('goods-receipt-lines', window).expect(200);
      const body = response.body as Paged<ReceiptLine>;

      expect(validator('logistics-01자재창고.json', '/logistics/goods-receipt-lines')(body)).toBe(true);
      expect(body.items.map((line) => line.goodsReceiptNo)).toEqual([`${PREFIX}-GR-PRD`, `${PREFIX}-GR-MAT`]);
      expect(body.page.total).toBe(2);
      expect(body.totals).toEqual({ lineCount: 2, qtyByUom: [{ uomId: Number(ids.uom), uomCode: expect.any(String), qty: 140 }] });
    });

    it('자재입고 줄은 입하의 공급사를, 생산입고 줄은 LOT 원천 W/O 를 싣는다', async () => {
      const body = (await get('goods-receipt-lines', window).expect(200)).body as Paged<ReceiptLine>;
      const [product, material] = body.items;

      expect(material).toMatchObject({
        receiptTypeCode: 'MATERIAL', lotNo: `${PREFIX}-LOT-MAT`, receiptQty: 100, workOrder: null,
        supplier: { id: Number(ids.supplier), code: `${PREFIX}-SUP` },
      });
      expect(product).toMatchObject({
        receiptTypeCode: 'PRODUCT', lotNo: `${PREFIX}-LOT-FG1`, receiptQty: 40, supplier: null,
        workOrder: { workOrderId: Number(ids.workOrder), workOrderNo: `${PREFIX}-WO` },
      });
    });

    it('유형·품목·공급사·상태로 거르고 합계도 그 조건으로 센다', async () => {
      const material = (await get('goods-receipt-lines', { ...window, receiptTypeCode: 'MATERIAL' }).expect(200)).body as Paged<ReceiptLine>;
      expect(material.items.map((line) => line.goodsReceiptNo)).toEqual([`${PREFIX}-GR-MAT`]);
      expect(material.totals.qtyByUom[0].qty).toBe(100);

      const product = (await get('goods-receipt-lines', { ...window, itemId: Number(ids.product) }).expect(200)).body as Paged<ReceiptLine>;
      expect(product.items.map((line) => line.goodsReceiptNo)).toEqual([`${PREFIX}-GR-PRD`]);

      const supplier = (await get('goods-receipt-lines', { ...window, supplierId: Number(ids.supplier) }).expect(200)).body as Paged<ReceiptLine>;
      expect(supplier.items.map((line) => line.goodsReceiptNo)).toEqual([`${PREFIX}-GR-MAT`]);

      const cancelled = (await get('goods-receipt-lines', { ...window, statusCode: 'CANCELLED' }).expect(200)).body as Paged<ReceiptLine>;
      expect(cancelled.items.map((line) => line.goodsReceiptNo)).toEqual([`${PREFIX}-GR-CXL`]);
    });

    it('기간 시작이 없거나 366일을 넘으면 400 이고 칸과 조치를 알린다', async () => {
      const missing = await get('goods-receipt-lines', { q: PREFIX }).expect(400);
      expect(missing.body.errors).toEqual([{
        scope: 'field', field: 'receiptDateFrom', code: 'REQUIRED',
        message: '입고일 시작(receiptDateFrom)이 비었습니다. 시작일을 넣어 다시 조회하세요 — 기간은 최대 366일입니다.',
      }]);
      const tooLong = await get('goods-receipt-lines', { receiptDateFrom: '2025-01-01', receiptDateTo: '2026-01-02' }).expect(400);
      expect(tooLong.body.errors[0]).toMatchObject({ field: 'receiptDateTo', code: 'RANGE' });
    });

    it('추적 화면 권한이 없으면 403 이다', async () => {
      await get('goods-receipt-lines', window, 'denied').expect(403);
    });
  });

  describe('GET /logistics/shipment-lines', () => {
    const window = { shipDateFrom: DAY, shipDateTo: DAY, q: PREFIX };

    it('현지 날짜의 출하 줄을 고객·LOT 과 함께 싣고 취소·기간 밖 출하는 뺀다', async () => {
      const body = (await get('shipment-lines', window).expect(200)).body as Paged<ShipmentLine>;

      expect(validator('shipment-04제품출하.json', '/logistics/shipment-lines')(body)).toBe(true);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        shipmentNo: `${PREFIX}-SH-OK`, statusCode: 'CONFIRMED', shippedQty: 30, lotCount: 2,
        customer: { id: Number(ids.customer), code: `${PREFIX}-CUS` },
        item: { id: Number(ids.product) },
        lots: [{ lotNo: `${PREFIX}-LOT-FG1`, qty: 20 }, { lotNo: `${PREFIX}-LOT-FG2`, qty: 10 }],
      });
      expect(body.totals).toEqual({ lineCount: 1, qtyByUom: [{ uomId: Number(ids.uom), uomCode: expect.any(String), qty: 30 }] });
    });

    it('상태·고객·품목·LOT 번호로 거른다', async () => {
      const cancelled = (await get('shipment-lines', { ...window, statusCode: 'CANCELLED' }).expect(200)).body as Paged<ShipmentLine>;
      expect(cancelled.items.map((line) => line.shipmentNo)).toEqual([`${PREFIX}-SH-CXL`]);

      const otherItem = (await get('shipment-lines', { ...window, itemId: Number(ids.material) }).expect(200)).body as Paged<ShipmentLine>;
      expect(otherItem.items).toEqual([]);

      const byCustomer = (await get('shipment-lines', { ...window, customerId: Number(ids.customer) }).expect(200)).body as Paged<ShipmentLine>;
      expect(byCustomer.items).toHaveLength(1);

      const byLot = (await get('shipment-lines', { shipDateFrom: DAY, shipDateTo: DAY, q: `${PREFIX}-LOT-FG2` }).expect(200)).body as Paged<ShipmentLine>;
      expect(byLot.items.map((line) => line.shipmentNo)).toEqual([`${PREFIX}-SH-OK`]);
    });

    it('기간 시작이 없으면 400, 권한이 없으면 403 이다', async () => {
      const missing = await get('shipment-lines', { q: PREFIX }).expect(400);
      expect(missing.body.errors[0]).toMatchObject({ field: 'shipDateFrom', code: 'REQUIRED' });
      await get('shipment-lines', window, 'denied').expect(403);
    });
  });

  /** 그 공장의 현지 시각 → UTC 순간. 공장 시간대를 시험이 가정하지 않고 DB 로 푼다. */
  async function local(day: string, time: string): Promise<Date> {
    const [row] = await prisma.$queryRawUnsafe<{ at: Date }[]>(
      `SELECT ($1::timestamp AT TIME ZONE p.timezone_code) AS at FROM mdm.plant p WHERE p.plant_id = $2::bigint`,
      `${day} ${time}`, ids.plant,
    );
    return row.at;
  }

  async function ensure<T>(
    delegate: { findFirst: (a: unknown) => Promise<T | null>; create: (a: unknown) => Promise<T> },
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<T> {
    return (await delegate.findFirst({ where })) ?? (await delegate.create({ data }));
  }

  async function makeMasters(): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    ids.plant = plant.plant_id;
    const [uom] = await prisma.uom.findMany({ take: 1, orderBy: { uom_id: 'asc' } });
    ids.uom = uom.uom_id;
    const warehouse = await ensure(prisma.warehouse, { warehouse_code: `${PREFIX}-WH` }, {
      plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH`,
      warehouse_name: '추적현황창고', warehouse_type_code: 'FINISHED', management_level_code: 'WAREHOUSE',
    });
    ids.warehouse = warehouse.warehouse_id;
    const location = await ensure(prisma.location, { location_code: `${PREFIX}-LOC` }, {
      warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: '추적현황위치', location_type_code: 'DEFAULT',
    });
    ids.location = location.location_id;
    for (const [key, code, type] of [['material', 'MAT', 'RAW_MATERIAL'], ['product', 'FG', 'FINISHED']] as const) {
      const item = await ensure(prisma.item, { item_code: `${PREFIX}-${code}` }, {
        item_code: `${PREFIX}-${code}`, item_name: `추적현황${code}`, item_type_code: type, base_uom_id: uom.uom_id,
      });
      ids[key] = item.item_id;
    }
    for (const [key, code] of [['supplier', 'SUP'], ['customer', 'CUS']] as const) {
      const partner = await ensure(prisma.partner, { partner_code: `${PREFIX}-${code}` }, {
        partner_code: `${PREFIX}-${code}`, partner_name: `추적현황${code}`,
      });
      ids[key] = partner.partner_id;
    }
    const process = await ensure(prisma.process, { process_code: `${PREFIX}-PR` }, {
      process_code: `${PREFIX}-PR`, process_name: '추적현황공정', process_type_code: 'MOLDING',
    });
    const routing = await ensure(prisma.routing, { routing_code: `${PREFIX}-RT` }, {
      item_id: ids.product, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE',
    });
    const operation = await ensure(prisma.routing_operation, { routing_id: routing.routing_id }, {
      routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '추적현황작업',
    });
    const workOrder = await ensure(prisma.work_order, { work_order_no: `${PREFIX}-WO` }, {
      work_order_no: `${PREFIX}-WO`, routing_operation_id: operation.routing_operation_id, item_id: ids.product,
      order_qty: 100, uom_id: uom.uom_id, status_code: 'RELEASED',
    });
    ids.workOrder = workOrder.work_order_id;
    const lot = (suffix: string, itemId: bigint, sourceType: string, sourceId: bigint) =>
      ensure(prisma.lot, { lot_no: `${PREFIX}-LOT-${suffix}` }, {
        lot_no: `${PREFIX}-LOT-${suffix}`, item_id: itemId, lot_type_code: itemId === ids.material ? 'MATERIAL' : 'PRODUCT',
        plant_id: plant.plant_id, initial_qty: 100, uom_id: uom.uom_id, source_type_code: sourceType, source_id: sourceId, status_code: 'NORMAL',
      });
    ids.lotMat = (await lot('MAT', ids.material, 'INBOUND_RECEIPT_LINE', 1n)).lot_id;
    ids.lotFg1 = (await lot('FG1', ids.product, 'WORK_ORDER', ids.workOrder)).lot_id;
    ids.lotFg2 = (await lot('FG2', ids.product, 'WORK_ORDER', ids.workOrder)).lot_id;
    // W/O 는 실행마다 새로 만들어 id 가 바뀐다 — 남아 있던 LOT 의 원천을 새 W/O 로 다시 잇는다.
    await prisma.lot.updateMany({ where: { lot_id: { in: [ids.lotFg1, ids.lotFg2] } }, data: { source_id: ids.workOrder } });
  }

  async function makeReceipts(): Promise<void> {
    const inbound = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`, supplier_id: ids.supplier, plant_id: ids.plant,
        receipt_datetime: await local(DAY, '00:10'), status_code: 'RECEIVED',
        inbound_receipt_line: {
          create: [{ line_no: 1, item_id: ids.material, received_qty: 100, uom_id: ids.uom, inspection_required: false,
            supplier_lot_label_attached: true, status_code: 'RECEIVED', lot_id: ids.lotMat }],
        },
      },
      include: { inbound_receipt_line: true },
    });
    const receipt = async (suffix: string, type: string, at: Date, status: string, lotId: bigint, itemId: bigint, qty: number, inboundLineId?: bigint) =>
      prisma.goods_receipt.create({
        data: {
          goods_receipt_no: `${PREFIX}-GR-${suffix}`, receipt_type_code: type, plant_id: ids.plant, warehouse_id: ids.warehouse,
          receipt_datetime: at, status_code: status,
          goods_receipt_line: {
            create: [{ line_no: 1, item_id: itemId, lot_id: lotId, receipt_qty: qty, uom_id: ids.uom, quality_status_code: 'NORMAL',
              inventory_status_code: 'AVAILABLE', destination_location_id: ids.location, inbound_receipt_line_id: inboundLineId ?? null }],
          },
        },
      });
    const inboundLineId = inbound.inbound_receipt_line[0].inbound_receipt_line_id;
    // 현지 자정 30분 뒤 — UTC 로는 전날이지만 현지 그날이다.
    await receipt('MAT', 'MATERIAL', await local(DAY, '00:30'), 'POSTED', ids.lotMat, ids.material, 100, inboundLineId);
    await receipt('PRD', 'PRODUCT', await local(DAY, '10:00'), 'POSTED', ids.lotFg1, ids.product, 40);
    await receipt('CXL', 'MATERIAL', await local(DAY, '11:00'), 'CANCELLED', ids.lotMat, ids.material, 7);
    // 현지 전날 23:30 — UTC 날짜로 보면 위 자재입고와 같은 날이다.
    await receipt('EVE', 'MATERIAL', await local('2026-08-09', '23:30'), 'POSTED', ids.lotMat, ids.material, 5);
  }

  async function makeShipments(): Promise<void> {
    const shipmentRequest = await prisma.shipment_request.create({
      data: {
        shipment_request_no: `${PREFIX}-SR`, customer_id: ids.customer, ship_to_partner_id: ids.customer,
        requested_ship_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
        shipment_request_line: { create: [{ line_no: 1, item_id: ids.product, requested_qty: 100, uom_id: ids.uom }] },
      },
      include: { shipment_request_line: true },
    });
    const requestLineId = shipmentRequest.shipment_request_line[0].shipment_request_line_id;
    const shipment = async (suffix: string, status: string, at: Date, allocations: [bigint, number][]) =>
      prisma.shipment.create({
        data: {
          shipment_no: `${PREFIX}-SH-${suffix}`, shipment_request_id: shipmentRequest.shipment_request_id, warehouse_id: ids.warehouse,
          status_code: status, shipped_at: at,
          shipment_line: {
            create: [{
              line_no: 1, shipment_request_line_id: requestLineId, item_id: ids.product,
              shipped_qty: allocations.reduce((sum, [, qty]) => sum + qty, 0), uom_id: ids.uom,
              shipment_lot_allocation: { create: allocations.map(([lotId, qty]) => ({ lot_id: lotId, allocated_qty: qty, uom_id: ids.uom })) },
            }],
          },
        },
      });
    await shipment('OK', 'CONFIRMED', await local(DAY, '01:00'), [[ids.lotFg2, 10], [ids.lotFg1, 20]]);
    await shipment('CXL', 'CANCELLED', await local(DAY, '02:00'), [[ids.lotFg1, 5]]);
    await shipment('OUT', 'CONFIRMED', await local('2026-08-11', '00:30'), [[ids.lotFg1, 5]]);
  }

  async function login(loginId: string, permissions: string[]): Promise<string[]> {
    const user = await prisma.app_user.create({ data: { login_id: loginId, user_name: loginId, status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: `${loginId}-ROLE`, role_name: loginId } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    for (const sql of [
      `DELETE FROM logistics.shipment_lot_allocation WHERE shipment_line_id IN (SELECT sl.shipment_line_id FROM logistics.shipment_line sl
         JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id WHERE s.shipment_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipment_line WHERE shipment_id IN (SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (
         SELECT shipment_request_id FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.goods_receipt_line WHERE goods_receipt_id IN (
         SELECT goods_receipt_id FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (
         SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      // ⛔ W/O 는 지운다 — 계획 없는 W/O 가 남으면 W/O 목록 e2e 의 계약 검증(productionPlanId 필수)이 깨진다.
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
      // 마스터(LOT·품목·창고·파트너)는 남겨 다음 실행이 `ensure()` 로 다시 쓴다.
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    for (const loginId of Object.values(USERS)) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (user) {
        await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
        await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
        await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
        await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
      }
      const role = await prisma.role.findUnique({ where: { role_code: `${loginId}-ROLE` } });
      if (role) {
        await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
        await prisma.role.delete({ where: { role_id: role.role_id } });
      }
    }
  }
});
