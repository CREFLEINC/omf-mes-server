/**
 * 생산 창고 보충 — 관리 품목·실행 시각(피처 004 · omf-all-around#230 · US4 · W-02-12). 진행 중 보충 요청은 시험 준비에서
 * 직접 넣는다(만드는 경로는 직접 요청 PR).
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
import { chooseSources } from '../src/core/material-issue/source-warehouse';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { MaterialIssueFixture } from './support/material-issue-fixture';

const PREFIX = `RIT${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';
const ITEMS = '/api/logistics/replenishment-items';
const SETTINGS = '/api/logistics/replenishment-settings';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
function validator(path: string, method: string, status: number): ValidateFunction {
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

type Place = { warehouseId: bigint; locationId: bigint };

describe('생산 창고 보충 관리 품목·실행 시각 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: MaterialIssueFixture;
  let cookie: string;
  let today: string;
  const w: Record<string, Place> = {};
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
    fx.ids.p2 = await fx.plant('P2', HANOI);
    today = localDate(new Date(), HANOI);
    for (const key of ['PROD', 'PROD2', 'MAT', 'MAT2', 'DEF', 'OFF']) w[key] = await fx.warehouse(fx.ids.p1, key);
    w.OTHER = await fx.warehouse(fx.ids.p2, 'OTHER');
    await prisma.warehouse.update({ where: { warehouse_id: w.DEF.warehouseId }, data: { is_defect: true } });
    await prisma.warehouse.update({ where: { warehouse_id: w.OFF.warehouseId }, data: { is_active: false } });
    await fx.department('D', [w.PROD.warehouseId, w.PROD2.warehouseId]);
    await fx.stock(w.PROD, 'X', 30);
    await fx.stock(w.PROD, 'Y', 500);

    // fx 의 역할에는 W-02-12 가 없다 — 403 은 그 쿠키로 본다.
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-U12`, user_name: '보충', status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-R12`, role_name: '보충' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-02-12' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
  });

  afterAll(async () => {
    const mine = { issue_request_no: { startsWith: `${PREFIX}-R` } };
    await prisma.material_issue_request_line.deleteMany({ where: { material_issue_request: mine } });
    await prisma.material_issue_request.deleteMany({ where: mine });
    const items = await prisma.replenishment_item.findMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } }, select: { replenishment_item_id: true } });
    const all = await prisma.audit_event.findMany({ where: { target_type_code: 'REPLENISHMENT_ITEM' }, select: { audit_event_id: true, target_id: true, performed_by: true } });
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: PREFIX } }, select: { app_user_id: true } });
    const userIds = new Set(users.map((u) => u.app_user_id));
    await prisma.audit_event.deleteMany({ where: { audit_event_id: { in: all.filter((a) => a.performed_by !== null && userIds.has(a.performed_by)).map((a) => a.audit_event_id) } } });
    await prisma.replenishment_item.deleteMany({ where: { replenishment_item_id: { in: items.map((i) => i.replenishment_item_id) } } });
    await prisma.replenishment_warehouse_setting.deleteMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } } });
    await fx.cleanup();
    await app.close();
  });

  const send = (method: 'post' | 'put' | 'delete', path: string, body?: object, as = cookie) =>
    request(app.getHttpServer())[method](path).set('Cookie', as).set('Idempotency-Key', randomUUID()).send(body);
  const list = (query: object, as = cookie) =>
    request(app.getHttpServer()).get(ITEMS).query({ plantId: Number(fx.ids.p1), size: 100, ...query }).set('Cookie', as);
  const body = (overrides: object = {}) => ({
    productionWarehouseId: Number(w.PROD.warehouseId),
    itemId: Number(fx.items.X),
    reorderPointQty: 50,
    targetQty: 200,
    sourceWarehouseId: Number(w.MAT.warehouseId),
    ...overrides,
  });

  /** 창고 보충 요청(한 줄)을 직접 넣는다. */
  async function replenishment(source: Place, destination: Place, item: 'X' | 'Y', qty: number) {
    return prisma.material_issue_request.create({
      data: {
        issue_request_no: `${PREFIX}-R${++seq}`,
        request_type_code: 'REPLENISHMENT',
        replenishment_origin_code: 'DIRECT',
        source_warehouse_id: source.warehouseId,
        destination_location_id: destination.locationId,
        status_code: 'REGISTERED',
        issue_work_date: new Date(`${today}T00:00:00.000Z`),
        material_issue_request_line: { create: [{ line_no: 1, item_id: fx.items[item], requested_qty: qty, uom_id: fx.ids.uom }] },
      },
    });
  }

  it('US4-1 추가·목록에 계산 값 — 가용·예정·쓸 수 있는 양·진행 중 보충·기준 아래', async () => {
    await replenishment(w.MAT, w.PROD, 'X', 40); // PROD 로 들어오는 보충 40
    await replenishment(w.PROD, w.PROD2, 'X', 10); // PROD 가 출발지인 예정 10
    const created = await send('post', ITEMS, body()).expect(201);
    expect(validator('/logistics/replenishment-items', 'post', 201)(created.body)).toBe(true);
    const expected = {
      productionWarehouseId: Number(w.PROD.warehouseId),
      productionWarehouseName: 'PROD',
      itemId: Number(fx.items.X),
      sourceWarehouseId: Number(w.MAT.warehouseId),
      sourceWarehouseName: 'MAT',
      reorderPointQty: 50,
      targetQty: 200,
      availableQty: 30,
      plannedQty: 10,
      usableQty: 20,
      inProgressQty: 40,
      belowPoint: true,
      versionNo: 1,
    };
    expect(created.body).toMatchObject(expected);
    const listed = await list({}).expect(200);
    expect(validator('/logistics/replenishment-items', 'get', 200)(listed.body)).toBe(true);
    expect(listed.body.items).toEqual([expect.objectContaining(expected)]);
  });

  it('US4-2 보충 시점 ≤ 0 또는 유지량 ≤ 보충 시점이면 400 RANGE', async () => {
    const zero = await send('post', ITEMS, body({ itemId: Number(fx.items.Z), reorderPointQty: 0 })).expect(400);
    expect(zero.body.errors).toContainEqual(expect.objectContaining({ field: 'reorderPointQty', code: 'RANGE' }));
    const flat = await send('post', ITEMS, body({ itemId: Number(fx.items.Z), reorderPointQty: 100, targetQty: 100 })).expect(400);
    expect(flat.body.errors).toContainEqual(expect.objectContaining({ field: 'targetQty', code: 'RANGE' }));
  });

  it('US4-3 같은 생산 창고·품목은 409 DUPLICATE', async () => {
    const dup = await send('post', ITEMS, body()).expect(409);
    expect(dup.body.errors[0]).toMatchObject({ code: 'DUPLICATE', field: 'itemId' });
  });

  it('US4-4 출고 자재 창고·품목·생산 창고 규칙 — 400 INVALID', async () => {
    for (const key of ['PROD', 'DEF', 'OTHER', 'OFF']) {
      const bad = await send('post', ITEMS, body({ itemId: Number(fx.items.Z), sourceWarehouseId: Number(w[key].warehouseId) })).expect(400);
      expect(bad.body.errors).toContainEqual(expect.objectContaining({ field: 'sourceWarehouseId', code: 'INVALID' }));
    }
    const finished = await send('post', ITEMS, body({ itemId: Number(fx.ids.fg) })).expect(400);
    expect(finished.body.errors).toContainEqual(expect.objectContaining({ field: 'itemId', code: 'INVALID' }));
    const notProduction = await send('post', ITEMS, body({ itemId: Number(fx.items.Z), productionWarehouseId: Number(w.MAT2.warehouseId) })).expect(400);
    expect(notProduction.body.errors).toContainEqual(expect.objectContaining({ field: 'productionWarehouseId', code: 'INVALID' }));
  });

  it('US4-7 조건 — 품목·출고 자재 창고·기준 아래만', async () => {
    await send('post', ITEMS, body({ itemId: Number(fx.items.Y), sourceWarehouseId: Number(w.MAT2.warehouseId) })).expect(201);
    const ids = async (query: object) => (await list(query).expect(200)).body.items.map((i: { itemId: number }) => i.itemId);
    expect(await ids({})).toEqual([Number(fx.items.X), Number(fx.items.Y)]);
    expect(await ids({ itemId: Number(fx.items.Y) })).toEqual([Number(fx.items.Y)]);
    expect(await ids({ sourceWarehouseId: Number(w.MAT.warehouseId) })).toEqual([Number(fx.items.X)]);
    expect(await ids({ belowPointOnly: true })).toEqual([Number(fx.items.X)]);
    expect(await ids({ productionWarehouseId: Number(w.PROD2.warehouseId) })).toEqual([]);
    const paged = await list({ size: 1, page: 2 }).expect(200);
    expect(paged.body.page.total).toBe(2);
    expect(paged.body.items.map((i: { itemId: number }) => i.itemId)).toEqual([Number(fx.items.Y)]);
  });

  it('FR-026 관리 품목이 있어도 003 출발 생산 창고 선택은 같다', async () => {
    const choose = () => prisma.$transaction((tx) => chooseSources(tx, { warehouseIds: [w.PROD.warehouseId, w.PROD2.warehouseId], itemIds: [fx.items.X, fx.items.Y] }));
    const withItems = await choose();
    const rows = await prisma.replenishment_item.findMany({ where: { warehouse_id: w.PROD.warehouseId } });
    await prisma.replenishment_item.deleteMany({ where: { warehouse_id: w.PROD.warehouseId } });
    const without = await choose();
    await prisma.replenishment_item.createMany({ data: rows });
    expect([...withItems.chosen]).toEqual([...without.chosen]);
    expect(withItems.unsourced).toEqual(without.unsourced);
  });

  it('PUT 은 보충 시점·유지량·출고 자재 창고를 바꾸고, 판 번호가 다르면 409', async () => {
    const [x] = (await list({ itemId: Number(fx.items.X) }).expect(200)).body.items;
    const path = `${ITEMS}/${x.replenishmentItemId}`;
    const changed = await send('put', path, { reorderPointQty: 10, targetQty: 100, sourceWarehouseId: Number(w.MAT2.warehouseId), versionNo: x.versionNo }).expect(200);
    expect(changed.body).toMatchObject({ reorderPointQty: 10, targetQty: 100, sourceWarehouseName: 'MAT2', belowPoint: false, versionNo: x.versionNo + 1 });
    const stale = await send('put', path, { reorderPointQty: 10, targetQty: 100, sourceWarehouseId: Number(w.MAT2.warehouseId), versionNo: x.versionNo }).expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('US4-5 진행 중 요청이 있는 품목을 지우면 그 수를 알리고 요청은 그대로다', async () => {
    const [x] = (await list({ itemId: Number(fx.items.X) }).expect(200)).body.items;
    const before = await prisma.material_issue_request.count({ where: { issue_request_no: { startsWith: `${PREFIX}-R` } } });
    const deleted = await send('delete', `${ITEMS}/${x.replenishmentItemId}`).expect(200);
    expect(deleted.body).toEqual({ inProgressRequestCount: 1 });
    expect(await prisma.material_issue_request.count({ where: { issue_request_no: { startsWith: `${PREFIX}-R` } } })).toBe(before);
    await send('delete', `${ITEMS}/${x.replenishmentItemId}`).expect(404);
  });

  it('실행 시각 — 공장 기본 01:00(SERVER_DEFAULT), 창고 시각 저장·해제·형식 오류·판 번호', async () => {
    const get = () => request(app.getHttpServer()).get(SETTINGS).query({ plantId: Number(fx.ids.p1) }).set('Cookie', cookie).expect(200);
    const first = await get();
    expect(validator('/logistics/replenishment-settings', 'get', 200)(first.body)).toBe(true);
    expect(first.body).toMatchObject({ plantDefaultRunTime: '01:00', plantDefaultSource: 'SERVER_DEFAULT' });
    expect(first.body.warehouses.map((x: { warehouseName: string }) => x.warehouseName)).toEqual(['PROD', 'PROD2']);
    expect(first.body.warehouses[0]).toMatchObject({ runTime: null, effectiveRunTime: '01:00', versionNo: 0, lastRun: null });

    const path = `${SETTINGS}/warehouses/${w.PROD.warehouseId}`;
    const set = await send('put', path, { runTime: '07:00', versionNo: 0 }).expect(200);
    expect(validator('/logistics/replenishment-settings/warehouses/{warehouseId}', 'put', 200)(set.body)).toBe(true);
    expect(set.body).toMatchObject({ runTime: '07:00', effectiveRunTime: '07:00', versionNo: 1 });
    await send('put', path, { runTime: '08:00', versionNo: 0 }).expect(409);
    const cleared = await send('put', path, { runTime: null, versionNo: 1 }).expect(200);
    expect(cleared.body).toMatchObject({ runTime: null, effectiveRunTime: '01:00', versionNo: 2 });
    for (const bad of ['24:00', '7:00', '07:60']) {
      const res = await send('put', path, { runTime: bad, versionNo: 2 }).expect(400);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ field: 'runTime', code: 'RANGE' }));
    }
    const notProduction = await send('put', `${SETTINGS}/warehouses/${w.MAT.warehouseId}`, { runTime: '07:00', versionNo: 0 }).expect(400);
    expect(notProduction.body.errors).toContainEqual(expect.objectContaining({ field: 'warehouseId', code: 'INVALID' }));
  });

  it('공장 기본 시각 — 정책 REPLENISHMENT_RUN_TIME(공장 범위·HH:MM)을 W-02-12 로 저장하면 POLICY', async () => {
    const policy = (overrides: object) =>
      send('post', '/api/app/operation-policies', { policyCode: 'REPLENISHMENT_RUN_TIME', plantId: Number(fx.ids.p1), valueText: '06:30', effectiveFrom: '2026-01-01', ...overrides });
    const wrong = await policy({ valueText: '6:30' }).expect(400);
    expect(wrong.body.errors).toContainEqual(expect.objectContaining({ field: 'valueText', code: 'RANGE' }));
    await policy({ itemId: Number(fx.items.X) }).expect(400);
    await policy({}).expect(201);
    const after = await request(app.getHttpServer()).get(SETTINGS).query({ plantId: Number(fx.ids.p1) }).set('Cookie', cookie).expect(200);
    expect(after.body).toMatchObject({ plantDefaultRunTime: '06:30', plantDefaultSource: 'POLICY' });
    expect(after.body.warehouses[1]).toMatchObject({ warehouseName: 'PROD2', runTime: null, effectiveRunTime: '06:30' });
    // W-02-12 는 다른 정책 코드를 쓰지 못한다.
    await send('post', '/api/app/operation-policies', { policyCode: 'WEEKLY_WORKING_DAYS', plantId: Number(fx.ids.p1), valueNumeric: 6, effectiveFrom: '2026-01-01' }).expect(403);
  });

  it('FR-037 모든 경로가 W-02-12 없으면 403', async () => {
    const other = fx.cookie;
    await list({}, other).expect(403);
    await send('post', ITEMS, body({ itemId: Number(fx.items.Z) }), other).expect(403);
    await send('put', `${ITEMS}/1`, { reorderPointQty: 1, targetQty: 2, sourceWarehouseId: 1, versionNo: 1 }, other).expect(403);
    await send('delete', `${ITEMS}/1`, undefined, other).expect(403);
    await request(app.getHttpServer()).get(SETTINGS).query({ plantId: Number(fx.ids.p1) }).set('Cookie', other).expect(403);
    await send('put', `${SETTINGS}/warehouses/${w.PROD.warehouseId}`, { runTime: null, versionNo: 0 }, other).expect(403);
  });
});
