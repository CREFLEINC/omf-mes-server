/**
 * 피처 005 S2 읽기 전환 뒤처리 — 「입하 줄 ↔ LOT」 읽기 넷(omf-all-around#254 · D-2).
 *
 * 새 모양(입하 줄 `lot_id` 없음 · 입하 LOT 1 = 자재 관리 LOT 2)은 쓰기 경로가 아직 없어(S3~) 시험 준비에서 직접 넣는다
 * (`material-lot-read-switch.e2e-spec.ts` 의 `newShape()` 와 같은 모양). 갈래마다 입하를 따로 둬 서로의 줄이 섞이지 않는다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E005RF';
const LOGIN_ID = 'e2e-005-read-followups';
const PASSWORD = '읽기-뒤처리-비밀번호';
const ROLE = 'E2E_005_READ_FOLLOWUPS';
const DAY = '2026-10-23';

const key = (): string => randomUUID();

interface NewShape {
  lineId: bigint;
  lotIds: bigint[];
}

describe('피처 005 S2 뒤처리 — 새 모양 입하 줄의 LOT 읽기 넷 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let terminalToken: string;
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
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('D2-1 새 모양 입하의 자재 관리 LOT 을 투입하면 입하 취소가 옛 모양과 같은 400 SUCCESSOR_EXISTS 로 막힌다', async () => {
    const fresh = await receipt('CN');
    const shape = await newShape(fresh, [5, 5]);
    expect((await progress(fresh)).cancellable).toBe(true);
    await consume(shape.lotIds[1], 3);

    const detail = await progress(fresh);
    expect(detail).toMatchObject({ cancellable: false, cancelBlockedReasonCode: 'SUCCESSOR_EXISTS', successorCount: 1 });
    const blocked = await requestCancel(fresh).expect(400);

    // 옛 모양(줄 `lot_id` 하나)도 같은 오류다.
    const legacyReceipt = await receipt('CO');
    const legacy = await oldShape(legacyReceipt, 4);
    await consume(legacy, 2);
    const legacyBlocked = await requestCancel(legacyReceipt).expect(400);
    expect(blocked.body).toEqual(legacyBlocked.body);
    expect(blocked.body.errors[0]).toMatchObject({ code: 'SUCCESSOR_EXISTS' });
    const row = await prisma.inbound_receipt.findUniqueOrThrow({ where: { inbound_receipt_id: fresh }, select: { status_code: true } });
    expect(row.status_code).toBe('REGISTERED');
  });

  it('D2-1 labelIssued 거르기가 새 모양 줄을 LOT 의 라벨 발행 기록으로 발행됨/대기로 가른다(헤더 목록·줄)', async () => {
    const issuedReceipt = await receipt('LI');
    const pendingReceipt = await receipt('LP');
    const issued = await newShape(issuedReceipt, [2, 3]);
    const pending = await newShape(pendingReceipt, [4]);
    // 두 LOT 중 하나만 발행해도 줄은 발행됨이다.
    await prisma.document_issue_log.create({
      data: { document_type_code: 'MATERIAL_LOT_LABEL', target_type_code: 'LOT', target_id: issued.lotIds[1], lot_id: issued.lotIds[1],
        issued_worker_id: ids.worker },
    });

    expect(await headerIds(true)).toEqual([Number(issuedReceipt)]);
    expect(await headerIds(false)).toEqual([Number(pendingReceipt)]);
    expect(await lineIds(issuedReceipt, true)).toEqual([Number(issued.lineId)]);
    expect(await lineIds(issuedReceipt, false)).toEqual([]);
    expect(await lineIds(pendingReceipt, false)).toEqual([Number(pending.lineId)]);
    expect(await lineIds(pendingReceipt, true)).toEqual([]);
  });

  it('D2-1 옛 POST /trace/lots(입하 원천·단말)는 새 모양 줄을 401 PERMISSION_DENIED 로 거절한다 — LOT 없는 옛 줄은 연다', async () => {
    const fresh = await receipt('TG');
    const shape = await newShape(fresh, [5]);
    const empty = await inboundLine(fresh, 6);

    const denied = await terminalCreateLot(shape.lineId, 5).expect(401);
    expect(denied.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await prisma.lot.count({ where: { source_type_code: 'INBOUND_RECEIPT_LINE', source_id: shape.lineId } })).toBe(1);

    const opened = await terminalCreateLot(empty, 6);
    expect(opened.status).not.toBe(401);
  });

  it('D2-1 P/O 목록 ?lotId= 가 새 모양 자재 관리 LOT 으로 그 줄의 발주를 찾는다', async () => {
    const fresh = await receipt('PO');
    const shape = await newShape(fresh, [1, 2]);

    for (const lotId of shape.lotIds) {
      const body = (await get('/api/logistics/purchase-orders').query({ lotId: Number(lotId), size: 100 }).expect(200)).body as {
        items: { purchaseOrderId: number }[];
      };
      expect(body.items.map((item) => item.purchaseOrderId)).toEqual([Number(ids.order)]);
    }
  });

  // ─────────────────────────────── 준비 ───────────────────────────────

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', cookie);
  }

  async function progress(receiptId: bigint): Promise<{ cancellable: boolean; cancelBlockedReasonCode?: string; successorCount: number }> {
    return (await get(`/api/logistics/document-progress/INBOUND_RECEIPT/${String(receiptId)}`).expect(200)).body.progress;
  }

  function requestCancel(receiptId: bigint): request.Test {
    return request(app.getHttpServer())
      .post(`/api/logistics/document-progress/INBOUND_RECEIPT/${String(receiptId)}:request-cancel`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ reason: '읽기 전환 시험' });
  }

  async function headerIds(labelIssued: boolean): Promise<number[]> {
    const body = (await get('/api/logistics/inbound-receipts').query({ q: `${PREFIX}-IR-L`, labelIssued, size: 100 }).expect(200))
      .body as { items: { inboundReceiptId: number }[] };
    return body.items.map((item) => item.inboundReceiptId);
  }

  async function lineIds(receiptId: bigint, labelIssued: boolean): Promise<number[]> {
    const body = (await get(`/api/logistics/inbound-receipts/${String(receiptId)}/lines`).query({ labelIssued, size: 100 }).expect(200))
      .body as { items: { inboundReceiptLineId: number }[] };
    return body.items.map((item) => item.inboundReceiptLineId);
  }

  function terminalCreateLot(lineId: bigint, qty: number): request.Test {
    return request(app.getHttpServer())
      .post('/api/trace/lots')
      .set('Authorization', `Bearer ${terminalToken}`)
      .set('X-Worker-No', `${PREFIX}-W1`)
      .set('Idempotency-Key', key())
      .send({
        itemId: Number(ids.item), lotTypeCode: 'MATERIAL', plantId: Number(ids.plant), initialQty: qty, uomId: Number(ids.uom),
        sourceTypeCode: 'INBOUND_RECEIPT_LINE', sourceId: Number(lineId), numberSourceCode: 'MES',
        businessDate: DAY, occurredAt: `${DAY}T02:00:00.000Z`,
      });
  }

  async function receipt(tag: string): Promise<bigint> {
    return (await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR-${tag}`, supplier_id: ids.supplier, plant_id: ids.plant,
        receipt_datetime: new Date(`${DAY}T01:00:00.000Z`), status_code: 'REGISTERED',
      },
    })).inbound_receipt_id;
  }

  async function inboundLine(receiptId: bigint, qty: number): Promise<bigint> {
    seq += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: receiptId, line_no: seq, item_id: ids.item, received_qty: qty, uom_id: ids.uom,
        supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED',
      },
    });
    await prisma.inbound_receipt_po_allocation.create({
      data: { inbound_receipt_line_id: line.inbound_receipt_line_id, purchase_order_line_id: ids.orderLine, allocated_qty: qty },
    });
    return line.inbound_receipt_line_id;
  }

  /** 새 흐름이 만들 모양 — 입하 줄 `lot_id` 없음, 입하 LOT(마감됨)과 그 줄을 원천으로 한 자재 관리 LOT 들. */
  async function newShape(receiptId: bigint, qtys: number[]): Promise<NewShape> {
    const lineId = await inboundLine(receiptId, qtys.reduce((sum, qty) => sum + qty, 0));
    const inboundLot = await prisma.inbound_lot.create({
      data: {
        inbound_lot_no: `IL-${PREFIX}-${seq}`, plant_id: ids.plant, item_id: ids.item, supplier_id: ids.supplier, uom_id: ids.uom,
        status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`),
        received_closed_at: new Date(`${DAY}T01:30:00.000Z`), erp_send_mode_code: 'ON_FINALIZE', inbound_receipt_line_id: lineId,
      },
    });
    const lotIds: bigint[] = [];
    for (const [index, qty] of qtys.entries()) {
      lotIds.push((await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-N${seq}-${index}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty,
          uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: lineId, status_code: 'AVAILABLE',
          lifecycle_status_code: 'ACTIVE', inbound_lot_id: inboundLot.inbound_lot_id,
        },
      })).lot_id);
    }
    return { lineId, lotIds };
  }

  /** 옛 모양 — 줄 `lot_id` 가 그 줄을 원천으로 한 LOT 하나를 가리킨다. */
  async function oldShape(receiptId: bigint, qty: number): Promise<bigint> {
    const lineId = await inboundLine(receiptId, qty);
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-O${seq}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty,
        uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: lineId, status_code: 'AVAILABLE',
        lifecycle_status_code: 'ACTIVE',
      },
    });
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: lineId }, data: { lot_id: lot.lot_id } });
    return lot.lot_id;
  }

  /** LOT 축 후속 — 자재 투입 한 건(원장은 트리거가 지우지 못하게 막아 정리가 어렵다). */
  async function consume(lotId: bigint, qty: number): Promise<void> {
    seq += 1;
    await prisma.material_consumption.create({
      data: {
        consumption_no: `${PREFIX}-MC-${seq}`, work_order_id: ids.workOrder, item_id: ids.item, lot_id: lotId,
        consumption_type_code: 'NORMAL', input_qty: qty, uom_id: ids.uom, occurred_at: new Date(`${DAY}T03:00:00.000Z`),
        worker_id: ids.worker, status_code: 'RECORDED', idempotency_key: `${PREFIX}-MC-${seq}`,
      },
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '읽기뒤처리법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '읽기뒤처리사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '읽기뒤처리공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    })).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: {
        item_code: `${PREFIX}-ITEM`, item_name: '읽기뒤처리자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom,
        lot_controlled: true, inspection_required: true,
      },
    })).item_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-SUP`, partner_name: `${PREFIX}-SUP` } })).partner_id;
    ids.order = (await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO`, supplier_id: ids.supplier, business_unit_id: ids.unit, plant_id: ids.plant,
        order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
      },
    })).purchase_order_id;
    ids.orderLine = (await prisma.purchase_order_line.create({
      data: { purchase_order_id: ids.order, line_no: 1, item_id: ids.item, ordered_qty: 1000, uom_id: ids.uom },
    })).purchase_order_line_id;
    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'PRODUCTION' } });
    const routing = await prisma.routing.create({ data: { item_id: ids.item, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    const operation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: PREFIX },
    });
    ids.workOrder = (await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`, routing_operation_id: operation.routing_operation_id, item_id: ids.item, order_qty: 100,
        uom_id: ids.uom, status_code: 'RELEASED',
      },
    })).work_order_id;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-POP`, plant_id: ids.plant, terminal_type_code: 'POP', status_code: 'RUNNING' },
    });
    terminalToken = app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(ids.plant),
    });
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '읽기뒤처리', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '읽기뒤처리용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission) => ({ role_id: role.role_id, permission_code: permission.code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    ids.worker = (await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`, worker_name: '읽기뒤처리작업자', business_unit_id: ids.unit, plant_id: ids.plant,
        app_user_id: user.app_user_id, status_code: 'EMPLOYED',
      },
    })).worker_id;
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', key())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`;
    const lines = `SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`;
    const terminals = `SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM production.material_consumption WHERE consumption_no LIKE '${PREFIX}%'`,
      `DELETE FROM app.document_issue_log WHERE lot_id IN (${lots})`,
      `DELETE FROM audit.audit_event WHERE terminal_id IN (${terminals})`,
      `DELETE FROM quality.inspection_request WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (${lines})`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order
         WHERE purchase_order_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.purchase_order WHERE purchase_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM planning.routing_operation WHERE routing_id IN (SELECT routing_id FROM planning.routing WHERE routing_code LIKE '${PREFIX}%')`,
      `DELETE FROM planning.routing WHERE routing_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.process WHERE process_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
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
