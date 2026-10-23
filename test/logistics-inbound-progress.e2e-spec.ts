/**
 * 입고 관리 허브 — 발주 하나의 LOT 진행(#805 · omf-all-around#168 · 장부 P-110).
 *
 * 실제 API 로 잇는다 — LOT 등록(P-01-01) · 판정(W-01-01) · 입고(W-01-10). 적치 완료만 행을 바꾼다
 * (단말 작업자·버전 머리가 드는 쓰기라 이 시험의 관심이 아니다).
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

const PREFIX = 'INPROG';
const LOGIN_ID = 'e2e-inbound-progress';
const PASSWORD = '입고-진행-비밀번호';
const ROLE = 'E2E_INBOUND_PROGRESS';
const PERMISSIONS = ['P-01-01', 'W-01-01', 'W-01-10'];
const DAY = '2026-10-23';

const key = (): string => randomUUID();

interface Row {
  purchaseOrderLineId: number;
  inboundReceiptId: number;
  inboundReceiptLineId: number;
  lotId: number;
  lotNo: string;
  stageCode: string;
  nextActionCode: string | null;
  receivableQty: number | null;
  blockedReasons: { code: string; name: string }[];
  inspection: { statusCode: string; judgmentCode: string | null; judgedAt: string | null } | null;
  goodsReceipt: { goodsReceiptNo: string } | null;
  putaway: { statusCode: string; locationCode: string | null } | null;
}

function responseValidator(path = '~1logistics~1purchase-orders~1{purchaseOrderId}~1inbound-progress'): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float']) ajv.addFormat(format, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({
    $ref: `https://omf-mes.invalid/contract#/paths/${path}/get/responses/200/content/application~1json/schema`,
  });
}

describe('입고 관리 허브 — 발주 하나의 LOT 진행 (e2e · 장부 P-110)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  const validate = responseValidator();
  const ids: Record<string, bigint> = {};
  let lineNo = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeMasters();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 한 LOT 이 검사 → 입고 → 적치 단계를 차례로 바꾼다 — 응답이 계약 모양이다', async () => {
    const { lotId, lineId, requestId } = await registerLot('iqcItem', ids.orderLine, 10);
    expect(await rowOf(lotId)).toMatchObject({
      stageCode: 'INSPECTION_REQUESTED',
      nextActionCode: null,
      receivableQty: 10,
      inspection: { statusCode: 'REQUESTED', judgmentCode: null },
      goodsReceipt: null,
      putaway: null,
    });

    const resultId = await draft(requestId, 10);
    expect((await rowOf(lotId)).stageCode).toBe('INSPECTION_IN_PROGRESS');

    await confirm(resultId, 'ACCEPTED').expect(200);
    const accepted = await rowOf(lotId);
    expect(accepted).toMatchObject({ stageCode: 'RECEIPT_READY', nextActionCode: 'POST_RECEIPT' });
    expect(accepted.inspection).toMatchObject({ statusCode: 'COMPLETED', judgmentCode: 'ACCEPTED' });
    expect(accepted.inspection?.judgedAt).not.toBeNull();

    await receive(lotId, lineId, 4).expect(201);
    const partly = await rowOf(lotId);
    expect(partly).toMatchObject({ stageCode: 'RECEIPT_READY', receivableQty: 6 });
    expect(partly.goodsReceipt).not.toBeNull();

    await receive(lotId, lineId, 6).expect(201);
    expect(await rowOf(lotId)).toMatchObject({
      stageCode: 'PUTAWAY_PENDING',
      nextActionCode: 'PUTAWAY',
      receivableQty: 0,
      putaway: { statusCode: 'PENDING', locationCode: null },
    });

    await prisma.putaway_task.updateMany({
      where: { lot_id: BigInt(lotId) },
      data: { status_code: 'COMPLETED', actual_location_id: ids.location, completed_at: new Date(`${DAY}T06:00:00.000Z`) },
    });
    expect(await rowOf(lotId)).toMatchObject({
      stageCode: 'COMPLETED',
      nextActionCode: null,
      putaway: { statusCode: 'COMPLETED', locationCode: `${PREFIX}-LOC` },
    });
  });

  it('⭐ 세 id 가 입하 상세·발주 라인 목록과 같다 — 화면이 라인 아래에 묶고 입고 처리 창을 연다', async () => {
    const { lotId, lineId } = await registerLot('iqcItem', ids.orderLine, 5);
    const row = await rowOf(lotId);
    expect(row).toMatchObject({ inboundReceiptId: Number(ids.receipt), inboundReceiptLineId: lineId });

    const detail = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts/${String(ids.receipt)}`)
      .set('Cookie', cookie)
      .expect(200);
    const lines = detail.body.lines as { inboundReceiptLineId: number; lotId: number | null }[];
    expect(lines.find((line) => line.inboundReceiptLineId === row.inboundReceiptLineId)?.lotId).toBe(row.lotId);

    const orderLines = await request(app.getHttpServer())
      .get('/api/logistics/purchase-order-lines')
      .query({ purchaseOrderId: Number(ids.order), openOnly: 'false' })
      .set('Cookie', cookie)
      .expect(200);
    const orderLineIds = (orderLines.body.items as { purchaseOrderLineId: number }[]).map((line) => line.purchaseOrderLineId);
    expect(orderLineIds).toContain(row.purchaseOrderLineId);
  });

  it('⭐ 판정 보류면 INSPECTION_HELD 이고 열린 보류 사유가 공통코드 이름으로 실린다', async () => {
    const { lotId, requestId } = await registerLot('iqcItem', ids.orderLine, 3);
    await confirm(await draft(requestId, 3), 'HELD').expect(200);

    const name = await prisma.code_value.findFirstOrThrow({
      where: { code: 'INCOMING_INSPECTION_WAIT', code_group: { group_code: 'LOT_HOLD_REASON' } },
      select: { code_name: true },
    });
    expect(await rowOf(lotId)).toMatchObject({
      stageCode: 'INSPECTION_HELD',
      nextActionCode: null,
      blockedReasons: [{ code: 'INCOMING_INSPECTION_WAIT', name: name.code_name }],
      inspection: { judgmentCode: 'HELD' },
    });
  });

  it('⭐ 무검사 품목 LOT 은 의뢰 없이 RECEIPT_READY 다', async () => {
    const { lotId } = await registerLot('plainItem', ids.plainLine, 7);
    expect(await rowOf(lotId)).toMatchObject({
      stageCode: 'RECEIPT_READY',
      nextActionCode: 'POST_RECEIPT',
      inspection: null,
      blockedReasons: [],
    });
  });

  it('⭐ 선별 자식 LOT 도 한 줄이고 조상의 입하 라인·의뢰를 따른다', async () => {
    const parent = await registerLot('iqcItem', ids.orderLine, 8);
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(parent.lotId) } });
    const child = await prisma.lot.create({
      data: {
        lot_no: `${lot.lot_no}-S1`, item_id: lot.item_id, lot_type_code: lot.lot_type_code, plant_id: lot.plant_id,
        initial_qty: 2, uom_id: lot.uom_id, source_type_code: 'LOT_SPLIT', source_id: lot.lot_id,
        parent_lot_id: lot.lot_id, status_code: 'DEFECTIVE',
      },
    });

    const row = await rowOf(Number(child.lot_id));
    expect(row).toMatchObject({
      lotNo: `${lot.lot_no}-S1`,
      inboundReceiptLineId: parent.lineId,
      stageCode: 'RECEIPT_READY',
      receivableQty: 2,
      inspection: { statusCode: 'REQUESTED' },
    });
    // 떼어 낸 만큼 부모의 입고 가능 수량이 준다(P-56).
    expect((await rowOf(parent.lotId)).receivableQty).toBe(6);
  });

  it('⭐ 다른 발주의 LOT 은 섞이지 않는다 — LOT 이 없는 입하 라인은 줄이 없다', async () => {
    const other = await registerLot('iqcItem', ids.otherLine, 4);
    const unlabeled = await inboundLine('iqcItem', ids.orderLine, 9);

    const rows = await progress(ids.order);
    expect(rows.map((row) => row.lotId)).not.toContain(other.lotId);
    expect(rows.map((row) => row.inboundReceiptLineId)).not.toContain(unlabeled);
    expect((await progress(ids.otherOrder)).map((row) => row.lotId)).toEqual([other.lotId]);
  });

  it('⛔ 없는 발주는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/purchase-orders/999999999/inbound-progress')
      .set('Cookie', cookie)
      .expect(404);
  });

  describe('단계 칩 — 목록의 묶음 수 · inboundStage · 건수 경로', () => {
    const Q = `${PREFIX}-S-`;
    const validateCounts = responseValidator('~1logistics~1purchase-orders:inbound-stage-counts');

    /** S-1: 검사 의뢰 1 · 입고 대기 1 · S-2: 판정 보류 1 · S-3: LOT 없음. */
    beforeAll(async () => {
      const [s1, s2] = [await makeOrder('S-1', ['iqcItem', 'plainItem']), await makeOrder('S-2', ['iqcItem'])];
      await makeOrder('S-3', ['iqcItem']);
      await registerLot('iqcItem', s1[0], 2);
      await registerLot('plainItem', s1[1], 2);
      const held = await registerLot('iqcItem', s2[0], 2);
      await confirm(await draft(held.requestId, 2), 'HELD').expect(200);
    });

    it('⭐ 목록 줄마다 inboundStageCounts 가 그 발주 LOT 의 묶음 수다 — LOT 이 없으면 {}', async () => {
      const response = await list({ q: Q }).expect(200);
      const counts = Object.fromEntries(
        (response.body.items as { purchaseOrderNo: string; inboundStageCounts: object }[]).map((item) => [item.purchaseOrderNo, item.inboundStageCounts]),
      );
      expect(counts).toEqual({ [`${Q}1`]: { INSPECTION: 1, RECEIPT: 1 }, [`${Q}2`]: { HELD: 1 }, [`${Q}3`]: {} });
    });

    it('⭐ inboundStage 로 거르면 그 묶음 LOT 이 있는 발주만 오고 쪽·총계가 맞다', async () => {
      const numbers = async (query: Record<string, unknown>) => {
        const response = await list({ q: Q, ...query }).expect(200);
        return { nos: (response.body.items as { purchaseOrderNo: string }[]).map((item) => item.purchaseOrderNo), total: response.body.page.total as number };
      };
      expect(await numbers({ inboundStage: 'INSPECTION' })).toEqual({ nos: [`${Q}1`], total: 1 });
      expect(await numbers({ inboundStage: 'HELD', size: 1 })).toEqual({ nos: [`${Q}2`], total: 1 });
      expect(await numbers({ inboundStage: 'PUTAWAY' })).toEqual({ nos: [], total: 0 });
    });

    it('⭐ 건수 경로는 page·size·inboundStage 를 빼고 조건 전체를 센다 — 응답이 계약 모양이다', async () => {
      const response = await stageCounts({ q: Q, page: 1, size: 1, inboundStage: 'HELD' }).expect(200);
      expect(validateCounts(response.body)).toBe(true);
      expect(validateCounts.errors ?? []).toEqual([]);
      expect(response.body).toEqual({ counts: { INSPECTION: 1, HELD: 1, RECEIPT: 1, PUTAWAY: 0 } });
      // 계약 밖 조건도 목록처럼 형을 맞춘다 — 글자 'false' 를 참으로 읽으면 납기 없는 발주가 모두 빠진다.
      const unfiltered = await stageCounts({ q: Q, overdueOnly: 'false' }).expect(200);
      expect(unfiltered.body).toEqual(response.body);
    });

    it('⛔ inboundStage 가 네 값 밖이면 400 이다 — 건수 경로도 목록과 같은 조건을 검사한다', async () => {
      await list({ q: Q, inboundStage: 'COMPLETED' }).expect(400);
      await stageCounts({ q: Q, expectedReceiptDateFrom: '2026-02-30' }).expect(400);
      await stageCounts({ q: Q, plantId: 'abc' }).expect(400);
    });

    function list(query: Record<string, unknown>): request.Test {
      return request(app.getHttpServer()).get('/api/logistics/purchase-orders').query(query).set('Cookie', cookie);
    }

    function stageCounts(query: Record<string, unknown>): request.Test {
      return request(app.getHttpServer())
        .get('/api/logistics/purchase-orders:inbound-stage-counts')
        .query(query)
        .set('Cookie', cookie);
    }

    async function makeOrder(no: string, items: string[]): Promise<bigint[]> {
      const order = await prisma.purchase_order.create({
        data: {
          purchase_order_no: `${PREFIX}-${no}`, supplier_id: ids.supplier, business_unit_id: ids.unit, plant_id: ids.plant,
          order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
        },
      });
      const lines: bigint[] = [];
      for (const [index, item] of items.entries()) {
        const line = await prisma.purchase_order_line.create({
          data: { purchase_order_id: order.purchase_order_id, line_no: index + 1, item_id: ids[item], ordered_qty: 1000, uom_id: ids.uom },
        });
        lines.push(line.purchase_order_line_id);
      }
      return lines;
    }
  });

  async function progress(orderId: bigint): Promise<Row[]> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/purchase-orders/${String(orderId)}/inbound-progress`)
      .set('Cookie', cookie)
      .expect(200);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body.items as Row[];
  }

  async function rowOf(lotId: number): Promise<Row> {
    const row = (await progress(ids.order)).find((item) => item.lotId === lotId);
    if (row === undefined) throw new Error(`LOT ${lotId} 줄이 없다`);
    return row;
  }

  async function inboundLine(item: string, orderLineId: bigint, qty: number): Promise<number> {
    lineNo += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: ids.receipt, line_no: lineNo, item_id: ids[item], purchase_order_line_id: orderLineId,
        received_qty: qty, uom_id: ids.uom, supplier_lot_label_attached: false,
        inspection_required: item === 'iqcItem', status_code: 'REGISTERED',
      },
    });
    return Number(line.inbound_receipt_line_id);
  }

  /** 입하 라인 + LOT 등록(실제 API) — 검사 대상 품목이면 의뢰가 함께 선다. */
  async function registerLot(item: string, orderLineId: bigint, qty: number) {
    const lineId = await inboundLine(item, orderLineId, qty);
    const created = await request(app.getHttpServer())
      .post('/api/trace/lots')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        itemId: Number(ids[item]), lotTypeCode: 'MATERIAL', plantId: Number(ids.plant), initialQty: qty,
        uomId: Number(ids.uom), sourceTypeCode: 'INBOUND_RECEIPT_LINE', sourceId: lineId, numberSourceCode: 'MES',
        businessDate: DAY, occurredAt: `${DAY}T02:00:00.000Z`,
      })
      .expect(201);
    const lotId = created.body.lot.lotId as number;
    const iqc = await prisma.inspection_request.findFirst({
      where: { lot_id: BigInt(lotId), inspection_type_code: 'IQC' },
      select: { inspection_request_id: true },
    });
    return { lotId, lineId, requestId: Number(iqc?.inspection_request_id ?? 0) };
  }

  async function draft(requestId: number, qty: number): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/quality/inspection-results')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        inspectionRequestId: requestId, inspectedQty: qty, acceptedQty: qty, rejectedQty: 0, heldQty: 0,
        uomId: Number(ids.uom), inspectedAt: `${DAY}T03:00:00.000Z`, statusCode: 'DRAFT',
      })
      .expect(201);
    return response.body.inspectionResultId as number;
  }

  function confirm(resultId: number, judgment: string): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/inspection-results/${resultId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', 'W/"1"')
      .send({ overallJudgmentCode: judgment });
  }

  function receive(lotId: number, lineId: number, qty: number): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        receiptTypeCode: 'MATERIAL', plantId: Number(ids.plant), warehouseId: Number(ids.warehouse),
        receiptDatetime: `${DAY}T05:00:00.000Z`, businessDate: DAY,
        lines: [{
          inboundReceiptLineId: lineId, itemId: Number(ids.iqcItem), lotId, receiptQty: qty, uomId: Number(ids.uom),
          qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(ids.location),
        }],
      });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '입고진행법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '입고진행사업부' },
    });
    ids.unit = unit.business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '입고진행공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    })).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    for (const [name, inspection] of [['iqcItem', true], ['plainItem', false]] as const) {
      ids[name] = (await prisma.item.create({
        data: {
          item_code: `${PREFIX}-${name}`, item_name: `입고진행${name}`, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom,
          lot_controlled: true, inspection_required: inspection,
        },
      })).item_id;
    }
    ids.warehouse = (await prisma.warehouse.create({
      data: {
        plant_id: ids.plant, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH`, warehouse_name: '입고진행창고',
        warehouse_type_code: 'RAW', management_level_code: 'LOCATION',
      },
    })).warehouse_id;
    ids.location = (await prisma.location.create({
      data: { warehouse_id: ids.warehouse, location_code: `${PREFIX}-LOC`, location_name: '입고진행위치', location_type_code: 'BIN' },
    })).location_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-SUP`, partner_name: '입고진행공급사' } })).partner_id;
    for (const [order, lines] of [['order', [['orderLine', 'iqcItem'], ['plainLine', 'plainItem']]], ['otherOrder', [['otherLine', 'iqcItem']]]] as const) {
      ids[order] = (await prisma.purchase_order.create({
        data: {
          purchase_order_no: `${PREFIX}-${order}`, supplier_id: ids.supplier, business_unit_id: unit.business_unit_id,
          plant_id: ids.plant, order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
        },
      })).purchase_order_id;
      for (const [index, [line, item]] of lines.entries()) {
        ids[line] = (await prisma.purchase_order_line.create({
          data: { purchase_order_id: ids[order], line_no: index + 1, item_id: ids[item], ordered_qty: 1000, uom_id: ids.uom },
        })).purchase_order_line_id;
      }
    }
    ids.receipt = (await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`, supplier_id: ids.supplier, plant_id: ids.plant,
        receipt_datetime: new Date(`${DAY}T01:00:00.000Z`), status_code: 'REGISTERED',
      },
    })).inbound_receipt_id;
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '입고진행', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '입고진행용' } });
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    // 관리웹 판정의 검사자는 계정에 연결된 작업자다(#104).
    await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`, worker_name: '입고진행검사자', business_unit_id: ids.unit, plant_id: ids.plant,
        app_user_id: user.app_user_id, status_code: 'EMPLOYED',
      },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', key())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — 재고 스위트들과 같은 이유다. */
  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    await prisma.$executeRawUnsafe(`TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`);
    for (const sql of [
      `DELETE FROM logistics.putaway_task WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM inventory.inventory_balance WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (SELECT inspection_request_id FROM quality.inspection_request WHERE lot_id IN (${lots}))`,
      `DELETE FROM quality.inspection_request WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_relation WHERE source_lot_id IN (${lots}) OR target_lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE parent_lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE purchase_order_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.purchase_order WHERE purchase_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
