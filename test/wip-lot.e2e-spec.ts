/**
 * 피처 016 공정 반제품(WIP) LOT — 배포가 마지막이 아닌 공정 W/O 의 선발행 슬롯을 `WIP` 로 세운다(omf-all-around#359).
 * 바탕은 `support/wip-lot-fixture.ts`(3공정 ABC·공정 하나 X). 배포·실적은 API 로 탄다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { WipLotFixture } from './support/wip-lot-fixture';

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

  it('FR-005 — 반제품 LOT 번호도 지금 생산 LOT 형식(M + 공장 6 + 날짜 8 + 순번 6 + 난수 13)이다', async () => {
    const { lots } = await fx.releasedWorkOrder('abc1_20', 10, 10);

    const plant = String(fx.ids.plant).padStart(6, '0').slice(-6);
    expect(lots[0].lot_type_code).toBe('WIP');
    expect(lots[0].lot_no).toMatch(new RegExp(`^M${plant}\\d{8}\\d{6}[A-Z2-9]{13}$`));
  });
});
