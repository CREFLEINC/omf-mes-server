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
import { PrismaService } from '../src/prisma/prisma.service';
import { ShipmentBuWarehouseFixture } from './support/shipment-bu-warehouse-fixture';

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
  });
});
