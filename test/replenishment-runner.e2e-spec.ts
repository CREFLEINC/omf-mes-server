/**
 * 생산 창고 자동 보충 러너(피처 004 · omf-all-around#230 · US5 · US4-6 · SC-004·005 · FR-036). 시각은 `tick(now)` 로만
 * 움직인다. 리스는 늘 잡히는 가짜다 — 「한 번만」은 실행 기록 UNIQUE(창고, 공장 현지 날짜)가 지키는지를 본다.
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
import { ReplenishmentCreator } from '../src/core/material-issue/replenishment-create';
import { NumberingService } from '../src/core/numbering';
import { PickingHandoverNotifier } from '../src/core/picking';
import { ReplenishmentRunner } from '../src/logistics/replenishment/replenishment.runner';
import { zonedToUtc } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { ItemKey } from './support/material-issue-fixture';
import { Place, ReplenishmentFixture } from './support/replenishment-fixture';

const PREFIX = `RRN${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';
const SEOUL = 'Asia/Seoul';
const DAY1 = '2026-12-01';
const DAY2 = '2026-12-02';
const DAY3 = '2026-12-03';
const DAY4 = '2026-12-04';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
const runs200 = ajv.compile({ $ref: 'https://omf-mes.invalid/contract#/paths/~1logistics~1replenishment-runs/get/responses/200/content/application~1json/schema' });

const at = (day: string, time: string, timezone = HANOI) => zonedToUtc(day, time, timezone);

describe('생산 창고 자동 보충 러너 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: ReplenishmentFixture;
  const w: Record<string, Place> = {};

  const runner = (enabled = true) =>
    new ReplenishmentRunner(
      enabled,
      prisma,
      { acquire: async () => true, release: async () => undefined },
      new ReplenishmentCreator(app.get(DocumentStateService), app.get(PickingHandoverNotifier)),
      app.get(NumberingService),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new ReplenishmentFixture(app, prisma, PREFIX);
    await fx.setup();
    fx.ids.p1 = await fx.plant('P1', HANOI);
    fx.ids.p2 = await fx.plant('P2', SEOUL);
    for (const key of ['PROD', 'PROD2', 'PROD3', 'PROD4', 'BROKEN', 'MAT', 'MAT2', 'OFF']) w[key] = await fx.warehouse(fx.ids.p1, key);
    for (const key of ['SPROD', 'SMAT']) w[key] = await fx.warehouse(fx.ids.p2, key);
    await prisma.warehouse.update({ where: { warehouse_id: w.OFF.warehouseId }, data: { is_active: false } });
    await fx.department('D1', ['PROD', 'PROD2', 'PROD3', 'PROD4', 'BROKEN'].map((k) => w[k].warehouseId));
    await fx.department('D2', [w.SPROD.warehouseId]);
    // 부서 연결이 끊긴 창고(FR-036) — 관리 품목이 있어도 돌지 않는다.
    await prisma.department_production_warehouse.deleteMany({ where: { warehouse_id: w.PROD4.warehouseId } });
    // 실패하는 창고 — 나뉜 창고인데 적치 대기 위치가 없다(도착 위치를 풀지 못한다).
    await prisma.location.deleteMany({ where: { warehouse_id: w.BROKEN.warehouseId, system_role_code: 'PUTAWAY_STAGING' } });

    await fx.stock(w.PROD, 'X', 80);
    await fx.stock(w.PROD, 'W', 60);
    for (const item of ['X', 'Z', 'W'] as const) await fx.stock(w.MAT, item, 500);
    await fx.stock(w.MAT2, 'Y', 100);
    await fx.stock(w.SMAT, 'X', 500);
    // PROD 가 출발지인 예정 40(보충 아닌 곳으로) — 쓸 수 있는 양 = 80 − 40 = 40.
    await insertRequest(w.PROD, w.MAT, 'X', 40);
    // PROD2 로 들어오는 진행 중 보충(X) — 자동 보충은 건너뛴다.
    await insertRequest(w.MAT, w.PROD2, 'X', 5);

    const managed = (warehouse: string, item: ItemKey, point: number, target: number, source: string) =>
      prisma.replenishment_item.create({
        data: { warehouse_id: w[warehouse].warehouseId, item_id: fx.items[item], reorder_point_qty: point, target_qty: target, source_warehouse_id: w[source].warehouseId },
      });
    await managed('PROD', 'X', 50, 200, 'MAT'); // 40 → 160 CREATED
    await managed('PROD', 'Z', 50, 100, 'MAT'); // 0 → 100 같은 출고 자재 창고 → 한 장 두 줄
    await managed('PROD', 'Y', 50, 160, 'MAT2'); // 0 → 160, MAT2 에 100 → SHORTAGE 60
    await managed('PROD', 'V', 10, 50, 'MAT2'); // MAT2 에 없음 → NO_SOURCE_STOCK
    await managed('PROD', 'W', 10, 50, 'MAT'); // 60 ≥ 10 → 행 없음
    await managed('PROD2', 'X', 50, 100, 'MAT'); // 진행 중 → IN_PROGRESS
    await managed('PROD2', 'Y', 50, 100, 'OFF'); // 출고 자재 창고 사용 중지 → SOURCE_INACTIVE
    await managed('PROD3', 'Z', 50, 100, 'MAT'); // 창고 시각 07:00
    await managed('PROD4', 'Z', 50, 100, 'MAT');
    await managed('BROKEN', 'Z', 50, 100, 'MAT');
    await managed('SPROD', 'X', 50, 100, 'SMAT');
    await prisma.replenishment_warehouse_setting.create({ data: { warehouse_id: w.PROD3.warehouseId, run_time: '07:00' } });
    // 서울 공장 기본 시각 04:00(정책) — 하노이 01:00:30 은 서울 03:00:30 이라 아직이다.
    await prisma.operation_policy.create({
      data: { policy_code: 'REPLENISHMENT_RUN_TIME', plant_id: fx.ids.p2, value_text: '04:00', effective_from: new Date('2026-01-01T00:00:00Z') },
    });
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  let seq = 0;
  async function insertRequest(source: Place, destination: Place, item: ItemKey, qty: number) {
    return prisma.material_issue_request.create({
      data: {
        issue_request_no: `${PREFIX}-R${++seq}`, request_type_code: 'REPLENISHMENT', replenishment_origin_code: 'DIRECT',
        source_warehouse_id: source.warehouseId, destination_location_id: destination.locationId, status_code: 'REGISTERED',
        issue_work_date: new Date(`${DAY1}T00:00:00Z`),
        material_issue_request_line: { create: [{ line_no: 1, item_id: fx.items[item], requested_qty: qty, uom_id: fx.ids.uom }] },
      },
    });
  }
  const runsOf = (warehouse: string) =>
    prisma.replenishment_run.findMany({ where: { warehouse_id: w[warehouse].warehouseId }, include: { replenishment_run_line: true }, orderBy: { run_date: 'asc' } });
  const autoRequests = (warehouse: string) =>
    prisma.material_issue_request.findMany({
      where: { replenishment_origin_code: 'AUTO', location: { warehouse_id: w[warehouse].warehouseId } },
      include: { material_issue_request_line: { orderBy: { line_no: 'asc' } } },
      orderBy: { material_issue_request_id: 'asc' },
    });
  const day = (date: Date) => date.toISOString().slice(0, 10);

  it('환경값이 꺼져 있으면 아무것도 돌리지 않는다', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    const off = runner(false);
    off.onApplicationBootstrap();
    await off.onApplicationShutdown();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('US4-6 실행 시각 전(00:59)에는 돌지 않는다', async () => {
    await runner().tick(at(DAY1, '00:59:00'));
    expect(await runsOf('PROD')).toEqual([]);
  });

  it('US5-1 US5-6 US5-7 01:00:30 — 기준 아래 품목을 출고 자재 창고별로 「자동」 요청·바로 배포, 부족·재고 없음은 결과에 남는다', async () => {
    await runner().tick(at(DAY1, '01:00:30'));
    const [run] = await runsOf('PROD');
    expect(run).toMatchObject({ status_code: 'DONE', checked_item_count: 5, created_request_count: 2 });
    expect(day(run.run_date)).toBe(DAY1);
    const byItem = new Map(run.replenishment_run_line.map((l) => [l.item_id, l]));
    expect(byItem.get(fx.items.X)).toMatchObject({ result_code: 'CREATED' });
    expect(byItem.get(fx.items.X)?.usable_qty.toNumber()).toBe(40);
    expect(byItem.get(fx.items.X)?.requested_qty.toNumber()).toBe(160);
    expect(byItem.get(fx.items.Y)).toMatchObject({ result_code: 'SHORTAGE' });
    expect([byItem.get(fx.items.Y)?.requested_qty.toNumber(), byItem.get(fx.items.Y)?.shortage_qty.toNumber()]).toEqual([100, 60]);
    expect(byItem.get(fx.items.V)).toMatchObject({ result_code: 'NO_SOURCE_STOCK', material_issue_request_id: null });
    expect(byItem.has(fx.items.W)).toBe(false);

    const requests = await autoRequests('PROD');
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r).toMatchObject({ request_type_code: 'REPLENISHMENT', status_code: 'REGISTERED', work_order_id: null, replenishment_run_id: run.replenishment_run_id });
      expect(day(r.issue_work_date as Date)).toBe(DAY1);
      expect((await fx.pickings(r.material_issue_request_id)).length).toBe(1);
    }
    const mat = requests.find((r) => r.source_warehouse_id === w.MAT.warehouseId);
    expect(mat?.material_issue_request_line.map((l) => [l.item_id, l.requested_qty.toNumber()])).toEqual([[fx.items.X, 160], [fx.items.Z, 100]]);
    // 관리 품목이 아닌 품목은 요청이 없다(US5-5).
    const items = new Set(requests.flatMap((r) => r.material_issue_request_line.map((l) => l.item_id)));
    expect([...items].every((id) => [fx.items.X, fx.items.Z, fx.items.Y].includes(id))).toBe(true);
  });

  it('US5-4 진행 중 보충 → IN_PROGRESS, 출고 자재 창고 사용 중지 → SOURCE_INACTIVE', async () => {
    const [run] = await runsOf('PROD2');
    expect(run.replenishment_run_line.map((l) => [l.item_id, l.result_code]).sort()).toEqual(
      [[fx.items.X, 'IN_PROGRESS'], [fx.items.Y, 'SOURCE_INACTIVE']].sort(),
    );
    expect(await autoRequests('PROD2')).toEqual([]);
  });

  it('SC-004 기준 아래 품목은 생성·부족·사유 있는 건너뜀 중 정확히 하나, 같은 품목 진행 중 보충은 2건 이상 없다', async () => {
    for (const warehouse of ['PROD', 'PROD2']) {
      const [run] = await runsOf(warehouse);
      const items = run.replenishment_run_line.map((l) => l.item_id);
      expect(new Set(items).size).toBe(items.length);
    }
    const lines = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request: { request_type_code: 'REPLENISHMENT', status_code: { in: ['WAITING', 'REGISTERED'] }, closed_at: null, location: { warehouse_id: { in: [w.PROD.warehouseId, w.PROD2.warehouseId] } } } },
      select: { item_id: true, material_issue_request: { select: { location: { select: { warehouse_id: true } } } } },
    });
    const pairs = lines.map((l) => `${l.material_issue_request.location.warehouse_id}:${l.item_id}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('US5-8 같은 날 다시 tick → 아무것도 없음 · US5-9 새 러너(재시작) 같은 날 → 한 번뿐', async () => {
    const before = (await autoRequests('PROD')).length;
    await runner().tick(at(DAY1, '01:05:00'));
    await runner().tick(at(DAY1, '02:00:00'));
    expect(await runsOf('PROD')).toHaveLength(1);
    expect(await autoRequests('PROD')).toHaveLength(before);
  });

  it('US4-6 창고 시각 07:00 — 01:00 에는 없고 07:00 에 돈다, 그날 돈 뒤 시각을 바꿔도 다음 날부터', async () => {
    expect(await runsOf('PROD3')).toEqual([]);
    await runner().tick(at(DAY1, '07:00:10'));
    expect(await runsOf('PROD3')).toHaveLength(1);
    await prisma.replenishment_warehouse_setting.update({ where: { warehouse_id: w.PROD3.warehouseId }, data: { run_time: '08:00' } });
    await runner().tick(at(DAY1, '08:30:00'));
    expect(await runsOf('PROD3')).toHaveLength(1);
  });

  it('시간대 다른 공장 — 서울 공장 정책 04:00 은 서울 현지 시각으로, 실행 날짜는 서울 날짜로', async () => {
    // 하노이 01:00:30·01:05 회차는 서울 03:00·03:05 라 돌지 않았고, 하노이 02:00 회차(= 서울 04:00)에 돌았다.
    const runs = await runsOf('SPROD');
    expect(runs).toHaveLength(1);
    expect(runs[0].started_at.toISOString()).toBe(at(DAY1, '04:00:00', SEOUL).toISOString());
    expect(day(runs[0].run_date)).toBe(DAY1);
    expect(runs[0].created_request_count).toBe(1);
  });

  it('FR-036 부서 연결이 끊긴 창고는 돌지 않는다 · 창고 단위 실패 → FAILED·오류 글·다음 창고 계속·그날 재실행 없음', async () => {
    expect(await runsOf('PROD4')).toEqual([]);
    const [failed] = await runsOf('BROKEN');
    expect(failed).toMatchObject({ status_code: 'FAILED' });
    expect(failed.error_text).toMatch(/PUTAWAY_STAGING/);
    // 같은 회차의 다른 창고(PROD·PROD2)는 돌았다 — 위 시험들. 같은 날 다시 tick 해도 실패 창고는 다시 돌지 않는다.
    await runner().tick(at(DAY1, '09:00:00'));
    expect(await runsOf('BROKEN')).toHaveLength(1);
  });

  it('US5-9 지난날은 돌지 않는다 — 2일을 건너뛰고 3일에 tick 하면 3일 기록만 생긴다', async () => {
    await runner().tick(at(DAY3, '01:00:30'));
    expect((await runsOf('PROD')).map((r) => day(r.run_date))).toEqual([DAY1, DAY3]);
    expect((await runsOf('PROD')).map((r) => day(r.run_date))).not.toContain(DAY2);
  });

  it('SC-005 두 러너가 같은 순간 tick — 창고마다 기록 하나, 요청 한 벌', async () => {
    // 4일엔 PROD 의 X·Z·Y 가 진행 중이라 새 요청이 없다 — 진행 중 보충을 닫아 새로 만들게 한다.
    await prisma.material_issue_request.updateMany({ where: { replenishment_origin_code: 'AUTO', location: { warehouse_id: w.PROD.warehouseId } }, data: { status_code: 'CANCELLED' } });
    const before = (await autoRequests('PROD')).length;
    await Promise.all([runner().tick(at(DAY4, '01:00:30')), runner().tick(at(DAY4, '01:00:30'))]);
    const runs = (await runsOf('PROD')).filter((r) => day(r.run_date) === DAY4);
    expect(runs).toHaveLength(1);
    expect((await autoRequests('PROD')).length - before).toBe(runs[0].created_request_count);
    expect(runs[0].created_request_count).toBe(2);
  });

  it('US5-10 실행 기록 조회 — 창고별 결과·줄, 설정의 마지막 실행', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/logistics/replenishment-runs')
      .query({ plantId: Number(fx.ids.p1), productionWarehouseId: Number(w.PROD.warehouseId), runDateFrom: DAY1, runDateTo: DAY1 })
      .set('Cookie', fx.replenishmentCookie)
      .expect(200);
    expect(runs200(res.body)).toBe(true);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ runDate: DAY1, status: 'DONE', checkedItemCount: 5, createdRequestCount: 2, errorText: null });
    expect(res.body.items[0].lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: Number(fx.items.Y), resultCode: 'SHORTAGE', requestedQty: 100, shortageQty: 60, issueRequestNo: expect.any(String) })]),
    );
    const failed = await request(app.getHttpServer()).get('/api/logistics/replenishment-runs').query({ plantId: Number(fx.ids.p1), productionWarehouseId: Number(w.BROKEN.warehouseId) }).set('Cookie', fx.replenishmentCookie).expect(200);
    expect(failed.body.items[0]).toMatchObject({ status: 'FAILED', lines: [] });

    const settings = await request(app.getHttpServer()).get('/api/logistics/replenishment-settings').query({ plantId: Number(fx.ids.p1) }).set('Cookie', fx.replenishmentCookie).expect(200);
    const prod = settings.body.warehouses.find((x: { warehouseId: number }) => x.warehouseId === Number(w.PROD.warehouseId));
    expect(prod.lastRun).toMatchObject({ runDate: DAY4, status: 'DONE', createdRequestCount: 2 });
    await request(app.getHttpServer()).get('/api/logistics/replenishment-runs').query({ plantId: Number(fx.ids.p1) }).set('Cookie', fx.cookie).expect(403);
  });
});
