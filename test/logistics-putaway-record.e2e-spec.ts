/**
 * 피처 011 — PDA 적치 기록 조회 `GET /logistics/putaway-records`(omf-all-around#325). 「내 기록(WORKER) / 이 단말(TERMINAL)」로
 * 공장 영업일 하루치의 지시 없는 적치(DIRECT)와 지시 적치(TASK)를 최근 순으로 본다.
 *
 * 지시 없는 적치는 PDA 적치가 부르는 입고 코어(`postReceipt` + 적치 방식·작업자·단말)로, 지시 적치는 입고로 만든 지시를
 * 실제 단말 `:complete`·`:complete-temporary` 로 완료해 세운다(작업자·단말 칸은 S2 가 쓴다). 쪽 나눔 60건만 행을 바로 넣는다.
 *
 * 공장 P1: 창고 A(R1·R2), 불량창고 D(D1). 공장 P2: 창고 C(C1). 작업자 WA·WB·WC(P1), WP2(P2). 단말 T1·T2·T3(P1 MOBILE), TP2(P2), POP.
 * 날짜: 오늘(H3·H5) · 1일 전(US3) · 2일 전(쪽 나눔 60건, WC/T3) · 6일 전(기간 경계).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { InventoryPostingService } from '../src/core/inventory-posting';
import { GoodsReceiptCreate, postReceipt } from '../src/logistics/goods-receipt/receipt-posting';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E11PR';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const PATH = '/api/logistics/putaway-records';

interface RecordItem {
  recordType: string; recordId: number; putawayModeCode: string; sourceCode: string; recordedAt: string; documentNo: string;
  lot: { lotId: number; lotNo: string }; item: { itemId: number; itemCode: string; itemName: string }; qty: string; uomCode: string;
  qualityStatusCode: string | null; warehouse: { warehouseId: number; warehouseCode: string; warehouseName: string };
  location: { locationId: number; locationCode: string; path: string }; worker: { workerNo: string; workerName: string };
  terminalCode: string; receiptStatusCode: string | null;
}
interface RecordPage { items: RecordItem[]; page: { page: number; size: number; total: number } }

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 그 현지 날짜(UTC+7)의 `hh`시(UTC) — 0~16시는 같은 현지 날짜다. */
function at(day: string, hour: number, minute = 0): string {
  return `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

function validator(status = 200): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
  const pointer = `/paths/${'/logistics/putaway-records'.replace(/\//g, '~1')}/get/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('피처 011 — PDA 적치 기록 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const ids: Record<string, bigint> = {};
  const codes: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const records: Record<string, { documentNo: string; recordId: number; lotNo: string }> = {};
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

    // 오늘 — H3·H5: WA 가 T1 에서 2건·T2 에서 1건, WB 가 T1 에서 1건.
    await direct('d1', { worker: 'wa', terminal: 't1', mode: 'DESIGNATED', location: 'R1', at: at(DAY, 1) });
    await direct('d2', { worker: 'wa', terminal: 't1', mode: 'UNDESIGNATED', location: 'R2', at: at(DAY, 2) });
    await direct('d3', { worker: 'wa', terminal: 't2', mode: 'TEMPORARY', location: 'AWHOLE', at: at(DAY, 3) });
    await direct('d4', { worker: 'wb', terminal: 't1', mode: 'DESIGNATED', location: 'R1', at: at(DAY, 4) });
    // 다른 공장(H11) — WP2 가 TP2 에서.
    await direct('p2', { worker: 'wp2', terminal: 'tp2', mode: 'DESIGNATED', location: 'C1', at: at(DAY, 5) });
    // 관리웹 입고(작업자·단말 없음)는 어느 기준에도 나오지 않는다.
    await post({ plant: 'p1', warehouse: 'a', location: 'R1', at: at(DAY, 6), lotTag: 'WEB', putawayModeCode: null });

    // 1일 전 — US3: 지시 적치 넷(구매·제품·보충·임시), 취소·취소 요청·불량.
    const yesterday = shiftDay(DAY, -1);
    await task('tPurchase', { receiptType: 'MATERIAL', path: 'complete', at: at(yesterday, 1) });
    await task('tProduct', { receiptType: 'PRODUCT', path: 'complete', at: at(yesterday, 2) });
    await replenishmentTask('tReplenish', at(yesterday, 3));
    await task('tTemporary', { receiptType: 'MATERIAL', path: 'complete-temporary', at: at(yesterday, 4) });
    await direct('cancelled', { worker: 'wa', terminal: 't2', mode: 'DESIGNATED', location: 'R1', at: at(yesterday, 5) });
    await direct('requested', { worker: 'wa', terminal: 't2', mode: 'DESIGNATED', location: 'R1', at: at(yesterday, 6) });
    await direct('defective', { worker: 'wa', terminal: 't2', mode: 'DESIGNATED', location: 'D1', at: at(yesterday, 7), defective: true });
    await prisma.goods_receipt.updateMany({ where: { goods_receipt_no: records.cancelled.documentNo }, data: { status_code: 'CANCELLED' } });
    await prisma.goods_receipt.updateMany({ where: { goods_receipt_no: records.requested.documentNo }, data: { status_code: 'CANCEL_REQUESTED' } });

    // 6일 전 — 현지 날짜 경계: 6일 전 00:10·23:50 은 그날, 7일 전 23:50 은 아니다.
    const sixAgo = shiftDay(DAY, -6);
    await direct('six1', { worker: 'wa', terminal: 't1', mode: 'DESIGNATED', location: 'R1', at: `${shiftDay(sixAgo, -1)}T17:10:00.000Z` });
    await direct('six2', { worker: 'wa', terminal: 't1', mode: 'DESIGNATED', location: 'R1', at: `${sixAgo}T16:50:00.000Z` });
    await direct('seven', { worker: 'wa', terminal: 't1', mode: 'DESIGNATED', location: 'R1', at: `${shiftDay(sixAgo, -1)}T16:50:00.000Z` });

    await bulk(60, shiftDay(DAY, -2));
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US1-1 H3 「내 기록」 — 지정·미지정·임시 3건이 최근 순, 줄 칸(LOT·품목·수량·단위·창고·위치 경로·방식·번호·시각·작업자·단말)', async () => {
    const response = await list('t1', 'wa', { scope: 'WORKER', businessDate: DAY }).expect(200);
    const validate = validator();
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const body = response.body as RecordPage;
    expect(body.items.map((item) => item.documentNo)).toEqual(['d3', 'd2', 'd1'].map((key) => records[key].documentNo));
    expect(body.items.map((item) => item.putawayModeCode)).toEqual(['TEMPORARY', 'UNDESIGNATED', 'DESIGNATED']);
    expect(body.page).toEqual({ page: 1, size: 50, total: 3 });
    expect(body.items[2]).toEqual({
      recordType: 'DIRECT', recordId: records.d1.recordId, putawayModeCode: 'DESIGNATED', sourceCode: 'PURCHASE',
      recordedAt: at(DAY, 1), documentNo: records.d1.documentNo,
      lot: { lotId: expect.any(Number), lotNo: records.d1.lotNo },
      item: { itemId: Number(ids.x), itemCode: `${PREFIX}-X`, itemName: '기록자재 X' }, qty: '10', uomCode: 'EA', qualityStatusCode: 'NORMAL',
      warehouse: { warehouseId: Number(ids.a), warehouseCode: `${PREFIX}-WHA`, warehouseName: `${PREFIX} 창고 A` },
      location: { locationId: Number(ids.R1), locationCode: codes.R1, path: `${PREFIX} 창고 A › R1 랙` },
      worker: { workerNo: `${PREFIX}-WA`, workerName: '기록작업자 WA' }, terminalCode: `${PREFIX}-T1`, receiptStatusCode: 'POSTED',
    });
    expect(body.items[0]).toMatchObject({ terminalCode: `${PREFIX}-T2`, location: { locationCode: codes.AWHOLE } });
  });

  it('US1-3 H5 기준 — 「내 기록」은 단말과 무관하게 작업자 3건, 「이 단말」은 작업자와 무관하게 단말 3건', async () => {
    const mine = (await list('t1', 'wa', { scope: 'WORKER', businessDate: DAY }).expect(200)).body as RecordPage;
    expect(mine.items.map((item) => item.documentNo).sort()).toEqual(['d1', 'd2', 'd3'].map((key) => records[key].documentNo).sort());

    const terminal = (await list('t1', 'wa', { scope: 'TERMINAL', businessDate: DAY }).expect(200)).body as RecordPage;
    expect(terminal.items.map((item) => item.documentNo)).toEqual(['d4', 'd2', 'd1'].map((key) => records[key].documentNo));
    expect(terminal.items.map((item) => item.worker.workerNo)).toEqual([`${PREFIX}-WB`, `${PREFIX}-WA`, `${PREFIX}-WA`]);

    // 「이 단말」은 사번 없이도 본다.
    const noWorker = (await list('t2', null, { scope: 'TERMINAL', businessDate: DAY }).expect(200)).body as RecordPage;
    expect(noWorker.items.map((item) => item.documentNo)).toEqual([records.d3.documentNo]);
  });

  it('US3-1 H6 지시 적치 — 구매·제품·보충은 TASK, 임시 완료는 TASK_TEMPORARY, 번호는 지시 번호·출처 구분', async () => {
    const body = (await list('t2', 'wa', { scope: 'WORKER', businessDate: shiftDay(DAY, -1) }).expect(200)).body as RecordPage;
    const byNo = new Map(body.items.map((item) => [item.documentNo, item]));
    expect(byNo.get(records.tPurchase.documentNo)).toMatchObject({ recordType: 'TASK', recordId: records.tPurchase.recordId, putawayModeCode: 'TASK', sourceCode: 'PURCHASE' });
    expect(byNo.get(records.tProduct.documentNo)).toMatchObject({ recordType: 'TASK', putawayModeCode: 'TASK', sourceCode: 'PRODUCT' });
    expect(byNo.get(records.tReplenish.documentNo)).toMatchObject({ recordType: 'TASK', putawayModeCode: 'TASK', sourceCode: 'REPLENISHMENT', qty: '10' });
    expect(byNo.get(records.tTemporary.documentNo)).toMatchObject({ recordType: 'TASK', putawayModeCode: 'TASK_TEMPORARY', sourceCode: 'PURCHASE' });
    expect(byNo.get(records.tPurchase.documentNo)).toMatchObject({
      location: { locationCode: codes.R1, path: `${PREFIX} 창고 A › R1 랙` }, terminalCode: `${PREFIX}-T2`, worker: { workerNo: `${PREFIX}-WA` },
      qualityStatusCode: 'NORMAL',
    });
    expect(body.items.map((item) => item.documentNo)).toEqual(
      ['defective', 'requested', 'cancelled', 'tTemporary', 'tReplenish', 'tProduct', 'tPurchase'].map((key) => records[key].documentNo),
    );
  });

  it('US3-2 H7 입고 취소 — 취소 승인 줄은 CANCELLED 로 남고, 취소 요청은 CANCEL_REQUESTED, 보충 지시는 null', async () => {
    const body = (await list('t2', 'wa', { scope: 'WORKER', businessDate: shiftDay(DAY, -1) }).expect(200)).body as RecordPage;
    const byNo = new Map(body.items.map((item) => [item.documentNo, item]));
    expect(byNo.get(records.cancelled.documentNo)?.receiptStatusCode).toBe('CANCELLED');
    expect(byNo.get(records.requested.documentNo)?.receiptStatusCode).toBe('CANCEL_REQUESTED');
    expect(byNo.get(records.tReplenish.documentNo)?.receiptStatusCode).toBeNull();
    expect(byNo.get(records.tPurchase.documentNo)?.receiptStatusCode).toBe('POSTED');
  });

  it('US3-3 H8 불량 LOT 줄은 qualityStatusCode=DEFECTIVE', async () => {
    const body = (await list('t2', 'wa', { scope: 'WORKER', businessDate: shiftDay(DAY, -1) }).expect(200)).body as RecordPage;
    const defective = body.items.find((item) => item.documentNo === records.defective.documentNo);
    expect(defective).toMatchObject({ qualityStatusCode: 'DEFECTIVE', warehouse: { warehouseId: Number(ids.d) } });
  });

  it('FR-006 H9 기간 — 공장 오늘 ~ 6일 전(현지 날짜 경계), 7일 전·미래는 400 RANGE', async () => {
    const sixAgo = (await list('t1', 'wa', { scope: 'WORKER', businessDate: shiftDay(DAY, -6) }).expect(200)).body as RecordPage;
    expect(sixAgo.items.map((item) => item.documentNo)).toEqual(['six2', 'six1'].map((key) => records[key].documentNo));

    for (const businessDate of [shiftDay(DAY, -7), shiftDay(DAY, 1)]) {
      const response = await list('t1', 'wa', { scope: 'WORKER', businessDate }).expect(400);
      expect(response.body.errors).toEqual([expect.objectContaining({ field: 'businessDate', code: 'RANGE' })]);
    }
  });

  it('FR-012 H10 SC-004 쪽 나눔 — 60건이면 첫 쪽 50·둘째 쪽 10·total 60, 첫 쪽 2초 안', async () => {
    const businessDate = shiftDay(DAY, -2);
    const started = Date.now();
    const first = (await list('t3', 'wc', { scope: 'WORKER', businessDate, size: 50 }).expect(200)).body as RecordPage;
    const elapsed = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(`SC-004 적치 기록 60건 첫 쪽(50건) 응답 ${elapsed}ms`);
    expect(elapsed).toBeLessThan(2000);
    expect(first.items).toHaveLength(50);
    expect(first.page).toEqual({ page: 1, size: 50, total: 60 });

    const second = (await list('t3', 'wc', { scope: 'WORKER', businessDate, page: 2 }).expect(200)).body as RecordPage;
    expect(second.items).toHaveLength(10);
    expect(second.page).toEqual({ page: 2, size: 50, total: 60 });
    const all = [...first.items, ...second.items].map((item) => item.recordedAt);
    expect(new Set([...first.items, ...second.items].map((item) => item.recordId)).size).toBe(60);
    expect(all).toEqual([...all].sort().reverse());
  });

  it('FR-013 H11 다른 공장 단말은 그 공장 기록만 — P1 작업자 사번은 400 INVALID', async () => {
    const mine = (await list('tp2', 'wp2', { scope: 'WORKER', businessDate: DAY }).expect(200)).body as RecordPage;
    expect(mine.items.map((item) => item.documentNo)).toEqual([records.p2.documentNo]);
    const terminal = (await list('tp2', 'wp2', { scope: 'TERMINAL', businessDate: DAY }).expect(200)).body as RecordPage;
    expect(terminal.items.map((item) => item.documentNo)).toEqual([records.p2.documentNo]);

    const other = await list('tp2', 'wa', { scope: 'WORKER', businessDate: DAY }).expect(400);
    expect(other.body.errors).toEqual([expect.objectContaining({ field: 'X-Worker-No', code: 'INVALID' })]);
  });

  it('H15 세션 토큰은 401(권한 없으면 403), POP 토큰 401, WORKER 에 사번 없음 400 INVALID, 잘못된 scope·businessDate 400', async () => {
    const query = { scope: 'TERMINAL', businessDate: DAY };
    await request(app.getHttpServer()).get(PATH).query(query).set('Cookie', cookies.m0105).expect(401);
    await request(app.getHttpServer()).get(PATH).query(query).set('Cookie', cookies.none).expect(403);
    await request(app.getHttpServer()).get(PATH).query(query).expect(401);
    await list('pop', 'wa', query).expect(401);

    const noWorker = await list('t1', null, { scope: 'WORKER', businessDate: DAY }).expect(400);
    expect(noWorker.body.errors).toEqual([expect.objectContaining({ field: 'X-Worker-No', code: 'INVALID' })]);
    await list('t1', 'wa', { scope: 'MINE', businessDate: DAY }).expect(400);
    await list('t1', 'wa', { scope: 'WORKER', businessDate: '2026/11/19' }).expect(400);
    await list('t1', 'wa', { scope: 'WORKER' }).expect(400);
  });

  // ── 도우미 ─────────────────────────────────────────────────────

  function list(terminal: string, worker: string | null, query: Record<string, unknown>): request.Test {
    const call = request(app.getHttpServer()).get(PATH).query(query).set('Authorization', `Bearer ${tokens[terminal]}`);
    return worker === null ? call : call.set('X-Worker-No', `${PREFIX}-${worker.toUpperCase()}`);
  }

  async function lot(plant: string, tag: string): Promise<{ lotId: bigint; lotNo: string }> {
    seq += 1;
    const lotNo = `${PREFIX}-L${String(seq)}-${tag}`;
    const row = await prisma.lot.create({
      data: { lot_no: lotNo, item_id: ids.x, lot_type_code: 'MATERIAL', plant_id: ids[plant], initial_qty: 10, uom_id: ids.ea,
        source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 1n, status_code: 'NORMAL' },
    });
    return { lotId: row.lot_id, lotNo };
  }

  /** 입고 코어로 전표 1건·라인 1줄 — PDA 적치와 같은 함수다(`putawayActor`·`putawayModeCode`). */
  async function post(input: {
    plant: string; warehouse: string; location: string; at: string; lotTag: string; putawayModeCode: string | null;
    actor?: { workerId: bigint; terminalId: bigint }; receiptType?: string; defective?: boolean; putawayNo?: string;
  }): Promise<{ receiptNo: string; lineId: bigint; lotNo: string; lotId: bigint }> {
    const made = await lot(input.plant, input.lotTag);
    const receiptNo = `${PREFIX}-GR-${String(seq)}`;
    const receipt: GoodsReceiptCreate = {
      receiptTypeCode: input.receiptType ?? 'MATERIAL', plantId: Number(ids[input.plant]), warehouseId: Number(ids[input.warehouse]),
      receiptDatetime: input.at, businessDate: input.at.slice(0, 10), putawayActor: input.actor ?? null,
      lines: [{
        itemId: Number(ids.x), lotId: Number(made.lotId), receiptQty: 10, uomId: Number(ids.ea),
        qualityStatusCode: input.defective === true ? 'DEFECTIVE' : 'NORMAL', inventoryStatusCode: input.defective === true ? 'ON_HOLD' : 'AVAILABLE',
        destinationLocationId: Number(ids[input.location]), putawayModeCode: input.putawayModeCode,
      }],
    };
    const posting = app.get(InventoryPostingService);
    const id = await prisma.$transaction((tx) => postReceipt(tx, posting, receipt, undefined, receiptNo, input.putawayNo === undefined ? null : [input.putawayNo]));
    const line = await prisma.goods_receipt_line.findFirstOrThrow({ where: { goods_receipt_id: id } });
    return { receiptNo, lineId: line.goods_receipt_line_id, lotNo: made.lotNo, lotId: made.lotId };
  }

  async function direct(key: string, input: { worker: string; terminal: string; mode: string; location: string; at: string; defective?: boolean }): Promise<void> {
    const plant = input.terminal === 'tp2' ? 'p2' : 'p1';
    const warehouse = input.location === 'C1' ? 'c' : input.location === 'D1' ? 'd' : 'a';
    const made = await post({
      plant, warehouse, location: input.location, at: input.at, lotTag: key, putawayModeCode: input.mode, defective: input.defective,
      actor: { workerId: ids[input.worker], terminalId: ids[input.terminal] },
    });
    records[key] = { documentNo: made.receiptNo, recordId: Number(made.lineId), lotNo: made.lotNo };
  }

  /** 입고(적치 대기 자리)로 지시를 만들고 단말 T2·작업자 WA 로 완료한다. */
  async function task(key: string, input: { receiptType: string; path: 'complete' | 'complete-temporary'; at: string }): Promise<void> {
    const taskNo = `${PREFIX}-PT-${key}`;
    await post({ plant: 'p1', warehouse: 'a', location: 'ASTAGING', at: input.at, lotTag: key, putawayModeCode: null, receiptType: input.receiptType, putawayNo: taskNo });
    const row = await prisma.putaway_task.findUniqueOrThrow({ where: { putaway_task_no: taskNo } });
    await complete(row.putaway_task_id, input.path, input.at);
    records[key] = { documentNo: taskNo, recordId: Number(row.putaway_task_id), lotNo: '' };
  }

  /** 창고 보충 수령 원천(피처 004) 지시 — 입고 전표가 없다. 출발 위치(R2)에 재고를 세우고 수령 줄에 지시를 매단다. */
  async function replenishmentTask(key: string, time: string): Promise<void> {
    const stock = await post({ plant: 'p1', warehouse: 'a', location: 'R2', at: time, lotTag: key, putawayModeCode: null });
    const issue = await prisma.goods_issue.create({
      data: { goods_issue_no: `${PREFIX}-GI-${key}`, issue_type_code: 'OTHER', source_document_type_code: 'PICKING_ORDER', source_document_id: 1n,
        source_warehouse_id: ids.a, issued_at: new Date(time), status_code: 'POSTED' },
    });
    const issueLine = await prisma.goods_issue_line.create({
      data: { goods_issue_id: issue.goods_issue_id, line_no: 1, item_id: ids.x, lot_id: stock.lotId, issue_qty: 10, uom_id: ids.ea, source_location_id: ids.R2 },
    });
    const receipt = await prisma.shopfloor_receipt.create({
      data: { shopfloor_receipt_no: `${PREFIX}-SR-${key}`, goods_issue_id: issue.goods_issue_id, destination_location_id: ids.R2,
        received_at: new Date(time), status_code: 'REGISTERED' },
    });
    const receiptLine = await prisma.shopfloor_receipt_line.create({
      data: { shopfloor_receipt_id: receipt.shopfloor_receipt_id, goods_issue_line_id: issueLine.goods_issue_line_id, item_id: ids.x,
        lot_id: stock.lotId, issued_qty: 10, received_qty: 10, uom_id: ids.ea },
    });
    const taskNo = `${PREFIX}-PT-${key}`;
    const row = await prisma.putaway_task.create({
      data: { putaway_task_no: taskNo, shopfloor_receipt_line_id: receiptLine.shopfloor_receipt_line_id, item_id: ids.x, lot_id: stock.lotId,
        task_qty: 10, uom_id: ids.ea, from_location_id: ids.R2, status_code: 'PENDING' },
    });
    await complete(row.putaway_task_id, 'complete', time);
    records[key] = { documentNo: taskNo, recordId: Number(row.putaway_task_id), lotNo: stock.lotNo };
  }

  async function complete(taskId: bigint, path: 'complete' | 'complete-temporary', time: string): Promise<void> {
    await request(app.getHttpServer()).post(`/api/logistics/putaway-tasks/${String(taskId)}:${path}`)
      .set('Authorization', `Bearer ${tokens.t2}`).set('X-Worker-No', `${PREFIX}-WA`).set('Idempotency-Key', randomUUID())
      .send({ actualLocationId: Number(ids.R1), businessDate: time.slice(0, 10), occurredAt: time, ...(path === 'complete-temporary' ? { reasonCode: 'NO_SPACE' } : {}) })
      .expect(200);
  }

  /** 쪽 나눔 자료 — WC 가 T3 에서 `count` 건(행을 바로 넣는다). */
  async function bulk(count: number, day: string): Promise<void> {
    const made = await lot('p1', 'BULK');
    for (let index = 0; index < count; index += 1) {
      const receipt = await prisma.goods_receipt.create({
        data: { goods_receipt_no: `${PREFIX}-GRB-${String(index)}`, receipt_type_code: 'MATERIAL', plant_id: ids.p1, warehouse_id: ids.a,
          receipt_datetime: new Date(Date.parse(at(day, 1)) + index * 60_000), status_code: 'POSTED', putaway_worker_id: ids.wc, putaway_terminal_id: ids.t3 },
      });
      await prisma.goods_receipt_line.create({
        data: { goods_receipt_id: receipt.goods_receipt_id, line_no: 1, item_id: ids.x, lot_id: made.lotId, receipt_qty: 1, uom_id: ids.ea,
          quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', destination_location_id: ids.R1, putaway_mode_code: 'DESIGNATED' },
      });
    }
  }

  async function terminal(key: string, plant: string, type: 'MOBILE' | 'POP'): Promise<void> {
    const row = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-${key.toUpperCase()}`, plant_id: ids[plant], terminal_type_code: type, status_code: 'RUNNING' },
    });
    ids[key] = row.terminal_id;
    tokens[key] = jwt.sign({ sub: Number(row.terminal_id), typ: 'terminal', tv: row.token_version, terminalCode: row.terminal_code, plantId: Number(ids[plant]) });
  }

  async function warehouse(plant: string, key: string, isDefect = false): Promise<void> {
    const row = await prisma.warehouse.create({
      data: { plant_id: ids[plant], business_unit_id: ids.unit, warehouse_code: `${PREFIX}-WH${key.toUpperCase()}`, warehouse_name: `${PREFIX} 창고 ${key.toUpperCase()}`,
        warehouse_type_code: 'MATERIAL', management_level_code: 'LOCATION', is_defect: isDefect },
    });
    ids[key] = row.warehouse_id;
    for (const system of await prisma.location.findMany({ where: { warehouse_id: row.warehouse_id, system_role_code: { not: null } } })) {
      const name = `${key.toUpperCase()}${system.system_role_code === 'WAREHOUSE_WHOLE' ? 'WHOLE' : 'STAGING'}`;
      ids[name] = system.location_id;
      codes[name] = system.location_code;
    }
  }

  async function location(wh: string, key: string): Promise<void> {
    const row = await prisma.location.create({ data: { warehouse_id: ids[wh], location_code: `${PREFIX}-${key}`, location_name: `${key} 랙` } });
    ids[key] = row.location_id;
    codes[key] = row.location_code;
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `기록 ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `기록 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '기록법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '기록사업부' },
    })).business_unit_id;
    for (const plant of ['p1', 'p2']) {
      ids[plant] = (await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-${plant.toUpperCase()}`, plant_name: `기록공장 ${plant}`, timezone_code: TZ },
      })).plant_id;
    }
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.x = (await prisma.item.create({
      data: { item_code: `${PREFIX}-X`, item_name: '기록자재 X', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true },
    })).item_id;
    for (const [key, plant] of [['wa', 'p1'], ['wb', 'p1'], ['wc', 'p1'], ['wp2', 'p2']]) {
      ids[key] = (await prisma.worker.create({
        data: { worker_no: `${PREFIX}-${key.toUpperCase()}`, worker_name: `기록작업자 ${key.toUpperCase()}`, business_unit_id: ids.unit, plant_id: ids[plant], status_code: 'EMPLOYED' },
      })).worker_id;
    }
    for (const [key, plant] of [['t1', 'p1'], ['t2', 'p1'], ['t3', 'p1'], ['tp2', 'p2']]) await terminal(key, plant, 'MOBILE');
    await terminal('pop', 'p1', 'POP');
    await warehouse('p1', 'a');
    await warehouse('p1', 'd', true);
    await warehouse('p2', 'c');
    await location('a', 'R1');
    await location('a', 'R2');
    await location('d', 'D1');
    await location('c', 'C1');
    cookies.m0105 = await makeUser('M0105', ['M-01-05']);
    cookies.none = await makeUser('NONE', ['W-01-09']);
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const warehouses = `SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    // ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — CASCADE 가 입고 라인·적치 지시까지 비운다(다른 적치 스위트와 같다).
    await prisma.$executeRawUnsafe('TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE');
    for (const sql of [
      `DELETE FROM inventory.inventory_balance WHERE warehouse_id IN (${warehouses})`,
      `DELETE FROM logistics.putaway_task WHERE putaway_task_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.shopfloor_receipt_line WHERE shopfloor_receipt_id IN (SELECT shopfloor_receipt_id FROM logistics.shopfloor_receipt WHERE shopfloor_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shopfloor_receipt WHERE shopfloor_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.goods_issue_line WHERE goods_issue_id IN (SELECT goods_issue_id FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.goods_receipt_line WHERE goods_receipt_id IN (SELECT goods_receipt_id FROM logistics.goods_receipt WHERE plant_id IN (${plants}))`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM mdm.location WHERE warehouse_id IN (${warehouses})`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM audit.audit_event WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%')`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) await prisma.$executeRawUnsafe(sql);
  }
});
