/**
 * 피처 005 S7 — 옛 입하·LOT 생성 경로 닫기(omf-all-around#254 · T039 · FR-036 · R-6 · 계약 §7).
 * `POST /logistics/inbound-receipts`·`:split`·`:per-line`·입하 원천 `POST /trace/lots` 는 409 STATE_LOCKED 이고, 이전 데이터
 * (`lot_id` 없는 옛 줄 · `PER_RECEIPT`)의 조회·배정은 그대로다. 옛 줄은 이제 만들 경로가 없어 직접 넣는다.
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
import { requestFingerprint } from '../src/common/idempotency';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  Authorize, InboundLotFixture, closeInboundLotFixture, idempotencyKey, issueAndReceive, sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'E5LG';
const DAY = '2026-11-12';
const AT = `${DAY}T03:00:00.000Z`;
const WORKER_NO = `${PREFIX}-W1`;
const CLOSED_MESSAGE = '입하 LOT 받기를 쓰세요';

const CONTRACT = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(CONTRACT, 'contract');
const conflictSchema = (path: string): ValidateFunction => ajv.compile({
  $ref: `contract#/paths/${path.replace(/\//g, '~1')}/post/responses/409/content/application~1json/schema`,
});

describe('피처 005 S7 — 옛 입하·LOT 생성 경로 닫기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let web: Authorize;
  let mobile: Authorize;
  let pop: Authorize;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
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
    web = sessionAuth(await makeUser());
    mobile = terminalAuth(await terminalToken('MOBILE'), WORKER_NO);
    pop = terminalAuth(await terminalToken('POP'), WORKER_NO);
    fx = { app, issuer: pop, receiver: mobile, businessDate: DAY, keys };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('FR-036 POST /logistics/inbound-receipts·:per-line(웹·PDA)·:split(웹)은 409 STATE_LOCKED「입하 LOT 받기를 쓰세요」이고 아무것도 서지 않는다', async () => {
    const cases: [string, Authorize, Record<string, unknown>][] = [
      ['/logistics/inbound-receipts', web, receiptBody()],
      ['/logistics/inbound-receipts', mobile, receiptBody()],
      ['/logistics/inbound-receipts:per-line', web, receiptBody()],
      ['/logistics/inbound-receipts:per-line', mobile, receiptBody()],
      ['/logistics/inbound-receipts:split', web, splitBody()],
    ];
    for (const [path, auth, body] of cases) {
      const response = await post(path, auth).send(body);
      expect([path, response.status]).toEqual([path, 409]);
      expectClosed(path, response.body);
    }
    expect(await prisma.inbound_receipt.count({ where: { plant_id: ids.plant } })).toBe(0);
    expect(await prisma.lot.count({ where: { plant_id: ids.plant } })).toBe(0);
    expect(Number((await orderLine(ids.orderLine)).received_qty)).toBe(0);
  });

  it('FR-036 닫기 전에 성공한 PDA 입하를 같은 Idempotency-Key 로 다시 보내면 저장된 201 을 받고, 다른 본문이면 409 conflictCause 다', async () => {
    const body = receiptBody();
    const key = idempotencyKey(fx);
    const stored = { inboundReceipt: { inboundReceiptNo: `${PREFIX}-STORED` }, lines: [] };
    await prisma.idempotency_record.create({
      data: {
        idempotency_key: key, request_fingerprint: requestFingerprint('POST /api/logistics/inbound-receipts', body), status: 'COMPLETED',
        response_status: 201, response_body: stored, completed_at: new Date(), expires_at: new Date(Date.now() + 3600_000),
      },
    });

    const replayed = await mobile(request(app.getHttpServer()).post('/api/logistics/inbound-receipts')).set('Idempotency-Key', key).send(body);
    expect(replayed.status).toBe(201);
    expect(replayed.body).toEqual(stored);
    const reused = await mobile(request(app.getHttpServer()).post('/api/logistics/inbound-receipts')).set('Idempotency-Key', key)
      .send({ ...body, receiptDatetime: `${DAY}T04:00:00.000Z` }).expect(409);
    const validate = conflictSchema('/logistics/inbound-receipts');
    validate(reused.body);
    expect(validate.errors ?? []).toEqual([]);
    expect(reused.body).toMatchObject({ conflictCause: 'user' });
  });

  it('FR-036 입하 원천 POST /trace/lots(POP·PDA·웹, MES·SUPPLIER)는 409 STATE_LOCKED 이고 옛 줄에 LOT 이 서지 않는다', async () => {
    const legacy = await legacyLine(40);
    for (const auth of [pop, mobile, web]) {
      for (const numberSourceCode of ['MES', 'SUPPLIER']) {
        const response = await post('/trace/lots', auth).send(lotBody(legacy.lineId, 40, numberSourceCode));
        expect([numberSourceCode, response.status]).toEqual([numberSourceCode, 409]);
        expectClosed('/trace/lots', response.body);
      }
    }
    expect(await prisma.lot.count({ where: { source_type_code: 'INBOUND_RECEIPT_LINE', source_id: legacy.lineId } })).toBe(0);
    const line = await prisma.inbound_receipt_line.findUniqueOrThrow({ where: { inbound_receipt_line_id: legacy.lineId } });
    expect(line.lot_id).toBeNull();
  });

  it('FR-036 GET /logistics/inbound-receipt-lines(라벨 대기)에 새 흐름 입하 줄은 없고 이전 데이터 줄만 있다', async () => {
    const legacy = await legacyLine(30);
    const { inboundLot } = await issueAndReceive(fx, {
      plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(ids.item), lotQty: 100, lotCount: 2,
    });
    const newLine = (await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLot.inboundLotId) } }))
      .inbound_receipt_line_id;

    const waiting = await lineIds({ labelIssued: false, supplierLotLabelAttached: false });
    expect(waiting).toContain(Number(legacy.lineId));
    expect(waiting).not.toContain(Number(newLine));
    const counts = (await read('/logistics/inbound-receipt-lines:supplier-counts')
      .query({ plantId: Number(ids.plant), labelIssued: false, supplierLotLabelAttached: false }).expect(200)).body as {
      items: { supplierId: number; pendingCount: number }[];
    };
    expect(counts.items.find((row) => row.supplierId === Number(ids.supplier))?.pendingCount).toBe(waiting.length);

    await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    expect(await lineIds({ labelIssued: false, supplierLotLabelAttached: false })).not.toContain(Number(newLine));
  });

  it('FR-036 이전 데이터 줄의 조회·배정은 그대로다 — 입하 상세·줄 목록·미배정 목록·배정 더하기/빼기', async () => {
    const legacy = await legacyLine(50, 20);
    const detail = await read(`/logistics/inbound-receipts/${String(legacy.receiptId)}`).expect(200);
    expect((detail.body as { lines: { inboundReceiptLineId: number; receivedQty: number }[] }).lines)
      .toEqual([expect.objectContaining({ inboundReceiptLineId: Number(legacy.lineId), receivedQty: 50 })]);
    await read(`/logistics/inbound-receipts/${String(legacy.receiptId)}/lines`).expect(200);

    const unallocated = (await read('/logistics/inbound-unallocated').query({ plantId: Number(ids.plant), size: 100 }).expect(200)).body as {
      items: { inboundReceiptLineId: number; unallocatedQty: number }[];
    };
    expect(unallocated.items.find((row) => row.inboundReceiptLineId === Number(legacy.lineId))?.unallocatedQty).toBe(30);

    const allocations = `/logistics/inbound-receipt-lines/${String(legacy.lineId)}/allocations`;
    const created = await post(allocations, web).send({ purchaseOrderLineId: Number(ids.orderLine2), qty: 30 }).expect(201);
    expect(created.body).toMatchObject({ inboundReceiptLineId: Number(legacy.lineId), allocatedQty: 30 });
    expect(Number((await orderLine(ids.orderLine2)).received_qty)).toBe(30);
    const allocationId = (created.body as { inboundReceiptPoAllocationId: number }).inboundReceiptPoAllocationId;
    await web(request(app.getHttpServer()).delete(`/api${allocations}/${String(allocationId)}`)).set('Idempotency-Key', idempotencyKey(fx)).expect(204);
    expect(Number((await orderLine(ids.orderLine2)).received_qty)).toBe(0);
  });

  // ─────────────────────────────── 준비 ───────────────────────────────

  function post(path: string, auth: Authorize): request.Test {
    return auth(request(app.getHttpServer()).post(`/api${path}`)).set('Idempotency-Key', idempotencyKey(fx));
  }

  function read(path: string): request.Test {
    return web(request(app.getHttpServer()).get(`/api${path}`));
  }

  function expectClosed(path: string, body: unknown): void {
    const validate = conflictSchema(path);
    validate(body);
    expect(validate.errors ?? []).toEqual([]);
    const [error] = (body as { errors: { code: string; message: string }[] }).errors;
    expect(error.code).toBe('STATE_LOCKED');
    expect(error.message).toContain(CLOSED_MESSAGE);
  }

  async function lineIds(query: Record<string, unknown>): Promise<number[]> {
    const body = (await read('/logistics/inbound-receipt-lines').query({ plantId: Number(ids.plant), size: 100, ...query }).expect(200)).body as {
      items: { inboundReceiptLineId: number }[];
    };
    return body.items.map((row) => row.inboundReceiptLineId);
  }

  function orderLine(id: bigint) {
    return prisma.purchase_order_line.findUniqueOrThrow({ where: { purchase_order_line_id: id } });
  }

  function receiptBody(): Record<string, unknown> {
    return {
      supplierId: Number(ids.supplier), plantId: Number(ids.plant), receiptDatetime: AT, businessDate: DAY, occurredAt: AT,
      lines: [{ purchaseOrderLineId: Number(ids.orderLine), itemId: Number(ids.item), receivedQty: 10, uomId: Number(ids.uom), supplierLotMissing: true }],
    };
  }

  function splitBody(): Record<string, unknown> {
    const { businessDate, occurredAt, ...part } = receiptBody();
    return { mode: 'NORMAL_ONLY', normal: part, businessDate, occurredAt };
  }

  function lotBody(lineId: bigint, qty: number, numberSourceCode: string): Record<string, unknown> {
    return {
      itemId: Number(ids.item), lotTypeCode: 'MATERIAL', plantId: Number(ids.plant), initialQty: qty, uomId: Number(ids.uom),
      sourceTypeCode: 'INBOUND_RECEIPT_LINE', sourceId: Number(lineId), numberSourceCode,
      ...(numberSourceCode === 'SUPPLIER' ? { lotNo: `${PREFIX}-SUP-${String(lineId)}` } : {}),
      businessDate: DAY, occurredAt: AT,
    };
  }

  /** 옛 경로가 만들던 모양 — 입하 LOT 없는 줄(`PER_RECEIPT` 이전 데이터), 아직 LOT 없음. `allocated` 만 P/O 라인에 배정. */
  async function legacyLine(qty: number, allocated = qty): Promise<{ receiptId: bigint; lineId: bigint }> {
    seq += 1;
    const receipt = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR-${String(seq)}`, supplier_id: ids.supplier, plant_id: ids.plant,
        receipt_datetime: new Date(AT), status_code: 'REGISTERED',
      },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: receipt.inbound_receipt_id, line_no: 1, purchase_order_line_id: ids.orderLine, item_id: ids.item,
        received_qty: qty, uom_id: ids.uom, supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED',
      },
    });
    if (allocated > 0) {
      await prisma.inbound_receipt_po_allocation.create({
        data: { inbound_receipt_line_id: line.inbound_receipt_line_id, purchase_order_line_id: ids.orderLine, allocated_qty: allocated },
      });
      await prisma.purchase_order_line.update({ where: { purchase_order_line_id: ids.orderLine }, data: { received_qty: { increment: allocated } } });
    }
    return { receiptId: receipt.inbound_receipt_id, lineId: line.inbound_receipt_line_id };
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-${type}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(ids.plant),
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '옛경로법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '옛경로사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '옛경로공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    })).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: {
        item_code: `${PREFIX}-A`, item_name: '옛경로자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom,
        lot_controlled: true, inspection_required: true,
      },
    })).item_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-S`, partner_name: `${PREFIX} 공급사` } })).partner_id;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO`, supplier_id: ids.supplier, business_unit_id: ids.unit, plant_id: ids.plant,
        order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
      },
    });
    for (const [name, lineNo] of [['orderLine', 1], ['orderLine2', 2]] as const) {
      ids[name] = (await prisma.purchase_order_line.create({
        data: { purchase_order_id: order.purchase_order_id, line_no: lineNo, item_id: ids.item, ordered_qty: 1000, uom_id: ids.uom },
      })).purchase_order_line_id;
    }
    await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: '옛경로작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    });
  }

  async function makeUser(): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-ALL`, user_name: '옛경로', status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_ALL`, role_name: '옛경로' } });
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission) => ({ role_id: role.role_id, permission_code: permission.code })) });
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
