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
});
