/**
 * 출고 요청 현황 조회(피처 003 · omf-all-around#66 · W-02-11 · US6 · FR-015·016·007a) — 목록 조건·표시 상태·부족,
 * 생산 창고 예정·부족 조회.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { ItemKey, MaterialIssueFixture } from './support/material-issue-fixture';

const PREFIX = `MIQ${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';
const BASE = '/api/logistics/material-issue-requests';

describe('출고 요청 현황 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: MaterialIssueFixture;
  let today: string;
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new MaterialIssueFixture(app, prisma, PREFIX);
    await fx.setup();
    fx.ids.p1 = await fx.plant('P1', HANOI);
    today = localDate(new Date(), HANOI);
  });

  afterAll(async () => {
    await prisma.audit_event.deleteMany({ where: { target_type_code: 'MATERIAL_ISSUE_REQUEST', performed_by: fx.ids.user } });
    await fx.cleanup();
    await app.close();
  });

  async function line(stock: [ItemKey, number][]) {
    const code = `S${++seq}`;
    const a = await fx.warehouse(fx.ids.p1, `${code}-A`);
    for (const [item, qty] of stock) await fx.stock(a, item, qty);
    return { a, lineId: await fx.line('P1', `${code}-L`, await fx.department(`${code}-D`, [a.warehouseId])) };
  }
  async function made(lineId: bigint, operation: string, productionDate: string) {
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation, productionDate });
    await fx.release(workOrderId).expect(200);
    const [row] = await fx.requests(workOrderId);
    return { workOrderId, row };
  }
  const list = (query: Record<string, unknown>) =>
    request(app.getHttpServer()).get(BASE).query({ plantId: Number(fx.ids.p1), size: 100, ...query }).set('Cookie', fx.cookie).expect(200);
  const idsOf = (body: { items: { materialIssueRequestId: number }[] }) => body.items.map((i) => i.materialIssueRequestId).sort();

  it('US6-1 생산일 기간·생산계획으로 조회 — W/O·생산일·출발 창고·출고 작업일·상태가 실린다', async () => {
    const { a, lineId } = await line([['X', 100]]);
    const monday = fx.nextWeekday('P1', 1);
    const { row } = await made(lineId, 'X20', monday);
    const wo = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: row.work_order_id as bigint } });

    const found = await list({ productionDateFrom: monday, productionDateTo: monday, productionPlanId: Number(wo.production_plan_id) });
    expect(idsOf(found.body)).toContain(Number(row.material_issue_request_id));
    expect(found.body.items.find((i: { materialIssueRequestId: number }) => i.materialIssueRequestId === Number(row.material_issue_request_id))).toMatchObject({
      workOrderNo: wo.work_order_no,
      productionDate: monday,
      productionPlanId: Number(wo.production_plan_id),
      sourceWarehouseId: Number(a.warehouseId),
      sourceWarehouseName: expect.stringContaining('-A'),
      displayStatus: 'WAITING',
      lineCount: 1,
      shortageQtyTotal: 0,
      dynamicShortageQtyTotal: 0,
      destinationLocationName: expect.any(String),
      productionPlanNo: expect.stringContaining('-PP-P1'),
    });
    // omf-all-around#268 — 입고지 코드 · 별칭 · 역할을 함께 싣는다(관리웹 「코드 · 별칭」 · 서버가 둔 위치는 역할 이름).
    const destination = await prisma.location.findUniqueOrThrow({ where: { location_id: row.destination_location_id } });
    expect(found.body.items.find((i: { materialIssueRequestId: number }) => i.materialIssueRequestId === Number(row.material_issue_request_id))).toMatchObject({
      destinationLocationCode: destination.location_code,
      destinationLocationAliasName: destination.alias_name,
      destinationLocationSystemRoleCode: destination.system_role_code,
    });
    const other = await list({ productionDateFrom: today, productionDateTo: today, sourceWarehouseId: Number(a.warehouseId) });
    expect(idsOf(other.body)).not.toContain(Number(row.material_issue_request_id));
  });

  it('displayStatus 다섯 — 대기·배포·진행 중·완료(닫힘 사유)·취소, 줄이 모두 0 인 배포 요청은 배포', async () => {
    const { a, lineId } = await line([['X', 50], ['Y', 100], ['Z', 100]]);
    const waiting = await made(lineId, 'X20', fx.nextWeekday('P1', 1));
    // X 50 을 다 잡는다 — 아래 요청들의 X 줄은 요청 0 · 부족 전부다.
    await made(lineId, 'X50', fx.nextWeekday('P1', 2));
    const zero = await made(lineId, 'X20', today);
    const started = await made(lineId, 'XYZ', today);
    const [pl] = (await prisma.picking_order.findMany({ where: { source_document_id: started.row.material_issue_request_id }, include: { picking_line: true } })).flatMap((o) => o.picking_line);
    await prisma.picking_line.update({ where: { picking_line_id: pl.picking_line_id }, data: { picked_qty: 1 } });
    const cancelled = await made(lineId, 'X20', fx.nextWeekday('P1', 3));
    await request(app.getHttpServer()).post(`${BASE}/${cancelled.row.material_issue_request_id}:cancel`).set('Cookie', fx.cookie).set('Idempotency-Key', randomUUID()).send({ versionNo: cancelled.row.version_no }).expect(200);
    const closedWo = await made(lineId, 'XYZ', today);
    const [cpl] = (await prisma.picking_order.findMany({ where: { source_document_id: closedWo.row.material_issue_request_id }, include: { picking_line: true } })).flatMap((o) => o.picking_line);
    await prisma.picking_line.update({ where: { picking_line_id: cpl.picking_line_id }, data: { picked_qty: 1 } });
    const version = (await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: closedWo.workOrderId } })).version_no;
    await request(app.getHttpServer()).post(`/api/production/work-orders/${closedWo.workOrderId}:cancel`).set('Cookie', fx.cookie).set('Idempotency-Key', randomUUID()).set('If-Match', String(version)).send({ reasonCode: 'PLAN_CHANGE' }).expect(200);

    const status = async (id: bigint) => (await request(app.getHttpServer()).get(`${BASE}/${id}`).set('Cookie', fx.cookie).expect(200)).body.materialIssueRequest;
    expect((await status(waiting.row.material_issue_request_id)).displayStatus).toBe('WAITING');
    expect(await status(zero.row.material_issue_request_id)).toMatchObject({ displayStatus: 'RELEASED', statusCode: 'REGISTERED' });
    expect((await status(started.row.material_issue_request_id)).displayStatus).toBe('IN_PROGRESS');
    expect(await status(closedWo.row.material_issue_request_id)).toMatchObject({ displayStatus: 'DONE', closeReasonCode: 'WO_CANCELLED' });
    expect((await status(cancelled.row.material_issue_request_id)).displayStatus).toBe('CANCELLED');

    const busy = await list({ sourceWarehouseId: Number(a.warehouseId), displayStatus: 'RELEASED,IN_PROGRESS' });
    expect(idsOf(busy.body)).toEqual([zero.row.material_issue_request_id, started.row.material_issue_request_id].map(Number).sort());
    const detail = await request(app.getHttpServer()).get(`${BASE}/${started.row.material_issue_request_id}`).set('Cookie', fx.cookie).expect(200);
    expect(detail.body.lines).toEqual(expect.arrayContaining([expect.objectContaining({ pickedQty: 1, outstandingQty: 10, dynamicShortageQty: 0, uomCode: expect.any(String) })]));
    expect(detail.body.lines.map((l: { itemCode: string }) => l.itemCode)).toEqual([`${PREFIX}-X`, `${PREFIX}-Y`, `${PREFIX}-Z`]);
    expect(detail.body.materialIssueRequest).toMatchObject({ workOrderNo: expect.any(String), versionNo: expect.any(Number) });
  });

  it('US6-2 부족 있는 요청만 — 저장 부족 · 동적 부족 · 배포 실패만', async () => {
    const { a, lineId } = await line([['X', 60]]);
    const full = await made(lineId, 'X50', fx.nextWeekday('P1', 1));
    const short = await made(lineId, 'X20', fx.nextWeekday('P1', 2));
    expect(short.row.material_issue_request_line[0].shortage_qty.toNumber()).toBe(10);
    let found = await list({ sourceWarehouseId: Number(a.warehouseId), hasShortage: true });
    expect(idsOf(found.body)).toEqual([Number(short.row.material_issue_request_id)]);

    // 재고가 줄면 동적 부족 — 늦은 요청이 먼저 받는다.
    const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { warehouse_id: a.warehouseId } });
    await prisma.inventory_balance.update({ where: { inventory_balance_id: balance.inventory_balance_id }, data: { on_hand_qty: 40 } });
    found = await list({ sourceWarehouseId: Number(a.warehouseId), hasShortage: true });
    expect(idsOf(found.body)).toEqual([full.row.material_issue_request_id, short.row.material_issue_request_id].map(Number).sort());
    const shortRow = found.body.items.find((i: { materialIssueRequestId: number }) => i.materialIssueRequestId === Number(short.row.material_issue_request_id));
    expect(shortRow).toMatchObject({ shortageQtyTotal: 10, dynamicShortageQtyTotal: 10 });

    await prisma.material_issue_request.update({ where: { material_issue_request_id: full.row.material_issue_request_id }, data: { release_error_text: '시험 실패' } });
    found = await list({ sourceWarehouseId: Number(a.warehouseId), releaseFailed: true });
    expect(idsOf(found.body)).toEqual([Number(full.row.material_issue_request_id)]);
  });

  it('FR-015 FR-016 FR-007a 생산 창고 예정·부족 — 요청 배분 · 재고 있는 생산 창고 없음(W/O 취소 제외)', async () => {
    const { a, lineId } = await line([['X', 60]]);
    const early = await made(lineId, 'X50', fx.nextWeekday('P1', 1));
    const late = await made(lineId, 'X20', fx.nextWeekday('P1', 1, 14));
    const all = await request(app.getHttpServer()).get(`${BASE}/planned-stock`).query({ plantId: Number(fx.ids.p1), sourceWarehouseId: Number(a.warehouseId) }).set('Cookie', fx.cookie).expect(200);
    expect(all.body.items).toEqual([
      expect.objectContaining({ itemCode: `${PREFIX}-X`, availableQty: 60, plannedQty: 60, freeQty: 0, shortageQty: 10 }),
    ]);
    expect(all.body.items[0].requests.map((r: { materialIssueRequestId: number; shortageQty: number }) => [r.materialIssueRequestId, r.shortageQty])).toEqual([
      [Number(late.row.material_issue_request_id), 10],
      [Number(early.row.material_issue_request_id), 0],
    ]);
    expect(all.body.unsourced).toBeUndefined();

    const noStock = await made(lineId, 'WVX', fx.nextWeekday('P1', 2));
    const gone = await made(lineId, 'WVX', fx.nextWeekday('P1', 3));
    const version = (await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: gone.workOrderId } })).version_no;
    await request(app.getHttpServer()).post(`/api/production/work-orders/${gone.workOrderId}:cancel`).set('Cookie', fx.cookie).set('Idempotency-Key', randomUUID()).set('If-Match', String(version)).send({ reasonCode: 'PLAN_CHANGE' }).expect(200);
    const shortages = await request(app.getHttpServer()).get(`${BASE}/planned-stock`).query({ plantId: Number(fx.ids.p1), onlyShortage: true }).set('Cookie', fx.cookie).expect(200);
    expect(shortages.body.items.every((r: { shortageQty: number }) => r.shortageQty > 0)).toBe(true);
    const unsourcedWo = new Set(shortages.body.unsourced.map((u: { workOrderId: number }) => u.workOrderId));
    expect(unsourcedWo.has(Number(noStock.workOrderId))).toBe(true);
    expect(unsourcedWo.has(Number(gone.workOrderId))).toBe(false);
    expect(shortages.body.unsourced.filter((u: { workOrderId: number }) => u.workOrderId === Number(noStock.workOrderId)).map((u: { itemCode: string; shortageQty: number; resolvedRequestNo: string | null }) => [u.itemCode, u.shortageQty, u.resolvedRequestNo]).sort()).toEqual([
      [`${PREFIX}-V`, 10, null],
      [`${PREFIX}-W`, 20, null],
    ]);
  });
});
