/**
 * 피처 005 S12 — ERP 구매입고의 입고 쪽 제외(R-25 · T098). 새 흐름(`ON_FINALIZE`) 입하 LOT 은 입고·입고 취소 때 ERP 로 아무것도 가지 않고,
 * 이전 데이터(`PER_RECEIPT`)는 지금 경로(입고별 묶음·입고 취소 C 행·줄 축 배정 `ALLOC` 묶음) 그대로다(FR-051).
 * 새 흐름 LOT 은 도우미(발행 → 받기 → 마감 → IQC 합격), 이전 데이터 줄·LOT 은 데이터 이전 1 모양으로 직접 세운다. 입고·취소·배정은 서비스로
 * 부르고 묶음 행은 빌더로 만든다(선례 `erp-send-goods-receipt.e2e-spec.ts`). ⛔ 최종 마감 때 보내는 묶음은 #265.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { ContractException } from '../src/common/errors';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { RowDraft } from '../src/integration/erp/outbound-rows';
import { goodsReceiptBuilder } from '../src/integration/erp/send/goods-receipt.send';
import { DocumentCancelExecuteService } from '../src/logistics/document-progress/document-cancel-execute.service';
import { GoodsReceiptService } from '../src/logistics/goods-receipt/goods-receipt.service';
import { InboundAllocationService } from '../src/logistics/inbound-receipt/inbound-allocation.service';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { InboundLotFixture, IssuedMaterialLot, issueAndReceive, passInboundLotIqc, sessionAuth, terminalAuth } from './support/inbound-lot-fixture';

const PREFIX = 'E12E';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;

interface ReceiptLot {
  lotId: bigint;
  inboundLineId: bigint;
  qty: number;
}

describe('피처 005 S12 — ERP 구매입고 입고 쪽 제외 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let receipts: GoodsReceiptService;
  let cancels: DocumentCancelExecuteService;
  let allocations: InboundAllocationService;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let terminalSeq = 0;
  let seq = 0;
  /** US8-6 의 새 흐름 입하 줄 — FR-051 이 줄 축 배정이 막히는지 본다. */
  let newFlowLine: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    receipts = app.get(GoodsReceiptService);
    cancels = app.get(DocumentCancelExecuteService);
    allocations = app.get(InboundAllocationService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code));
    await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W2`, worker_name: 'ERP제외검사자', business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: ids.user, status_code: 'EMPLOYED' },
    });
    fx = {
      app, issuer: terminalAuth(await terminalToken('POP'), WORKER_NO), receiver: terminalAuth(await terminalToken('MOBILE'), WORKER_NO),
      businessDate: DAY, keys, inspector: sessionAuth(cookie), prisma,
    };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US8-6 SC-010 새 흐름 LOT 입고 → IF-GR-SEND 입고 묶음 없음, 입고 취소 → 취소 C 묶음 없음·「마감 승인 대기」에서 빠짐', async () => {
    await makeOrder(ids.s1, '2026-10-01', [20]);
    const passed = await passedLot(ids.s1, 2, 10);
    newFlowLine = passed.inboundLineId;
    const outboxBefore = await outboxCount();

    const detail = await receive(passed.lots.map((lot) => ({ lotId: BigInt(lot.lotId), inboundLineId: passed.inboundLineId, qty: lot.lotQty })));
    const receiptNo = detail.goodsReceipt.goodsReceiptNo;
    expect(detail.goodsReceipt.erpMessageQueued).toBe(false);
    expect(await messageOf(receiptNo)).toBeNull();
    expect(await finalizableOf(passed.inboundLotId)).toBe(true);

    await requestCancel(detail.goodsReceipt.goodsReceiptId);
    expect(await finalizableOf(passed.inboundLotId)).toBe(false);
    const cancelled = await cancels.cancel('GOODS_RECEIPT', BigInt(detail.goodsReceipt.goodsReceiptId), await receiptVersion(detail.goodsReceipt.goodsReceiptId), Number(ids.user));
    expect(cancelled.statusCode).toBe('CANCELLED');
    expect(await messageOf(`CANCEL:${receiptNo}`)).toBeNull();
    expect(await outboxCount()).toBe(outboxBefore);
    const row = await request(app.getHttpServer()).get(`/api/logistics/inbound-lots/${String(passed.inboundLotId)}`).set('Cookie', cookie).expect(200);
    expect(row.body).toMatchObject({ finalizable: false, goodsReceivedQty: 0, finalizeBlockers: [{ code: 'NOT_RECEIVED', lotNos: passed.lots.map((lot) => lot.lotNo).sort() }] });
  });

  it('SC-010 이전 데이터 + 새 흐름 LOT 이 섞인 입고 한 건 → 입고 묶음은 적재하고 행은 이전 데이터 줄 몫만', async () => {
    const legacyOrder = await makeOrder(ids.s2, '2026-09-01', [30], 30);
    const legacy = await makeLegacyLot(ids.s2, 30, [{ orderLine: legacyOrder[0], qty: 30 }]);
    const newOrder = await makeOrder(ids.s2, '2026-08-01', [10]);
    const passed = await passedLot(ids.s2, 1, 10);
    expect(await prisma.inbound_receipt_po_allocation.findMany({ where: { inbound_receipt_line_id: passed.inboundLineId }, select: { purchase_order_line_id: true } }))
      .toEqual([{ purchase_order_line_id: newOrder[0] }]);

    const detail = await receive([legacy, { lotId: BigInt(passed.lots[0].lotId), inboundLineId: passed.inboundLineId, qty: 10 }]);
    expect(detail.goodsReceipt.erpMessageQueued).toBe(true);
    expect(await messageOf(detail.goodsReceipt.goodsReceiptNo)).toMatchObject({ target_type_code: 'GOODS_RECEIPT', status_code: 'PENDING' });
    const rows = await build('GOODS_RECEIPT', BigInt(detail.goodsReceipt.goodsReceiptId));
    expect(summary(rows)).toEqual([[orderNoOf(legacyOrder[0]), 1, '30']]);
  });

  it('US8-7 FR-051 이전 데이터 LOT 입고 → 입고 취소 → 다시 입고 = 입고별 묶음·C 묶음, 줄 축 ALLOC 묶음은 이전 데이터만, 같은 수량이 두 키로 가는 일 0건', async () => {
    const order = await makeOrder(ids.s3, '2026-09-01', [30, 10], 30);
    const legacy = await makeLegacyLot(ids.s3, 40, [{ orderLine: order[0], qty: 30 }]);

    const first = await receive([legacy]);
    expect(await messageOf(first.goodsReceipt.goodsReceiptNo)).not.toBeNull();
    expect(summary(await build('GOODS_RECEIPT', BigInt(first.goodsReceipt.goodsReceiptId)))).toEqual([[orderNoOf(order[0]), 1, '30']]);
    await requestCancel(first.goodsReceipt.goodsReceiptId);
    await cancels.cancel('GOODS_RECEIPT', BigInt(first.goodsReceipt.goodsReceiptId), await receiptVersion(first.goodsReceipt.goodsReceiptId), Number(ids.user));
    expect(await messageOf(`CANCEL:${first.goodsReceipt.goodsReceiptNo}`)).toMatchObject({ target_type_code: 'GOODS_RECEIPT_CANCEL' });

    const second = await receive([legacy]);
    expect(await messageOf(second.goodsReceipt.goodsReceiptNo)).not.toBeNull();
    // 입고 뒤 미배정 10 을 ERP 발주 라인 2 에 잇는다 — 자기 묶음(ALLOC)으로 가고 입고 묶음에서는 빠진다.
    const added = await allocations.addToLine(legacy.inboundLineId, order[1], new Prisma.Decimal(10), Number(ids.user));
    const allocationId = BigInt(added.inboundReceiptPoAllocationId);
    expect(await messageOf(`ALLOC:${String(allocationId)}`)).toMatchObject({ target_type_code: 'INBOUND_RECEIPT_PO_ALLOCATION' });
    const receiptRows = summary(await build('GOODS_RECEIPT', BigInt(second.goodsReceipt.goodsReceiptId)));
    const allocationRows = summary(await build('INBOUND_RECEIPT_PO_ALLOCATION', allocationId));
    expect(receiptRows).toEqual([[orderNoOf(order[0]), 1, '30']]);
    expect(allocationRows).toEqual([[orderNoOf(order[0]), 2, '10']]);
    expect([...receiptRows, ...allocationRows].reduce((sum, row) => sum + Number(row[2]), 0)).toBe(40);

    // 새 흐름 줄은 줄 축 배정이 막힌다(R-7) — ALLOC 묶음이 생기지 않는다.
    const blocked = await allocations.addToLine(newFlowLine, order[1], new Prisma.Decimal(1), Number(ids.user))
      .catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(ContractException);
    expect((blocked as ContractException).getStatus()).toBe(409);
    const newFlowAllocations = await prisma.inbound_receipt_po_allocation.findMany({ where: { inbound_receipt_line_id: newFlowLine }, select: { inbound_receipt_po_allocation_id: true } });
    for (const row of newFlowAllocations) expect(await messageOf(`ALLOC:${String(row.inbound_receipt_po_allocation_id)}`)).toBeNull();
  });

  // ── 도우미 ─────────────────────────────────────────────────────

  async function passedLot(supplier: bigint, lotCount: number, lotQty: number): Promise<{ inboundLotId: number; inboundLineId: bigint; lots: IssuedMaterialLot[] }> {
    const { inboundLot } = await issueAndReceive(fx, { plantId: Number(ids.plant), supplierId: Number(supplier), itemId: Number(ids.item), lotQty, lotCount });
    const lots = await passInboundLotIqc(fx, inboundLot.inboundLotId);
    const row = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLot.inboundLotId) } });
    return { inboundLotId: inboundLot.inboundLotId, inboundLineId: row.inbound_receipt_line_id, lots };
  }

  function receive(lots: ReceiptLot[]) {
    return receipts.create({
      receiptTypeCode: 'MATERIAL', plantId: Number(ids.plant), warehouseId: Number(ids.warehouse), receiptDatetime: `${DAY}T07:00:00.000Z`, businessDate: DAY,
      lines: lots.map((lot) => ({
        inboundReceiptLineId: Number(lot.inboundLineId), itemId: Number(ids.item), lotId: Number(lot.lotId), receiptQty: lot.qty, uomId: Number(ids.ea),
        qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(ids.location),
      })),
    }, Number(ids.user));
  }

  /** 입고 취소 요청이 올라간 상태 — 결재선 없이 실행 경로를 보려고 상태만 세운다(승인 요청 0건이면 실행이 받는다). */
  async function requestCancel(goodsReceiptId: number): Promise<void> {
    await prisma.goods_receipt.update({ where: { goods_receipt_id: BigInt(goodsReceiptId) }, data: { status_code: 'CANCEL_REQUESTED' } });
  }

  async function receiptVersion(goodsReceiptId: number): Promise<number> {
    return (await prisma.goods_receipt.findUniqueOrThrow({ where: { goods_receipt_id: BigInt(goodsReceiptId) } })).version_no;
  }

  async function finalizableOf(inboundLotId: number): Promise<boolean> {
    const response = await request(app.getHttpServer()).get(`/api/logistics/inbound-lots/${String(inboundLotId)}`).set('Cookie', cookie).expect(200);
    return (response.body as { finalizable: boolean }).finalizable;
  }

  function messageOf(suffix: string) {
    return prisma.integration_message.findUnique({ where: { message_key: `IF-GR-SEND:${suffix}` } });
  }

  function outboxCount(): Promise<number> {
    return prisma.integration_message.count({ where: { interface_code: 'IF-GR-SEND' } });
  }

  function build(targetTypeCode: string, targetId: bigint): Promise<RowDraft[]> {
    return goodsReceiptBuilder(prisma).build({ id: 1n, interfaceCode: 'IF-GR-SEND', targetTypeCode, targetId, payload: {} });
  }

  function summary(rows: RowDraft[]): [unknown, unknown, unknown][] {
    return rows.map((row) => [row.values.PO_NO, row.values.PO_SEQ_NO, row.values.GR_QTY]);
  }

  const orderNos = new Map<bigint, string>();
  function orderNoOf(lineId: bigint): string {
    return orderNos.get(lineId) as string;
  }

  /** ERP 발주(라인 줄마다 발주량) — `received` 는 첫 라인에 이미 오른 받은 양(이전 데이터 배정 몫). */
  async function makeOrder(supplier: bigint, orderDate: string, ordered: number[], received = 0): Promise<bigint[]> {
    seq += 1;
    const erpNo = `${PREFIX}-ERP-${String(seq)}`;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-${String(seq)}`, erp_purchase_order_no: erpNo, supplier_id: supplier, business_unit_id: ids.unit,
        plant_id: ids.plant, order_date: new Date(`${orderDate}T00:00:00.000Z`), status_code: 'CONFIRMED', erp_purchase_group_code: 'P01', erp_io_type_code: 'DGR',
      },
    });
    const lineIds: bigint[] = [];
    for (const [index, qty] of ordered.entries()) {
      const line = await prisma.purchase_order_line.create({
        data: { purchase_order_id: order.purchase_order_id, line_no: index + 1, item_id: ids.item, uom_id: ids.ea, ordered_qty: qty,
          received_qty: index === 0 ? received : 0, erp_storage_location_code: 'S240' },
      });
      orderNos.set(line.purchase_order_line_id, erpNo);
      lineIds.push(line.purchase_order_line_id);
    }
    return lineIds;
  }

  /** 이전 데이터 줄·LOT — 줄 = LOT 1(정상), 입하 LOT PER_RECEIPT·RECEIVED, 배정은 주어진 대로. */
  async function makeLegacyLot(supplier: bigint, qty: number, shares: { orderLine: bigint; qty: number }[]): Promise<ReceiptLot> {
    seq += 1;
    const header = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-${String(seq)}`, supplier_id: supplier, plant_id: ids.plant, receipt_datetime: new Date(), status_code: 'REGISTERED' },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: { inbound_receipt_id: header.inbound_receipt_id, line_no: 1, item_id: ids.item, received_qty: qty, uom_id: ids.ea,
        supplier_lot_missing: false, supplier_lot_label_attached: true, inspection_required: false, status_code: 'REGISTERED' },
    });
    for (const share of shares) {
      await prisma.inbound_receipt_po_allocation.create({
        data: { inbound_receipt_line_id: line.inbound_receipt_line_id, purchase_order_line_id: share.orderLine, allocated_qty: share.qty },
      });
    }
    const inboundLot = await prisma.inbound_lot.create({
      data: { inbound_lot_no: `IL-MIG-${String(line.inbound_receipt_line_id)}`, plant_id: ids.plant, item_id: ids.item, supplier_id: supplier, uom_id: ids.ea,
        status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`), received_closed_at: new Date(),
        erp_send_mode_code: 'PER_RECEIPT', inbound_receipt_line_id: line.inbound_receipt_line_id },
    });
    const lot = await prisma.lot.create({
      data: { lot_no: `${PREFIX}-LG-${String(seq)}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty, uom_id: ids.ea,
        source_type_code: 'INBOUND_RECEIPT_LINE', source_id: line.inbound_receipt_line_id, status_code: 'NORMAL', inbound_lot_id: inboundLot.inbound_lot_id },
    });
    return { lotId: lot.lot_id, inboundLineId: line.inbound_receipt_line_id, qty };
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
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'ERP제외법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'ERP제외사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: 'ERP제외공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: 'ERP제외자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
    for (let index = 1; index <= 3; index += 1) {
      ids[`s${String(index)}`] = (await prisma.partner.create({
        data: { partner_code: `${PREFIX}-S${String(index)}`, partner_name: `${PREFIX} 공급사 ${String(index)}`, erp_partner_code: `S000${String(index)}` },
      })).partner_id;
    }
    await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: 'ERP제외작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    });
    ids.warehouse = (await prisma.warehouse.create({
      data: { plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-WH`, warehouse_name: 'ERP제외창고',
        warehouse_type_code: 'MATERIAL', management_level_code: 'LOCATION' },
    })).warehouse_id;
    ids.location = (await prisma.location.create({ data: { warehouse_id: ids.warehouse, location_code: `${PREFIX}-L1`, location_name: 'ERP제외위치' } })).location_id;
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `ERP제외 ${suffix}`, status_code: 'EMPLOYED' } });
    ids.user ??= user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `ERP제외 ${suffix}` } });
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
    const lines = `SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`;
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (${items})`;
    const results = `SELECT inspection_result_id FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`;
    const goodsReceipts = `SELECT goods_receipt_id FROM logistics.goods_receipt WHERE plant_id IN (${plants})`;
    const allocationKeys = `SELECT 'IF-GR-SEND:ALLOC:' || inbound_receipt_po_allocation_id FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (${lines})`;
    const receiptKeys = `SELECT 'IF-GR-SEND:' || goods_receipt_no FROM logistics.goods_receipt WHERE plant_id IN (${plants})
      UNION ALL SELECT 'IF-GR-SEND:CANCEL:' || goods_receipt_no FROM logistics.goods_receipt WHERE plant_id IN (${plants})`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))
         OR (aggregate_type_code = 'GOODS_RECEIPT' AND aggregate_id IN (${goodsReceipts}))`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    // 적재한 메시지는 지운다 — 남기면 이 DB 에서 보내기를 켤 때 실제로 나간다.
    await prisma.$executeRawUnsafe(`DELETE FROM integration.erp_outbound_row WHERE integration_message_id IN (
      SELECT integration_message_id FROM integration.integration_message WHERE message_key IN (${receiptKeys}) OR message_key IN (${allocationKeys}))`);
    await prisma.$executeRawUnsafe(`DELETE FROM integration.integration_message WHERE message_key IN (${receiptKeys}) OR message_key IN (${allocationKeys})`);
    await prisma.$executeRawUnsafe('TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.document_cancellation WHERE document_id IN (${goodsReceipts}) AND document_type_code = 'GOODS_RECEIPT'`,
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
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (${lines})`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN (${plants}))`,
      `DELETE FROM logistics.purchase_order WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
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
