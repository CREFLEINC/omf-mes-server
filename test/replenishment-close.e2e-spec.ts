/**
 * 창고 보충 요청 취소·잔량 마감·수령 요약(피처 004 · omf-all-around#230 · US3 · FR-023 · SC-006). 요청은 직접 요청 경로로
 * 만들고, 피킹은 표에 옮기고, 출고는 실제 경로로 전기한다. 수령 기록은 시험 준비에서 직접 넣는다(수령 경로는 뒤 PR).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { ItemKey } from './support/material-issue-fixture';
import { Place, ReplenishmentFixture } from './support/replenishment-fixture';

const PREFIX = `RCL${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';
const BASE = '/api/logistics/material-issue-requests';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
const schema = (path: string, method: string, status: number) =>
  ajv.compile({ $ref: `https://omf-mes.invalid/contract#/paths/${path.replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema` });
const closed200 = schema('/logistics/material-issue-requests/{materialIssueRequestId}:close-remaining', 'post', 200);
const detail200 = schema('/logistics/material-issue-requests/{materialIssueRequestId}', 'get', 200);

describe('창고 보충 요청 취소·잔량 마감·수령 요약 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: ReplenishmentFixture;
  const w: Record<string, Place> = {};
  let seq = 0;
  const made: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new ReplenishmentFixture(app, prisma, PREFIX);
    await fx.setup();
    fx.ids.p1 = await fx.plant('P1', HANOI);
    for (const key of ['PROD', 'MAT']) w[key] = await fx.warehouse(fx.ids.p1, key);
    fx.ids.department = await fx.department('D', [w.PROD.warehouseId]);
    for (const item of ['X', 'Y', 'Z', 'W', 'V'] as const) await fx.stock(w.MAT, item, 500);
    await fx.stock(w.PROD, 'X', 100);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  async function create(item: ItemKey, qty: number): Promise<bigint> {
    const res = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item, qty, source: w.MAT.warehouseId }] }).expect(201);
    return BigInt(res.body.requests[0].materialIssueRequestId);
  }
  const version = async (id: bigint) => (await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: id } })).version_no;
  const post = (id: bigint, action: 'close-remaining' | 'cancel', body: object, cookie = fx.replenishmentCookie) =>
    request(app.getHttpServer()).post(`${BASE}/${id}:${action}`).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send(body);
  const close = async (id: bigint, status: number, extra: object = {}) =>
    post(id, 'close-remaining', { versionNo: await version(id), reasonCode: 'STOCK_OUT', ...extra }).expect(status);
  const cancel = async (id: bigint, status: number) => post(id, 'cancel', { versionNo: await version(id) }).expect(status);
  /** 자재 창고의 출고 예정 가운데 창고 보충 요청 몫(품목별). */
  async function plannedReplenishment(item: ItemKey): Promise<number> {
    const res = await request(app.getHttpServer())
      .get(`${BASE}/planned-stock`)
      .query({ plantId: Number(fx.ids.p1), sourceWarehouseId: Number(w.MAT.warehouseId), itemId: Number(fx.items[item]) })
      .set('Cookie', fx.replenishmentCookie)
      .expect(200);
    const rows = res.body.items as { requests: { requestTypeCode: string; plannedQty: number }[] }[];
    return rows.flatMap((r) => r.requests).filter((r) => r.requestTypeCode === 'REPLENISHMENT').reduce((s, r) => s + r.plannedQty, 0);
  }

  it('US3-1 US3-4 90 중 60 출고 뒤 잔량 마감 — 닫은 사람·시각·사유가 남고 예정에서 30 이 빠진다', async () => {
    const id = (made.closed = await create('X', 90));
    await fx.pick(id, 60);
    await fx.issue(id, 60);
    expect(await plannedReplenishment('X')).toBe(30);

    const res = await close(id, 200, { remark: '공급사 납기 지연' });
    expect(closed200(res.body)).toBe(true);
    expect(res.body).toMatchObject({
      statusCode: 'REGISTERED',
      displayStatus: 'DONE',
      replenishmentStatus: 'REMAINDER_CLOSED',
      closeReasonCode: 'REMAINDER_CLOSED',
      closeReasonDetailCode: 'STOCK_OUT',
      closeRemark: '공급사 납기 지연',
      closedBy: Number(fx.ids.replenishmentUser),
      qtySummary: { requestedQty: 90, issuedQty: 60, closedQty: 30 },
    });
    expect(res.body.closedAt).not.toBeNull();
    expect(await plannedReplenishment('X')).toBe(0);
    const [picking] = await fx.pickings(id);
    expect(picking.picking_line.map((l) => [l.planned_qty.toNumber(), l.picked_qty.toNumber()])).toEqual([[60, 60]]);
    await close(id, 409);
  });

  it('US3-2 진행 없는 요청 취소 — 요청·피킹 지시 취소, 예정 0', async () => {
    const id = (made.cancelled = await create('Y', 40));
    expect(await plannedReplenishment('Y')).toBe(40);
    const res = await cancel(id, 200);
    expect(res.body.materialIssueRequest).toMatchObject({ statusCode: 'CANCELLED', replenishmentStatus: 'CANCELLED' });
    expect((await fx.pickings(id)).map((o) => o.status_code)).toEqual(['CANCELLED']);
    expect(await plannedReplenishment('Y')).toBe(0);
  });

  it('US3-3 진행 있으면 취소 409(잔량 마감 안내) · 진행 없으면 잔량 마감 409(취소 안내)', async () => {
    const started = (made.started = await create('Z', 50));
    await fx.pick(started, 10);
    await fx.issue(started, 10);
    const blocked = await cancel(started, 409);
    expect(blocked.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', message: '피킹·출고가 시작된 요청은 취소할 수 없습니다. 잔량 마감을 쓰세요.' });
    const fresh = await create('Z', 5);
    const early = await close(fresh, 409);
    expect(early.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', message: '아직 피킹·출고가 시작되지 않았습니다. 요청 취소를 쓰세요.' });
  });

  it('SC-006 출고·취소·마감을 섞은 뒤 품목별 「진행 중 보충 미출고 합」 = 「보충 요청이 만든 자재 창고 예정」', async () => {
    for (const item of ['X', 'Y', 'Z'] as const) {
      const lines = await prisma.material_issue_request_line.findMany({
        where: {
          item_id: fx.items[item],
          material_issue_request: { request_type_code: 'REPLENISHMENT', source_warehouse_id: w.MAT.warehouseId, status_code: { in: ['WAITING', 'REGISTERED'] }, closed_at: null },
        },
      });
      const outstanding = lines.reduce((s, l) => s + l.requested_qty.minus(l.issued_qty).toNumber(), 0);
      expect([item, await plannedReplenishment(item)]).toEqual([item, outstanding]);
    }
  });

  it('R5-1 집었지만 출고하지 않은 양이 있으면 잔량 마감 409', async () => {
    const id = await create('W', 30);
    await fx.pick(id, 10);
    await fx.issue(id, 10);
    await fx.pick(id, 5);
    const res = await close(id, 409);
    expect(res.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', message: '집었지만 아직 출고하지 않은 자재가 있습니다. 집은 양을 먼저 출고하세요.' });
  });

  it('사유 코드가 없거나 틀리면 400 · W-02-12 가 없으면 403 · W/O 요청은 409', async () => {
    const id = made.started;
    await post(id, 'close-remaining', { versionNo: await version(id) }).expect(400);
    const wrong = await close(id, 400, { reasonCode: 'NOPE' });
    expect(wrong.body.errors).toContainEqual(expect.objectContaining({ field: 'reasonCode', code: 'INVALID' }));
    await post(id, 'close-remaining', { versionNo: await version(id), reasonCode: 'OTHER' }, fx.cookie).expect(403);

    const lineId = await fx.line('P1', 'L', fx.ids.department);
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X20', productionDate: fx.nextWeekday('P1', 1) });
    await fx.release(workOrderId).expect(200);
    const [wo] = await fx.requests(workOrderId);
    made.workOrder = wo.material_issue_request_id;
    const res = await close(wo.material_issue_request_id, 409);
    expect(res.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', message: '잔량 마감은 창고 보충 요청만 합니다.' });
  });

  it('FR-023 수령 요약·출고 전표 목록 — 출고 2장 중 1장 수령이면 2/1, W/O 요청은 null', async () => {
    const id = await create('V', 30);
    await fx.pick(id, 20);
    const first = await fx.issue(id, 20);
    await fx.pick(id, 10);
    await fx.issue(id, 10);
    const receipt = await prisma.shopfloor_receipt.create({
      data: {
        shopfloor_receipt_no: `${PREFIX}-SR${++seq}`,
        goods_issue_id: BigInt(first.body.goodsIssue.goodsIssueId as number),
        destination_location_id: (await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: id } })).destination_location_id,
        received_at: new Date(),
        status_code: 'POSTED',
      },
    });

    const [row] = await fx.list({ requestTypeCode: 'REPLENISHMENT', itemId: Number(fx.items.V) });
    expect(row).toMatchObject({ replenishmentStatus: 'COMPLETED', receiptSummary: { issuedCount: 2, receivedCount: 1 } });
    expect(row).not.toHaveProperty('goodsIssues');
    const detail = await request(app.getHttpServer()).get(`${BASE}/${id}`).set('Cookie', fx.replenishmentCookie).expect(200);
    expect(detail200(detail.body)).toBe(true);
    expect(detail.body.materialIssueRequest.goodsIssues).toEqual([
      expect.objectContaining({ goodsIssueId: first.body.goodsIssue.goodsIssueId, received: true, shopfloorReceiptId: Number(receipt.shopfloor_receipt_id) }),
      expect.objectContaining({ received: false, shopfloorReceiptId: null }),
    ]);

    const wo = await request(app.getHttpServer()).get(`${BASE}/${made.workOrder}`).set('Cookie', fx.replenishmentCookie).expect(200);
    expect(wo.body.materialIssueRequest).toMatchObject({ replenishmentStatus: null, qtySummary: null, receiptSummary: null, goodsIssues: null });
  });

  it('목록 조건 replenishmentStatus — 여러 값, 쪽 나눔이 맞는다', async () => {
    const ids = async (statuses: string) =>
      (await fx.list({ requestTypeCode: 'REPLENISHMENT', plantId: Number(fx.ids.p1), replenishmentStatus: statuses })).map((r) => BigInt(r.materialIssueRequestId as number));
    expect(await ids('REMAINDER_CLOSED')).toEqual([made.closed]);
    expect(await ids('CANCELLED')).toEqual([made.cancelled]);
    const both = await ids('REMAINDER_CLOSED,CANCELLED');
    expect(both.sort()).toEqual([made.closed, made.cancelled].sort());
    expect(await ids('IN_PROGRESS')).toContain(made.started);
    const paged = await request(app.getHttpServer())
      .get(BASE)
      .query({ requestTypeCode: 'REPLENISHMENT', plantId: Number(fx.ids.p1), replenishmentStatus: 'REMAINDER_CLOSED,CANCELLED', size: 1 })
      .set('Cookie', fx.replenishmentCookie)
      .expect(200);
    expect(paged.body.page.total).toBe(2);
    expect(paged.body.items).toHaveLength(1);
    await request(app.getHttpServer()).get(BASE).query({ replenishmentStatus: 'NOPE' }).set('Cookie', fx.replenishmentCookie).expect(400);
  });
});
