/**
 * 받은 창고 보충 자재 적치(피처 004 · omf-all-around#230 · US6 · research R-7·R-8). 나뉜 생산 창고는 적치 대기로 들어와
 * 수령 때 지시가 서고, 적치는 남은 재고만큼만 옮긴다. 나뉘지 않은 창고는 창고 전체로 들어와 지시가 없다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { ItemKey } from './support/material-issue-fixture';
import { Place, ReplenishmentFixture } from './support/replenishment-fixture';

const PREFIX = `RPA${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';
const TASKS = '/api/logistics/putaway-tasks';

describe('창고 보충 수령 적치 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: ReplenishmentFixture;
  let terminalToken: string;
  const w: Record<string, Place> = {};
  let flat: bigint;
  let staging: bigint;

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
    flat = await fx.undividedWarehouse(fx.ids.p1, 'FLAT');
    await fx.department('D', [w.PROD.warehouseId, flat]);
    for (const item of ['X', 'Y', 'Z', 'W', 'V'] as const) await fx.stock(w.MAT, item, 500);
    staging = await fx.systemLocation(w.PROD.warehouseId, 'PUTAWAY_STAGING');
    // 나뉜 창고의 사람이 만든 위치(PROD) — 보관 품목으로 걸어 둘 곳이 된다(재고 코어도 보관 품목을 본다).
    for (const item of ['X', 'W', 'V'] as const) await prisma.location_item.create({ data: { location_id: w.PROD.locationId, item_id: fx.items[item] } });
    // 적치 완료는 모바일 적치(M-01-05)와 실재하는 사번이 필요하다.
    const base = await prisma.role.findUniqueOrThrow({ where: { role_code: `${PREFIX}-R` } });
    await prisma.role_permission.create({ data: { role_id: base.role_id, permission_code: 'M-01-05' } });
    await prisma.worker.create({ data: { worker_no: `${PREFIX}-WK`, worker_name: '적치', business_unit_id: fx.ids.unit, plant_id: fx.ids.p1, status_code: 'EMPLOYED' } });
    const terminal = await prisma.terminal.create({ data: { terminal_code: `${PREFIX}-T`, plant_id: fx.ids.p1, terminal_type_code: 'MOBILE', status_code: 'RUNNING' } });
    terminalToken = app.get(JwtService).sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(fx.ids.p1) });
  });

  afterAll(async () => {
    await prisma.putaway_task.deleteMany({ where: { location_putaway_task_from_location_idTolocation: { warehouse: { warehouse_code: { startsWith: PREFIX } } } } });
    await prisma.location_item.deleteMany({ where: { location: { warehouse: { warehouse_code: { startsWith: PREFIX } } } } });
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await fx.cleanup();
    await app.close();
  });

  async function shipped(item: ItemKey, qty: number, warehouse: bigint = w.PROD.warehouseId): Promise<number> {
    const res = await fx.create({ productionWarehouseId: warehouse, lines: [{ item, qty, source: w.MAT.warehouseId }] }).expect(201);
    const id = BigInt(res.body.requests[0].materialIssueRequestId);
    await fx.pick(id, qty);
    return (await fx.issue(id, qty)).body.goodsIssue.goodsIssueId as number;
  }
  const now = () => new Date().toISOString();
  async function webReceive(goodsIssueId: number, received?: number) {
    const lines = await prisma.goods_issue_line.findMany({ where: { goods_issue_id: goodsIssueId } });
    return request(app.getHttpServer())
      .post(`/api/logistics/replenishment-requests/arrivals/${goodsIssueId}:receive`)
      .set('Cookie', fx.replenishmentCookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        businessDate: '2026-11-05', receivedAt: now(), occurredAt: now(),
        lines: lines.map((l) => {
          const got = received ?? l.issue_qty.toNumber();
          return { goodsIssueLineId: Number(l.goods_issue_line_id), itemId: Number(l.item_id), lotId: Number(l.lot_id), issuedQty: l.issue_qty.toNumber(), receivedQty: got, uomId: Number(l.uom_id), ...(got === l.issue_qty.toNumber() ? {} : { varianceReasonCode: 'DAMAGED_IN_TRANSIT' }) };
        }),
      })
      .expect(201);
  }
  const complete = (taskId: number, locationId: bigint) =>
    request(app.getHttpServer())
      .post(`${TASKS}/${taskId}:complete`)
      .set('Cookie', fx.cookie)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', `${PREFIX}-WK`)
      .send({ actualLocationId: Number(locationId), businessDate: '2026-11-05', occurredAt: now() });
  const stagingBalance = (item: ItemKey) =>
    prisma.inventory_balance.findFirstOrThrow({ where: { location_id: staging, item_id: fx.items[item] } });

  it('US6-1 나뉜 생산 창고로 출고 → 적치 대기에 정상·가용으로 들어온다', async () => {
    await shipped('X', 50);
    const balance = await stagingBalance('X');
    expect(balance).toMatchObject({ quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE' });
    expect(balance.available_qty?.toNumber()).toBe(50);
  });

  it('US6-2 수령(웹 개별·일괄·모바일)마다 출고 줄마다 지시 — 원천 REPLENISHMENT_RECEIPT·출발 = 적치 대기·둘 곳 = 보관 품목 위치, 받은 0 이면 없음', async () => {
    const [web, viaBulk, viaMobile, nothing] = [await shipped('X', 30), await shipped('X', 20), await shipped('X', 10), await shipped('Y', 5)];
    const res = await webReceive(web);
    expect(res.body.shopfloorReceipt.putawayTaskIds).toHaveLength(1);
    const [taskId] = res.body.shopfloorReceipt.putawayTaskIds;
    const task = await request(app.getHttpServer()).get(`${TASKS}/${taskId}`).set('Cookie', fx.cookie).expect(200);
    expect(task.body).toMatchObject({
      originCode: 'REPLENISHMENT_RECEIPT', goodsReceiptLineId: null, fromLocationId: Number(staging),
      warehouseId: Number(w.PROD.warehouseId), taskQty: 30, statusCode: 'PENDING',
      allowedLocations: [expect.objectContaining({ locationId: Number(w.PROD.locationId) })],
    });
    expect(task.body.shopfloorReceiptLineId).toEqual(expect.any(Number));

    await request(app.getHttpServer())
      .post('/api/logistics/shopfloor-receipts:bulk')
      .set('Cookie', fx.replenishmentCookie)
      .set('Idempotency-Key', randomUUID())
      .send({ businessDate: '2026-11-05', receivedAt: now(), goodsIssueIds: [viaBulk] })
      .expect(200);
    const lines = await prisma.goods_issue_line.findMany({ where: { goods_issue_id: viaMobile } });
    const mobile = await request(app.getHttpServer())
      .post('/api/logistics/shopfloor-receipts')
      .set('Cookie', fx.mobileCookie)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', `${PREFIX}-WK`)
      .send({
        goodsIssueId: viaMobile, destinationLocationId: Number(staging), receivedAt: now(), businessDate: '2026-11-05', occurredAt: now(),
        lines: lines.map((l) => ({ goodsIssueLineId: Number(l.goods_issue_line_id), itemId: Number(l.item_id), lotId: Number(l.lot_id), issuedQty: 10, receivedQty: 10, uomId: Number(l.uom_id) })),
      })
      .expect(201);
    expect(mobile.body.shopfloorReceipt.putawayTaskIds).toHaveLength(1);
    const byReceipt = async (goodsIssueId: number) =>
      prisma.putaway_task.findMany({ where: { shopfloor_receipt_line: { shopfloor_receipt: { goods_issue_id: goodsIssueId } } } });
    expect((await byReceipt(viaBulk)).map((t) => t.task_qty.toNumber())).toEqual([20]);
    expect((await byReceipt(viaMobile)).map((t) => t.task_qty.toNumber())).toEqual([10]);

    const zero = await webReceive(nothing, 0);
    expect(zero.body.shopfloorReceipt.putawayTaskIds).toEqual([]);
    expect(await byReceipt(nothing)).toEqual([]);
  });

  it('US6-3 나뉘지 않은 생산 창고는 창고 전체로 들어오고 수령해도 지시가 없다', async () => {
    const issue = await shipped('Z', 15, flat);
    const whole = await fx.systemLocation(flat, 'WAREHOUSE_WHOLE');
    expect((await prisma.inventory_balance.findFirstOrThrow({ where: { location_id: whole, item_id: fx.items.Z } })).available_qty?.toNumber()).toBe(15);
    const res = await webReceive(issue);
    expect(res.body.shopfloorReceipt.putawayTaskIds).toEqual([]);
  });

  it('US6-4 적치 전에 피킹이 10 을 집었으면 남은 20 만 옮기고 끝낸다', async () => {
    const issue = await shipped('W', 30);
    const [taskId] = (await webReceive(issue)).body.shopfloorReceipt.putawayTaskIds;
    const balance = await stagingBalance('W');
    await prisma.inventory_balance.update({ where: { inventory_balance_id: balance.inventory_balance_id }, data: { picked_qty: { increment: 10 } } });

    const res = await complete(taskId, w.PROD.locationId).expect(200);
    expect(res.body).toMatchObject({ statusCode: 'COMPLETED', movedQty: 20, actualLocationId: Number(w.PROD.locationId) });
    const moved = await prisma.inventory_balance.aggregate({ where: { location_id: w.PROD.locationId, item_id: fx.items.W }, _sum: { on_hand_qty: true } });
    expect(moved._sum.on_hand_qty?.toNumber()).toBe(20);
    expect((await stagingBalance('W')).on_hand_qty.toNumber()).toBe(10);
  });

  it('US6-5 적치 대기에 남은 것이 없으면 원장 없이 완료', async () => {
    const issue = await shipped('V', 8);
    const [taskId] = (await webReceive(issue)).body.shopfloorReceipt.putawayTaskIds;
    const balance = await stagingBalance('V');
    await prisma.inventory_balance.update({ where: { inventory_balance_id: balance.inventory_balance_id }, data: { picked_qty: { increment: 8 } } });

    const res = await complete(taskId, w.PROD.locationId).expect(200);
    expect(res.body).toMatchObject({ statusCode: 'COMPLETED', movedQty: 0 });
    const task = await prisma.putaway_task.findUniqueOrThrow({ where: { putaway_task_id: taskId } });
    expect(task.inventory_transaction_line_id).toBeNull();
    expect(await prisma.inventory_transaction.count({ where: { source_document_type_code: 'STOCK_TRANSFER', source_document_id: BigInt(taskId) } })).toBe(0);
  });

  it('목록 창고 조건·단말 범위·배지가 출발 위치 창고 축으로 보충 지시를 센다', async () => {
    const pending = await prisma.putaway_task.count({ where: { status_code: 'PENDING', location_putaway_task_from_location_idTolocation: { warehouse_id: w.PROD.warehouseId } } });
    expect(pending).toBeGreaterThan(0);
    const listed = await request(app.getHttpServer()).get(TASKS).query({ warehouseId: Number(w.PROD.warehouseId), statusCode: 'PENDING', size: 100 }).set('Cookie', fx.cookie).expect(200);
    expect(listed.body.page.total).toBe(pending);
    const terminalList = await request(app.getHttpServer()).get(TASKS).query({ statusCode: 'PENDING', size: 100 }).set('Authorization', `Bearer ${terminalToken}`).expect(200);
    expect(terminalList.body.items.filter((t: { originCode: string }) => t.originCode === 'REPLENISHMENT_RECEIPT')).toHaveLength(pending);
    const counts = await request(app.getHttpServer()).get('/api/app/terminal-work-counts').set('Authorization', `Bearer ${terminalToken}`).expect(200);
    expect(counts.body.putaway).toBe(terminalList.body.page.total);
    const [first] = terminalList.body.items;
    await request(app.getHttpServer()).get(`${TASKS}/${first.putawayTaskId}`).set('Authorization', `Bearer ${terminalToken}`).expect(200);
  });

  it('CHECK — 원천이 없거나 둘 다인 지시는 넣지 못한다', async () => {
    const base = { putaway_task_no: `${PREFIX}-BAD`, item_id: fx.items.X, lot_id: (await stagingBalance('X')).lot_id as bigint, task_qty: 1, uom_id: fx.ids.uom, from_location_id: staging, status_code: 'PENDING' };
    await expect(prisma.putaway_task.create({ data: base })).rejects.toThrow();
    const line = await prisma.shopfloor_receipt_line.findFirstOrThrow({ where: { shopfloor_receipt: { location: { warehouse_id: w.PROD.warehouseId } } } });
    const receiptLine = await prisma.goods_receipt_line.findFirst();
    if (receiptLine !== null) {
      await expect(prisma.putaway_task.create({ data: { ...base, shopfloor_receipt_line_id: line.shopfloor_receipt_line_id, goods_receipt_line_id: receiptLine.goods_receipt_line_id } })).rejects.toThrow();
    }
  });
});
