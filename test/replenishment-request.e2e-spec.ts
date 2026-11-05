/**
 * 창고 보충 직접 요청(피처 004 · omf-all-around#230 · US1 · W-02-12) — 상한·분할·배포·출고, 생산 창고·출고 자재 창고 규칙,
 * 도착 위치.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { Place, ReplenishmentFixture } from './support/replenishment-fixture';

const PREFIX = `RRQ${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
function validator(path: string, method: string, status: number): ValidateFunction {
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}
const created201 = validator('/logistics/replenishment-requests', 'post', 201);

describe('창고 보충 직접 요청 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: ReplenishmentFixture;
  let today: string;
  const w: Record<string, Place> = {};
  let flat: bigint; // 나뉘지 않은 생산 창고
  let lonely: bigint; // 생산 창고가 없는 공장의 창고

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new ReplenishmentFixture(app, prisma, PREFIX);
    await fx.setup();
    fx.ids.p1 = await fx.plant('P1', HANOI);
    fx.ids.p2 = await fx.plant('P2', HANOI);
    fx.ids.p3 = await fx.plant('P3', HANOI);
    today = localDate(new Date(), HANOI);
    for (const key of ['PROD', 'MAT', 'MAT2', 'DEF']) w[key] = await fx.warehouse(fx.ids.p1, key);
    w.OTHER = await fx.warehouse(fx.ids.p2, 'OTHER');
    await prisma.warehouse.update({ where: { warehouse_id: w.DEF.warehouseId }, data: { is_defect: true } });
    flat = await fx.undividedWarehouse(fx.ids.p1, 'FLAT');
    lonely = await fx.undividedWarehouse(fx.ids.p3, 'LONELY');
    fx.ids.department = await fx.department('D', [w.PROD.warehouseId, flat]);
    await fx.stock(w.MAT, 'X', 100);
    await fx.stock(w.MAT, 'Y', 200);
    await fx.stock(w.MAT, 'W', 100);
    await fx.stock(w.MAT, 'V', 100);
    await fx.stock(w.MAT2, 'X', 30);
    await fx.stock(w.DEF, 'Z', 10);
    await fx.stock(w.OTHER, 'Z', 10);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  const request = (id: number) => prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: id }, include: { material_issue_request_line: { orderBy: { line_no: 'asc' } } } });

  it('US1-1 FR-037 W-02-12 만으로 직접 요청 — W/O 없는 보충 요청이 바로 배포되고 피킹 지시·인계 알림이 생긴다', async () => {
    const res = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'X', qty: 100, source: w.MAT.warehouseId }], remarks: '라인 증설' }).expect(201);
    expect(created201(res.body)).toBe(true);
    expect(res.body.skippedLines).toEqual([]);
    expect(res.body.requests).toHaveLength(1);
    const [made] = res.body.requests;
    expect(made).toMatchObject({
      requestTypeCode: 'REPLENISHMENT',
      replenishmentOriginCode: 'DIRECT',
      workOrderId: null,
      workOrderNo: null,
      statusCode: 'REGISTERED',
      sourceWarehouseId: Number(w.MAT.warehouseId),
      destinationWarehouseId: Number(w.PROD.warehouseId),
      issueWorkDate: today,
      replenishmentStatus: 'DISPATCHED',
      receiptSummary: { issuedCount: 0, receivedCount: 0 },
      qtySummary: { requestedQty: 100, issuedQty: 0, closedQty: 0 },
      remarks: '라인 증설',
    });
    const [picking] = await fx.pickings(BigInt(made.materialIssueRequestId));
    expect(picking).toMatchObject({ warehouse_id: w.MAT.warehouseId, status_code: 'REGISTERED', assigned_worker_id: null });
    expect(picking.picking_line.reduce((s, l) => s + l.planned_qty.toNumber(), 0)).toBe(100);
    const events = await prisma.notification_event.count({ where: { event_type_code: 'MATERIAL_PICKING_REQUESTED', aggregate_type_code: 'PICKING_ORDER', aggregate_id: picking.picking_order_id } });
    expect(events).toBe(1);
  });

  it('US1-4 100 출고 확정 → 생산 창고 가용 +100·출고 누계 100·요청 완료', async () => {
    const [row] = await prisma.material_issue_request.findMany({ where: { source_warehouse_id: w.MAT.warehouseId, material_issue_request_line: { some: { item_id: fx.items.X } } } });
    const staging = await fx.systemLocation(w.PROD.warehouseId, 'PUTAWAY_STAGING');
    await fx.pick(row.material_issue_request_id, 100);
    const issued = await fx.issue(row.material_issue_request_id, 100);
    expect(issued.body.goodsIssue).toMatchObject({ statusCode: 'POSTED', destinationTypeCode: 'LOCATION', destinationId: Number(staging) });
    const balance = await prisma.inventory_balance.aggregate({ where: { warehouse_id: w.PROD.warehouseId, item_id: fx.items.X }, _sum: { available_qty: true } });
    expect(balance._sum.available_qty?.toNumber()).toBe(100);
    const after = await request(Number(row.material_issue_request_id));
    expect(after.status_code).toBe('POSTED');
    expect(after.material_issue_request_line[0].issued_qty.toNumber()).toBe(100);
    const listed = await fx.list({ requestTypeCode: 'REPLENISHMENT', destinationWarehouseId: Number(w.PROD.warehouseId), itemId: Number(fx.items.X) });
    expect(listed[0]).toMatchObject({ replenishmentStatus: 'COMPLETED', receiptSummary: { issuedCount: 1, receivedCount: 0 }, qtySummary: { requestedQty: 100, issuedQty: 100 } });
  });

  it('US1-2 관리 품목이면 출고 자재 창고를 비워도 그 창고 · US1-3 관리 품목이 아니면 400 REQUIRED', async () => {
    await prisma.replenishment_item.create({ data: { warehouse_id: w.PROD.warehouseId, item_id: fx.items.Y, reorder_point_qty: 10, target_qty: 50, source_warehouse_id: w.MAT.warehouseId } });
    const res = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'Y', qty: 20 }] }).expect(201);
    expect(res.body.requests[0].sourceWarehouseId).toBe(Number(w.MAT.warehouseId));
    const missing = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'Z', qty: 5 }] }).expect(400);
    expect(missing.body.errors).toContainEqual(expect.objectContaining({ field: 'lines[0].sourceWarehouseId', code: 'REQUIRED' }));
  });

  it('US1-5 같은 출고 자재 창고의 두 줄은 한 요청 — 두 품목이면 수량 합은 null', async () => {
    const res = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'Y', qty: 10, source: w.MAT.warehouseId }, { item: 'V', qty: 10, source: w.MAT.warehouseId }] }).expect(201);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0]).toMatchObject({ lineCount: 2, qtySummary: null });
  });

  it('US1-6 다른 생산 창고 보충이 예정을 잡으면 쓸 수 있는 양까지만 — 나머지는 부족 · FR-008 나뉘지 않은 창고는 창고 전체로', async () => {
    const other = await fx.create({ productionWarehouseId: flat, lines: [{ item: 'W', qty: 60, source: w.MAT.warehouseId }] }).expect(201);
    expect(other.body.requests[0].destinationLocationId).toBe(Number(await fx.systemLocation(flat, 'WAREHOUSE_WHOLE')));
    const res = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'W', qty: 100, source: w.MAT.warehouseId }] }).expect(201);
    const row = await request(res.body.requests[0].materialIssueRequestId);
    expect(row.material_issue_request_line.map((l) => [l.requested_qty.toNumber(), l.shortage_qty.toNumber()])).toEqual([[40, 60]]);
    expect(row.destination_location_id).toBe(await fx.systemLocation(w.PROD.warehouseId, 'PUTAWAY_STAGING'));
  });

  it('US1-7 쓸 수 있는 양 0 인 줄은 건너뛰고, 모두 0 이면 409 PLANNED_STOCK_CONFLICT(overridable 없음)', async () => {
    const res = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'W', qty: 10, source: w.MAT.warehouseId }, { item: 'V', qty: 5, source: w.MAT.warehouseId }] }).expect(201);
    expect(res.body.skippedLines).toEqual([{ itemId: Number(fx.items.W), sourceWarehouseId: Number(w.MAT.warehouseId), requestedQty: 10, freeQty: 0 }]);
    expect(res.body.requests[0].lineCount).toBe(1);
    const none = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'W', qty: 10, source: w.MAT.warehouseId }] }).expect(409);
    expect(none.body.errors[0].code).toBe('PLANNED_STOCK_CONFLICT');
    expect(none.body.plannedStockConflicts).toEqual([expect.objectContaining({ itemId: Number(fx.items.W), freeQty: 0, overridable: false })]);
  });

  it('서로 다른 출고 자재 창고의 줄은 요청 두 장 — 출고 작업일은 공장 오늘', async () => {
    const res = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'V', qty: 5, source: w.MAT.warehouseId }, { item: 'X', qty: 10, source: w.MAT2.warehouseId }] }).expect(201);
    expect(res.body.requests.map((r: { sourceWarehouseId: number; issueWorkDate: string }) => [r.sourceWarehouseId, r.issueWorkDate])).toEqual(
      [w.MAT.warehouseId, w.MAT2.warehouseId].sort((a, b) => Number(a - b)).map((id) => [Number(id), today]),
    );
  });

  it('FR-002 출고 자재 창고 규칙·중복 줄·수량 — 400', async () => {
    for (const source of [w.PROD.warehouseId, w.DEF.warehouseId, w.OTHER.warehouseId]) {
      const bad = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'Z', qty: 1, source }] }).expect(400);
      expect(bad.body.errors).toContainEqual(expect.objectContaining({ field: 'lines[0].sourceWarehouseId', code: 'INVALID' }));
    }
    const dup = await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'V', qty: 1, source: w.MAT.warehouseId }, { item: 'V', qty: 2, source: w.MAT.warehouseId }] }).expect(400);
    expect(dup.body.errors).toContainEqual(expect.objectContaining({ field: 'lines[1].itemId', code: 'INVALID' }));
  });

  it('US1-8 생산 창고 없는 공장·생산 창고가 아닌 창고는 400 — 부서 연결이 끊긴 창고도 400 이고 이미 나간 요청은 그대로', async () => {
    const none = await fx.create({ productionWarehouseId: lonely, lines: [{ item: 'X', qty: 1, source: w.MAT.warehouseId }] }).expect(400);
    expect(none.body.errors).toContainEqual(expect.objectContaining({ field: 'productionWarehouseId', code: 'INVALID' }));
    await fx.create({ productionWarehouseId: w.MAT.warehouseId, lines: [{ item: 'X', qty: 1, source: w.MAT2.warehouseId }] }).expect(400);

    const before = await prisma.material_issue_request.findMany({ where: { location: { warehouse_id: flat } }, select: { material_issue_request_id: true, status_code: true } });
    await prisma.department_production_warehouse.deleteMany({ where: { warehouse_id: flat } });
    await fx.create({ productionWarehouseId: flat, lines: [{ item: 'V', qty: 1, source: w.MAT.warehouseId }] }).expect(400);
    const after = await prisma.material_issue_request.findMany({ where: { location: { warehouse_id: flat } }, select: { material_issue_request_id: true, status_code: true } });
    expect(after).toEqual(before);
    expect(after.every((r) => r.status_code === 'REGISTERED')).toBe(true);
  });

  it('W-02-12 가 없으면 403', async () => {
    await fx.create({ productionWarehouseId: w.PROD.warehouseId, lines: [{ item: 'V', qty: 1, source: w.MAT.warehouseId }] }, fx.cookie).expect(403);
  });
});
