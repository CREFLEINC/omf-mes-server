/**
 * 피처 016 공정 반제품(WIP) LOT — 배포가 마지막이 아닌 공정 W/O 의 선발행 슬롯을 `WIP` 로 세운다(omf-all-around#359).
 * 바탕은 `support/wip-lot-fixture.ts`(3공정 ABC·공정 하나 X). 배포·실적은 API 로 탄다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { contractValidator, WipLotFixture } from './support/wip-lot-fixture';

describe('공정 반제품 LOT — 배포 유형 (피처 016, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: WipLotFixture;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new WipLotFixture(app, prisma, 'WIPLOT');
    await fx.setup();
  });

  afterAll(async () => {
    await app.close();
  });

  it('Q1·SC-001 — ABC 의 공정 10·20 W/O 슬롯은 WIP, 마지막 공정 30 은 PRODUCTION 이다', async () => {
    const op10 = await fx.releasedWorkOrder('abc1_10', 100, 50);
    const op20 = await fx.releasedWorkOrder('abc1_20', 100, 50);
    const op30 = await fx.releasedWorkOrder('abc1_30', 100, 50);

    expect(op10.lots.map((lot) => lot.lot_type_code)).toEqual(['WIP', 'WIP']);
    expect(op20.lots.map((lot) => lot.lot_type_code)).toEqual(['WIP', 'WIP']);
    expect(op30.lots.map((lot) => lot.lot_type_code)).toEqual(['PRODUCTION', 'PRODUCTION']);
    // 반제품도 생산 슬롯과 같은 첫 상태다 — 검사 대기·대기(R-1).
    expect(op10.lots[0]).toMatchObject({ status_code: 'INSPECTION_PENDING', lifecycle_status_code: 'WAITING', work_order_lot_seq: 1 });
  });

  it('Q2·US1-4·SC-005 — 공정 하나인 X 는 PRODUCTION 만 나온다', async () => {
    const { lots } = await fx.releasedWorkOrder('x_10', 30, 10);

    expect(lots.map((lot) => lot.lot_type_code)).toEqual(['PRODUCTION', 'PRODUCTION', 'PRODUCTION']);
  });

  it('US1-2 — 공정 30 실적이 배분된 LOT 은 PRODUCTION 이다', async () => {
    const { workOrderId, lots } = await fx.releasedWorkOrder('abc1_30', 20, 20);

    await fx.result(workOrderId, lots[0].lot_id, 20, '2026-11-25T03:00:00.000Z').expect(201);

    const response = await fx.getLot(lots[0].lot_id).expect(200);
    expect(response.body.lot).toMatchObject({ lotTypeCode: 'PRODUCTION', lifecycleStatusCode: 'ACTIVE', statusCode: 'NORMAL' });
  });

  it('US1-1 — 현재 생산 LOT 조회(currentOnly)가 공정 10 W/O 의 WIP LOT 을 준다', async () => {
    const { workOrderId, lots } = await fx.releasedWorkOrder('abc1_10', 100, 50);

    const response = await fx.listLots({ workOrderId: Number(workOrderId), currentOnly: true }).expect(200);

    expect(response.body.items.map((lot: { lotId: number; lotTypeCode: string }) => [lot.lotId, lot.lotTypeCode])).toEqual([
      [Number(lots[0].lot_id), 'WIP'],
    ]);
  });

  it('FR-007 — 배포 전에 이미 발행된 PRODUCTION 중간 공정 슬롯은 다른 W/O 배포 뒤에도 그대로다', async () => {
    // 배포 전(옛 코드)에 배포된 공정 10 W/O 의 슬롯을 흉내 낸다 — 그때는 모든 공정이 PRODUCTION 이었다.
    const old = await fx.plannedWorkOrder('abc1_10', 10);
    await prisma.work_order.update({ where: { work_order_id: old }, data: { status_code: 'RELEASED', released_at: new Date() } });
    const legacy = await prisma.lot.create({ data: {
      lot_no: `${fx.prefix}-${fx.run}-OLD`, item_id: fx.ids.itemAbc, lot_type_code: 'PRODUCTION', plant_id: fx.ids.plant,
      initial_qty: 10, uom_id: fx.ids.uom, source_type_code: 'WORK_ORDER', source_id: old, status_code: 'INSPECTION_PENDING',
      lifecycle_status_code: 'WAITING', work_order_lot_seq: 1,
    } });

    await fx.releasedWorkOrder('abc1_10', 10, 10);

    expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: legacy.lot_id } })).lot_type_code).toBe('PRODUCTION');
  });

  it('US1-1·Q3·FR-003 — 공정 10 실적 100 뒤 LOT 조회에 생산 공정·실적·남은 수량이 실린다', async () => {
    const { workOrderId, lots } = await fx.releasedWorkOrder('abc1_10', 100, 100);
    await fx.result(workOrderId, lots[0].lot_id, 100, '2026-11-25T01:00:00.000Z').expect(201);

    const detail = await fx.getLot(lots[0].lot_id).expect(200);
    const listed = await fx.listLots({ lotNo: lots[0].lot_no }).expect(200);

    const expected = {
      lotTypeCode: 'WIP',
      statusCode: 'NORMAL',
      producedOperation: { workOrderId: Number(workOrderId), operationSeq: 10, processCode: `${fx.prefix}-P10`, processName: '가공' },
      wipProducedQty: 100,
      wipRemainingQty: 100,
    };
    expect(detail.body.lot).toMatchObject(expected);
    expect(listed.body.items).toEqual([expect.objectContaining(expected)]);
    expect(contractValidator('logistics-01자재창고.json', 'GET /trace/lots/{lotId}')(detail.body)).toBe(true);
    expect(contractValidator('logistics-01자재창고.json', 'GET /trace/lots')(listed.body)).toBe(true);
  });

  it('US1-1·FR-003 — PRODUCTION·MATERIAL LOT 은 반제품 칸 셋이 null 이다', async () => {
    const { lots } = await fx.releasedWorkOrder('abc1_30', 10, 10);
    const material = await fx.materialLot();

    for (const lotId of [lots[0].lot_id, material]) {
      const response = await fx.getLot(lotId).expect(200);
      expect(response.body.lot).toMatchObject({ producedOperation: null, wipProducedQty: null, wipRemainingQty: null });
    }
  });

  it('US1-6·Q6·FR-006 — PQC 기준이 있는 품목은 반제품 공정도 의뢰가 서고 실적 뒤 검사 대기, 합격 뒤 정상이다(품목 규칙 그대로)', async () => {
    const plan = await prisma.inspection_plan.create({ data: {
      inspection_plan_code: `${fx.prefix}-${fx.run}-PQC`, inspection_plan_name: '반제품 PQC', inspection_type_code: 'PQC', item_id: fx.ids.itemAbc, is_active: true,
    } });
    try {
      const { workOrderId, lots } = await fx.releasedWorkOrder('abc1_10', 20, 20);
      const [request] = await prisma.inspection_request.findMany({ where: { work_order_id: workOrderId, inspection_type_code: 'PQC' } });
      expect(request).toBeDefined();

      await fx.result(workOrderId, lots[0].lot_id, 10, '2026-11-25T01:00:00.000Z').expect(201);
      expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: lots[0].lot_id } })).status_code).toBe('INSPECTION_PENDING');

      // 합격 확정이 난 W/O 는 그 판정을 따른다(C4) — 검사 확정 화면 대신 결과 행을 직접 세운다.
      await prisma.inspection_result.create({ data: {
        inspection_result_no: `${fx.prefix}-${fx.run}-IR`, inspection_request_id: request.inspection_request_id, inspected_qty: 20, accepted_qty: 20,
        uom_id: fx.ids.uom, inspector_id: fx.ids.workerId, inspected_at: new Date('2026-11-25T01:30:00.000Z'), status_code: 'CONFIRMED',
        overall_judgment_code: 'ACCEPTED', idempotency_key: `${fx.prefix}-${fx.run}-IR`,
      } });
      await fx.result(workOrderId, lots[0].lot_id, 10, '2026-11-25T02:00:00.000Z').expect(201);
      expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: lots[0].lot_id } })).status_code).toBe('NORMAL');
    } finally {
      await prisma.inspection_plan.update({ where: { inspection_plan_id: plan.inspection_plan_id }, data: { is_active: false } });
    }

    // 기준이 없으면 실적이 곧 정상이다.
    const plain = await fx.releasedWorkOrder('abc1_10', 10, 10);
    await fx.result(plain.workOrderId, plain.lots[0].lot_id, 10, '2026-11-25T01:00:00.000Z').expect(201);
    expect(await prisma.inspection_request.count({ where: { work_order_id: plain.workOrderId } })).toBe(0);
    expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: plain.lots[0].lot_id } })).status_code).toBe('NORMAL');
  });

  it('FR-005 — 반제품 LOT 번호도 지금 생산 LOT 형식(M + 공장 6 + 날짜 8 + 순번 6 + 난수 13)이다', async () => {
    const { lots } = await fx.releasedWorkOrder('abc1_20', 10, 10);

    const plant = String(fx.ids.plant).padStart(6, '0').slice(-6);
    expect(lots[0].lot_type_code).toBe('WIP');
    expect(lots[0].lot_no).toMatch(new RegExp(`^M${plant}\\d{8}\\d{6}[A-Z2-9]{13}$`));
  });
});
