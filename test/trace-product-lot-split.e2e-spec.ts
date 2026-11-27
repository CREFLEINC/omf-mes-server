/**
 * 피처 013 생산 LOT 수량 분리(omf-all-around#303) — 분리 자식 LOT 의 추적·LOT 상세·W/O 검색 (e2e).
 *
 * 시험 이름 앞의 ID 는 `specs/013-product-lot-split/verification.md`·`quickstart.md` 의 항목이다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PLS_PREFIX, ProductLotSplitFixture } from './support/product-lot-split-fixture';

describe('생산 LOT 분리 — 추적·상세·검색 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let f: ProductLotSplitFixture;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    f = new ProductLotSplitFixture(app, prisma);
    await f.setup();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  /** W/O·생산 LOT(실적 100)·투입 자재 LOT 하나 → 30 분리. */
  const made = async () => {
    const { workOrderId, workOrderNo } = await f.workOrder();
    const lot = await f.lot({ workOrderId, balances: [{ at: 'A', qty: 100 }] });
    await f.result(workOrderId, lot.lotId, 100, '2026-11-18T02:30:00.000Z');
    const material = await f.lot({ item: 'M', balances: [], initialQty: 500 });
    const worker = await prisma.worker.findFirstOrThrow({ where: { worker_no: f.pop.workerNo } });
    await prisma.material_consumption.create({ data: {
      consumption_no: `${PLS_PREFIX}-${f.run}-MC-${f.next()}`, work_order_id: workOrderId, item_id: f.ids.itemM, lot_id: BigInt(material.lotId),
      consumption_type_code: 'NORMAL', input_qty: 50, uom_id: f.ids.uom, occurred_at: new Date('2026-11-18T01:00:00.000Z'),
      worker_id: worker.worker_id, status_code: 'RECORDED', idempotency_key: `${PLS_PREFIX}-${f.run}-MC-${f.next()}`,
    } });
    const split = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);
    return { workOrderId, workOrderNo, lot, material, split: split.body as { productLotSplitId: number; childLot: { lotId: number; lotNo: string } } };
  };

  it('US4-2·SC-005·Q18 자식 거꾸로 추적 — 원래 LOT(분할)·뿌리 W/O·투입 자재까지 잇는다', async () => {
    const { workOrderNo, lot, material, split } = await made();

    const response = await f.asSession(f.http().get(`/api/trace/lots/${split.childLot.lotId}/backward-flow`)).expect(200);

    expect(response.body.splitFrom).toMatchObject({ lot: { lotId: lot.lotId, lotNo: lot.lotNo }, relationTypeCode: 'SPLIT', qty: 30 });
    expect(response.body.workOrder).toMatchObject({ workOrderNo });
    expect(response.body.inputMaterials.map((row: { lotId: number }) => row.lotId)).toEqual([material.lotId]);
  });

  it('US4-3·Q18 원래 LOT 앞으로 추적 — 분리 자식들이 분할로 나온다', async () => {
    const { lot, split } = await made();

    const response = await f.asSession(f.http().get(`/api/trace/lots/${lot.lotId}/forward-flow`)).expect(200);

    expect(response.body.splits.map((row: { lot: { lotId: number } }) => row.lot.lotId)).toEqual([split.childLot.lotId]);
  });

  it('US4-4·Q19 LOT 상세 productLotSplit — 자식은 CHILD(위치·작업자·단말·확인 전·원래 W/O), 원래는 PARENT', async () => {
    const { workOrderNo, lot, split } = await made();

    const child = await f.asSession(f.http().get(`/api/trace/lots/${split.childLot.lotId}`)).expect(200);
    const parent = await f.asSession(f.http().get(`/api/trace/lots/${lot.lotId}`)).expect(200);

    expect(child.body.lot).toMatchObject({
      parentLotNo: lot.lotNo,
      productLotSplit: {
        productLotSplitId: split.productLotSplitId, role: 'CHILD', splitQty: 30, splitWorkerNo: f.pop.workerNo, splitTerminalCode: `${PLS_PREFIX}-POP1`,
        location: { locationId: f.locationOf('A'), locationCode: `${PLS_PREFIX}-A01`, warehouseCode: `${PLS_PREFIX}-FG`, warehouseName: '분리검사FG' },
        confirmedAt: null, confirmedWorkerNo: null, workOrderNo,
      },
    });
    expect(parent.body.lot.productLotSplit).toMatchObject({ productLotSplitId: split.productLotSplitId, role: 'PARENT', workOrderNo });
  });

  it('US4-5·Q19 W/O 로 LOT 을 찾으면 분리 자식도 나온다 — 「현재 생산 LOT」 후보에는 끼지 않는다', async () => {
    const { workOrderId, lot, split } = await made();

    const all = await f.asSession(f.http().get('/api/trace/lots').query({ workOrderId: Number(workOrderId) })).expect(200);
    const current = await f.asSession(f.http().get('/api/trace/lots').query({ workOrderId: Number(workOrderId), currentOnly: true })).expect(200);

    expect(all.body.items.map((row: { lotId: number }) => row.lotId).sort()).toEqual([lot.lotId, split.childLot.lotId].sort());
    expect(current.body.items.map((row: { lotId: number }) => row.lotId)).not.toContain(split.childLot.lotId);
  });
});
