/**
 * LOT 추적 정방향·역방향(장부 P-119) — 사슬 하나로 목록 둘과 LOT 하나의 사슬 둘을 본다.
 *
 * 자재 LOT M1 ─ 입하(공급사 LOT)·자재입고
 *   ├ W/O G(계보) → 생산 LOT G1 ─ 생산입고·포장·출하      (G2 는 실적 없는 선발행 슬롯 — 안 보여야 한다)
 *   ├ W/O L(계보 없음 · #166 이전) → L1 (W/O 단위 추정)
 *   ├ W/O N(실적 없음) → 이은 LOT 없음
 *   └ W/O S(계보) → 반제품 S1 ─ W/O G 에 다시 투입(S1 → G1)
 * 자재 LOT M2 ─ 자재입고만
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

const PREFIX = 'TLFE2E';
const DAY = '2026-08-12';
const USERS = { allowed: `${PREFIX}-allowed`, denied: `${PREFIX}-denied` };
const PASSWORD = 'TL-추적-비밀번호';
const CONTRACT = 'logistics-01자재창고.json';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function validator(path: string): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts', CONTRACT), 'utf8')) as object;
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/get/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

function conforms(path: string, body: unknown): void {
  const validate = validator(path);
  if (!validate(body)) throw new Error(JSON.stringify(validate.errors));
}

describe('LOT 추적 정방향·역방향 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cookies: Record<keyof typeof USERS, string[]> = { allowed: [], denied: [] };
  const ids: Record<string, bigint> = {};
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeChain();
    cookies.allowed = await login(USERS.allowed, ['W-02-09']);
    cookies.denied = await login(USERS.denied, ['W-02-08']);
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const get = (path: string, query: Record<string, string | number> = {}, who: keyof typeof USERS = 'allowed') =>
    request(app.getHttpServer()).get(`/api/trace/${path}`).query(query).set('Cookie', cookies[who]);
  const no = (rows: Body[]) => rows.map((row) => row.lotNo as string);

  describe('정방향 목록 GET /trace/material-lot-flows', () => {
    const window = { itemId: 0, receiptDateFrom: DAY, receiptDateTo: DAY };
    const query = () => ({ ...window, itemId: Number(ids.material) });

    it('자재 LOT 마다 입하·입고와 단계를 싣고, 단계별 건수를 함께 준다', async () => {
      const body = (await get('material-lot-flows', query()).expect(200)).body as Body;

      conforms('/trace/material-lot-flows', body);
      expect(no(body.items)).toEqual([`${PREFIX}-M2`, `${PREFIX}-M1`]);
      expect(body.stageCounts).toEqual({ RECEIVED: 1, CONSUMED: 0, PRODUCED: 0, PRODUCTION_RECEIVED: 0, PACKED: 0, SHIPPED: 1 });
      const m1 = body.items[1];
      expect(m1).toMatchObject({
        currentStageCode: 'SHIPPED', basis: 'WORK_ORDER_ESTIMATE', receivedQty: 100,
        inbound: { inboundReceiptNo: `${PREFIX}-IR`, supplierLotNo: 'SUP-LOT-1', supplier: { code: `${PREFIX}-SUP` } },
        stages: {
          received: { count: 1 }, consumed: { workOrderCount: 4 }, produced: { lotCount: 3 },
          productionReceived: { lotCount: 1 }, packed: { lotCount: 1, handlingUnitCount: 1 }, shipped: { lotCount: 1, shipmentCount: 1 },
        },
      });
      expect(body.items[0]).toMatchObject({ currentStageCode: 'RECEIVED', basis: 'LOT_GENEALOGY_ESTIMATE' });
    });

    it('단계로 거르면 그 단계만 오지만 단계별 건수는 그대로다', async () => {
      const body = (await get('material-lot-flows', { ...query(), currentStageCode: 'RECEIVED,PACKED' }).expect(200)).body as Body;

      expect(no(body.items)).toEqual([`${PREFIX}-M2`]);
      expect(body.page.total).toBe(1);
      expect(body.stageCounts.SHIPPED).toBe(1);
    });

    it('입하 번호로 집으면 기간 없이도 된다', async () => {
      const body = (await get('material-lot-flows', { inboundReceiptNo: `${PREFIX}-IR` }).expect(200)).body as Body;
      expect(no(body.items)).toEqual([`${PREFIX}-M1`]);
    });

    it('진입점이 없으면 400 — itemId 칸을 짚고 넣을 수 있는 칸을 알린다 · 품목만이면 기간 시작이 필수다', async () => {
      const none = await get('material-lot-flows', { receiptDateFrom: DAY }).expect(400);
      expect(none.body.errors).toEqual([{
        scope: 'field', field: 'itemId', code: 'REQUIRED',
        message: '찾을 대상이 없습니다. 자재 품목(itemId) · 자재 LOT 번호(lotNo) · 입하 번호(inboundReceiptNo) · LOT 번호 일부(q) 중 하나를 넣어 다시 조회하세요.',
      }]);
      const noPeriod = await get('material-lot-flows', { itemId: Number(ids.material) }).expect(400);
      expect(noPeriod.body.errors[0]).toMatchObject({ field: 'receiptDateFrom', code: 'REQUIRED' });
    });

    it('LOT 추적 권한이 없으면 403 이다', async () => {
      await get('material-lot-flows', query(), 'denied').expect(403);
    });
  });

  describe('정방향 사슬 GET /trace/lots/{lotId}/forward-flow', () => {
    it('투입 W/O 마다 이은 생산 LOT 과 그 뒤 문서를 싣는다 — 근거는 W/O 마다, 실적 없는 W/O 는 null', async () => {
      const body = (await get(`lots/${ids.m1}/forward-flow`).expect(200)).body as Body;

      conforms('/trace/lots/{lotId}/forward-flow', body);
      expect(body).toMatchObject({ basis: 'WORK_ORDER_ESTIMATE', truncated: false, totalProductionLotCount: 3, lot: { lotNo: `${PREFIX}-M1` } });
      const byNo = Object.fromEntries((body.workOrders as Body[]).map((wo) => [wo.workOrderNo, wo]));
      expect(Object.keys(byNo).sort()).toEqual([`${PREFIX}-WO-G`, `${PREFIX}-WO-L`, `${PREFIX}-WO-N`, `${PREFIX}-WO-S`]);
      expect(byNo[`${PREFIX}-WO-N`]).toMatchObject({ linkBasis: null, productionLots: [] });
      expect(byNo[`${PREFIX}-WO-L`]).toMatchObject({ linkBasis: 'WORK_ORDER_ESTIMATE' });
      expect(no(byNo[`${PREFIX}-WO-L`].productionLots)).toEqual([`${PREFIX}-L1`]);
      // 실적 없는 선발행 슬롯 G2 는 같은 W/O 여도 잇지 않는다.
      expect(no(byNo[`${PREFIX}-WO-G`].productionLots)).toEqual([`${PREFIX}-G1`]);
      expect(byNo[`${PREFIX}-WO-G`].productionLots[0]).toMatchObject({
        linkBasis: 'LOT_GENEALOGY_ESTIMATE', goodQty: 40, consumedFurther: 0, cyclic: false,
        productionReceipts: [{ goodsReceiptNo: `${PREFIX}-GR-G1`, qty: 40 }],
        packages: [{ handlingUnitNo: `${PREFIX}-HU1`, qty: 30 }],
        shipments: [{ shipmentNo: `${PREFIX}-SH1`, qty: 30, handlingUnitNo: `${PREFIX}-HU1`, customer: { code: `${PREFIX}-CUS` } }],
      });
      // 반제품은 한 단만 — 다시 투입됐다는 표시만 준다.
      expect(byNo[`${PREFIX}-WO-S`].productionLots[0]).toMatchObject({ lotNo: `${PREFIX}-S1`, consumedFurther: 1 });
    });

    it('없는 LOT 은 404 이다', async () => {
      await get('lots/999999999999/forward-flow').expect(404);
    });
  });

  describe('역방향 목록 GET /trace/product-lot-flows', () => {
    const query = () => ({ itemId: Number(ids.product), dateFrom: DAY, dateTo: DAY });

    it('실적 배분이 있는 생산 LOT 만 — 단계·근거·투입 자재 수·고객을 싣는다', async () => {
      const body = (await get('product-lot-flows', query()).expect(200)).body as Body;

      conforms('/trace/product-lot-flows', body);
      expect(no(body.items).sort()).toEqual([`${PREFIX}-G1`, `${PREFIX}-L1`]);
      expect(body.stageCounts).toEqual({ PRODUCED: 1, PRODUCTION_RECEIVED: 0, PACKED: 0, SHIPPED: 1 });
      const g1 = body.items.find((row: Body) => row.lotNo === `${PREFIX}-G1`);
      expect(g1).toMatchObject({
        currentStageCode: 'SHIPPED', basis: 'LOT_GENEALOGY_ESTIMATE', inputMaterialLotCount: 2, producedQty: 40,
        workOrder: { workOrderNo: `${PREFIX}-WO-G` },
        stages: { productionReceived: { count: 1, qty: 40 }, packed: { handlingUnitCount: 1, qty: 30 },
          shipped: { shipmentCount: 1, qty: 30, customerCount: 1, customers: [{ code: `${PREFIX}-CUS` }] } },
      });
      expect(body.items.find((row: Body) => row.lotNo === `${PREFIX}-L1`)).toMatchObject({
        currentStageCode: 'PRODUCED', basis: 'WORK_ORDER_ESTIMATE', inputMaterialLotCount: 1,
      });
    });

    it('출하 번호·W/O 번호로 집거나 출하일 축·LOT 번호 일부·단계로 거른다', async () => {
      expect(no((await get('product-lot-flows', { shipmentNo: `${PREFIX}-SH1` }).expect(200)).body.items)).toEqual([`${PREFIX}-G1`]);
      expect(no((await get('product-lot-flows', { workOrderNo: `${PREFIX}-WO-L` }).expect(200)).body.items)).toEqual([`${PREFIX}-L1`]);
      expect(no((await get('product-lot-flows', { ...query(), dateAxis: 'SHIPPED' }).expect(200)).body.items)).toEqual([`${PREFIX}-G1`]);
      expect(no((await get('product-lot-flows', { q: `${PREFIX}-L`, dateFrom: DAY, dateTo: DAY }).expect(200)).body.items)).toEqual([`${PREFIX}-L1`]);
      expect(no((await get('product-lot-flows', { ...query(), currentStageCode: 'PRODUCED' }).expect(200)).body.items)).toEqual([`${PREFIX}-L1`]);
    });

    it('진입점이 없으면 400 이고 itemId 칸을 짚는다', async () => {
      const response = await get('product-lot-flows', { dateFrom: DAY }).expect(400);
      expect(response.body.errors[0]).toMatchObject({ scope: 'field', field: 'itemId', code: 'REQUIRED' });
    });
  });

  describe('역방향 사슬 GET /trace/lots/{lotId}/backward-flow', () => {
    it('출하·포장·생산입고와 W/O 실적, 투입 자재의 입하(입하 번호·공급사 LOT)를 싣고 반제품은 만든 W/O 를 짚는다', async () => {
      const body = (await get(`lots/${ids.g1}/backward-flow`).expect(200)).body as Body;

      conforms('/trace/lots/{lotId}/backward-flow', body);
      expect(body).toMatchObject({
        basis: 'LOT_GENEALOGY_ESTIMATE', goodQty: 40,
        workOrder: { workOrderNo: `${PREFIX}-WO-G`, results: { count: 1, goodQty: 40 } },
        shipments: [{ shipmentNo: `${PREFIX}-SH1` }], packages: [{ handlingUnitNo: `${PREFIX}-HU1` }],
        productionReceipts: [{ goodsReceiptNo: `${PREFIX}-GR-G1` }],
      });
      const inputs = Object.fromEntries((body.inputMaterials as Body[]).map((input) => [input.lotNo, input]));
      expect(Object.keys(inputs).sort()).toEqual([`${PREFIX}-M1`, `${PREFIX}-S1`]);
      expect(inputs[`${PREFIX}-M1`]).toMatchObject({
        linkBasis: 'LOT_GENEALOGY_ESTIMATE', producedBy: null, cyclic: false, consumedQty: 10,
        inbound: { inboundReceiptNo: `${PREFIX}-IR`, supplierLotNo: 'SUP-LOT-1' },
        receipts: [{ goodsReceiptNo: `${PREFIX}-GR-M1` }],
      });
      expect(inputs[`${PREFIX}-S1`]).toMatchObject({ producedBy: { workOrderNo: `${PREFIX}-WO-S` }, inbound: null });
    });

    it('계보 없는 W/O 의 생산 LOT 은 W/O 단위 추정으로 그 W/O 의 투입 자재 전부다', async () => {
      const body = (await get(`lots/${ids.l1}/backward-flow`).expect(200)).body as Body;
      expect(body.basis).toBe('WORK_ORDER_ESTIMATE');
      expect(no(body.inputMaterials)).toEqual([`${PREFIX}-M1`]);
    });

    it('권한이 없으면 403 이다', async () => {
      await get(`lots/${ids.g1}/backward-flow`, {}, 'denied').expect(403);
    });
  });

  async function local(day: string, time: string): Promise<Date> {
    const [row] = await prisma.$queryRawUnsafe<{ at: Date }[]>(
      `SELECT ($1::timestamp AT TIME ZONE p.timezone_code) AS at FROM mdm.plant p WHERE p.plant_id = $2::bigint`, `${day} ${time}`, ids.plant,
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
    ids.plant = plant.plant_id;
    ids.unit = plant.business_unit_id;
    const [uom] = await prisma.uom.findMany({ take: 1, orderBy: { uom_id: 'asc' } });
    ids.uom = uom.uom_id;
    const warehouse = await ensure(prisma.warehouse, { warehouse_code: `${PREFIX}-WH` }, {
      plant_id: plant.plant_id, business_unit_id: plant.business_unit_id, warehouse_code: `${PREFIX}-WH`, warehouse_name: 'LOT추적창고',
      warehouse_type_code: 'FINISHED', management_level_code: 'WAREHOUSE',
    });
    ids.warehouse = warehouse.warehouse_id;
    ids.location = (await ensure(prisma.location, { location_code: `${PREFIX}-LOC` }, {
      warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: 'LOT추적위치', location_type_code: 'DEFAULT',
    })).location_id;
    for (const [key, code, type] of [['material', 'MAT', 'RAW_MATERIAL'], ['semi', 'SEMI', 'SEMI_FINISHED'], ['product', 'FG', 'FINISHED']] as const) {
      ids[key] = (await ensure(prisma.item, { item_code: `${PREFIX}-${code}` }, {
        item_code: `${PREFIX}-${code}`, item_name: `LOT추적${code}`, item_type_code: type, base_uom_id: uom.uom_id,
      })).item_id;
    }
    for (const [key, code] of [['supplier', 'SUP'], ['customer', 'CUS']] as const) {
      ids[key] = (await ensure(prisma.partner, { partner_code: `${PREFIX}-${code}` }, { partner_code: `${PREFIX}-${code}`, partner_name: `LOT추적${code}` })).partner_id;
    }
    ids.worker = (await ensure(prisma.worker, { worker_no: `${PREFIX}-W` }, {
      worker_no: `${PREFIX}-W`, worker_name: 'LOT추적작업자', business_unit_id: plant.business_unit_id, plant_id: plant.plant_id, status_code: 'ACTIVE',
    })).worker_id;
    const process = await ensure(prisma.process, { process_code: `${PREFIX}-PR` }, { process_code: `${PREFIX}-PR`, process_name: 'LOT추적공정', process_type_code: 'MOLDING' });
    const routing = await ensure(prisma.routing, { routing_code: `${PREFIX}-RT` }, { item_id: ids.product, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' });
    ids.operation = (await ensure(prisma.routing_operation, { routing_id: routing.routing_id }, {
      routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: 'LOT추적작업',
    })).routing_operation_id;
  }

  async function lot(suffix: string, itemId: bigint, type: string, sourceType: string, sourceId: bigint): Promise<bigint> {
    const found = await ensure(prisma.lot, { lot_no: `${PREFIX}-${suffix}` }, {
      lot_no: `${PREFIX}-${suffix}`, item_id: itemId, lot_type_code: type, plant_id: ids.plant, initial_qty: 100, uom_id: ids.uom,
      source_type_code: sourceType, source_id: sourceId, status_code: 'NORMAL',
    });
    // W/O 는 실행마다 새로 만들어 id 가 바뀐다 — 남아 있던 LOT 의 원천을 다시 잇는다.
    await prisma.lot.update({ where: { lot_id: found.lot_id }, data: { source_id: sourceId } });
    return found.lot_id;
  }

  async function workOrder(suffix: string, itemId: bigint): Promise<bigint> {
    return (await prisma.work_order.create({
      data: { work_order_no: `${PREFIX}-WO-${suffix}`, routing_operation_id: ids.operation, item_id: itemId, order_qty: 100, uom_id: ids.uom, status_code: 'IN_PROGRESS' },
    })).work_order_id;
  }

  async function consume(workOrderId: bigint, lotId: bigint, itemId: bigint, qty: number, at: Date): Promise<void> {
    seq += 1;
    await prisma.material_consumption.create({ data: {
      consumption_no: `${PREFIX}-MC-${seq}`, work_order_id: workOrderId, item_id: itemId, lot_id: lotId, consumption_type_code: 'NORMAL',
      input_qty: qty, uom_id: ids.uom, occurred_at: at, worker_id: ids.worker, status_code: 'RECORDED', idempotency_key: `${PREFIX}-MC-${seq}-${randomUUID()}`,
    } });
  }

  async function produce(workOrderId: bigint, lotId: bigint, qty: number, at: Date, sources: bigint[]): Promise<void> {
    seq += 1;
    const result = await prisma.production_result.create({ data: {
      production_result_no: `${PREFIX}-PR-${seq}`, work_order_id: workOrderId, result_sequence: 1, good_qty: qty, uom_id: ids.uom,
      result_source_code: 'POP', occurred_at: at, worker_id: ids.worker, status_code: 'CONFIRMED', idempotency_key: `${PREFIX}-PR-${seq}-${randomUUID()}`,
      production_result_lot_allocation: { create: [{ lot_id: lotId, allocated_qty: qty, uom_id: ids.uom }] },
    } });
    for (const source of sources) {
      await prisma.lot_relation.create({ data: {
        source_lot_id: source, target_lot_id: lotId, relation_type_code: 'CONSUMED', relation_qty: qty, uom_id: ids.uom,
        source_event_type_code: 'PRODUCTION_RESULT', source_event_id: result.production_result_id, allocation_method_code: 'INPUT_TIME_WINDOW',
        trace_accuracy_code: 'ESTIMATED', occurred_at: at,
      } });
    }
  }

  async function receive(suffix: string, type: string, lotId: bigint, itemId: bigint, qty: number, at: Date, inboundLineId?: bigint): Promise<void> {
    await prisma.goods_receipt.create({ data: {
      goods_receipt_no: `${PREFIX}-GR-${suffix}`, receipt_type_code: type, plant_id: ids.plant, warehouse_id: ids.warehouse, receipt_datetime: at, status_code: 'POSTED',
      goods_receipt_line: { create: [{ line_no: 1, item_id: itemId, lot_id: lotId, receipt_qty: qty, uom_id: ids.uom, quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE', destination_location_id: ids.location, inbound_receipt_line_id: inboundLineId ?? null }] },
    } });
  }

  async function makeChain(): Promise<void> {
    const wo = { G: await workOrder('G', ids.product), L: await workOrder('L', ids.product), N: await workOrder('N', ids.product), S: await workOrder('S', ids.semi) };
    ids.m1 = await lot('M1', ids.material, 'MATERIAL', 'INBOUND_RECEIPT_LINE', 1n);
    ids.m2 = await lot('M2', ids.material, 'MATERIAL', 'INBOUND_RECEIPT_LINE', 1n);
    ids.s1 = await lot('S1', ids.semi, 'PRODUCTION', 'WORK_ORDER', wo.S);
    ids.g1 = await lot('G1', ids.product, 'PRODUCTION', 'WORK_ORDER', wo.G);
    ids.g2 = await lot('G2', ids.product, 'PRODUCTION', 'WORK_ORDER', wo.G);
    ids.l1 = await lot('L1', ids.product, 'PRODUCTION', 'WORK_ORDER', wo.L);
    ids.n1 = await lot('N1', ids.product, 'PRODUCTION', 'WORK_ORDER', wo.N);

    const inbound = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR`, supplier_id: ids.supplier, plant_id: ids.plant, receipt_datetime: await local(DAY, '08:00'), status_code: 'RECEIVED',
        inbound_receipt_line: { create: [{ line_no: 1, item_id: ids.material, received_qty: 100, uom_id: ids.uom, inspection_required: false,
          supplier_lot_label_attached: true, supplier_lot_no: 'SUP-LOT-1', status_code: 'RECEIVED', lot_id: ids.m1 }] } },
      include: { inbound_receipt_line: true },
    });
    await receive('M1', 'MATERIAL', ids.m1, ids.material, 100, await local(DAY, '09:00'), inbound.inbound_receipt_line[0].inbound_receipt_line_id);
    await receive('M2', 'MATERIAL', ids.m2, ids.material, 50, await local(DAY, '09:30'));

    const at = await local(DAY, '10:00');
    for (const target of [wo.G, wo.L, wo.N, wo.S]) await consume(target, ids.m1, ids.material, 10, at);
    await consume(wo.G, ids.s1, ids.semi, 5, at);
    const later = await local(DAY, '11:00');
    await produce(wo.S, ids.s1, 20, later, [ids.m1]);
    await produce(wo.G, ids.g1, 40, later, [ids.m1, ids.s1]);
    await produce(wo.L, ids.l1, 25, later, []);

    await receive('G1', 'PRODUCT', ids.g1, ids.product, 40, await local(DAY, '12:00'));
    const box = await prisma.handling_unit.create({ data: { handling_unit_no: `${PREFIX}-HU1`, handling_unit_type_code: 'BOX', status_code: 'ACTIVE',
      handling_unit_content: { create: [{ item_id: ids.product, lot_id: ids.g1, qty: 30, uom_id: ids.uom }] } } });
    const shipmentRequest = await prisma.shipment_request.create({
      data: { shipment_request_no: `${PREFIX}-SR`, customer_id: ids.customer, ship_to_partner_id: ids.customer, requested_ship_date: new Date(`${DAY}T00:00:00.000Z`),
        status_code: 'CONFIRMED', shipment_request_line: { create: [{ line_no: 1, item_id: ids.product, requested_qty: 30, uom_id: ids.uom }] } },
      include: { shipment_request_line: true },
    });
    await prisma.shipment.create({ data: {
      shipment_no: `${PREFIX}-SH1`, shipment_request_id: shipmentRequest.shipment_request_id, warehouse_id: ids.warehouse, status_code: 'CONFIRMED',
      shipped_at: await local(DAY, '15:00'),
      shipment_line: { create: [{ line_no: 1, shipment_request_line_id: shipmentRequest.shipment_request_line[0].shipment_request_line_id, item_id: ids.product,
        shipped_qty: 30, uom_id: ids.uom, shipment_lot_allocation: { create: [{ lot_id: ids.g1, allocated_qty: 30, uom_id: ids.uom, handling_unit_id: box.handling_unit_id }] } }] },
    } });
  }

  async function login(loginId: string, permissions: string[]): Promise<string[]> {
    const user = await prisma.app_user.create({ data: { login_id: loginId, user_name: loginId, status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: `${loginId}-ROLE`, role_name: loginId } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const response = await request(app.getHttpServer()).post('/api/app/sessions').set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD }).expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const OUR_LOTS = `SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`;
    const OUR_WOS = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM logistics.shipment_lot_allocation WHERE lot_id IN (${OUR_LOTS})`,
      `DELETE FROM logistics.shipment_line WHERE shipment_id IN (SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (
         SELECT shipment_request_id FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM inventory.handling_unit_content WHERE lot_id IN (${OUR_LOTS})`,
      `DELETE FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.goods_receipt_line WHERE goods_receipt_id IN (
         SELECT goods_receipt_id FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (
         SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.lot_relation WHERE source_lot_id IN (${OUR_LOTS}) OR target_lot_id IN (${OUR_LOTS})`,
      `DELETE FROM production.production_result_lot_allocation WHERE lot_id IN (${OUR_LOTS})`,
      `DELETE FROM production.production_result WHERE work_order_id IN (${OUR_WOS})`,
      `DELETE FROM production.material_consumption WHERE work_order_id IN (${OUR_WOS})`,
      // ⛔ W/O 는 지운다 — 계획 없는 W/O 가 남으면 W/O 목록 e2e 의 계약 검증(productionPlanId 필수)이 깨진다.
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
      // 마스터(LOT·품목·창고·파트너·작업자)는 남겨 다음 실행이 `ensure()` 로 다시 쓴다.
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
