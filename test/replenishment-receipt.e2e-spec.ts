/**
 * 창고 보충 출고 수령(피처 004 · omf-all-around#230 · US2 · SC-002·003) — 나눠 출고, 도착 대기, 일괄·웹 개별·모바일 수령.
 * 요청은 직접 요청 경로로, 피킹은 표에 옮기고, 출고는 실제 경로로 전기한다.
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
import { DocumentStateService } from '../src/core/document-state';
import { MaterialIssueReleaser } from '../src/core/material-issue/release-request';
import { PickingHandoverNotifier } from '../src/core/picking';
import { PrismaService } from '../src/prisma/prisma.service';
import { ItemKey } from './support/material-issue-fixture';
import { Place, ReplenishmentFixture } from './support/replenishment-fixture';

const PREFIX = `RRC${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';
const ARRIVALS = '/api/logistics/replenishment-requests/arrivals';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
const schema = (path: string, method: string, status: number) =>
  ajv.compile({ $ref: `https://omf-mes.invalid/contract#/paths/${path.replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema` });
const arrivals200 = schema('/logistics/replenishment-requests/arrivals', 'get', 200);
const bulk200 = schema('/logistics/shopfloor-receipts:bulk', 'post', 200);
const receive201 = schema('/logistics/replenishment-requests/arrivals/{goodsIssueId}:receive', 'post', 201);

describe('창고 보충 출고 수령 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: ReplenishmentFixture;
  const w: Record<string, Place> = {};
  const gi: Record<string, number> = {};
  let woIssue: number;

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

    // W/O 출고 한 장 — 도착 대기에 나오지 않고 W/O 없이는 받지 못한다.
    const lineId = await fx.line('P1', 'L', fx.ids.department);
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X20', productionDate: fx.nextWeekday('P1', 1) });
    await fx.release(workOrderId).expect(200);
    const [wo] = await fx.requests(workOrderId);
    // 출고 작업일 전이라 대기다 — 003 배포 함수로 바로 배포한다.
    const releaser = new MaterialIssueReleaser(app.get(DocumentStateService), app.get(PickingHandoverNotifier));
    await prisma.$transaction((tx) => releaser.release(tx, wo.material_issue_request_id, `${PREFIX}-PKWO`, null));
    await fx.pick(wo.material_issue_request_id, 20);
    woIssue = (await fx.issue(wo.material_issue_request_id, 20)).body.goodsIssue.goodsIssueId as number;
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  async function create(item: ItemKey, qty: number): Promise<bigint> {
    const res = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item, qty, source: w.MAT.warehouseId }] }).expect(201);
    return BigInt(res.body.requests[0].materialIssueRequestId);
  }
  async function ship(id: bigint, qty: number): Promise<number> {
    await fx.pick(id, qty);
    return (await fx.issue(id, qty)).body.goodsIssue.goodsIssueId as number;
  }
  const available = async (item: ItemKey) =>
    (await prisma.inventory_balance.aggregate({ where: { warehouse_id: w.PROD.warehouseId, item_id: fx.items[item] }, _sum: { available_qty: true } }))._sum.available_qty?.toNumber() ?? 0;
  const listArrivals = async (cookie = fx.replenishmentCookie) =>
    (await request(app.getHttpServer()).get(ARRIVALS).query({ plantId: Number(fx.ids.p1), size: 100 }).set('Cookie', cookie).expect(200)).body;
  const bulk = (ids: number[], cookie = fx.replenishmentCookie) =>
    request(app.getHttpServer())
      .post('/api/logistics/shopfloor-receipts:bulk')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ businessDate: '2026-11-05', receivedAt: new Date().toISOString(), goodsIssueIds: ids });
  async function linesOf(goodsIssueId: number, received?: (qty: number) => number, reason?: string) {
    const lines = await prisma.goods_issue_line.findMany({ where: { goods_issue_id: goodsIssueId }, orderBy: { line_no: 'asc' } });
    return lines.map((l) => {
      const issued = l.issue_qty.toNumber();
      const got = received === undefined ? issued : received(issued);
      return { goodsIssueLineId: Number(l.goods_issue_line_id), itemId: Number(l.item_id), lotId: Number(l.lot_id), issuedQty: issued, receivedQty: got, uomId: Number(l.uom_id), ...(got === issued ? {} : { varianceReasonCode: reason }) };
    });
  }
  const now = () => new Date().toISOString();
  const webReceive = async (goodsIssueId: number, received?: (qty: number) => number, cookie = fx.replenishmentCookie) =>
    request(app.getHttpServer())
      .post(`${ARRIVALS}/${goodsIssueId}:receive`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ businessDate: '2026-11-05', receivedAt: now(), occurredAt: now(), lines: await linesOf(goodsIssueId, received, 'DAMAGED_IN_TRANSIT') });
  const mobileReceive = async (goodsIssueId: number, extra: object = {}, cookie = fx.mobileCookie) =>
    request(app.getHttpServer())
      .post('/api/logistics/shopfloor-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', `${PREFIX}-WK`)
      .send({
        goodsIssueId,
        destinationLocationId: Number(await fx.systemLocation(w.PROD.warehouseId, 'PUTAWAY_STAGING')),
        receivedAt: now(),
        businessDate: '2026-11-05',
        occurredAt: now(),
        lines: await linesOf(goodsIssueId),
        ...extra,
      });

  it('US2-1 US2-2 SC-002 90 을 30·30·30 으로 나눠 출고 — 전표 3장, 매번 생산 창고 +30, 셋째 뒤 요청·피킹 닫힘 / 한 번에 출고도 같다', async () => {
    const id = await create('X', 90);
    const before = await available('X');
    for (const [index, key] of ['x1', 'x2', 'x3'].entries()) {
      gi[key] = await ship(id, 30);
      expect(await available('X')).toBe(before + 30 * (index + 1));
    }
    const request_ = await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: id }, include: { material_issue_request_line: true } });
    expect(request_.status_code).toBe('POSTED');
    expect(request_.material_issue_request_line[0].issued_qty.toNumber()).toBe(90);
    expect((await fx.pickings(id)).map((o) => o.status_code)).toEqual(['POSTED']);

    const once = await create('Y', 40);
    const y0 = await available('Y');
    gi.y = await ship(once, 40);
    expect(await available('Y')).toBe(y0 + 40);
  });

  it('US2-3 FR-037 도착 대기 — 세 전표가 생산 창고·출고번호·요청번호·품목·LOT·수량·시각·경과 일수와 함께, W/O 출고는 없다', async () => {
    const body = await listArrivals();
    expect(arrivals200(body)).toBe(true);
    const ids = body.items.map((i: { goodsIssueId: number }) => i.goodsIssueId);
    expect(ids).toEqual(expect.arrayContaining([gi.x1, gi.x2, gi.x3, gi.y]));
    expect(ids).not.toContain(woIssue);
    const row = body.items.find((i: { goodsIssueId: number }) => i.goodsIssueId === gi.x1);
    expect(row).toMatchObject({ productionWarehouseName: 'PROD', replenishmentOriginCode: 'DIRECT', elapsedDays: 0, destinationLocationCode: expect.any(String) });
    expect(row.issueRequestNo).toMatch(/.+/);
    expect(row.lines).toEqual([expect.objectContaining({ itemId: Number(fx.items.X), issueQty: 30, lotNo: expect.any(String) })]);
  });

  it('US2-4 일괄 수령 두 장 — RECEIVED, 도착 대기에서 빠지고 재고는 그대로', async () => {
    const x = await available('X');
    const res = await bulk([gi.x1, gi.x2]).expect(200);
    expect(bulk200(res.body)).toBe(true);
    expect(res.body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['RECEIVED', 'RECEIVED']);
    const ids = (await listArrivals()).items.map((i: { goodsIssueId: number }) => i.goodsIssueId);
    expect(ids).not.toContain(gi.x1);
    expect(ids).not.toContain(gi.x2);
    expect(await available('X')).toBe(x);
    const receipt = await prisma.shopfloor_receipt.findFirstOrThrow({ where: { goods_issue_id: gi.x1 }, include: { shopfloor_receipt_line: true } });
    expect(receipt.work_order_id).toBeNull();
    expect(receipt.shopfloor_receipt_line.map((l) => [l.issued_qty.toNumber(), l.received_qty.toNumber()])).toEqual([[30, 30]]);
  });

  it('US2-5 웹 개별 수령 28/30 + 사유 — 차이가 기록되고 재고는 그대로 · 다시 받으면 409 ALREADY_RECEIVED', async () => {
    const x = await available('X');
    const res = await webReceive(gi.x3, (qty) => qty - 2);
    expect(res.status).toBe(201);
    expect(receive201(res.body)).toBe(true);
    expect(res.body.shopfloorReceipt).toMatchObject({ workOrderId: null, goodsIssueId: gi.x3 });
    expect(res.body.lines[0]).toMatchObject({ receivedQty: 28, varianceQty: 2, varianceReasonCode: 'DAMAGED_IN_TRANSIT' });
    expect(await available('X')).toBe(x);
    const again = await webReceive(gi.x3);
    expect(again.status).toBe(409);
    expect(again.body.errors[0].code).toBe('ALREADY_RECEIVED');
  });

  it('US2-6 US2-8 FR-037 M-01-09 만 가진 역할이 모바일 경로로 W/O 없이 보충 출고 수령(QR 발행과 무관) · US2-7 두 번째는 거부', async () => {
    const res = await mobileReceive(gi.y);
    expect(res.status).toBe(201);
    expect(res.body.shopfloorReceipt.workOrderId).toBeNull();
    const again = await mobileReceive(gi.y);
    expect(again.status).toBe(400);
    expect(again.body.errors[0]).toMatchObject({ field: 'goodsIssueId', code: 'STATE_LOCKED' });
    expect((await listArrivals()).items.map((i: { goodsIssueId: number }) => i.goodsIssueId)).not.toContain(gi.y);
  });

  it('W/O 없이 W/O 출고 → 400 · 도착 위치가 출고와 다르면 400 · 웹 개별 수령도 W/O 출고면 400', async () => {
    const wo = await mobileReceive(woIssue);
    expect(wo.status).toBe(400);
    expect(wo.body.errors).toContainEqual(expect.objectContaining({ field: 'workOrderId', code: 'INVALID' }));

    const id = await create('Z', 10);
    gi.z = await ship(id, 10);
    const wrong = await mobileReceive(gi.z, { destinationLocationId: Number(w.PROD.locationId) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.errors).toContainEqual(expect.objectContaining({ field: 'destinationLocationId', code: 'INVALID' }));

    const web = await webReceive(woIssue);
    expect(web.status).toBe(400);
    expect(web.body.errors).toContainEqual(expect.objectContaining({ field: 'goodsIssueId', code: 'INVALID' }));
  });

  it('US2-9 일괄 중 한 장이 먼저 수령됨 → 그 건만 ALREADY_RECEIVED · W/O 출고는 FAILED · 101건은 400', async () => {
    const res = await bulk([gi.z, gi.x1, woIssue]).expect(200);
    expect(res.body.results.map((r: { goodsIssueId: number; outcome: string }) => [r.goodsIssueId, r.outcome])).toEqual([
      [gi.z, 'RECEIVED'],
      [gi.x1, 'ALREADY_RECEIVED'],
      [woIssue, 'FAILED'],
    ]);
    expect(res.body.results[2].message).toContain('창고 보충 출고가 아닙니다');
    const tooMany = await bulk(Array.from({ length: 101 }, (_, i) => i + 1)).expect(400);
    expect(tooMany.body.errors[0]).toMatchObject({ field: 'goodsIssueIds', code: 'RANGE' });
  });

  it('SC-003 출고 20장을 한 번의 일괄로 — 20건 수령, 중복 0, 다시 보내면 모두 ALREADY_RECEIVED', async () => {
    const id = await create('V', 20);
    const ids: number[] = [];
    for (let i = 0; i < 20; i += 1) ids.push(await ship(id, 1));
    const res = await bulk(ids).expect(200);
    expect(res.body.results.filter((r: { outcome: string }) => r.outcome === 'RECEIVED')).toHaveLength(20);
    expect(await prisma.shopfloor_receipt.count({ where: { goods_issue_id: { in: ids.map(BigInt) } } })).toBe(20);
    const again = await bulk(ids).expect(200);
    expect(new Set(again.body.results.map((r: { outcome: string }) => r.outcome))).toEqual(new Set(['ALREADY_RECEIVED']));
    expect(await prisma.shopfloor_receipt.count({ where: { goods_issue_id: { in: ids.map(BigInt) } } })).toBe(20);
  });

  it('US3-5 잔량 마감 뒤에도 이미 나간 출고 전표는 수령한다', async () => {
    const id = await create('W', 50);
    const shipped = await ship(id, 20);
    const version = (await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: id } })).version_no;
    await request(app.getHttpServer())
      .post(`/api/logistics/material-issue-requests/${id}:close-remaining`)
      .set('Cookie', fx.replenishmentCookie)
      .set('Idempotency-Key', randomUUID())
      .send({ versionNo: version, reasonCode: 'STOCK_OUT' })
      .expect(200);
    expect((await listArrivals()).items.map((i: { goodsIssueId: number }) => i.goodsIssueId)).toContain(shipped);
    expect((await webReceive(shipped)).status).toBe(201);
  });

  it('FR-037 W-02-12 만 가진 역할은 모바일 경로(POST /shopfloor-receipts) 403 — 그 경로 권한은 그대로, M-01-09 만이면 도착 대기·일괄 403', async () => {
    const id = await create('Z', 5);
    const shipped = await ship(id, 5);
    expect((await mobileReceive(shipped, {}, fx.replenishmentCookie)).status).toBe(403);
    await request(app.getHttpServer()).get(ARRIVALS).query({ plantId: Number(fx.ids.p1) }).set('Cookie', fx.mobileCookie).expect(403);
    await bulk([shipped], fx.mobileCookie).expect(403);
    expect((await webReceive(shipped, undefined, fx.mobileCookie)).status).toBe(403);
  });
});
