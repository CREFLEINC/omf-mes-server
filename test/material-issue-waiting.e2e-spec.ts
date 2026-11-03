/**
 * W/O 배포 → 생산 창고별 대기 출고 요청(피처 003 · omf-all-around#66 · US1·US2·US7).
 *
 * 시나리오마다 생산 창고·부서·라인을 새로 만든다 — 출고 예정 재고는 (창고, 품목)에 쌓이므로 시나리오끼리 섞이면
 * 앞 시험의 예정이 뒤 시험의 상한을 바꾼다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { issueWorkDate } from '../src/core/calendar/issue-work-date';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { ITEMS, ItemKey, MaterialIssueFixture, OPERATIONS } from './support/material-issue-fixture';

const PREFIX = `MIW${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';

describe('배포 → 대기 출고 요청 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: MaterialIssueFixture;
  let scenarioSeq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new MaterialIssueFixture(app, prisma, PREFIX);
    await fx.setup();
    fx.ids.p1 = await fx.plant('P1', HANOI);
    fx.ids.p2 = await fx.plant('P2', 'Asia/Seoul');
    await prisma.operation_policy.create({
      data: { policy_code: 'WEEKLY_WORKING_DAYS', plant_id: fx.ids.p2, value_numeric: 6, effective_from: new Date('2026-01-01T00:00:00Z') },
    });
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  /** 공장에 생산 창고 `codes` 를 만들고 재고를 넣은 뒤 그 창고들을 연결한 부서·라인을 낸다. */
  async function scenario(
    plantKey: string,
    stocks: Record<string, [ItemKey, number, string?][]>,
  ): Promise<{ lineId: bigint; warehouses: Record<string, bigint> }> {
    const code = `S${++scenarioSeq}`;
    const plantId = fx.ids[plantKey.toLowerCase()];
    const warehouses: Record<string, bigint> = {};
    for (const [key, rows] of Object.entries(stocks)) {
      const at = await fx.warehouse(plantId, `${code}-${key}`);
      warehouses[key] = at.warehouseId;
      for (const [item, qty, created] of rows) await fx.stock(at, item, qty, created);
    }
    const department = await fx.department(`${code}-D`, Object.values(warehouses));
    return { lineId: await fx.line(plantKey, `${code}-L`, department), warehouses };
  }

  const qtys = (lines: { item_id: bigint; requested_qty: { toNumber(): number }; shortage_qty: { toNumber(): number } }[]) =>
    lines.map((line) => [itemKey(line.item_id), line.requested_qty.toNumber(), line.shortage_qty.toNumber()]);
  const itemKey = (id: bigint) => ITEMS.find((key) => fx.items[key] === id);

  it('US1-1 US7-2 US2-1 US2-3 US1-4 주 5일·설정 없는 공장, 월요일 생산 → 대기 1장 · 출고 작업일 전주 금 · 피킹 없음', async () => {
    const { lineId, warehouses } = await scenario('P1', { A: [['X', 100], ['Y', 50], ['Z', 60]] });
    const monday = fx.nextWeekday('P1', 1);
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'XYZ', productionDate: monday });

    const response = await fx.release(workOrderId).expect(200);

    const [only, ...rest] = await fx.requests(workOrderId);
    expect(rest).toEqual([]);
    const friday = issueWorkDate(monday, 5);
    expect(new Date(`${friday}T00:00:00Z`).getUTCDay()).toBe(5);
    expect(only).toMatchObject({ status_code: 'WAITING', source_warehouse_id: warehouses.A, released_at: null });
    expect(only.issue_work_date?.toISOString().slice(0, 10)).toBe(friday);
    const line = await prisma.production_line.findUniqueOrThrow({ where: { production_line_id: lineId } });
    expect(only.destination_location_id).toBe(line.default_wip_location_id);
    expect(qtys(only.material_issue_request_line)).toEqual([['X', 20, 0], ['Y', 10, 0], ['Z', 10, 0]]);
    // US1-4 — 대기 요청은 피킹 지시가 없다: 모바일 피킹 목록·대기 작업 수·T2 는 모두 피킹 지시를 센다.
    expect(await fx.pickings(only.material_issue_request_id)).toEqual([]);
    expect(response.body.materialIssueRequests).toEqual([
      { materialIssueRequestId: Number(only.material_issue_request_id), issueRequestNo: only.issue_request_no, sourceWarehouseId: Number(warehouses.A), statusCode: 'WAITING', issueWorkDate: friday },
    ]);
    expect(response.body.unsourcedShortages).toEqual([]);
  });

  it('US1-5 출고 요청 응답에 출고 작업일·출발 창고·입고지·상태가 실린다', async () => {
    const { lineId, warehouses } = await scenario('P1', { A: [['X', 100]] });
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X20', productionDate: fx.nextWeekday('P1', 3) });
    await fx.release(workOrderId).expect(200);
    const [row] = await fx.requests(workOrderId);

    const detail = await request(app.getHttpServer())
      .get(`/api/logistics/material-issue-requests/${row.material_issue_request_id}`)
      .set('Cookie', fx.cookie)
      .expect(200);
    expect(detail.body.materialIssueRequest).toMatchObject({
      statusCode: 'WAITING',
      sourceWarehouseId: Number(warehouses.A),
      issueWorkDate: row.issue_work_date?.toISOString().slice(0, 10),
      destinationLocationId: Number(row.destination_location_id),
      releasedAt: null,
      closedAt: null,
    });
    expect(detail.body.lines[0]).toMatchObject({ requestedQty: 20, shortageQty: 0, issuedQty: 0 });
  });

  it('US1-2 US7-8 주 6일 공장(시간대 다름)의 월요일 생산 → 전주 토, 설정을 바꿔도 만든 요청의 날짜는 그대로', async () => {
    const { lineId } = await scenario('P2', { A: [['X', 100]] });
    const monday = fx.nextWeekday('P2', 1);
    const workOrderId = await fx.workOrder({ plantKey: 'P2', lineId, operation: 'X20', productionDate: monday });
    await fx.release(workOrderId).expect(200);
    const [row] = await fx.requests(workOrderId);
    const saturday = issueWorkDate(monday, 6);
    expect(new Date(`${saturday}T00:00:00Z`).getUTCDay()).toBe(6);
    expect(row.issue_work_date?.toISOString().slice(0, 10)).toBe(saturday);

    await prisma.operation_policy.updateMany({ where: { plant_id: fx.ids.p2 }, data: { value_numeric: 5 } });
    const [after] = await fx.requests(workOrderId);
    expect(after.issue_work_date?.toISOString().slice(0, 10)).toBe(saturday);
    await prisma.operation_policy.updateMany({ where: { plant_id: fx.ids.p2 }, data: { value_numeric: 6 } });
  });

  it('US1-3 출고 작업일이 이미 지났으면 같은 트랜잭션에서 배포 — 피킹 지시·T2', async () => {
    const { lineId, warehouses } = await scenario('P1', { A: [['X', 100]] });
    const today = localDate(new Date(), HANOI);
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X20', productionDate: today });
    const response = await fx.release(workOrderId).expect(200);

    const [row] = await fx.requests(workOrderId);
    expect(row.status_code).toBe('REGISTERED');
    expect(row.released_at).not.toBeNull();
    expect(response.body.materialIssueRequests[0].statusCode).toBe('REGISTERED');
    const pickings = await fx.pickings(row.material_issue_request_id);
    expect(pickings).toHaveLength(1);
    expect(pickings[0]).toMatchObject({ warehouse_id: warehouses.A, status_code: 'REGISTERED' });
    expect(pickings[0].picking_line.map((l) => l.planned_qty.toNumber())).toEqual([20]);
    const events = await prisma.notification_event.count({
      where: { aggregate_type_code: 'PICKING_ORDER', aggregate_id: pickings[0].picking_order_id },
    });
    expect(events).toBe(1);
  });

  it('US2-2 US2-3 SC-007 창고 A·B 에 자재가 갈리면 창고별 요청 — 입고지·출고 작업일 같음, 자재는 정확히 한 번', async () => {
    const { lineId, warehouses } = await scenario('P1', { A: [['X', 100], ['Y', 50]], B: [['Z', 60]] });
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'XYZ', productionDate: fx.nextWeekday('P1', 2) });
    await fx.release(workOrderId).expect(200);

    const rows = await fx.requests(workOrderId);
    expect(rows.map((r) => [r.source_warehouse_id, qtys(r.material_issue_request_line)])).toEqual([
      [warehouses.A, [['X', 20, 0], ['Y', 10, 0]]],
      [warehouses.B, [['Z', 10, 0]]],
    ]);
    expect(new Set(rows.map((r) => String(r.destination_location_id))).size).toBe(1);
    expect(new Set(rows.map((r) => r.issue_work_date?.toISOString())).size).toBe(1);
    await expectEachMaterialOnce(workOrderId, 'XYZ');
  });

  it('US2-4 두 창고 모두 재고 → 쓸 수 있는 양이 큰 창고(A 30 · B 80 → B)에 전량', async () => {
    const { lineId, warehouses } = await scenario('P1', { A: [['X', 30]], B: [['X', 80]] });
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X50', productionDate: fx.nextWeekday('P1', 2) });
    await fx.release(workOrderId).expect(200);
    const rows = await fx.requests(workOrderId);
    expect(rows.map((r) => [r.source_warehouse_id, qtys(r.material_issue_request_line)])).toEqual([[warehouses.B, [['X', 50, 0]]]]);
  });

  it('US2-10 쓸 수 있는 양이 같으면 가장 오래된 LOT 이 있는 창고', async () => {
    const { lineId, warehouses } = await scenario('P1', {
      A: [['X', 50, '2026-10-20T00:00:00Z']],
      B: [['X', 50, '2026-10-02T00:00:00Z']],
    });
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X20', productionDate: fx.nextWeekday('P1', 2) });
    await fx.release(workOrderId).expect(200);
    const [row] = await fx.requests(workOrderId);
    expect(row.source_warehouse_id).toBe(warehouses.B);
  });

  it('US2-11 가용은 있으나 예정이 다 잡은 창고 → 그 창고에 요청 0 · 부족 20', async () => {
    const { lineId, warehouses } = await scenario('P1', { A: [['X', 50]] });
    const first = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X50', productionDate: fx.nextWeekday('P1', 2) });
    await fx.release(first).expect(200);
    const second = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X20', productionDate: fx.nextWeekday('P1', 3) });
    await fx.release(second).expect(200);
    const [row] = await fx.requests(second);
    expect(row.source_warehouse_id).toBe(warehouses.A);
    expect(qtys(row.material_issue_request_line)).toEqual([['X', 0, 20]]);

    // 같은 처지의 요청을 바로 배포해도 피킹은 요청 0 줄을 건너뛴다 — 수량 0 인 피킹 줄을 만들지 않는다.
    const now = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X20', productionDate: localDate(new Date(), HANOI) });
    await fx.release(now).expect(200);
    const [released] = await fx.requests(now);
    expect(released.status_code).toBe('REGISTERED');
    expect(qtys(released.material_issue_request_line)).toEqual([['X', 0, 20]]);
    expect(await fx.pickings(released.material_issue_request_id)).toEqual([]);
    expect(await prisma.picking_line.count({ where: { picking_order: { warehouse_id: warehouses.A }, planned_qty: { lte: 0 } } })).toBe(0);
  });

  it('US2-9 SC-007 어느 생산 창고에도 재고 없는 자재 → 요청 없음 · W/O 단위 부족 행 · 배포 성공', async () => {
    const { lineId, warehouses } = await scenario('P1', { A: [['X', 100]], B: [] });
    // V 는 B 에 있었으나 보류돼 집을 수 없다 — 재고가 없는 것과 같다.
    const vLot = await fx.stock({ warehouseId: warehouses.B, locationId: (await prisma.location.findFirstOrThrow({ where: { warehouse_id: warehouses.B } })).location_id }, 'V', 40);
    await prisma.lot_hold.create({ data: { lot_id: vLot, reason_code: 'OTHER', status_code: 'HELD', held_at: new Date(), held_by: fx.ids.user } });
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'WVX', productionDate: fx.nextWeekday('P1', 2) });

    const response = await fx.release(workOrderId).expect(200);

    const rows = await fx.requests(workOrderId);
    expect(rows.map((r) => [r.source_warehouse_id, qtys(r.material_issue_request_line)])).toEqual([[warehouses.A, [['X', 30, 0]]]]);
    const unsourced = await prisma.material_issue_unsourced_shortage.findMany({ where: { work_order_id: workOrderId }, orderBy: { item_id: 'asc' } });
    expect(unsourced.map((u) => [itemKey(u.item_id), u.shortage_qty.toNumber(), u.resolved_request_id])).toEqual(
      [['W', 20, null], ['V', 10, null]].sort((a, b) => Number(fx.items[a[0] as ItemKey] - fx.items[b[0] as ItemKey])),
    );
    expect(response.body.unsourcedShortages.map((u: { itemCode: string; shortageQty: number }) => [u.itemCode, u.shortageQty]).sort()).toEqual([
      [`${PREFIX}-V`, 10],
      [`${PREFIX}-W`, 20],
    ]);
    await expectEachMaterialOnce(workOrderId, 'WVX');
    await prisma.lot_hold.deleteMany({ where: { lot_id: vLot } });
  });

  it('같은 자재 줄이 여럿이면 자재 단위로 한 창고 — 상한은 두 줄의 합에 건다', async () => {
    const { lineId, warehouses } = await scenario('P1', { A: [['X', 20], ['Y', 50]], B: [['X', 18]] });
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'XX', productionDate: fx.nextWeekday('P1', 2) });
    await fx.release(workOrderId).expect(200);
    const rows = await fx.requests(workOrderId);
    expect(rows.map((r) => [r.source_warehouse_id, qtys(r.material_issue_request_line)])).toEqual([
      [warehouses.A, [['X', 10, 0], ['X', 10, 5], ['Y', 5, 0]]],
    ]);
  });

  it('US2-5 기준정보가 빠지면 배포 400 — 라인 부서·생산 현장 위치·부서 생산 창고를 모아 안내', async () => {
    await scenario('P1', { A: [['X', 10]] });
    const bare = await fx.line('P1', 'BARE', null, false);
    const noLine = await fx.release(await fx.workOrder({ plantKey: 'P1', lineId: bare, operation: 'X20', productionDate: fx.nextWeekday('P1', 2) })).expect(400);
    expect(noLine.body.errors.map((e: { code: string }) => e.code)).toEqual(['LINE_DEPARTMENT_MISSING', 'PRODUCTION_FLOOR_LOCATION_MISSING']);

    // 다른 공장 창고만 연결한 부서 — 이 공장의 후보가 아니다.
    const elsewhere = await fx.warehouse(fx.ids.p2, `S${++scenarioSeq}-OTHER`);
    const department = await fx.department(`S${scenarioSeq}-D`, [elsewhere.warehouseId]);
    const line = await fx.line('P1', `S${scenarioSeq}-L`, department);
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId: line, operation: 'X20', productionDate: fx.nextWeekday('P1', 2) });
    const noWarehouse = await fx.release(workOrderId).expect(400);
    expect(noWarehouse.body.errors).toEqual([expect.objectContaining({ field: 'departmentId', code: 'PRODUCTION_WAREHOUSE_MISSING' })]);
    expect(await fx.requests(workOrderId)).toEqual([]);
  });

  it('FR-035 다른 사업부의 W/O 도 같은 규칙이다', async () => {
    const { lineId } = await scenario('P1', { A: [['X', 100]] });
    const planId = await fx.otherUnitPlan('P1');
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X20', productionDate: fx.nextWeekday('P1', 2), planId });
    await fx.release(workOrderId).expect(200);
    const [row] = await fx.requests(workOrderId);
    expect(row.status_code).toBe('WAITING');
  });

  it('US2-7 US2-8 생산 창고 없는 공장은 지금 방식 — 연결한 뒤 새 W/O 부터 대기, 먼저 나간 요청은 그대로', async () => {
    fx.ids.p3 = await fx.plant('P3', HANOI);
    const material = await fx.warehouse(fx.ids.p3, 'P3-MAT', 'MATERIAL');
    await fx.stock(material, 'X', 100);
    const oldLine = await fx.line('P3', 'P3-L0', null);
    const before = await fx.workOrder({ plantKey: 'P3', lineId: oldLine, operation: 'X20', productionDate: fx.nextWeekday('P3', 2) });
    const response = await fx.release(before).expect(200);
    expect(response.body.materialIssueRequests).toBeUndefined();
    const [old] = await fx.requests(before);
    expect(old).toMatchObject({ status_code: 'REGISTERED', source_warehouse_id: null, issue_work_date: null });
    expect((await fx.pickings(old.material_issue_request_id))[0]).toMatchObject({ warehouse_id: material.warehouseId });
    expect(await prisma.material_issue_unsourced_shortage.count({ where: { work_order_id: before } })).toBe(0);

    const { lineId } = await scenario('P3', { A: [['X', 100]] });
    const after = await fx.workOrder({ plantKey: 'P3', lineId, operation: 'X20', productionDate: fx.nextWeekday('P3', 2) });
    await fx.release(after).expect(200);
    const [fresh] = await fx.requests(after);
    expect(fresh.status_code).toBe('WAITING');
    const [unchanged] = await fx.requests(before);
    expect(unchanged).toMatchObject({ status_code: 'REGISTERED', source_warehouse_id: null, version_no: old.version_no });
  });

  // 수정·취소 경로(S7)가 서면 활성화한다(tasks T066).
  it.todo('US2-8 지금 방식 요청은 PUT·:cancel 대상이 아니다(409)');

  /** SC-007 — BOM 의 자재마다 요청 줄 또는 미배정 부족 행 «한 곳»에만 있다. */
  async function expectEachMaterialOnce(workOrderId: bigint, operation: string): Promise<void> {
    const rows = await fx.requests(workOrderId);
    const unsourced = await prisma.material_issue_unsourced_shortage.findMany({ where: { work_order_id: workOrderId } });
    for (const item of new Set(OPERATIONS[operation].map(([key]) => key))) {
      const id = fx.items[item];
      const requestsWithItem = rows.filter((r) => r.material_issue_request_line.some((l) => l.item_id === id)).length;
      const unsourcedRows = unsourced.filter((u) => u.item_id === id).length;
      expect([item, requestsWithItem + unsourcedRows]).toEqual([item, 1]);
    }
  }
});
