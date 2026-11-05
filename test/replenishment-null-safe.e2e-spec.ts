/**
 * 창고 보충 요청의 W/O null 대응(피처 004 · omf-all-around#230 · research R-2·R-4·R-13). 보충 요청을 만드는 경로보다
 * 먼저 나가는 읽기 코드라, 요청 행은 시험 준비에서 직접 넣는다(출발 = 자재 창고, 도착 = 생산 창고 위치, W/O 없음).
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
import { DocumentStateService } from '../src/core/document-state';
import { MaterialIssueReleaser } from '../src/core/material-issue/release-request';
import { PickingHandoverNotifier } from '../src/core/picking';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { MaterialIssueFixture } from './support/material-issue-fixture';

const PREFIX = `RNS${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';
const BASE = '/api/logistics/material-issue-requests';

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

describe('창고 보충 요청 W/O null 대응 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: MaterialIssueFixture;
  let releaser: MaterialIssueReleaser;
  let replenishmentCookie: string;
  let today: string;
  let material: Place;
  let production: Place;
  let otherMaterial: Place;
  let workOrderRequestId: bigint;
  const tokens: Record<string, string> = {};
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    releaser = new MaterialIssueReleaser(app.get(DocumentStateService), app.get(PickingHandoverNotifier));
    fx = new MaterialIssueFixture(app, prisma, PREFIX);
    await fx.setup();
    fx.ids.p1 = await fx.plant('P1', HANOI);
    fx.ids.p2 = await fx.plant('P2', HANOI);
    today = localDate(new Date(), HANOI);

    material = await fx.warehouse(fx.ids.p1, 'MAT');
    production = await fx.warehouse(fx.ids.p1, 'PROD');
    otherMaterial = await fx.warehouse(fx.ids.p2, 'MAT2');
    await fx.stock(material, 'X', 500);
    await fx.stock(otherMaterial, 'X', 500);
    await fx.stock(production, 'X', 100);
    const lineId = await fx.line('P1', 'L', await fx.department('D', [production.warehouseId]));
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId, operation: 'X20', productionDate: fx.nextWeekday('P1', 1) });
    await fx.release(workOrderId).expect(200);
    [{ material_issue_request_id: workOrderRequestId }] = await fx.requests(workOrderId);

    // W-02-12 만 가진 역할(FR-037).
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-U12`, user_name: '보충만', status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-R12`, role_name: '보충만' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-02-12' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const jwt = app.get(JwtService);
    replenishmentCookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
    for (const [key, plantId] of [['T1', fx.ids.p1], ['T2', fx.ids.p2]] as const) {
      const terminal = await prisma.terminal.create({
        data: { terminal_code: `${PREFIX}-${key}`, plant_id: plantId, terminal_type_code: 'MOBILE', status_code: 'RUNNING' },
      });
      tokens[key] = jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(plantId) });
    }
  });

  afterAll(async () => {
    const mine = { issue_request_no: { startsWith: `${PREFIX}-R` } };
    const pickings = await prisma.picking_order.findMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } }, select: { picking_order_id: true } });
    const events = await prisma.notification_event.findMany({
      where: { aggregate_type_code: 'PICKING_ORDER', aggregate_id: { in: pickings.map((p) => p.picking_order_id) } },
      select: { notification_event_id: true },
    });
    const eventIds = events.map((e) => e.notification_event_id);
    await prisma.zalo_delivery.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    await prisma.notification.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    await prisma.notification_event.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    await prisma.audit_event.deleteMany({ where: { target_type_code: 'MATERIAL_ISSUE_REQUEST', performed_by: { in: [fx.ids.user] } } });
    const requests = await prisma.material_issue_request.findMany({ where: mine, select: { material_issue_request_id: true } });
    await prisma.audit_event.deleteMany({
      where: { target_type_code: 'MATERIAL_ISSUE_REQUEST', target_id: { in: requests.map((r) => r.material_issue_request_id) } },
    });
    await prisma.picking_line.deleteMany({ where: { picking_order: { warehouse: { warehouse_code: { startsWith: PREFIX } } } } });
    await prisma.picking_order.deleteMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } } });
    await prisma.material_issue_request_line.deleteMany({ where: { material_issue_request: mine } });
    await prisma.material_issue_request.deleteMany({ where: mine });
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await fx.cleanup();
    await app.close();
  });

  /** 창고 보충 요청 한 건(한 줄). 배포 상태면 피킹 없이 둔다 — 피킹이 필요한 시험은 대기로 넣고 배포한다. */
  async function replenishment(input: { status?: string; origin?: string; qty?: number; source?: Place; destination?: Place } = {}) {
    const status = input.status ?? 'REGISTERED';
    const row = await prisma.material_issue_request.create({
      data: {
        issue_request_no: `${PREFIX}-R${++seq}`,
        request_type_code: 'REPLENISHMENT',
        replenishment_origin_code: input.origin ?? 'DIRECT',
        source_warehouse_id: (input.source ?? material).warehouseId,
        destination_location_id: (input.destination ?? production).locationId,
        status_code: status,
        issue_work_date: new Date(`${today}T00:00:00.000Z`),
        released_at: status === 'REGISTERED' ? new Date() : null,
        material_issue_request_line: {
          create: [{ line_no: 1, item_id: fx.items.X, requested_qty: input.qty ?? 30, uom_id: fx.ids.uom }],
        },
      },
    });
    return row;
  }

  const get = (path: string, query: object = {}, cookie = fx.cookie) =>
    request(app.getHttpServer()).get(path).query(query).set('Cookie', cookie);
  const idsOf = (body: { items: { materialIssueRequestId: number }[] }) => body.items.map((i) => i.materialIssueRequestId);

  it('R2-1 목록 기본은 W/O 요청만, REPLENISHMENT 면 보충 행이 W/O 칸 null 로 보이고 공장은 출발 창고 공장으로 거른다', async () => {
    const mine = await replenishment();
    const elsewhere = await replenishment({ source: otherMaterial });

    const plain = await get(BASE, { plantId: Number(fx.ids.p1), size: 100 }).expect(200);
    expect(idsOf(plain.body)).toContain(Number(workOrderRequestId));
    expect(idsOf(plain.body)).not.toContain(Number(mine.material_issue_request_id));

    const listed = await get(BASE, { plantId: Number(fx.ids.p1), requestTypeCode: 'REPLENISHMENT', size: 100 }).expect(200);
    expect(validator('/logistics/material-issue-requests', 'get', 200)(listed.body)).toBe(true);
    expect(idsOf(listed.body)).toContain(Number(mine.material_issue_request_id));
    expect(idsOf(listed.body)).not.toContain(Number(elsewhere.material_issue_request_id));
    expect(idsOf(listed.body)).not.toContain(Number(workOrderRequestId));
    expect(listed.body.items.find((i: { materialIssueRequestId: number }) => i.materialIssueRequestId === Number(mine.material_issue_request_id))).toMatchObject({
      requestTypeCode: 'REPLENISHMENT',
      replenishmentOriginCode: 'DIRECT',
      workOrderId: null,
      workOrderNo: null,
      productionPlanId: null,
      productionPlanNo: null,
      productionDate: null,
      sourceWarehouseId: Number(material.warehouseId),
      destinationWarehouseId: Number(production.warehouseId),
      destinationWarehouseName: 'PROD',
      closeReasonDetailCode: null,
      closeRemark: null,
      closedBy: null,
      displayStatus: 'RELEASED',
    });
    const other = await get(BASE, { plantId: Number(fx.ids.p2), requestTypeCode: 'REPLENISHMENT', size: 100 }).expect(200);
    expect(idsOf(other.body)).toEqual([Number(elsewhere.material_issue_request_id)]);

    // 새 조건 셋 — 구분·입고 창고·품목.
    const filtered = (query: object) => get(BASE, { requestTypeCode: 'REPLENISHMENT', size: 100, ...query }).expect(200).then((r) => idsOf(r.body));
    expect(await filtered({ replenishmentOriginCode: 'AUTO', plantId: Number(fx.ids.p1) })).not.toContain(Number(mine.material_issue_request_id));
    expect(await filtered({ destinationWarehouseId: Number(production.warehouseId) })).toContain(Number(mine.material_issue_request_id));
    expect(await filtered({ destinationWarehouseId: Number(material.warehouseId) })).toEqual([]);
    expect(await filtered({ itemId: Number(fx.items.Y), plantId: Number(fx.ids.p1) })).toEqual([]);
    // W/O 요청의 새 칸 — 유형만 있고 나머지는 null.
    expect(plain.body.items.find((i: { materialIssueRequestId: number }) => i.materialIssueRequestId === Number(workOrderRequestId))).toMatchObject({
      requestTypeCode: 'WORK_ORDER',
      replenishmentOriginCode: null,
      destinationWarehouseName: 'P1-WIP',
    });
  });

  it('R2-2 상세·출고 예정 조회가 보충 행을 포함해 깨지지 않는다', async () => {
    const row = await replenishment({ qty: 40 });
    const detail = await get(`${BASE}/${row.material_issue_request_id}`).expect(200);
    expect(validator('/logistics/material-issue-requests/{materialIssueRequestId}', 'get', 200)(detail.body)).toBe(true);
    expect(detail.body.materialIssueRequest).toMatchObject({ workOrderId: null, workOrderNo: null, requestTypeCode: 'REPLENISHMENT' });
    expect(detail.body.lines).toHaveLength(1);

    const planned = await get(`${BASE}/planned-stock`, { plantId: Number(fx.ids.p1), sourceWarehouseId: Number(material.warehouseId) }).expect(200);
    expect(validator('/logistics/material-issue-requests/planned-stock', 'get', 200)(planned.body)).toBe(true);
    const [stock] = planned.body.items;
    expect(stock).toMatchObject({ sourceWarehouseId: Number(material.warehouseId), itemId: Number(fx.items.X) });
    expect(stock.requests).toContainEqual(
      expect.objectContaining({
        materialIssueRequestId: Number(row.material_issue_request_id),
        issueRequestNo: row.issue_request_no,
        requestTypeCode: 'REPLENISHMENT',
        workOrderId: null,
        workOrderNo: null,
        plannedQty: 40,
      }),
    );
  });

  it('R2-3 FR-037 보충 요청 수정은 409, 취소는 W-02-12 로만 — W-02-12 만 가진 역할로 예정·목록·상세가 된다', async () => {
    const row = await replenishment();
    const put = await request(app.getHttpServer())
      .put(`${BASE}/${row.material_issue_request_id}`)
      .set('Cookie', fx.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ versionNo: row.version_no, lines: [{ materialIssueRequestLineId: 1, requestedQty: 10 }] })
      .expect(409);
    expect(put.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', message: '창고 보충 요청은 고칠 수 없습니다. 취소하고 다시 요청하세요.' });

    const cancel = (id: bigint, cookie: string, versionNo: number) =>
      request(app.getHttpServer()).post(`${BASE}/${id}:cancel`).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({ versionNo });
    // W-02-11 만 있으면 보충 요청을 취소하지 못하고, W-02-12 만 있으면 W/O 요청을 취소하지 못한다.
    await cancel(row.material_issue_request_id, fx.cookie, row.version_no).expect(403);
    const wo = await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: workOrderRequestId } });
    await cancel(workOrderRequestId, replenishmentCookie, wo.version_no).expect(403);

    await get(`${BASE}/planned-stock`, { plantId: Number(fx.ids.p1) }, replenishmentCookie).expect(200);
    const listed = await get(BASE, { requestTypeCode: 'REPLENISHMENT', plantId: Number(fx.ids.p1), size: 100 }, replenishmentCookie).expect(200);
    expect(idsOf(listed.body)).toContain(Number(row.material_issue_request_id));
    await get(`${BASE}/${row.material_issue_request_id}`, {}, replenishmentCookie).expect(200);

    const done = await cancel(row.material_issue_request_id, replenishmentCookie, row.version_no).expect(200);
    expect(done.body.materialIssueRequest).toMatchObject({ statusCode: 'CANCELLED', displayStatus: 'CANCELLED', workOrderId: null });
  });

  it('R4-1 보충 요청 배포 — 담당자 없는 피킹 지시와 인계 알림이 한 번 생기고 W/O 자리에 요청 번호가 실린다', async () => {
    const row = await replenishment({ status: 'WAITING', qty: 25 });
    const release = () =>
      prisma.$transaction((tx) => releaser.release(tx, row.material_issue_request_id, `${PREFIX}-PK${++seq}`, null));
    expect(await release()).toBe(true);
    expect(await release()).toBe(false);

    const [picking] = await fx.pickings(row.material_issue_request_id);
    expect(picking).toMatchObject({ warehouse_id: material.warehouseId, assigned_worker_id: null, status_code: 'REGISTERED' });
    const events = await prisma.notification_event.findMany({
      where: { event_type_code: 'MATERIAL_PICKING_REQUESTED', aggregate_type_code: 'PICKING_ORDER', aggregate_id: picking.picking_order_id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ picking_no: picking.picking_order_no, wo_no: row.issue_request_no, item_count: 1 });
    const after = await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: row.material_issue_request_id } });
    expect(after.status_code).toBe('REGISTERED');
  });

  it('R2-4 단말 범위·작업 수가 보충 요청을 출발 창고 공장으로 본다', async () => {
    const counts = async (key: string) =>
      (await request(app.getHttpServer()).get('/api/app/terminal-work-counts').set('Authorization', `Bearer ${tokens[key]}`).expect(200)).body;
    const before = { t1: await counts('T1'), t2: await counts('T2') };
    const row = await replenishment({ status: 'WAITING', qty: 5 });
    await prisma.$transaction((tx) => releaser.release(tx, row.material_issue_request_id, `${PREFIX}-PK${++seq}`, null));
    expect((await counts('T1')).materialPicking).toBe(before.t1.materialPicking + 1);
    expect((await counts('T2')).materialPicking).toBe(before.t2.materialPicking);

    // 단말 범위 밖은 401 이다(`terminal-logistics-scope.ts` denied).
    const detail = (key: string, id: bigint) =>
      request(app.getHttpServer()).get(`${BASE}/${id}`).set('Authorization', `Bearer ${tokens[key]}`);
    await detail('T1', row.material_issue_request_id).expect(200);
    await detail('T2', row.material_issue_request_id).expect(401);
    const p2 = await replenishment({ source: otherMaterial });
    await detail('T2', p2.material_issue_request_id).expect(200);
    await detail('T1', p2.material_issue_request_id).expect(401);
  });

  it('R2-5 부서 생산 창고 해제 미리보기의 활성 요청 수에 그 창고로 들어오는 활성 보충 요청이 든다(해제는 막지 않는다)', async () => {
    const target = await fx.warehouse(fx.ids.p1, 'PROD2');
    const department = await fx.department('D2', [target.warehouseId]);
    await replenishment({ destination: target });
    await replenishment({ destination: target, status: 'CANCELLED' });
    const preview = await request(app.getHttpServer())
      .put(`/api/mdm/departments/${department}/production-warehouses?dryRun=true`)
      .set('Cookie', fx.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ warehouseIds: [] })
      .expect(200);
    expect(preview.body.removed).toEqual([{ warehouseId: Number(target.warehouseId), activeRequestCount: 1 }]);
  });
  it('R2-1 출고 예정 조회 requestTypeCode — 그 유형 요청만 싣고 없는 행은 빼며, 부족 계산은 전 유형(W-02-11 부족 탭)', async () => {
    // 생산 창고 X 100 에 W/O 예정 20 + 보충(출발 = 생산 창고) 예정 200 → 부족 120.
    await replenishment({ source: production, destination: material, qty: 200 });
    const planned = (query: object) =>
      get(`${BASE}/planned-stock`, { plantId: Number(fx.ids.p1), sourceWarehouseId: Number(production.warehouseId), onlyShortage: true, ...query }).expect(200);
    const all = await planned({});
    expect(all.body.items[0].requests.map((r: { requestTypeCode: string }) => r.requestTypeCode).sort()).toEqual(['REPLENISHMENT', 'WORK_ORDER']);
    const wo = await planned({ requestTypeCode: 'WORK_ORDER' });
    expect(wo.body.items).toHaveLength(1);
    expect(wo.body.items[0]).toMatchObject({ plannedQty: 220, shortageQty: all.body.items[0].shortageQty });
    expect(wo.body.items[0].requests).toEqual([expect.objectContaining({ materialIssueRequestId: Number(workOrderRequestId), requestTypeCode: 'WORK_ORDER' })]);
    // 자재 창고는 보충 요청만 잡고 있다 — W/O 로 거르면 행이 없다.
    const onlyReplenishment = await get(`${BASE}/planned-stock`, { plantId: Number(fx.ids.p1), sourceWarehouseId: Number(material.warehouseId), requestTypeCode: 'WORK_ORDER' }).expect(200);
    expect(onlyReplenishment.body.items).toEqual([]);
  });

  it('FR-037 이력 — W-02-12 만 가진 역할은 보충 요청 이력 200·W/O 요청 이력 403, W-02-11 만이면 보충 요청 이력 403', async () => {
    const row = await replenishment();
    const history = (id: bigint, cookie: string) => get(`${BASE}/${id}/history`, {}, cookie);
    await history(row.material_issue_request_id, replenishmentCookie).expect(200);
    await history(workOrderRequestId, replenishmentCookie).expect(403);
    await history(row.material_issue_request_id, fx.cookie).expect(403);
    await history(workOrderRequestId, fx.cookie).expect(200);
  });
});
