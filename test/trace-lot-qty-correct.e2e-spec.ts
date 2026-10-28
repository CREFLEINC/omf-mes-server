/**
 * 자재 LOT 수량 정정(장부 P-121) — IQC 검사가 시작되기 전까지 LOT·입하 줄·IQC 의뢰 대상 수량을 함께 고친다.
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
import { hashPassword } from '../src/auth/password';
import { InventoryPostingModule, InventoryPostingService } from '../src/core/inventory-posting';
import { PostingEndpoint } from '../src/core/inventory-posting/posting.types';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-lqc-probe';
const NOPERM_ID = 'e2e-lqc-noperm';
const PASSWORD = 'LOT-정정-비밀번호';
const PREFIX = 'LQCE2E';
const ROLE = 'E2E_LQC';
const DAY = '2026-05-01';
const OPERATION = 'POST /trace/lots/{lotId}:correct-qty';

interface Fixture {
  lotId: bigint;
  lotNo: string;
  lineId: bigint;
  receiptId: bigint;
}

describe('자재 LOT 수량 정정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let posting: InventoryPostingService;
  let cookie: string[];
  let noPermCookie: string[];
  let probeUserId: bigint;
  let plantId: bigint;
  let foreignPlantId: bigint;
  let businessUnitId: bigint;
  let supplierId: bigint;
  let itemId: bigint;
  let uomId: bigint;
  let here: PostingEndpoint;
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, InventoryPostingModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    posting = app.get(InventoryPostingService);
    await cleanup();
    await makeUsers();
    await makeMasters();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ LOT·입하 줄·시작 전 IQC 의뢰의 수량이 함께 바뀌고, 입하 버전이 오르고, 이력이 남는다', async () => {
    const lot = await inboundLot(10, { iqc: true });
    const etag = await etagOf(lot.lotId);
    const receiptVersion = (await prisma.inbound_receipt.findUniqueOrThrow({ where: { inbound_receipt_id: lot.receiptId } })).version_no;

    const corrected = await correct(lot.lotId, etag, { qty: 8, reason: '포장 단위 오기' }).expect(200);

    expect(valid(corrected.body)).toEqual([]);
    expect(corrected.body).toMatchObject({ lot: { lotId: Number(lot.lotId), initialQty: 8 }, qtyBefore: 10, labelReissueNeeded: false });
    expect(Number(corrected.headers.etag)).toBe(Number(etag) + 1);
    const line = await prisma.inbound_receipt_line.findUniqueOrThrow({ where: { inbound_receipt_line_id: lot.lineId } });
    expect(line.received_qty.toNumber()).toBe(8);
    const receipt = await prisma.inbound_receipt.findUniqueOrThrow({ where: { inbound_receipt_id: lot.receiptId } });
    expect(receipt.version_no).toBe(receiptVersion + 1);
    const iqc = await prisma.inspection_request.findFirstOrThrow({ where: { lot_id: lot.lotId } });
    expect(iqc.target_qty.toNumber()).toBe(8);
    const audit = await prisma.audit_event.findFirstOrThrow({
      where: { target_type_code: 'LOT', target_id: lot.lotId, event_type_code: 'LOT_QTY_CORRECTED' },
    });
    expect(audit).toMatchObject({ reason: '포장 단위 오기', performed_by: probeUserId, terminal_id: null });
    expect(audit.before_value).toMatchObject({ qty: 10, inboundReceiptNo: `${PREFIX}-IR-${seq}` });
    expect(audit.after_value).toEqual({ qty: 8 });
  });

  it('⭐ 발행된 자재 LOT 라벨이 있으면 재발행이 필요하다고 알린다 — 출력 실패한 발행은 세지 않는다', async () => {
    const failed = await inboundLot(10);
    await label(failed.lotId, 'FAILED');
    const notNeeded = await correct(failed.lotId, await etagOf(failed.lotId), { qty: 9, reason: '재계수' }).expect(200);
    expect(notNeeded.body.labelReissueNeeded).toBe(false);

    const printed = await inboundLot(10);
    await label(printed.lotId, null);
    const needed = await correct(printed.lotId, await etagOf(printed.lotId), { qty: 9, reason: '재계수' }).expect(200);
    expect(needed.body.labelReissueNeeded).toBe(true);
  });

  it('⭐ P/O 배정 합까지는 줄일 수 있고, 그 아래는 400 이다 — 배정을 먼저 줄이라고 안내한다', async () => {
    const lot = await inboundLot(10);
    await allocate(lot.lineId, 6);

    const rejected = await correct(lot.lotId, await etagOf(lot.lotId), { qty: 5, reason: '재계수' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'qty', code: 'RANGE' });
    expect(rejected.body.errors[0].message).toContain(lot.lotNo);
    expect(rejected.body.errors[0].message).toContain('배정을 먼저 줄이세요');
    expectReadable(rejected.body.errors[0].message);

    await correct(lot.lotId, await etagOf(lot.lotId), { qty: 6, reason: '재계수' }).expect(200);
  });

  it('⛔ IQC 검사가 시작됐으면(검사 중) 400 STATE_LOCKED 다 — 입하 차이 등록·공급사 반품으로 안내한다', async () => {
    const lot = await inboundLot(10, { iqc: true });
    await prisma.inspection_request.updateMany({ where: { lot_id: lot.lotId }, data: { status_code: 'IN_PROGRESS' } });

    const rejected = await correct(lot.lotId, await etagOf(lot.lotId), { qty: 8, reason: '재계수' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect(rejected.body.errors[0].message).toContain(lot.lotNo);
    expect(rejected.body.errors[0].message).toContain('IQC 수입검사·판정 화면');
    expectReadable(rejected.body.errors[0].message);
    expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: lot.lotId } })).initial_qty.toNumber()).toBe(10);
  });

  it('⛔ 재고 원장에 들어간 LOT 은 400 STATE_LOCKED 다 — 재고 조정으로 안내한다', async () => {
    const lot = await inboundLot(10);
    await prisma.$transaction((tx) => posting.post(tx, {
      businessDate: DAY,
      occurredAt: new Date(`${DAY}T02:00:00.000Z`),
      transactionTypeCode: 'RECEIPT',
      transactionNo: `${PREFIX}-GR-${lot.lotId}`,
      statusCode: 'POSTED',
      plantId: Number(plantId),
      sourceDocumentTypeCode: 'GOODS_RECEIPT',
      sourceDocumentId: 1,
      idempotencyKey: `${PREFIX}-${randomUUID()}`,
      lines: [{ itemId: Number(itemId), lotId: Number(lot.lotId), qty: 10, uomId: Number(uomId), to: here, ownershipTypeCode: 'OWNED' }],
    }));

    const rejected = await correct(lot.lotId, await etagOf(lot.lotId), { qty: 8, reason: '재계수' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect(rejected.body.errors[0].message).toContain('재고조정(W-01-12)');
    expectReadable(rejected.body.errors[0].message);
  });

  it('⛔ 입하가 작성중이 아니면 400 STATE_LOCKED 다', async () => {
    const lot = await inboundLot(10);
    await prisma.inbound_receipt.update({ where: { inbound_receipt_id: lot.receiptId }, data: { status_code: 'CONFIRMED' } });

    const rejected = await correct(lot.lotId, await etagOf(lot.lotId), { qty: 8, reason: '재계수' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect(rejected.body.errors[0].message).toContain(`${PREFIX}-IR-${seq}`);
    expectReadable(rejected.body.errors[0].message);
  });

  it('⛔ 생산 LOT 은 400 INVALID 다 — 실적 정정으로 안내한다', async () => {
    const lot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-WO-LOT`, item_id: itemId, lot_type_code: 'PRODUCTION', plant_id: plantId,
      initial_qty: 10, uom_id: uomId, source_type_code: 'WORK_ORDER', source_id: 1, status_code: 'NORMAL',
    } });

    const rejected = await correct(lot.lot_id, await etagOf(lot.lot_id), { qty: 8, reason: '재계수' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'qty', code: 'INVALID' });
    expect(rejected.body.errors[0].message).toContain('실적 정정');
  });

  it('⛔ 사유가 비면 400 · 낡은 If-Match 는 409 · 없는 LOT 은 404 · 권한이 없으면 403 이다', async () => {
    const lot = await inboundLot(10);
    const etag = await etagOf(lot.lotId);

    const blank = await correct(lot.lotId, etag, { qty: 8, reason: '  ' }).expect(400);
    expect(blank.body.errors[0]).toMatchObject({ field: 'reason', code: 'REQUIRED' });
    await correct(lot.lotId, String(Number(etag) + 5), { qty: 8, reason: '재계수' }).expect(409);
    await correct(999_999_999n, etag, { qty: 8, reason: '재계수' }).expect(404);
    await correct(lot.lotId, etag, { qty: 8, reason: '재계수' }, noPermCookie).expect(403);
  });

  it('⛔ 같은 수량이면 400 이다 — 바뀐 수량이 없다', async () => {
    const lot = await inboundLot(10);
    const rejected = await correct(lot.lotId, await etagOf(lot.lotId), { qty: 10, reason: '재계수' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'qty', code: 'INVALID' });
    expect(rejected.body.errors[0].message).toContain('바뀐 수량이 없습니다');
  });

  it('⛔ IQC 가 완료·생략됐거나, 의뢰 상태는 그대로인데 검사 회차가 기록됐으면 400 이다', async () => {
    for (const status of ['COMPLETED', 'SKIPPED']) {
      const lot = await inboundLot(10, { iqc: true });
      await prisma.inspection_request.updateMany({ where: { lot_id: lot.lotId }, data: { status_code: status } });
      const rejected = await correct(lot.lotId, await etagOf(lot.lotId), { qty: 8, reason: '재계수' }).expect(400);
      expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      expect(rejected.body.errors[0].message).toContain(status === 'SKIPPED' ? 'IQC 가 생략 처리된' : 'IQC 검사가 이미 시작된');
    }
    const recorded = await inboundLot(10, { iqc: true });
    const iqc = await prisma.inspection_request.findFirstOrThrow({ where: { lot_id: recorded.lotId } });
    await prisma.inspection_result.create({ data: {
      inspection_result_no: `${PREFIX}-IR-RES-${seq}`, inspection_request_id: iqc.inspection_request_id, inspected_qty: 10, uom_id: uomId,
      inspector_id: await reporter(), inspected_at: new Date(), status_code: 'DRAFT', idempotency_key: randomUUID(),
    } });
    await correct(recorded.lotId, await etagOf(recorded.lotId), { qty: 8, reason: '재계수' }).expect(400);
  });

  it('⛔ 입하 줄에 차이 등록이나 P/O 에 이은 초과분이 있으면 400 이다', async () => {
    const varied = await inboundLot(10);
    await prisma.inbound_variance.create({ data: { inbound_receipt_line_id: varied.lineId, variance_type_code: 'SHORTAGE', variance_qty: 1, uom_id: uomId } });
    const withVariance = await correct(varied.lotId, await etagOf(varied.lotId), { qty: 8, reason: '재계수' }).expect(400);
    expect(withVariance.body.errors[0].message).toContain('차이 등록이나 초과분 P/O');

    const excess = await inboundLot(10);
    const orderLineId = await allocate(excess.lineId, 6);
    await prisma.inbound_receipt_excess.create({ data: { inbound_receipt_line_id: excess.lineId, excess_qty: 4, purchase_order_line_id: orderLineId, linked_at: new Date() } });
    await correct(excess.lotId, await etagOf(excess.lotId), { qty: 12, reason: '재계수' }).expect(400);
  });

  it('⛔ 입고를 취소했어도 원장에 한 번 들어간 LOT 은 400 이다(의도 · 장부 P-121)', async () => {
    const lot = await inboundLot(10);
    const receipt = await prisma.goods_receipt.create({ data: {
      goods_receipt_no: `${PREFIX}-GR-${seq}`, receipt_type_code: 'MATERIAL', plant_id: plantId, warehouse_id: BigInt(here.warehouseId),
      receipt_datetime: new Date(`${DAY}T02:00:00.000Z`), status_code: 'CANCELLED',
      goods_receipt_line: { create: [{ line_no: 1, item_id: itemId, lot_id: lot.lotId, receipt_qty: 10, uom_id: uomId,
        quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', destination_location_id: BigInt(here.locationId) }] },
    } });
    const posted = await prisma.$transaction((tx) => posting.post(tx, {
      businessDate: DAY, occurredAt: new Date(`${DAY}T02:00:00.000Z`), transactionTypeCode: 'RECEIPT',
      transactionNo: `${PREFIX}-GRX-${lot.lotId}`, statusCode: 'POSTED', plantId: Number(plantId),
      sourceDocumentTypeCode: 'GOODS_RECEIPT', sourceDocumentId: Number(receipt.goods_receipt_id), idempotencyKey: `${PREFIX}-${randomUUID()}`,
      lines: [{ itemId: Number(itemId), lotId: Number(lot.lotId), qty: 10, uomId: Number(uomId), to: here, ownershipTypeCode: 'OWNED' }],
    }));
    await prisma.$transaction((tx) => posting.reverse(tx, {
      inventoryTransactionId: posted.inventoryTransactionId, businessDate: DAY, occurredAt: new Date(), createdBy: Number(probeUserId),
    }));

    const rejected = await correct(lot.lotId, await etagOf(lot.lotId), { qty: 8, reason: '재계수' }).expect(400);
    expect(rejected.body.errors[0].message).toContain('이미 재고에 반영된 LOT');
  });

  it('⛔ 선별 분할로 나온 LOT 은 400 INVALID 이고 재고조정으로 안내한다', async () => {
    const lot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-SPLIT-S1`, item_id: itemId, lot_type_code: 'MATERIAL', plant_id: plantId,
      initial_qty: 3, uom_id: uomId, source_type_code: 'LOT_SPLIT', source_id: 1, status_code: 'NORMAL',
    } });
    const rejected = await correct(lot.lot_id, await etagOf(lot.lot_id), { qty: 2, reason: '재계수' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'qty', code: 'INVALID' });
    expect(rejected.body.errors[0].message).toContain('재고조정(W-01-12)');
  });

  it('⭐ 같은 멱등 키로 다시 보내면 한 번만 반영된다 — 버전이 두 번 오르지 않는다', async () => {
    const lot = await inboundLot(10);
    const etag = await etagOf(lot.lotId);
    const key = randomUUID();
    const send = () => request(app.getHttpServer())
      .post(`/api/trace/lots/${lot.lotId}:correct-qty`).set('Cookie', cookie)
      .set('Idempotency-Key', key).set('If-Match', etag).send({ qty: 9, reason: '재계수' });

    const first = await send().expect(200);
    const second = await send().expect(200);

    expect(second.body).toEqual(first.body);
    expect(Number(await etagOf(lot.lotId))).toBe(Number(etag) + 1);
    expect(await prisma.audit_event.count({ where: { target_type_code: 'LOT', target_id: lot.lotId, event_type_code: 'LOT_QTY_CORRECTED' } })).toBe(1);
  });

  it('⭐ 모바일 단말은 그 공장 입하 LOT 을 고치고 이력에 작업자가 남는다 · 남의 공장·없는 LOT 은 401 이다', async () => {
    const token = await terminalToken();
    const workerNo = `${PREFIX}-W`;
    const asTerminal = (lotId: bigint, etag: string) => request(app.getHttpServer())
      .post(`/api/trace/lots/${lotId}:correct-qty`).set('Authorization', `Bearer ${token}`)
      .set('X-Worker-No', workerNo).set('Idempotency-Key', randomUUID()).set('If-Match', etag)
      .send({ qty: 9, reason: '단말 재계수' });

    const lot = await inboundLot(10);
    await asTerminal(lot.lotId, await etagOf(lot.lotId)).expect(200);
    const audit = await prisma.audit_event.findFirstOrThrow({
      where: { target_type_code: 'LOT', target_id: lot.lotId, event_type_code: 'LOT_QTY_CORRECTED' },
    });
    expect(audit.performed_by).toBeNull();
    expect(audit.terminal_id).not.toBeNull();
    expect(audit.after_value).toMatchObject({ qty: 9, workerNo });

    const foreign = await inboundLot(10, { plant: foreignPlantId });
    await asTerminal(foreign.lotId, await etagOf(foreign.lotId)).expect(401);
    await asTerminal(999_999_999n, '1').expect(401);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function correct(lotId: bigint, etag: string, body: object, as: string[] = cookie): request.Test {
    return request(app.getHttpServer())
      .post(`/api/trace/lots/${lotId}:correct-qty`)
      .set('Cookie', as)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', etag)
      .send(body);
  }

  /** 정정 화면은 상세 GET 의 ETag 를 쓴다 — 여기서는 그 값(`version_no`)을 표에서 읽는다(상세 GET 권한을 따로 주지 않으려고). */
  async function etagOf(lotId: bigint): Promise<string> {
    const lot = await prisma.lot.findUnique({ where: { lot_id: lotId }, select: { version_no: true } });
    return String(lot?.version_no ?? 1);
  }

  function valid(body: unknown): unknown[] {
    const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
    const [method, path] = OPERATION.split(' ');
    const pointer = `/paths/${path.replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const f of ['int64', 'int32', 'double', 'float']) ajv.addFormat(f, true);
    ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
    const validate = ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
    validate(body);
    return validate.errors ?? [];
  }

  /** 문구가 API 칸 이름·id 를 드러내지 않는다. */
  function expectReadable(message: string): void {
    expect(message).not.toMatch(/[a-z]+[A-Z][a-zA-Z]*|_id|\bid\b/);
  }

  async function inboundLot(qty: number, opts: { iqc?: boolean; plant?: bigint } = {}): Promise<Fixture> {
    seq += 1;
    const receipt = await prisma.inbound_receipt.create({ data: {
      inbound_receipt_no: `${PREFIX}-IR-${seq}`, supplier_id: supplierId, plant_id: opts.plant ?? plantId,
      receipt_datetime: new Date(`${DAY}T02:00:00.000Z`), status_code: 'REGISTERED',
    } });
    const line = await prisma.inbound_receipt_line.create({ data: {
      inbound_receipt_id: receipt.inbound_receipt_id, line_no: 1, item_id: itemId, received_qty: qty, uom_id: uomId,
      supplier_lot_label_attached: false, inspection_required: opts.iqc === true, status_code: 'REGISTERED',
    } });
    const lot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-LOT-${seq}`, item_id: itemId, lot_type_code: 'MATERIAL', plant_id: opts.plant ?? plantId, initial_qty: qty,
      uom_id: uomId, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: line.inbound_receipt_line_id, status_code: 'NORMAL',
    } });
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id }, data: { lot_id: lot.lot_id } });
    if (opts.iqc === true) {
      await prisma.inspection_request.create({ data: {
        inspection_request_no: `${PREFIX}-IQC-${seq}`, inspection_type_code: 'IQC', target_type_code: 'LOT', target_id: lot.lot_id,
        item_id: itemId, lot_id: lot.lot_id, target_qty: qty, uom_id: uomId, status_code: 'REQUESTED', requested_at: new Date(),
      } });
    }
    return { lotId: lot.lot_id, lotNo: lot.lot_no, lineId: line.inbound_receipt_line_id, receiptId: receipt.inbound_receipt_id };
  }

  async function label(lotId: bigint, outcome: string | null): Promise<void> {
    await prisma.document_issue_log.create({ data: {
      document_type_code: 'MATERIAL_LOT_LABEL', target_type_code: 'LOT', target_id: lotId, lot_id: lotId,
      issued_by: probeUserId, print_outcome_code: outcome,
      ...(outcome === 'FAILED' ? { print_reported_at: new Date(), print_failure_reason: '용지 걸림', print_reported_worker_id: await reporter() } : {}),
    } });
  }

  async function reporter(): Promise<bigint> {
    const worker = await prisma.worker.upsert({
      where: { worker_no: `${PREFIX}-W` },
      update: {},
      create: { worker_no: `${PREFIX}-W`, worker_name: 'LOT정정작업자', business_unit_id: businessUnitId, plant_id: plantId, status_code: 'EMPLOYED' },
    });
    return worker.worker_id;
  }

  async function allocate(lineId: bigint, qty: number): Promise<bigint> {
    const order = await prisma.purchase_order.create({ data: {
      purchase_order_no: `${PREFIX}-PO-${seq}`, supplier_id: supplierId, business_unit_id: businessUnitId, plant_id: plantId,
      order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
    } });
    const orderLine = await prisma.purchase_order_line.create({ data: {
      purchase_order_id: order.purchase_order_id, line_no: 1, item_id: itemId, ordered_qty: 100, uom_id: uomId,
    } });
    await prisma.inbound_receipt_po_allocation.create({ data: {
      inbound_receipt_line_id: lineId, purchase_order_line_id: orderLine.purchase_order_line_id, allocated_qty: qty,
    } });
    return orderLine.purchase_order_line_id;
  }

  async function terminalToken(): Promise<string> {
    await reporter();
    const row = await prisma.terminal.create({ data: {
      terminal_code: `${PREFIX}-MOB`, plant_id: plantId, terminal_type_code: 'MOBILE', status_code: 'RUNNING',
    } });
    return app.get(JwtService).sign({
      sub: Number(row.terminal_id), typ: 'terminal', tv: row.token_version, terminalCode: row.terminal_code, plantId: Number(plantId),
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'LOT정정법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'LOT정정사업부',
    } });
    businessUnitId = unit.business_unit_id;
    const plant = await prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'LOT정정공장', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    plantId = plant.plant_id;
    foreignPlantId = (await prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P2`, plant_name: 'LOT정정공장2', timezone_code: 'Asia/Ho_Chi_Minh',
    } })).plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = uom.uom_id;
    const item = await prisma.item.create({ data: {
      item_code: `${PREFIX}-ITEM`, item_name: 'LOT정정품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true,
    } });
    itemId = item.item_id;
    const warehouse = await prisma.warehouse.create({ data: {
      plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH`,
      warehouse_name: 'LOT정정창고', warehouse_type_code: 'RAW', management_level_code: 'LOCATION',
    } });
    const location = await prisma.location.create({ data: {
      warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: 'LOT정정위치', location_type_code: 'BIN',
    } });
    here = { warehouseId: Number(warehouse.warehouse_id), locationId: Number(location.location_id), qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE' };
    const supplier = await prisma.partner.create({ data: { partner_code: `${PREFIX}-SUP`, partner_name: 'LOT정정공급사' } });
    supplierId = supplier.partner_id;
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: 'LOT정정', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    probeUserId = user.app_user_id;
    const other = await prisma.app_user.create({ data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'LOT정정용' } });
    await prisma.role_permission.createMany({ data: ['W-01-10', 'M-01-04'].map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — 재고 스위트들과 같은 이유다. */
  async function cleanup(): Promise<void> {
    const lots = `SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`;
    const terminals = `SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`;
    await prisma.$executeRawUnsafe(`DELETE FROM audit.audit_event WHERE terminal_id IN (${terminals})`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM quality.inspection_result WHERE inspection_result_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt_line
       WHERE goods_receipt_id IN (SELECT goods_receipt_id FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_variance
       WHERE inbound_receipt_line_id IN (SELECT l.inbound_receipt_line_id FROM logistics.inbound_receipt_line l
         JOIN logistics.inbound_receipt r ON r.inbound_receipt_id = l.inbound_receipt_id WHERE r.inbound_receipt_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt_excess
       WHERE inbound_receipt_line_id IN (SELECT l.inbound_receipt_line_id FROM logistics.inbound_receipt_line l
         JOIN logistics.inbound_receipt r ON r.inbound_receipt_id = l.inbound_receipt_id WHERE r.inbound_receipt_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`);
    await prisma.$executeRawUnsafe(`DELETE FROM inventory.inventory_balance WHERE lot_id IN (${lots})`);
    await prisma.$executeRawUnsafe(`DELETE FROM app.document_issue_log WHERE lot_id IN (${lots})`);
    await prisma.$executeRawUnsafe(`DELETE FROM audit.audit_event WHERE target_type_code = 'LOT' AND target_id IN (${lots})`);
    await prisma.$executeRawUnsafe(`DELETE FROM quality.inspection_request WHERE lot_id IN (${lots})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt_po_allocation
       WHERE purchase_order_line_id IN (SELECT l.purchase_order_line_id FROM logistics.purchase_order_line l
                                          JOIN logistics.purchase_order o ON o.purchase_order_id = l.purchase_order_id
                                         WHERE o.purchase_order_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order_line
       WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE purchase_order_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.purchase_order WHERE purchase_order_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt_line
       WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
