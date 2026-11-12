/**
 * 피처 005 G1 관문 1차 고칠 것(omf-all-around#254) — POP 의 공급사·품목 기본 정보 읽기, 마감 취소 목록의 같은 조합 막힘,
 * 품질 계약의 INBOUND_LOT 대상, 새 흐름 입하의 줄 치환 잠금, P/O 라인 목록의 입하 중 입하 LOT. 응답은 ajv 로 계약 대조.
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
  ClosedInboundLot, InboundLotFixture, closeInboundLotFixture, idempotencyKey, issueAndReceive, sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'G1FX';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const LOTS = '/api/logistics/inbound-lots';
const DEFAULTS = '/api/mdm/supplier-item-defaults';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
for (const [name, file] of [['logistics', 'logistics-01자재창고.json'], ['quality', 'quality-03품질.json'], ['mdm', 'mdm-기준정보.json']]) {
  ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts', file), 'utf8')) as object, name);
}
const schemaOf = (contract: string, path: string, method: string, status: number): ValidateFunction => ajv.compile({
  $ref: `${contract}#/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${String(status)}/content/application~1json/schema`,
});

function expectShape(validate: ValidateFunction, body: unknown): void {
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

interface LotRow {
  inboundLotId: number; inboundLotNo: string; statusCode: string; supplierId: number; itemId: number;
  reopenable: boolean; reopenBlockerCode: string | null; openInboundLotNo: string | null;
}

describe('피처 005 G1 관문 고칠 것 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let fx: InboundLotFixture;
  const tokens: Record<string, string> = {};
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let terminalSeq = 0;
  let seq = 0;

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
    tokens.pop = await terminalToken(ids.plant, 'POP');
    tokens.foreignPop = await terminalToken(ids.foreignPlant, 'POP');
    tokens.mobile = await terminalToken(ids.plant, 'MOBILE');
    fx = {
      app, issuer: terminalAuth(tokens.pop, WORKER_NO), receiver: terminalAuth(tokens.mobile, WORKER_NO), businessDate: DAY, keys,
      inspector: sessionAuth(cookie), prisma,
    };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const batch = (supplier: bigint, item: bigint, lotCount: number, lotQty = 5) => ({
    plantId: Number(ids.plant), supplierId: Number(supplier), itemId: Number(item), lotQty, lotCount,
  });

  it('G1-1 POP 단말이 GET /mdm/supplier-item-defaults 를 단말 공장으로 읽는다(200) — 다른 공장·plantId 다른 POP 401, MOBILE 401', async () => {
    await webSend('post', DEFAULTS, {
      plantId: Number(ids.plant), supplierId: Number(ids.supplierA), itemId: Number(ids.itemA), lotQty: 1000, package: null, remarks: null,
    }).expect(201);
    const query = { plantId: Number(ids.plant), supplierId: Number(ids.supplierA), itemId: Number(ids.itemA) };
    const own = await terminalGet(DEFAULTS, tokens.pop).query(query).expect(200);
    expectShape(schemaOf('mdm', '/mdm/supplier-item-defaults', 'get', 200), own.body);
    expect(own.body.items).toEqual([expect.objectContaining({ supplierId: Number(ids.supplierA), itemId: Number(ids.itemA), lotQty: 1000 })]);

    await terminalGet(DEFAULTS, tokens.foreignPop).query(query).expect(401);
    await terminalGet(DEFAULTS, tokens.pop).query({ ...query, plantId: Number(ids.foreignPlant) }).expect(401);
    await terminalGet(DEFAULTS, tokens.mobile).query(query).expect(401);
  });

  it('G1-2 같은 조합 입하 중이 있으면 마감된 입하 LOT 이 reopenable=true 목록에 reopenable:false·OPEN_RECEIPT_EXISTS·그 번호로 나오고 :reopen-receipt 는 409', async () => {
    const closed = await closedLot(ids.supplierB, ids.itemA);
    const free = await closedLot(ids.supplierC, ids.itemA);
    const { inboundLot: open } = await issueAndReceive(fx, batch(ids.supplierB, ids.itemA, 1));

    const listed = await webGet(`${LOTS}?plantId=${String(ids.plant)}&reopenable=true&size=200`).expect(200);
    expectShape(schemaOf('logistics', '/logistics/inbound-lots', 'get', 200), listed.body);
    const rows = listed.body.items as LotRow[];
    expect(rows.find((row) => row.inboundLotId === closed.inboundLotId)).toMatchObject({
      statusCode: 'RECEIVED', reopenable: false, reopenBlockerCode: 'OPEN_RECEIPT_EXISTS', openInboundLotNo: open.inboundLotNo,
      supplierId: Number(ids.supplierB), itemId: Number(ids.itemA),
    });
    expect(rows.find((row) => row.inboundLotId === free.inboundLotId)).toMatchObject({ reopenable: true, reopenBlockerCode: null, openInboundLotNo: null });
    const others = await webGet(`${LOTS}?plantId=${String(ids.plant)}&reopenable=false&size=200`).expect(200);
    expect((others.body.items as LotRow[]).map((row) => row.inboundLotId)).not.toContain(closed.inboundLotId);
    // 막힘 줄은 같은 조합 RECEIVING 행으로 그린다 — 그 행에 id·상태·공급사·품목이 있다.
    const receiving = await webGet(`${LOTS}?plantId=${String(ids.plant)}&closable=true&supplierId=${String(ids.supplierB)}`).expect(200);
    expect(receiving.body.items).toEqual([expect.objectContaining({
      inboundLotId: open.inboundLotId, inboundLotNo: open.inboundLotNo, statusCode: 'RECEIVING', supplierId: Number(ids.supplierB), itemId: Number(ids.itemA),
      reopenBlockerCode: null, openInboundLotNo: null,
    })]);

    const response = await webSend('post', `${LOTS}/${String(closed.inboundLotId)}:reopen-receipt`, { versionNo: closed.versionNo }).expect(409);
    expect((response.body.errors as { code: string }[]).map((error) => error.code)).toEqual(['OPEN_RECEIPT_EXISTS']);
    expect(response.body.openInboundLotNo).toBe(open.inboundLotNo);
  });

  it('G1-3 입하 LOT IQC 요청(targetTypeCode INBOUND_LOT)의 상세·목록이 품질 계약을 통과한다', async () => {
    const closed = await closedLot(ids.supplierD, ids.itemA);
    expect(closed.iqcRequestId).not.toBeNull();
    const detail = await webGet(`/api/quality/inspection-requests/${String(closed.iqcRequestId)}`).expect(200);
    expectShape(schemaOf('quality', '/quality/inspection-requests/{inspectionRequestId}', 'get', 200), detail.body);
    expect(detail.body).toMatchObject({ targetTypeCode: 'INBOUND_LOT', targetId: closed.inboundLotId });

    const listed = await webGet(`/api/quality/inspection-requests?inspectionTypeCode=IQC&itemId=${String(ids.itemA)}&size=200`).expect(200);
    expectShape(schemaOf('quality', '/quality/inspection-requests', 'get', 200), listed.body);
    expect((listed.body.items as { inspectionRequestId: number }[]).map((row) => row.inspectionRequestId)).toContain(closed.iqcRequestId);
  });

  describe('G1-4 입하 LOT 받기로 만든(ON_FINALIZE) 입하는 줄 치환이 통째로 409 STATE_LOCKED', () => {
    let receiptId: number;
    let line: { inboundReceiptLineId: number; itemId: number; receivedQty: number; uomId: number; supplierLotMissing: boolean };

    beforeAll(async () => {
      const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierE, ids.itemA, 2));
      const row = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLot.inboundLotId) }, include: { inbound_receipt_line: true } });
      receiptId = Number(row.inbound_receipt_line.inbound_receipt_id);
      line = {
        inboundReceiptLineId: Number(row.inbound_receipt_line.inbound_receipt_line_id), itemId: Number(ids.itemA),
        receivedQty: Number(row.inbound_receipt_line.received_qty), uomId: Number(ids.ea), supplierLotMissing: false,
      };
    });

    it('G1-4 줄을 더하면 409 STATE_LOCKED 이고 줄이 그대로다', async () => {
      await expectLocked(receiptId, [line, { itemId: Number(ids.itemA), receivedQty: 1, uomId: Number(ids.ea), supplierLotMissing: false }]);
      expect(await prisma.inbound_receipt_line.count({ where: { inbound_receipt_id: BigInt(receiptId) } })).toBe(1);
    });

    it('G1-4 품목을 바꾸면 409 STATE_LOCKED', async () => {
      await expectLocked(receiptId, [{ ...line, itemId: Number(ids.itemN) }]);
    });

    it('G1-4 P/O 라인을 다시 쓰면 409 STATE_LOCKED 이고 P/O 받은 양을 건드리지 않는다', async () => {
      const order = await makeOrder(ids.supplierE, ids.itemA, [100]);
      await expectLocked(receiptId, [{ ...line, purchaseOrderLineId: Number(order.lineIds[0]) }]);
      expect(Number((await prisma.purchase_order_line.findUniqueOrThrow({ where: { purchase_order_line_id: order.lineIds[0] } })).received_qty)).toBe(0);
    });

    it('G1-4 이전 데이터(PER_RECEIPT) 입하는 줄을 더할 수 있다(200)', async () => {
      const legacy = await makeLegacyReceipt(ids.supplierE, ids.itemA, 10);
      const response = await putLines(legacy.receiptId, await receiptEtag(legacy.receiptId), [
        { inboundReceiptLineId: Number(legacy.lineId), itemId: Number(ids.itemA), receivedQty: 10, uomId: Number(ids.ea), supplierLotMissing: false },
        { itemId: Number(ids.itemA), receivedQty: 3, uomId: Number(ids.ea), supplierLotMissing: false },
      ]).expect(200);
      expect(response.body.items).toHaveLength(2);
    });

    async function expectLocked(id: number, items: object[]): Promise<void> {
      const response = await putLines(id, await receiptEtag(id), items).expect(409);
      expect(response.body.errors).toEqual([expect.objectContaining({ code: 'STATE_LOCKED' })]);
    }
  });

  it('G1-6 P/O 라인 목록 행에 같은 공장·공급사·품목의 입하 중 입하 LOT(receivingInboundLots) — 마감하면 빈다', async () => {
    const order = await makeOrder(ids.supplierF, ids.itemA, [100, 50]);
    const other = await makeOrder(ids.supplierF, ids.itemN, [10]);
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierF, ids.itemA, 2));
    const path = `/api/logistics/purchase-order-lines?plantId=${String(ids.plant)}&supplierId=${String(ids.supplierF)}`;

    const listed = await webGet(path).expect(200);
    expectShape(schemaOf('logistics', '/logistics/purchase-order-lines', 'get', 200), listed.body);
    const rows = listed.body.items as { purchaseOrderLineId: number; receivingInboundLots: unknown[] }[];
    const receiving = [{ inboundLotId: inboundLot.inboundLotId, inboundLotNo: inboundLot.inboundLotNo, receivedQty: 10 }];
    for (const lineId of order.lineIds) {
      expect(rows.find((row) => row.purchaseOrderLineId === Number(lineId))?.receivingInboundLots).toEqual(receiving);
    }
    expect(rows.find((row) => row.purchaseOrderLineId === Number(other.lineIds[0]))?.receivingInboundLots).toEqual([]);

    await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    const after = await webGet(path).expect(200);
    expect((after.body.items as { receivingInboundLots: unknown[] }[]).every((row) => row.receivingInboundLots.length === 0)).toBe(true);
  });

  // ── G1 2차 ─────────────────────────────────────────────────────

  it('G1-2-1 POP 단말이 GET /mdm/items/{itemId}/uom-conversions 를 읽는다(200) — MOBILE 401', async () => {
    const path = `/api/mdm/items/${String(ids.itemA)}/uom-conversions`;
    const own = await terminalGet(path, tokens.pop).expect(200);
    expectShape(schemaOf('mdm', '/mdm/items/{itemId}/uom-conversions', 'get', 200), own.body);
    await terminalGet(path, tokens.mobile).expect(401);
  });

  it('G1-2-2 대기 목록 후보에 미마감 P/O 라인만 있는 공급사·품목이 대기 0개 행으로 선다 — 마감된 P/O 는 아니다', async () => {
    await makeOrder(ids.supplierG, ids.itemA, [100]);
    const closedOrder = await makeOrder(ids.supplierG, ids.itemN, [100]);
    await prisma.purchase_order.updateMany({
      where: { purchase_order_line: { some: { purchase_order_line_id: closedOrder.lineIds[0] } } }, data: { status_code: 'CLOSED' },
    });
    const response = await terminalGet('/api/logistics/waiting-material-lots', tokens.pop)
      .query({ plantId: Number(ids.plant), supplierId: Number(ids.supplierG) }).expect(200);
    expectShape(schemaOf('logistics', '/logistics/waiting-material-lots', 'get', 200), response.body);
    expect(response.body.items).toEqual([expect.objectContaining({
      supplierId: Number(ids.supplierG), itemId: Number(ids.itemA), waitingCount: 0, waitingQty: 0, lastIssuedAt: null, batches: [], lots: [],
    })]);
  });

  it('G1-2-3 마감 → 마감 취소 → 다시 마감하면 IQC_INSPECTION_REQUESTED 인계 알림이 같은 입하에 2건', async () => {
    const first = await closedLot(ids.supplierH, ids.itemA);
    await webSend('post', `${LOTS}/${String(first.inboundLotId)}:reopen-receipt`, { versionNo: first.versionNo }).expect(200);
    await closeInboundLotFixture(fx, first.inboundLotId);
    const row = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(first.inboundLotId) }, include: { inbound_receipt_line: true } });
    const events = await prisma.notification_event.findMany({
      where: { event_type_code: 'IQC_INSPECTION_REQUESTED', aggregate_type_code: 'INBOUND_RECEIPT', aggregate_id: row.inbound_receipt_line.inbound_receipt_id },
    });
    expect(events).toHaveLength(2);
  });

  it('G1-2-6 입고 줄 목록의 기간 누락 400 문구에 입하 LOT 번호·입하 LOT 이 들어 있다', async () => {
    const rejected = await webGet('/api/logistics/goods-receipt-lines?receiptTypeCode=MATERIAL').expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'receiptDateFrom', code: 'REQUIRED' });
    expect(rejected.body.errors[0].message).toContain('입하 LOT 번호(inboundLotNo), 입하 LOT(inboundLotId)');
  });

  it('G1-2-7 헤더 PUT — 새 흐름 입하의 공급사 변경은 409 STATE_LOCKED, 공급사 그대로면 200, 이전 데이터는 공급사도 바꿀 수 있다', async () => {
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierI, ids.itemA, 1));
    const row = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLot.inboundLotId) }, include: { inbound_receipt_line: true } });
    const receiptId = Number(row.inbound_receipt_line.inbound_receipt_id);
    const header = (supplier: bigint) => ({ supplierId: Number(supplier), receiptDatetime: `${DAY}T03:00:00.000Z`, remarks: '관문' });

    const locked = await putHeader(receiptId, header(ids.supplierJ), 409);
    expectShape(schemaOf('logistics', '/logistics/inbound-receipts/{inboundReceiptId}', 'put', 409), locked.body);
    expect(locked.body.errors).toEqual([expect.objectContaining({ code: 'STATE_LOCKED' })]);
    expect((await prisma.inbound_receipt.findUniqueOrThrow({ where: { inbound_receipt_id: BigInt(receiptId) } })).supplier_id).toBe(ids.supplierI);
    await putHeader(receiptId, header(ids.supplierI), 200);

    const legacy = await makeLegacyReceipt(ids.supplierI, ids.itemA, 10);
    await putHeader(legacy.receiptId, header(ids.supplierJ), 200);
  });

  // ── 도우미 ─────────────────────────────────────────────────────

  async function putHeader(receiptId: number, body: object, status: number): Promise<request.Response> {
    const etag = await receiptEtag(receiptId);
    return webSend('put', `/api/logistics/inbound-receipts/${String(receiptId)}`, body).set('If-Match', etag).expect(status);
  }

  function webGet(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', cookie);
  }

  function webSend(method: 'post' | 'put', path: string, body: object): request.Test {
    return request(app.getHttpServer())[method](path).set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx)).send(body);
  }

  function terminalGet(path: string, token: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
  }

  function putLines(receiptId: number, etag: string, items: object[]): request.Test {
    return webSend('put', `/api/logistics/inbound-receipts/${String(receiptId)}/lines`, { items }).set('If-Match', etag);
  }

  async function receiptEtag(receiptId: number): Promise<string> {
    const response = await webGet(`/api/logistics/inbound-receipts/${String(receiptId)}`).expect(200);
    return response.headers.etag as string;
  }

  async function closedLot(supplier: bigint, item: bigint): Promise<ClosedInboundLot> {
    const { inboundLot } = await issueAndReceive(fx, batch(supplier, item, 1));
    return closeInboundLotFixture(fx, inboundLot.inboundLotId);
  }

  async function makeOrder(supplier: bigint, item: bigint, ordered: number[]): Promise<{ lineIds: bigint[] }> {
    seq += 1;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-${String(seq)}`, supplier_id: supplier, business_unit_id: ids.unit, plant_id: ids.plant,
        order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
      },
    });
    const lineIds: bigint[] = [];
    for (const [index, qty] of ordered.entries()) {
      lineIds.push((await prisma.purchase_order_line.create({
        data: { purchase_order_id: order.purchase_order_id, line_no: index + 1, item_id: item, uom_id: ids.ea, ordered_qty: qty, received_qty: 0 },
      })).purchase_order_line_id);
    }
    return { lineIds };
  }

  /** 이전 데이터 입하 — 줄 하나에 PER_RECEIPT 입하 LOT(데이터 이전 1). */
  async function makeLegacyReceipt(supplier: bigint, item: bigint, qty: number): Promise<{ receiptId: number; lineId: bigint }> {
    seq += 1;
    const header = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-${String(seq)}`, supplier_id: supplier, plant_id: ids.plant, receipt_datetime: new Date(), status_code: 'REGISTERED' },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: { inbound_receipt_id: header.inbound_receipt_id, line_no: 1, item_id: item, received_qty: qty, uom_id: ids.ea,
        supplier_lot_missing: false, supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED' },
    });
    await prisma.inbound_lot.create({
      data: { inbound_lot_no: `IL-MIG-${String(line.inbound_receipt_line_id)}`, plant_id: ids.plant, item_id: item, supplier_id: supplier, uom_id: ids.ea,
        status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`), received_closed_at: new Date(),
        erp_send_mode_code: 'PER_RECEIPT', inbound_receipt_line_id: line.inbound_receipt_line_id },
    });
    return { receiptId: Number(header.inbound_receipt_id), lineId: line.inbound_receipt_line_id };
  }

  async function terminalToken(plant: bigint, type: 'POP' | 'MOBILE'): Promise<string> {
    terminalSeq += 1;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T${String(terminalSeq)}`, plant_id: plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(plant),
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '관문법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '관문사업부' },
    })).business_unit_id;
    for (const [key, code] of [['plant', 'P'], ['foreignPlant', 'P2']] as const) {
      ids[key] = (await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-${code}`, plant_name: `관문공장${code}`, timezone_code: TZ },
      })).plant_id;
    }
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    for (const [name, code, required] of [['itemA', 'A', true], ['itemN', 'N', false]] as const) {
      ids[name] = (await prisma.item.create({
        data: { item_code: `${PREFIX}-${code}`, item_name: `관문자재${code}`, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea,
          lot_controlled: true, inspection_required: required },
      })).item_id;
    }
    for (const code of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
      ids[`supplier${code}`] = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-${code}`, partner_name: `${PREFIX} 공급사 ${code}` } })).partner_id;
    }
    await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: '관문작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    });
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `관문 ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `관문 ${suffix}` } });
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
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN (${plants}))`,
      `DELETE FROM logistics.purchase_order WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
      `DELETE FROM mdm.supplier_item_default WHERE plant_id IN (${plants})`,
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
