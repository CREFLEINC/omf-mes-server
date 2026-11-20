/**
 * 피처 012 출하 지시서 사업부 단위·줄별 출고 창고(omf-all-around#338) (e2e).
 *
 * 시험 이름 앞의 ID 는 `specs/012-shipment-bu-warehouse/verification.md`·`quickstart.md` 의 항목이다.
 * 바탕(사업부 X: P1·P2, 사업부 Y: P3, 사업부 없는 P0, 계정·단말)은 `support/shipment-bu-warehouse-fixture.ts` 가 만든다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { NumberingService } from '../src/core/numbering';
import { goodsIssueBuilder } from '../src/integration/erp/send/goods-issue.send';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedRoute } from './approval-request.fixture';
import { ShipmentBuWarehouseFixture, TerminalKey } from './support/shipment-bu-warehouse-fixture';

interface WarehouseBody { warehouseId: number; warehouseCode: string; warehouseName: string; plantId: number; plantName: string }
interface RequestBody {
  shipmentRequestId: number;
  businessUnitId: number | null;
  businessUnit: { businessUnitId: number; businessUnitCode: string; businessUnitName: string } | null;
  fulfillmentPlantId: number | null;
  warehouses: WarehouseBody[];
  lines: { shipmentRequestLineId: number; warehouse: WarehouseBody | null }[];
}

describe('피처 012 출하 지시서 사업부·줄 출고 창고 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let f: ShipmentBuWarehouseFixture;
  /** POP 완료 시험이 만든 출하 — #331 목록·취소 시험이 이어 쓴다. */
  let completed: { requestId: number; shipmentId: number };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    f = new ShipmentBuWarehouseFixture(app, prisma);
    await f.setup();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const fields = (response: { body: { errors: { field?: string }[] } }) => response.body.errors.map((error) => error.field);
  const list = async (account: 'X' | 'XY' | 'P1' | 'ALL', query: Record<string, unknown> = {}) =>
    (await f.asSession(f.http().get('/api/logistics/shipment-requests'), account)
      .query({ shipDateFrom: '2026-11-20', shipDateTo: '2026-11-20', size: 100, ...query }).expect(200)).body as { items: RequestBody[] };
  const detail = (id: number, account: 'X' | 'XY' | 'P1' | 'ALL' = 'X') =>
    f.asSession(f.http().get(`/api/logistics/shipment-requests/${id}`), account);

  describe('생성(W-04-01) — 사업부·줄 출고 창고', () => {
    it('US1-2 businessUnitId 가 없으면 422 businessUnitId', async () => {
      const response = await f.create(f.body([{ allocated: 10 }], { businessUnitId: undefined })).expect(422);
      expect(fields(response)).toEqual(['businessUnitId']);
    });

    it('D-1 fulfillmentPlantId 를 보내면 400 fulfillmentPlantId', async () => {
      const response = await f.create(f.body([{ allocated: 10 }], { fulfillmentPlantId: Number(f.plant.P1) })).expect(400);
      expect(fields(response)).toContain('fulfillmentPlantId');
    });

    it('US1-6 줄 warehouseId 가 없으면 422 lines[n].warehouseId', async () => {
      const response = await f.create(f.body([{ allocated: 10, warehouse: 'A' }, { allocated: 5, warehouse: null }])).expect(422);
      expect(fields(response)).toEqual(['lines[1].warehouseId']);
    });

    it('US1-3 다른 사업부·불량창고·비활성 창고는 422 lines[n].warehouseId', async () => {
      const response = await f.create(f.body([
        { allocated: 1, warehouse: 'A' }, { allocated: 1, warehouse: 'Y1' }, { allocated: 1, warehouse: 'D' }, { allocated: 1, warehouse: 'Z' },
      ]), 'ALL').expect(422);
      expect(fields(response)).toEqual(['lines[1].warehouseId', 'lines[2].warehouseId', 'lines[3].warehouseId']);
    });

    it('US1-3 계정 범위 밖 사업부는 403, 공장만 범위 계정이 다른 공장 창고를 고르면 403', async () => {
      await f.create(f.body([{ allocated: 1, warehouse: 'Y1' }], { businessUnitId: Number(f.unit.Y) }), 'X').expect(403);
      const response = await f.create(f.body([{ allocated: 1, warehouse: 'A' }, { allocated: 1, warehouse: 'B' }]), 'P1').expect(403);
      expect(fields(response)).toEqual(['lines[1].warehouseId']);
    });

    it('US1-5·Q4 같은 S/O 줄을 A 60·B 40 으로 나누면 성공, 70·40 은 422 lines[n].allocatedQty 「S/O 잔여 수량을 넘습니다」', async () => {
      const order = await f.salesOrder([{ ordered: 120, shipped: 20 }]);
      const split = (a: number, b: number) => f.body([
        { allocated: a, warehouse: 'A', salesOrderLineId: order.lineIds[0] }, { allocated: b, warehouse: 'B', salesOrderLineId: order.lineIds[0] },
      ], { salesOrderId: order.salesOrderId });
      const ok = await f.create(split(60, 40)).expect(201);
      expect((ok.body as RequestBody).lines.map((line) => line.warehouse?.warehouseId)).toEqual([Number(f.warehouse.A), Number(f.warehouse.B)]);
      const over = await f.create(split(70, 40)).expect(422);
      expect(over.body.errors).toEqual([
        expect.objectContaining({ field: 'lines[0].allocatedQty', message: 'S/O 잔여 수량을 넘습니다.' }),
        expect.objectContaining({ field: 'lines[1].allocatedQty', message: 'S/O 잔여 수량을 넘습니다.' }),
      ]);
    });

    it('D-1·D-2 새 지시서는 사업부·줄 창고를 저장하고 이행 공장은 비운다, 품목이 두 창고로 나뉘어도 OQC 의뢰는 지시서 × 품목 하나', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'A' }, { allocated: 5, warehouse: 'B' }]);
      const stored = await prisma.shipment_request.findUniqueOrThrow({
        where: { shipment_request_id: BigInt(made.requestId) }, include: { shipment_request_line: { orderBy: { line_no: 'asc' } } },
      });
      expect(stored).toMatchObject({ business_unit_id: f.unit.X, fulfillment_plant_id: null });
      expect(stored.shipment_request_line.map((line) => line.warehouse_id)).toEqual([f.warehouse.A, f.warehouse.B]);
      expect(await prisma.inspection_request.count({
        where: { inspection_type_code: 'OQC', target_type_code: 'SHIPMENT_REQUEST', target_id: BigInt(made.requestId) },
      })).toBe(1);
    });

    it('D-1 공장 지정 PUT 은 경로째 없다(404)', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'A' }]);
      await f.asSession(f.http().put(`/api/logistics/shipment-requests/${made.requestId}`), 'ALL')
        .set('Idempotency-Key', randomUUID()).set('If-Match', '1').send({ fulfillmentPlantId: Number(f.plant.P1) }).expect(404);
    });

    it('FR-016 피킹 인계 알림(T4)은 줄 출고 창고의 공장마다 하나 — 공장 둘이면 둘', async () => {
      const one = await f.made([{ allocated: 10, warehouse: 'A' }, { allocated: 5, warehouse: 'C' }]);
      const two = await f.made([{ allocated: 10, warehouse: 'A' }, { allocated: 5, warehouse: 'B' }]);
      const count = (id: number) => prisma.notification_event.count({
        where: { event_type_code: 'SHIPMENT_PICKING_REQUESTED', aggregate_type_code: 'SHIPMENT_REQUEST', aggregate_id: BigInt(id) },
      });
      expect(await count(one.requestId)).toBe(1);
      expect(await count(two.requestId)).toBe(2);
    });
  });

  describe('조회(W-04-02) — 계정 사업부 범위·사업부·줄 창고', () => {
    let inX: number;
    let inY: number;
    let legacyP1: number;
    let legacyP0: number;

    beforeAll(async () => {
      inX = (await f.made([{ allocated: 10, warehouse: 'A' }, { allocated: 5, warehouse: 'B' }, { allocated: 3, warehouse: 'A' }])).requestId;
      inY = (await f.made([{ allocated: 10, warehouse: 'Y1' }], { businessUnitId: Number(f.unit.Y) })).requestId;
      legacyP1 = (await f.legacy('P1', [{ allocated: 10 }])).requestId;
      legacyP0 = (await f.legacy('P0', [{ allocated: 10 }])).requestId;
    });

    it('FR-008·D-12 범위 X 계정은 Y 지시서를 목록에서 못 보고 상세는 404, 범위 X·Y·범위 없는 계정은 둘 다', async () => {
      const ids = (body: { items: RequestBody[] }) => body.items.map((item) => item.shipmentRequestId);
      const x = ids(await list('X'));
      expect(x).toEqual(expect.arrayContaining([inX, legacyP1]));
      expect(x).not.toContain(inY);
      await detail(inY, 'X').expect(404);
      await detail(inX, 'X').expect(200);
      expect(ids(await list('XY'))).toEqual(expect.arrayContaining([inX, inY]));
      expect(ids(await list('ALL'))).toEqual(expect.arrayContaining([inX, inY, legacyP1, legacyP0]));
    });

    it('Edge-scope 공장만 범위(P1) 계정은 그 공장 사업부의 지시서와 그 공장 옛 지시서를 본다, 사업부 없는 다른 공장 옛 지시서는 못 본다', async () => {
      const ids = (await list('P1')).items.map((item) => item.shipmentRequestId);
      expect(ids).toEqual(expect.arrayContaining([inX, legacyP1]));
      expect(ids).not.toContain(inY);
      expect(ids).not.toContain(legacyP0);
      await detail(legacyP0, 'P1').expect(404);
    });

    it('FR-007 조건 businessUnitId 로 거르고, 요약도 같은 기준이다', async () => {
      const onlyY = (await list('ALL', { businessUnitId: Number(f.unit.Y) })).items;
      expect(onlyY.map((item) => item.shipmentRequestId)).toContain(inY);
      expect(onlyY.every((item) => item.businessUnitId === Number(f.unit.Y))).toBe(true);
      const summary = await f.asSession(f.http().get('/api/logistics/shipment-requests/summary'), 'ALL')
        .query({ shipDateFrom: '2026-11-20', shipDateTo: '2026-11-20', businessUnitId: Number(f.unit.Y) }).expect(200);
      expect(summary.body.requestCount).toBe(onlyY.length);
    });

    it('FR-007 행에 사업부·줄 창고 요약(겹침 없이 줄 순서, 공장 이름), 상세 줄에 창고(공장)', async () => {
      const row = (await list('X')).items.find((item) => item.shipmentRequestId === inX) as RequestBody;
      expect(row.businessUnit).toEqual({ businessUnitId: Number(f.unit.X), businessUnitCode: 'BWE2E-BUX', businessUnitName: '사업부X' });
      expect(row.fulfillmentPlantId).toBeNull();
      expect(row.warehouses).toEqual([
        { warehouseId: Number(f.warehouse.A), warehouseCode: 'BWE2E-A', warehouseName: '완제품창고A', plantId: Number(f.plant.P1), plantName: 'P1공장' },
        { warehouseId: Number(f.warehouse.B), warehouseCode: 'BWE2E-B', warehouseName: '완제품창고B', plantId: Number(f.plant.P2), plantName: 'P2공장' },
      ]);
      const body = (await detail(inX).expect(200)).body as RequestBody;
      expect(body.lines.map((line) => line.warehouse?.plantName)).toEqual(['P1공장', 'P2공장', 'P1공장']);
    });

    it('US6-1 옛 지시서는 이행 공장·채운 사업부를 싣고 줄 창고는 null(창고 미지정), US6-3 사업부 없는 공장의 옛 지시서는 사업부 null', async () => {
      const old = (await detail(legacyP1, 'ALL').expect(200)).body as RequestBody;
      expect(old).toMatchObject({ fulfillmentPlantId: Number(f.plant.P1), businessUnitId: Number(f.unit.X), warehouses: [] });
      expect(old.lines.map((line) => line.warehouse)).toEqual([null]);
      const orphan = (await detail(legacyP0, 'ALL').expect(200)).body as RequestBody;
      expect(orphan).toMatchObject({ fulfillmentPlantId: Number(f.plant.P0), businessUnitId: null, businessUnit: null });
    });
  });

  describe('출하 예정 목록(W-04-02)이 출하 내역의 일을 받는다 — ERP 송신·출하 칸·권한', () => {
    const SHIP_DAY = { shipDateFrom: '2026-11-20', shipDateTo: '2026-11-20' };
    let pending: { requestId: number; shipmentNo: string; shipmentId: number };
    let noSo: number;
    let mixed: { requestId: number; olderId: number; newerId: number };
    let none: number;
    let w0412: string[];
    let w0402: string[];

    /** 출하 행만 직접(옛 흐름 모양 — 창고 있는 출하) — 송신 상태 판정(010 한 벌)의 입력을 고른다. 완료 흐름은 S4 의 e2e 가 본다. */
    const shipment = async (requestId: number, statusCode: string): Promise<{ shipmentId: number; shipmentNo: string }> => {
      const shipmentNo = `${f.run}-SH-${randomUUID().slice(0, 8)}`;
      const row = await prisma.shipment.create({ data: {
        shipment_no: shipmentNo, shipment_request_id: BigInt(requestId), warehouse_id: f.warehouse.A, status_code: statusCode,
      } });
      return { shipmentId: Number(row.shipment_id), shipmentNo };
    };

    beforeAll(async () => {
      // 미확정(옛 흐름 미확정 출하) → NOT_QUEUED · 수주 줄 없는 확정 → NOT_SENT_NO_SALES_ORDER · 출하 없음 → NO_SHIPMENT.
      const a = await f.made([{ allocated: 10, warehouse: 'A' }]);
      pending = { requestId: a.requestId, ...(await shipment(a.requestId, 'UNCONFIRMED')) };
      noSo = (await f.made([{ allocated: 10, warehouse: 'A' }])).requestId;
      await shipment(noSo, 'CONFIRMED');
      // 대표 출하 = 취소 안 된 것 중 최신 — 더 최근의 취소 출하가 있어도 미확정 출하가 대표다.
      const m = await f.made([{ allocated: 10, warehouse: 'B' }]);
      const older = await shipment(m.requestId, 'UNCONFIRMED');
      const newer = await shipment(m.requestId, 'CANCELLED');
      mixed = { requestId: m.requestId, olderId: older.shipmentId, newerId: newer.shipmentId };
      none = (await f.made([{ allocated: 10, warehouse: 'A' }])).requestId;
      w0412 = await f.account('e2e-bw-w0412', [{ unit: f.unit.X }], ['W-04-12']);
      w0402 = await f.account('e2e-bw-w0402', [{ unit: f.unit.X }], ['W-04-02']);
    });

    const listed = async (query: Record<string, unknown>) =>
      (await f.asSession(f.http().get('/api/logistics/shipment-requests'), 'ALL').query({ ...SHIP_DAY, size: 200, ...query }).expect(200)).body as {
        items: (RequestBody & { erpSendStatus: string | null })[]; erpSendStatusCounts: Record<string, number>;
      };

    it('US4-1·FR-018 erpSendStatus 로 거르고(010 6값 + NO_SHIPMENT), 행 erpSendStatus 는 대표 출하의 송신 상태(출하 없으면 null)', async () => {
      const notQueued = (await listed({ erpSendStatus: 'NOT_QUEUED' })).items;
      expect(notQueued.map((row) => row.shipmentRequestId)).toEqual(expect.arrayContaining([pending.requestId, mixed.requestId]));
      expect(notQueued.every((row) => row.erpSendStatus === 'NOT_QUEUED')).toBe(true);
      expect((await listed({ erpSendStatus: 'NOT_SENT_NO_SALES_ORDER' })).items.map((row) => row.shipmentRequestId)).toContain(noSo);
      const without = (await listed({ erpSendStatus: 'NO_SHIPMENT' })).items;
      expect(without.map((row) => row.shipmentRequestId)).toContain(none);
      expect(without.find((row) => row.shipmentRequestId === none)?.erpSendStatus).toBeNull();
      await f.asSession(f.http().get('/api/logistics/shipment-requests'), 'ALL').query({ ...SHIP_DAY, erpSendStatus: 'WHATEVER' }).expect(400);
    });

    it('US4-1·빈 곳 ② erpSendStatusCounts 는 송신 상태 조건만 뺀 같은 조건으로 센다 — 칩 건수 = 그 칩으로 거른 목록 수', async () => {
      const { erpSendStatusCounts: counts } = await listed({ erpSendStatus: 'SENT', businessUnitId: Number(f.unit.X) });
      for (const status of ['NOT_QUEUED', 'NOT_SENT_NO_SALES_ORDER', 'NO_SHIPMENT']) {
        const filtered = await listed({ erpSendStatus: status, businessUnitId: Number(f.unit.X) });
        expect(counts[status]).toBe(filtered.items.length);
      }
      expect(counts.NOT_QUEUED).toBeGreaterThanOrEqual(2);
    });

    it('Q13-q·빈 곳 ⑧ 검색어 q 가 출하 번호로도 지시서를 찾는다', async () => {
      const found = (await listed({ q: pending.shipmentNo })).items.map((row) => row.shipmentRequestId);
      expect(found).toEqual([pending.requestId]);
    });

    it('US4-2·FR-019 상세 shipments[] 는 취소 포함 최신순이고 출하 번호·상태·송신 상태·취소 상신 중을 싣는다', async () => {
      const body = (await detail(mixed.requestId, 'ALL').expect(200)).body as { erpSendStatus: string; shipments: Record<string, unknown>[] };
      expect(body.shipments.map((row) => row.shipmentId)).toEqual([mixed.newerId, mixed.olderId]);
      expect(body.shipments[0]).toMatchObject({ statusCode: 'CANCELLED', cancelRequestPending: false });
      expect(body.shipments[1]).toMatchObject({ statusCode: 'UNCONFIRMED', erpSendStatus: 'NOT_QUEUED', cancelRequestPending: false });
      expect(body.erpSendStatus).toBe('NOT_QUEUED');
    });

    it('US5-5·FR-024·SC-004 W-04-12 만 가진 역할이 W-04-02 가 부르는 조회 넷을 읽고, 확정·취소 요청·실행 권한 게이트를 지난다', async () => {
      await f.http().get('/api/logistics/shipment-requests').query(SHIP_DAY).set('Cookie', w0412).expect(200);
      await f.http().get(`/api/logistics/shipment-requests/${pending.requestId}`).set('Cookie', w0412).expect(200);
      await f.http().get('/api/logistics/shipments').query(SHIP_DAY).set('Cookie', w0412).expect(200);
      await f.http().get(`/api/logistics/shipments/${pending.shipmentId}`).set('Cookie', w0412).expect(200);
      for (const action of [':confirm', ':request-cancel', ':cancel']) {
        const post = (cookie: string[]) => f.http().post(`/api/logistics/shipments/${pending.shipmentId}${action}`)
          .set('Cookie', cookie).set('Idempotency-Key', randomUUID()).set('If-Match', '1').send({});
        // W-04-02 만으로는 403(보기 전용 역할이 취소·확정을 얻지 않는다 — R-6), W-04-12 는 게이트를 지나 업무 판정까지 간다.
        await post(w0402).expect(403);
        expect((await post(w0412)).status).not.toBe(403);
      }
    });

    it('D-13 새 지시서(공장 없음)로 긴급 직행 출하를 등록하면 지금처럼 400 「이행 공장이 지정되지 않은」 — 긴급 직행은 고치지 않는다', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'A' }]);
      const lot = await f.lot([{ warehouse: 'A', qty: 5 }]);
      const response = await f.asSession(f.http().post('/api/logistics/shipments'), 'ALL').set('Idempotency-Key', randomUUID()).send({
        shipmentRequestId: made.requestId, warehouseId: Number(f.warehouse.A), expedited: true, expediteReason: '시험', businessDate: '2026-11-20',
        occurredAt: '2026-11-20T03:00:00.000Z',
        lines: [{ shipmentRequestLineId: made.lineIds[0], shippedQty: 1, uomId: Number(f.uom), allocations: [{ lotId: lot.lotId, allocatedQty: 1, uomId: Number(f.uom) }] }],
      });
      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'shipmentRequestId', message: '이행 공장이 지정되지 않은 출하작업지시입니다.' }),
      ]));
    });

    it('US5-1·SC-004 W-04-12 권한으로 미확정 출하(수주 있음)를 :confirm 하면 확정·ERP 송신 대기(PENDING)가 되고 erpSendStatusCounts 「확정 전」이 1 준다', async () => {
      const order = await f.salesOrder([{ ordered: 10 }]);
      const made = await f.made([{ allocated: 10, warehouse: 'A', salesOrderLineId: order.lineIds[0] }], { salesOrderId: order.salesOrderId });
      const unconfirmed = await shipment(made.requestId, 'UNCONFIRMED');
      await prisma.shipment.update({ where: { shipment_id: BigInt(unconfirmed.shipmentId) }, data: { shipped_at: new Date('2026-11-20T03:00:00.000Z') } });
      await prisma.shipment_line.create({ data: {
        shipment_id: BigInt(unconfirmed.shipmentId), line_no: 1, shipment_request_line_id: BigInt(made.lineIds[0]), item_id: f.item.FG, shipped_qty: 10, uom_id: f.uom,
      } });
      const scope = { businessUnitId: Number(f.unit.X) };
      const before = (await listed(scope)).erpSendStatusCounts;
      expect((await detail(made.requestId, 'ALL').expect(200)).body.erpSendStatus).toBe('NOT_QUEUED');

      const etag = (await f.http().get(`/api/logistics/shipments/${unconfirmed.shipmentId}`).set('Cookie', w0412).expect(200)).headers.etag as string;
      await f.http().post(`/api/logistics/shipments/${unconfirmed.shipmentId}:confirm`).set('Cookie', w0412)
        .set('Idempotency-Key', randomUUID()).set('If-Match', etag).send({}).expect(200);

      const stored = await prisma.shipment.findUniqueOrThrow({ where: { shipment_id: BigInt(unconfirmed.shipmentId) } });
      expect(stored.status_code).toBe('CONFIRMED');
      expect(await prisma.integration_message.count({ where: { target_type_code: 'SHIPMENT', target_id: BigInt(unconfirmed.shipmentId) } })).toBe(1);
      const body = (await detail(made.requestId, 'ALL').expect(200)).body as { erpSendStatus: string; shipments: Record<string, unknown>[] };
      expect(body.erpSendStatus).toBe('PENDING');
      expect(body.shipments[0]).toMatchObject({ shipmentId: unconfirmed.shipmentId, statusCode: 'CONFIRMED', erpSendStatus: 'PENDING' });
      const after = (await listed(scope)).erpSendStatusCounts;
      expect(after.NOT_QUEUED).toBe(before.NOT_QUEUED - 1);
      expect(after.PENDING ?? 0).toBe((before.PENDING ?? 0) + 1);
    });
  });

  describe('피킹(PDA) — 줄 출고 창고 LOT 만, LOT 창고로 줄을 고른다', () => {
    const pick = (made: { requestId: number; lineIds: number[] }, index: number, lotId: number, terminal: TerminalKey = 'PDA_P1') =>
      f.asTerminal(f.http().post(`/api/logistics/shipment-requests/${made.requestId}/lines/${made.lineIds[index]}:pick-lot`), terminal)
        .set('Idempotency-Key', randomUUID()).send({ lotId });
    const pdaList = async (terminal: TerminalKey) =>
      (await f.asTerminal(f.http().get('/api/logistics/shipment-requests'), terminal)
        .query({ shipDateFrom: '2026-11-20', shipDateTo: '2026-11-20', size: 200 }).expect(200)).body as {
        items: { shipmentRequestId: number; pickableLineCount: number; lines: { inTerminalScope: boolean; outOfScopeReason: string | null }[] }[];
      };
    const reservations = (lotId: number) => prisma.inventory_reservation.count({ where: { lot_id: BigInt(lotId) } });

    it('US2-1·US2-2·Q6 PDA-P1 목록에는 P1 창고 줄이 있는 지시서만 — 행 pickableLineCount, 다른 공장 줄은 OTHER_PLANT. P0 PDA 에는 안 보인다', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'A' }, { allocated: 5, warehouse: 'B' }]);
      const onlyB = await f.made([{ allocated: 5, warehouse: 'B' }]);
      const row = (await pdaList('PDA_P1')).items.find((item) => item.shipmentRequestId === made.requestId);
      expect(row?.pickableLineCount).toBe(1);
      expect(row?.lines.map((line) => [line.inTerminalScope, line.outOfScopeReason])).toEqual([[true, null], [false, 'OTHER_PLANT']]);
      expect((await pdaList('PDA_P1')).items.map((item) => item.shipmentRequestId)).not.toContain(onlyB.requestId);
      expect((await pdaList('PDA_P2')).items.map((item) => item.shipmentRequestId)).toEqual(expect.arrayContaining([made.requestId, onlyB.requestId]));
      expect((await pdaList('PDA_P0')).items.map((item) => item.shipmentRequestId)).not.toContain(made.requestId);
    });

    it('US2-6·Q8·SC-005 창고 A 지정 PDA 는 창고 A 줄이 있는 지시서만, 같은 공장 C 줄은 OTHER_WAREHOUSE', async () => {
      const ac = await f.made([{ allocated: 10, warehouse: 'A' }, { allocated: 5, warehouse: 'C' }]);
      const onlyC = await f.made([{ allocated: 5, warehouse: 'C' }]);
      const list = await pdaList('PDA_P1A');
      expect(list.items.map((item) => item.shipmentRequestId)).not.toContain(onlyC.requestId);
      expect(list.items.find((item) => item.shipmentRequestId === ac.requestId)?.lines.map((line) => line.outOfScopeReason)).toEqual([null, 'OTHER_WAREHOUSE']);
    });

    it('US2-3·Q7 창고 A 의 LOT 은 줄1 에 통째로 피킹된다', async () => {
      const made = await f.made([{ allocated: 100, warehouse: 'A', item: 'G' }]);
      const lot = await f.lot([{ warehouse: 'A', qty: 40 }], 'G');
      const response = await pick(made, 0, lot.lotId).expect(200);
      expect(response.body.line).toMatchObject({ shipmentRequestLineId: made.lineIds[0], pickedQty: 40 });
      expect(response.body).not.toHaveProperty('otherWarehouseQty');
    });

    it('US2-4 같은 품목 줄1(A)·줄2(C) — C 의 LOT 을 줄1 경로로 스캔해도 줄2 로 간다(응답 line 이 실제 줄)', async () => {
      const made = await f.made([{ allocated: 50, warehouse: 'A', item: 'G' }, { allocated: 50, warehouse: 'C', item: 'G' }]);
      const lot = await f.lot([{ warehouse: 'C', qty: 20 }], 'G');
      const response = await pick(made, 0, lot.lotId).expect(200);
      expect(response.body.line.shipmentRequestLineId).toBe(made.lineIds[1]);
    });

    it('US2-5·Q7 줄 창고에 없는 B 의 LOT 은 409 LOT_NOT_IN_LINE_WAREHOUSE(LOT 이 있는 창고 실음) — 예약 없음', async () => {
      const made = await f.made([{ allocated: 50, warehouse: 'A', item: 'G' }, { allocated: 50, warehouse: 'B', item: 'G' }]);
      const lot = await f.lot([{ warehouse: 'B', qty: 20 }], 'G');
      const response = await pick(made, 0, lot.lotId).expect(409);
      expect(response.body).toMatchObject({ code: 'LOT_NOT_IN_LINE_WAREHOUSE' });
      expect(response.body.warehouses).toEqual([expect.objectContaining({ warehouseId: Number(f.warehouse.B), plantName: 'P2공장' })]);
      expect(response.body.message).toContain('완제품창고B(P2공장)');
      expect(await reservations(lot.lotId)).toBe(0);
      // 그 줄 공장의 PDA 는 같은 LOT 을 피킹한다(Q9).
      await pick(made, 1, lot.lotId, 'PDA_P2').expect(200);
    });

    it('Edge-span A·C 에 걸친 LOT 은 A 몫만 잡고 otherWarehouseQty 로 C 몫을 알린다', async () => {
      const made = await f.made([{ allocated: 100, warehouse: 'A', item: 'G' }]);
      const lot = await f.lot([{ warehouse: 'A', qty: 30 }, { warehouse: 'C', qty: 20 }], 'G');
      const response = await pick(made, 0, lot.lotId).expect(200);
      expect(response.body).toMatchObject({ otherWarehouseQty: 20, line: { pickedQty: 30 } });
      const balances = await prisma.inventory_balance.findMany({ where: { lot_id: BigInt(lot.lotId) }, orderBy: { warehouse_id: 'asc' } });
      expect(balances.map((row) => [row.warehouse_id, Number(row.picked_qty)])).toEqual([[f.warehouse.A, 30], [f.warehouse.C, 0]]);
    });

    it('Edge-order·E-3 창고 맞는 줄이 모두 목표를 채웠으면 LOT_TARGET_REACHED — 다른 창고 줄이 비어 있어도', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'A', item: 'G' }, { allocated: 10, warehouse: 'C', item: 'G' }]);
      await pick(made, 0, (await f.lot([{ warehouse: 'A', qty: 15 }], 'G')).lotId).expect(200);
      const response = await pick(made, 0, (await f.lot([{ warehouse: 'A', qty: 5 }], 'G')).lotId).expect(409);
      expect(response.body.code).toBe('LOT_TARGET_REACHED');
    });

    it('Edge-unavailable·E-2 줄 출고 창고가 비활성이면 409 LINE_WAREHOUSE_UNAVAILABLE 「출고 창고를 쓸 수 없습니다」', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'C', item: 'G' }]);
      const lot = await f.lot([{ warehouse: 'C', qty: 5 }], 'G');
      await prisma.warehouse.update({ where: { warehouse_id: f.warehouse.C }, data: { is_active: false } });
      try {
        const response = await pick(made, 0, lot.lotId).expect(409);
        expect(response.body).toMatchObject({ code: 'LINE_WAREHOUSE_UNAVAILABLE' });
        expect(response.body.message).toContain('출고 창고를 쓸 수 없습니다');
      } finally {
        await prisma.warehouse.update({ where: { warehouse_id: f.warehouse.C }, data: { is_active: true } });
      }
    });

    it('US2-2 범위 밖 줄을 다른 공장 PDA 로 직접 부르면 401(단말 소유 검사)', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'A', item: 'G' }]);
      await pick(made, 0, (await f.lot([{ warehouse: 'A', qty: 5 }], 'G')).lotId, 'PDA_P2').expect(401);
    });

    it('SC-002 줄 창고가 아닌 창고의 LOT 을 차례로 스캔하면 모두 거절되고 피킹은 0건이다', async () => {
      const made = await f.made([{ allocated: 100, warehouse: 'A', item: 'G' }]);
      for (const warehouse of ['B', 'C', 'Y1'] as const) {
        const lot = await f.lot([{ warehouse, qty: 10 }], 'G');
        const response = await pick(made, 0, lot.lotId).expect(409);
        expect(response.body.code).toBe('LOT_NOT_IN_LINE_WAREHOUSE');
      }
      expect(await prisma.shipment_request_lot.count({ where: { shipment_request_line_id: BigInt(made.lineIds[0]) } })).toBe(0);
    });

    it('US6-2·US2-7·FR-027 창고 미지정 옛 줄은 P1 PDA 가 P1 의 불량 외 모든 창고 LOT 을 받고, P2 PDA 는 범위 밖으로 본다', async () => {
      const old = await f.legacy('P1', [{ item: 'G', allocated: 100 }]);
      const lot = await f.lot([{ warehouse: 'A', qty: 30 }, { warehouse: 'C', qty: 20 }], 'G');
      const response = await pick(old, 0, lot.lotId).expect(200);
      expect(response.body.line.pickedQty).toBe(50);
      expect(response.body).not.toHaveProperty('otherWarehouseQty');
      expect((await pdaList('PDA_P2')).items.map((item) => item.shipmentRequestId)).not.toContain(old.requestId);
      await pick(old, 0, (await f.lot([{ warehouse: 'A', qty: 5 }], 'G')).lotId, 'PDA_P2').expect(401);
    });
  });

  describe('POP 완료 — 사업부 안 어느 POP, 창고마다 출고 전표', () => {
    const pick = (made: { requestId: number; lineIds: number[] }, index: number, lotId: number, terminal: TerminalKey) =>
      f.asTerminal(f.http().post(`/api/logistics/shipment-requests/${made.requestId}/lines/${made.lineIds[index]}:pick-lot`), terminal)
        .set('Idempotency-Key', randomUUID()).send({ lotId }).expect(200);
    const complete = (requestId: number, terminal: TerminalKey) =>
      f.asTerminal(f.http().post(`/api/logistics/shipment-requests/${requestId}:complete`), terminal)
        .set('Idempotency-Key', randomUUID()).send({ businessDate: '2026-11-20', occurredAt: '2026-11-20T05:00:00.000Z' });
    const lookup = (requestNo: string, terminal: TerminalKey) =>
      f.asTerminal(f.http().get('/api/logistics/shipment-requests:lookup'), terminal).query({ code: `SHPREQ:${requestNo}` });

    it('US3-1·Q9 POP-P1·POP-P2 의 :lookup 이 사업부 X 지시서를 열고, POP-P3 은 403 BUSINESS_UNIT_MISMATCH(내용 없음)', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'A', item: 'G' }, { allocated: 5, warehouse: 'B', item: 'G' }]);
      const opened = (await lookup(made.requestNo, 'POP_P2').expect(200)).body;
      expect(opened.businessUnit).toMatchObject({ businessUnitCode: 'BWE2E-BUX' });
      expect(opened.lines.map((line: { warehouse: { plantName: string } }) => line.warehouse.plantName)).toEqual(['P1공장', 'P2공장']);
      await lookup(made.requestNo, 'POP_P1').expect(200);
      const denied = await lookup(made.requestNo, 'POP_P3').expect(403);
      expect(denied.body.errors).toEqual([expect.objectContaining({ code: 'BUSINESS_UNIT_MISMATCH', message: '다른 사업부의 출하 지시서입니다.' })]);
      expect(JSON.stringify(denied.body)).not.toContain(made.requestNo);
      expect(JSON.stringify(denied.body)).not.toContain('사업부X');
      const blocked = await complete(made.requestId, 'POP_P3').expect(403);
      expect(blocked.body.errors[0].code).toBe('BUSINESS_UNIT_MISMATCH');
    });

    it('US3-3·Q10 한 공장 줄만 피킹하면 「피킹 부족: 라인 2(창고 B)」로 막히고 부분 완료가 없다', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'A', item: 'G' }, { allocated: 5, warehouse: 'B', item: 'G' }]);
      await pick(made, 0, (await f.lot([{ warehouse: 'A', qty: 10 }], 'G')).lotId, 'PDA_P1');
      const response = await complete(made.requestId, 'POP_P2').expect(409);
      expect(response.body).toMatchObject({ code: 'COMPLETION_BLOCKED', blockers: [{ code: 'PICKING_SHORT', lineNo: 2, warehouseName: '완제품창고B' }] });
      expect(await prisma.shipment.count({ where: { shipment_request_id: BigInt(made.requestId) } })).toBe(0);
    });

    it('US3-2·Q11·SC-003·D-5·E-6 POP-P2 완료 — 출하 하나, 창고마다 재고 차감·출고 전표 하나(번호 축 = 창고 공장), 출하 번호 축 = POP 공장, ERP 행 PLANT_CD = 전표 창고 공장', async () => {
      const order = await f.salesOrder([{ item: 'G', ordered: 10 }, { item: 'G', ordered: 5 }]);
      const made = await f.made([
        { allocated: 10, warehouse: 'A', item: 'G', salesOrderLineId: order.lineIds[0] },
        { allocated: 5, warehouse: 'B', item: 'G', salesOrderLineId: order.lineIds[1] },
      ], { salesOrderId: order.salesOrderId });
      const lotA = await f.lot([{ warehouse: 'A', qty: 10 }], 'G');
      const lotB = await f.lot([{ warehouse: 'B', qty: 5 }], 'G');
      await pick(made, 0, lotA.lotId, 'PDA_P1');
      await pick(made, 1, lotB.lotId, 'PDA_P2');

      const numbering = jest.spyOn(app.get(NumberingService), 'next');
      const done = await complete(made.requestId, 'POP_P2').expect(200);
      const calls = numbering.mock.calls.map(([type, plant]) => [type, plant]);
      numbering.mockRestore();
      expect(calls).toEqual(expect.arrayContaining([['SHIPMENT', f.plant.P2], ['GOODS_ISSUE', f.plant.P1], ['GOODS_ISSUE', f.plant.P2]]));

      expect(done.body.goodsIssues.map((row: { plantName: string; warehouseName: string }) => [row.warehouseName, row.plantName]).sort())
        .toEqual([['완제품창고A', 'P1공장'], ['완제품창고B', 'P2공장']]);
      const issues = await prisma.goods_issue.findMany({ where: { source_document_type_code: 'SHIPMENT', source_document_id: BigInt(done.body.shipmentId) } });
      expect(issues.map((row) => row.source_warehouse_id).sort()).toEqual([f.warehouse.A, f.warehouse.B].sort());
      const balances = await prisma.inventory_balance.findMany({ where: { lot_id: { in: [BigInt(lotA.lotId), BigInt(lotB.lotId)] } } });
      expect(balances.map((row) => Number(row.on_hand_qty))).toEqual([0, 0]);
      expect(await prisma.shipment.count({ where: { shipment_request_id: BigInt(made.requestId) } })).toBe(1);

      const message = await prisma.integration_message.findFirstOrThrow({ where: { target_type_code: 'SHIPMENT', target_id: BigInt(done.body.shipmentId) } });
      const rows = await goodsIssueBuilder(prisma).build({
        id: message.integration_message_id, interfaceCode: message.interface_code, targetTypeCode: 'SHIPMENT', targetId: BigInt(done.body.shipmentId), payload: {},
      });
      expect(rows.map((row) => row.values.PLANT_CD)).toEqual(['BWE2E-P1', 'BWE2E-P2']);
      expect(new Set(rows.map((row) => row.values.DN_REQ_NO)).size).toBe(1);

      await complete(made.requestId, 'POP_P1').expect(409);
      completed = { requestId: made.requestId, shipmentId: done.body.shipmentId as number };
    });

    it('FR-017·Q12·SC-005(#331) 창고 A 지정 POP 의 출하 목록에 새 흐름 출하가 보이고, 다른 사업부 POP 에는 없다', async () => {
      const ids = async (terminal: TerminalKey) => ((await f.asTerminal(f.http().get('/api/logistics/shipments'), terminal)
        .query({ shipDateFrom: '2026-11-20', shipDateTo: '2026-11-20', size: 200 }).expect(200)).body.items as { shipmentId: number }[])
        .map((row) => row.shipmentId);
      expect(await ids('POP_P1A')).toContain(completed.shipmentId);
      expect(await ids('POP_P2')).toContain(completed.shipmentId);
      expect(await ids('POP_P3')).not.toContain(completed.shipmentId);
      // 공장 없는 새 지시서의 출하도 영업일 거르기에서 빠지지 않는다(시간대 = 완료 POP 공장).
      const listed = await f.asSession(f.http().get('/api/logistics/shipments'), 'ALL').query({ shipDateFrom: '2026-11-20', shipDateTo: '2026-11-20', size: 500 }).expect(200);
      expect((listed.body.items as { shipmentId: number }[]).map((row) => row.shipmentId)).toContain(completed.shipmentId);
    });

    it('US3-5 사업부 안 POP 은 OQC 화면에서 지시서(줄 창고·공장)를 열고, 다른 사업부 POP 은 열지도 결과를 넣지도 못한다', async () => {
      const made = await f.made([{ allocated: 10, warehouse: 'A' }, { allocated: 5, warehouse: 'B' }]);
      const body = (await f.asTerminal(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`), 'POP_P2').expect(200)).body as RequestBody;
      expect(body.lines.map((line) => line.warehouse?.plantName)).toEqual(['P1공장', 'P2공장']);
      await f.asTerminal(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`), 'POP_P3').expect(401);
      const oqc = await prisma.inspection_request.findFirstOrThrow({ where: { target_type_code: 'SHIPMENT_REQUEST', target_id: BigInt(made.requestId) } });
      const scoped = await f.asTerminal(f.http().get('/api/quality/inspection-requests'), 'POP_P2').query({ inspectionTypeCode: 'OQC', size: 200 }).expect(200);
      expect((scoped.body.items as { inspectionRequestId: number }[]).map((row) => row.inspectionRequestId)).toContain(Number(oqc.inspection_request_id));
      await f.asTerminal(f.http().post('/api/quality/inspection-results'), 'POP_P3').set('Idempotency-Key', randomUUID()).send({
        inspectionRequestId: Number(oqc.inspection_request_id), inspectedQty: 0, acceptedQty: 0, rejectedQty: 0, heldQty: 0, uomId: Number(f.uom),
        inspectedAt: '2026-11-20T03:00:00.000Z', statusCode: 'DRAFT',
      }).expect(401);
    });

    it('US4-3·US4-5·SC-004 W-04-12 만 가진 계정이 W-04-02 「출하」 칸에서 송신 전 출하를 취소 요청 → 승인 → 실행한다', async () => {
      const cookie = await f.account('e2e-bw-w0412c', [{ unit: f.unit.X }], ['W-04-12']);
      if ((await prisma.approval_route.findFirst({ where: { approval_type_code: 'SHIPMENT_CANCEL' } })) === null) {
        const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: 'e2e-bw-w0412c' } });
        await seedRoute(prisma, 'SHIPMENT_CANCEL', [user.app_user_id]);
      }
      const etag = async () => (await f.http().get(`/api/logistics/shipments/${completed.shipmentId}`).set('Cookie', cookie).expect(200)).headers.etag as string;
      await f.http().post(`/api/logistics/shipments/${completed.shipmentId}:request-cancel`).set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID()).set('If-Match', await etag()).send({ reason: '고객 요청' }).expect(200);
      const pending = (await detail(completed.requestId, 'ALL').expect(200)).body.shipments[0];
      expect(pending).toMatchObject({ shipmentId: completed.shipmentId, cancelRequestPending: true });
      await prisma.approval_request.updateMany({
        where: { target_type_code: 'SHIPMENT', target_id: BigInt(completed.shipmentId), approval_type_code: 'SHIPMENT_CANCEL', status_code: 'PENDING' },
        data: { status_code: 'APPROVED', decided_at: new Date() },
      });
      await f.http().post(`/api/logistics/shipments/${completed.shipmentId}:cancel`).set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID()).set('If-Match', await etag()).send({ businessDate: '2026-11-20', occurredAt: '2026-11-20T06:00:00.000Z' }).expect(200);
      const after = (await detail(completed.requestId, 'ALL').expect(200)).body;
      expect(after.shipments[0]).toMatchObject({ statusCode: 'CANCELLED' });
      expect(after.erpSendStatus).toBe('CANCELLED');
    });

    it('US6-3·FR-026 사업부 없는 공장 P0 의 옛 지시서는 P0 POP 만 열고, 사업부 X 의 POP 은 403', async () => {
      const orphan = await f.legacy('P0', [{ item: 'G', allocated: 5 }]);
      await lookup(orphan.requestNo, 'POP_P0').expect(200);
      expect((await lookup(orphan.requestNo, 'POP_P1').expect(403)).body.errors[0].code).toBe('BUSINESS_UNIT_MISMATCH');
    });

    it('SC-006·US6-1 배포 전 옛 지시서(P1, 창고 미지정)를 P1 PDA 로 피킹하고 같은 사업부 POP-P2 가 추가 조치 없이 완료한다 — 전표는 P1 창고', async () => {
      const old = await f.legacy('P1', [{ item: 'G', allocated: 10 }]);
      await pick(old, 0, (await f.lot([{ warehouse: 'C', qty: 10 }], 'G')).lotId, 'PDA_P1');
      const done = await complete(old.requestId, 'POP_P2').expect(200);
      expect(done.body.goodsIssues).toEqual([expect.objectContaining({ warehouseId: Number(f.warehouse.C), plantName: 'P1공장' })]);
    });
  });
});
