/**
 * 출고 요청 수정·취소·출고 작업일 변경과 W/O 취소·마감 연결(피처 003 · omf-all-around#66 · US5 · US2-6 · US4-4 ·
 * FR-026·027·028). 피킹·출고는 그 결과(피킹 줄 picked_qty, 줄 issued_qty, 잔액)를 표에 옮겨 재현한다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { pairKey, plannedLines, sumPlanned } from '../src/core/material-issue/planned-stock';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { ItemKey, MaterialIssueFixture } from './support/material-issue-fixture';

const PREFIX = `MIE${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';
const BASE = '/api/logistics/material-issue-requests';

describe('출고 요청 수정·취소 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: MaterialIssueFixture;
  let seq = 0;
  let today: string;

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

  async function line(stock: [ItemKey, number][], extra: [ItemKey, number][] = []) {
    const code = `S${++seq}`;
    const a = await fx.warehouse(fx.ids.p1, `${code}-A`);
    const b = await fx.warehouse(fx.ids.p1, `${code}-B`);
    for (const [item, qty] of stock) await fx.stock(a, item, qty);
    for (const [item, qty] of extra) await fx.stock(b, item, qty);
    const lineId = await fx.line('P1', `${code}-L`, await fx.department(`${code}-D`, [a.warehouseId, b.warehouseId]));
    return { a, b, lineId };
  }

  /** 배포해 요청 하나 — `productionDate` 가 오늘이면 바로 배포된다. */
  async function made(lineId: bigint, operation: string, productionDate: string) {
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation, productionDate });
    await fx.release(workOrderId).expect(200);
    const [row] = await fx.requests(workOrderId);
    return { workOrderId, row };
  }

  const reload = (id: bigint) =>
    prisma.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: id },
      include: { material_issue_request_line: { orderBy: { line_no: 'asc' } } },
    });
  const put = (id: bigint, body: object) =>
    request(app.getHttpServer()).put(`${BASE}/${id}`).set('Cookie', fx.cookie).set('Idempotency-Key', randomUUID()).send(body);
  const cancel = (id: bigint, body: object) =>
    request(app.getHttpServer()).post(`${BASE}/${id}:cancel`).set('Cookie', fx.cookie).set('Idempotency-Key', randomUUID()).send(body);
  const planned = async (warehouseId: bigint) =>
    sumPlanned(await plannedLines(prisma, { warehouseIds: [warehouseId], itemIds: [fx.items.X] })).get(pairKey(warehouseId, fx.items.X))?.toNumber() ?? 0;
  const pickings = async (id: bigint) =>
    prisma.picking_order.findMany({ where: { source_document_type_code: 'MATERIAL_ISSUE_REQUEST', source_document_id: id }, include: { picking_line: true }, orderBy: { picking_order_id: 'asc' } });

  /** 집음(과 출고) 결과를 표에 옮긴다. */
  async function pick(requestId: bigint, qty: number, issue: boolean) {
    const [order] = (await pickings(requestId)).filter((o) => o.status_code === 'REGISTERED');
    const pl = order.picking_line[0];
    await prisma.picking_line.update({ where: { picking_line_id: pl.picking_line_id }, data: { picked_qty: { increment: qty } } });
    if (issue && pl.material_issue_request_line_id !== null) {
      await prisma.material_issue_request_line.update({ where: { material_issue_request_line_id: pl.material_issue_request_line_id }, data: { issued_qty: { increment: qty } } });
    }
  }

  const friday = () => fx.nextWeekday('P1', 5);

  it('US5-1 US4-4 피킹·출고 없는 배포 요청 취소 — 피킹 지시도 닫히고 예정이 풀린다', async () => {
    const { a, lineId } = await line([['X', 100]]);
    const { row } = await made(lineId, 'X20', today);
    expect(row.status_code).toBe('REGISTERED');
    expect(await planned(a.warehouseId)).toBe(20);

    const response = await cancel(row.material_issue_request_id, { versionNo: row.version_no, reason: '계획 변경' }).expect(200);
    expect(response.body.materialIssueRequest).toMatchObject({ statusCode: 'CANCELLED' });
    expect((await pickings(row.material_issue_request_id)).map((o) => o.status_code)).toEqual(['CANCELLED']);
    expect(await planned(a.warehouseId)).toBe(0);
    const after = await reload(row.material_issue_request_id);
    expect(after.cancelled_at).not.toBeNull();
  });

  it('US5-2 대기 요청 수량 수정 — 예정이 맞춰진다', async () => {
    const { a, lineId } = await line([['X', 100]]);
    const { row } = await made(lineId, 'X20', fx.nextWeekday('P1', 1));
    const lineId0 = row.material_issue_request_line[0].material_issue_request_line_id;
    await put(row.material_issue_request_id, { versionNo: row.version_no, lines: [{ materialIssueRequestLineId: Number(lineId0), requestedQty: 15 }] }).expect(200);
    expect(await planned(a.warehouseId)).toBe(15);
  });

  it('US5-3 대기 요청의 출고 작업일을 다른 미래 날짜로 — 대기 그대로', async () => {
    const { lineId } = await line([['X', 100]]);
    const { row } = await made(lineId, 'X20', fx.nextWeekday('P1', 1));
    const next = friday();
    const response = await put(row.material_issue_request_id, { versionNo: row.version_no, issueWorkDate: next }).expect(200);
    expect(response.body.materialIssueRequest).toMatchObject({ statusCode: 'WAITING', issueWorkDate: next });
  });

  it('US5-4 출고 작업일을 오늘로 앞당기면 바로 배포', async () => {
    const { lineId } = await line([['X', 100]]);
    const { row } = await made(lineId, 'X20', fx.nextWeekday('P1', 1));
    const response = await put(row.material_issue_request_id, { versionNo: row.version_no, issueWorkDate: today, acknowledgeHoliday: true }).expect(200);
    expect(response.body.materialIssueRequest.statusCode).toBe('REGISTERED');
    expect(await pickings(row.material_issue_request_id)).toHaveLength(1);
  });

  it('US5-5 배포·피킹 전 요청을 미래로 미루면 대기로 — 피킹 지시가 닫힌다', async () => {
    const { lineId } = await line([['X', 100]]);
    const { row } = await made(lineId, 'X20', today);
    const response = await put(row.material_issue_request_id, { versionNo: row.version_no, issueWorkDate: friday() }).expect(200);
    expect(response.body.materialIssueRequest).toMatchObject({ statusCode: 'WAITING', releasedAt: null });
    expect((await pickings(row.material_issue_request_id)).map((o) => o.status_code)).toEqual(['CANCELLED']);
  });

  it('US5-6 피킹이 시작된 요청의 출고 작업일 변경은 409 STATE_LOCKED', async () => {
    const { lineId } = await line([['X', 100]]);
    const { row } = await made(lineId, 'X20', today);
    await pick(row.material_issue_request_id, 5, false);
    const response = await put(row.material_issue_request_id, { versionNo: row.version_no, issueWorkDate: friday() }).expect(409);
    expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('US5-7 휴일로 바꾸면 422 — 확인하면 반영', async () => {
    const { lineId } = await line([['X', 100]]);
    const { row } = await made(lineId, 'X20', fx.nextWeekday('P1', 1));
    const sunday = fx.nextWeekday('P1', 0);
    const refused = await put(row.material_issue_request_id, { versionNo: row.version_no, issueWorkDate: sunday }).expect(422);
    expect(refused.body.errors[0]).toMatchObject({ field: 'issueWorkDate', code: 'HOLIDAY_ACK_REQUIRED' });
    const ok = await put(row.material_issue_request_id, { versionNo: row.version_no, issueWorkDate: sunday, acknowledgeHoliday: true }).expect(200);
    expect(ok.body.materialIssueRequest.issueWorkDate).toBe(sunday);
  });

  it('US5-8 US5-9 US5-10 70 중 40 출고 — 취소 409 · 30 은 400 · 60 은 반영(예정 20, 남은 20 을 새 피킹으로)', async () => {
    const { a, lineId } = await line([['X', 200]]);
    const { row } = await made(lineId, 'X70', today);
    await pick(row.material_issue_request_id, 40, true);
    const id = row.material_issue_request_id;
    const lineId0 = Number(row.material_issue_request_line[0].material_issue_request_line_id);

    expect((await cancel(id, { versionNo: row.version_no })).status).toBe(409);
    const tooLow = await put(id, { versionNo: row.version_no, lines: [{ materialIssueRequestLineId: lineId0, requestedQty: 30 }] }).expect(400);
    expect(tooLow.body.errors[0]).toMatchObject({ field: 'lines[0].requestedQty', code: 'RANGE' });

    await put(id, { versionNo: row.version_no, lines: [{ materialIssueRequestLineId: lineId0, requestedQty: 60 }] }).expect(200);
    expect(await planned(a.warehouseId)).toBe(20);
    const orders = await pickings(id);
    const open = orders.flatMap((o) => o.picking_line.map((l) => [o.status_code, l.planned_qty.toNumber(), l.picked_qty.toNumber()]));
    expect(open).toEqual([['REGISTERED', 40, 40], ['REGISTERED', 20, 0]]);
  });

  it('FR-026 집었지만 출고하지 않은 양이 있으면 수량 수정은 409', async () => {
    const { lineId } = await line([['X', 100]]);
    const { row } = await made(lineId, 'X20', today);
    await pick(row.material_issue_request_id, 10, false);
    const lineId0 = Number(row.material_issue_request_line[0].material_issue_request_line_id);
    const response = await put(row.material_issue_request_id, { versionNo: row.version_no, lines: [{ materialIssueRequestLineId: lineId0, requestedQty: 15 }] }).expect(409);
    expect(response.body.errors[0].code).toBe('STATE_LOCKED');
  });

  it('US2-6 FR-027 입고지·출발 창고 변경 — 예정이 새 창고로 옮겨 상한이 다시 걸리고 이력이 남는다', async () => {
    const { a, b, lineId } = await line([['X', 100]], [['X', 10]]);
    const { row } = await made(lineId, 'X20', fx.nextWeekday('P1', 1));
    const other = await fx.warehouse(fx.ids.p1, `S${seq}-DEST`);
    await put(row.material_issue_request_id, {
      versionNo: row.version_no,
      sourceWarehouseId: Number(b.warehouseId),
      destinationLocationId: Number(other.locationId),
    }).expect(200);
    const after = await reload(row.material_issue_request_id);
    expect(after).toMatchObject({ source_warehouse_id: b.warehouseId, destination_location_id: other.locationId });
    expect(after.material_issue_request_line.map((l) => [l.requested_qty.toNumber(), l.shortage_qty.toNumber()])).toEqual([[10, 10]]);
    expect(await planned(a.warehouseId)).toBe(0);
    expect(await planned(b.warehouseId)).toBe(10);

    const history = await request(app.getHttpServer()).get(`${BASE}/${row.material_issue_request_id}/history`).set('Cookie', fx.cookie).expect(200);
    // 바뀐 칸마다 한 줄(최근 것이 먼저) — 문장은 화면이 eventCode 로 만든다.
    const sourceName = async (id: bigint) => (await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: id } })).warehouse_name;
    const locationName = async (id: bigint) => (await prisma.location.findUniqueOrThrow({ where: { location_id: id } })).location_name;
    expect(history.body.items).toEqual([
      { occurredAt: expect.any(String), actorName: '출고요청시험', eventCode: 'DESTINATION_CHANGED', detail: { before: await locationName(row.destination_location_id), after: await locationName(other.locationId) } },
      { occurredAt: expect.any(String), actorName: '출고요청시험', eventCode: 'SOURCE_CHANGED', detail: { before: await sourceName(a.warehouseId), after: await sourceName(b.warehouseId) } },
      { occurredAt: expect.any(String), actorName: '출고요청시험', eventCode: 'QTY_CHANGED', detail: { itemCode: `${PREFIX}-X`, before: 20, after: 10 } },
      { occurredAt: expect.any(String), actorName: '출고요청시험', eventCode: 'CREATED', detail: {} },
    ]);
  });

  it('VERSION_CONFLICT 버전이 다르면 409 저장 충돌 · 지금 방식 요청은 PUT·:cancel 모두 409', async () => {
    const { lineId } = await line([['X', 100]]);
    const { row } = await made(lineId, 'X20', fx.nextWeekday('P1', 1));
    const stale = await put(row.material_issue_request_id, { versionNo: row.version_no + 5, issueWorkDate: friday() }).expect(409);
    expect(stale.body).toMatchObject({ conflictCause: 'user' });

    fx.ids.p9 = await fx.plant('P9', HANOI);
    const material = await fx.warehouse(fx.ids.p9, 'P9-MAT', 'MATERIAL');
    await fx.stock(material, 'X', 100);
    const oldLine = await fx.line('P9', 'P9-L', null);
    const oldWo = await fx.workOrder({ plantKey: 'P9', lineId: oldLine, operation: 'X20', productionDate: today });
    await fx.release(oldWo).expect(200);
    const [old] = await fx.requests(oldWo);
    expect(old.source_warehouse_id).toBeNull();
    expect((await put(old.material_issue_request_id, { versionNo: old.version_no, issueWorkDate: friday() })).body.errors[0].code).toBe('STATE_LOCKED');
    expect((await cancel(old.material_issue_request_id, { versionNo: old.version_no })).status).toBe(409);
  });

  describe('W/O 취소·마감 연결', () => {
    const woVersion = async (workOrderId: bigint) =>
      String((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).version_no);

    it('US5-11 진행 없는 요청은 W/O 취소로 모두 취소된다', async () => {
      const { lineId } = await line([['X', 100], ['Y', 100]], [['Z', 100]]);
      const { workOrderId } = await made(lineId, 'XYZ', today);
      const before = await fx.requests(workOrderId);
      expect(before).toHaveLength(2);
      await request(app.getHttpServer())
        .post(`/api/production/work-orders/${workOrderId}:cancel`)
        .set('Cookie', fx.cookie).set('Idempotency-Key', randomUUID()).set('If-Match', await woVersion(workOrderId))
        .send({ reasonCode: 'PLAN_CHANGE' })
        .expect(200);
      const after = await fx.requests(workOrderId);
      expect(after.map((r) => r.status_code)).toEqual(['CANCELLED', 'CANCELLED']);
      for (const r of after) expect((await pickings(r.material_issue_request_id)).map((o) => o.status_code)).toEqual(['CANCELLED']);
    });

    it('US5-12 창고별 2장 중 1장만 일부 출고 — 그 장은 닫히고(예정에서 빠짐, 더 집지 않음) 다른 장은 취소', async () => {
      const { a, lineId } = await line([['X', 100], ['Y', 100]], [['Z', 100]]);
      const { workOrderId } = await made(lineId, 'XYZ', today);
      const [withX] = (await fx.requests(workOrderId)).filter((r) => r.source_warehouse_id === a.warehouseId);
      await pick(withX.material_issue_request_id, 5, true);
      await request(app.getHttpServer())
        .post(`/api/production/work-orders/${workOrderId}:cancel`)
        .set('Cookie', fx.cookie).set('Idempotency-Key', randomUUID()).set('If-Match', await woVersion(workOrderId))
        .send({ reasonCode: 'PLAN_CHANGE' })
        .expect(200);
      const after = await fx.requests(workOrderId);
      const closed = after.find((r) => r.source_warehouse_id === a.warehouseId);
      const other = after.find((r) => r.source_warehouse_id !== a.warehouseId);
      expect(closed).toMatchObject({ status_code: 'REGISTERED', close_reason_code: 'WO_CANCELLED' });
      expect(closed?.closed_at).not.toBeNull();
      expect(other?.status_code).toBe('CANCELLED');
      expect(await planned(a.warehouseId)).toBe(0);
      const lines = (await pickings(withX.material_issue_request_id)).flatMap((o) => o.picking_line.map((l) => [l.planned_qty.toNumber(), l.picked_qty.toNumber()]));
      expect(lines).toEqual([[5, 5]]);
    });

    it('FR-028 W/O 마감도 같다 — 진행 없는 요청 취소 · 진행 있는 요청 닫힘(WO_CLOSED)', async () => {
      const { a, lineId } = await line([['X', 100], ['Y', 100]], [['Z', 100]]);
      const { workOrderId } = await made(lineId, 'XYZ', today);
      const [withX] = (await fx.requests(workOrderId)).filter((r) => r.source_warehouse_id === a.warehouseId);
      await pick(withX.material_issue_request_id, 5, true);
      await prisma.work_order.update({ where: { work_order_id: workOrderId }, data: { status_code: 'IN_PROGRESS' } });
      await request(app.getHttpServer())
        .post(`/api/production/work-orders/${workOrderId}:close`)
        .set('Cookie', fx.cookie).set('Idempotency-Key', randomUUID()).set('If-Match', await woVersion(workOrderId))
        .send({ remainderDispositionCode: 'WRITE_OFF', reasonCode: 'MATERIAL_SHORTAGE' })
        .expect(200);
      const after = await fx.requests(workOrderId);
      expect(after.find((r) => r.source_warehouse_id === a.warehouseId)).toMatchObject({ close_reason_code: 'WO_CLOSED' });
      expect(after.find((r) => r.source_warehouse_id !== a.warehouseId)?.status_code).toBe('CANCELLED');
    });
  });
});
