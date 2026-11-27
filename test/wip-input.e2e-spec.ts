/**
 * 피처 016 반제품 투입 — `POST /production/material-consumptions` 가 반제품(WIP) LOT 을 같은 품목·바로 앞 공정·남은 수량으로
 * 받고(R-3), 다음 공정 실적이 계보를 잇는다(omf-all-around#359). 바탕은 `support/wip-lot-fixture.ts`.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { contractValidator, Operation, WipLotFixture } from './support/wip-lot-fixture';

const PRODUCED_AT = '2026-11-25T01:00:00.000Z';
const INPUT_AT = '2026-11-25T02:00:00.000Z';
const NEXT_RESULT_AT = '2026-11-25T03:00:00.000Z';

describe('반제품 투입 (피처 016, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: WipLotFixture;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new WipLotFixture(app, prisma, 'WIPIN');
    await fx.setup();
  });

  afterAll(async () => {
    await app.close();
  });

  /** 앞 공정 W/O 를 배포하고 실적 `qty` 를 그 반제품 LOT 에 배분한다 — PQC 기준이 없어 실적 뒤 정상이다. */
  async function semi(operation: Operation = 'abc1_10', qty = 100): Promise<{ lotId: bigint; itemId: bigint; workOrderId: bigint }> {
    const { workOrderId, lots } = await fx.releasedWorkOrder(operation, qty, qty);
    await fx.result(workOrderId, lots[0].lot_id, qty, PRODUCED_AT).expect(201);
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lots[0].lot_id } });
    expect([lot.lot_type_code, lot.status_code]).toEqual(['WIP', 'NORMAL']);
    return { lotId: lot.lot_id, itemId: lot.item_id, workOrderId };
  }

  it('US2-1·Q7 — 공정 20 W/O 에 반제품 S1(실적 100) 60 투입 → 201, BOM 줄 없음, 남은 40', async () => {
    const s1 = await semi();
    const { workOrderId } = await fx.releasedWorkOrder('abc1_20', 100, 100);

    const response = await fx.consume(workOrderId, s1, 60, INPUT_AT).expect(201);

    expect(response.body).toMatchObject({ workOrderId: Number(workOrderId), lotId: Number(s1.lotId), itemId: Number(fx.ids.itemAbc), inputQty: 60 });
    expect(response.body).not.toHaveProperty('bomComponentId');
    const row = await prisma.material_consumption.findUniqueOrThrow({ where: { material_consumption_id: BigInt(response.body.materialConsumptionId) } });
    expect(row.bom_component_id).toBeNull();
    // 실제 사용 공정은 투입 W/O 의 공정(P20)이다 — 자재 투입과 같다.
    expect(row.actual_use_process_id).toBe(fx.ids.p20);
    const lot = await fx.getLot(s1.lotId).expect(200);
    expect(lot.body.lot).toMatchObject({ wipProducedQty: 100, wipRemainingQty: 40 });
  });

  it('US2-2·Q8·FR-012 — 공정 20 실적이 S1 → S2 계보(CONSUMED)를 잇는다', async () => {
    const s1 = await semi();
    const op20 = await fx.releasedWorkOrder('abc1_20', 100, 100);
    await fx.consume(op20.workOrderId, s1, 100, INPUT_AT).expect(201);

    await fx.result(op20.workOrderId, op20.lots[0].lot_id, 100, NEXT_RESULT_AT).expect(201);

    const relations = await prisma.lot_relation.findMany({ where: { target_lot_id: op20.lots[0].lot_id } });
    expect(relations.map((relation) => [relation.source_lot_id, relation.relation_type_code])).toEqual([[s1.lotId, 'CONSUMED']]);
    expect(op20.lots[0].lot_type_code).toBe('WIP');
  });

  it('US2-3·Q9·FR-009 — 공정 30 W/O 에 공정 10 반제품은 400 「이 W/O 의 앞 공정 반제품이 아닙니다.」', async () => {
    const s1 = await semi();
    const { workOrderId } = await fx.releasedWorkOrder('abc1_30', 10, 10);

    const response = await fx.consume(workOrderId, s1, 10, INPUT_AT).expect(400);

    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'lotId', code: 'INVALID', message: '이 W/O 의 앞 공정 반제품이 아닙니다.' })]);
  });

  it('US2-3·Q9·FR-009 — 첫 공정(10) W/O 는 같은 품목 반제품도 400 앞 공정 문구다', async () => {
    const s1 = await semi();
    const { workOrderId } = await fx.releasedWorkOrder('abc1_10', 10, 10);

    const response = await fx.consume(workOrderId, s1, 10, INPUT_AT).expect(400);

    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'lotId', code: 'INVALID', message: '이 W/O 의 앞 공정 반제품이 아닙니다.' })]);
  });

  it('US2-3·Q9 — 다른 품목의 반제품은 400 「다른 품목의 반제품입니다.」', async () => {
    const other = await semi('oth_10', 10);
    const { workOrderId } = await fx.releasedWorkOrder('abc1_20', 10, 10);

    const response = await fx.consume(workOrderId, other, 10, INPUT_AT).expect(400);

    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'lotId', code: 'INVALID', message: '다른 품목의 반제품입니다.' })]);
  });

  it.each([
    ['검사 대기', 'INSPECTION_PENDING', false],
    ['보류(의심 보류 — 검사 대기로 옮기고 보류 행이 선다)', 'INSPECTION_PENDING', true],
    ['불량', 'DEFECTIVE', false],
  ])('US2-4·Q10·FR-010 — %s 반제품은 400 지금 상태 문구다', async (_name, status, held) => {
    const s1 = await semi();
    await prisma.lot.update({ where: { lot_id: s1.lotId }, data: { status_code: status } });
    if (held) {
      await prisma.lot_hold.create({ data: {
        lot_id: s1.lotId, reason_code: 'SUSPECT', status_code: 'HELD', target_lot_status_code: status, held_at: new Date(), held_by: fx.ids.userId,
      } });
    }
    const { workOrderId } = await fx.releasedWorkOrder('abc1_20', 10, 10);

    const response = await fx.consume(workOrderId, s1, 10, INPUT_AT).expect(400);

    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'lotId', code: 'INVALID', message: '투입할 수 없는 상태의 LOT 입니다.' })]);
  });

  it('US2-5·Q11·FR-011 — 남은 40 에 50 은 409 WIP_QTY_EXCEEDED · meta 에 남은 40·실적 100', async () => {
    const s1 = await semi();
    const { workOrderId } = await fx.releasedWorkOrder('abc1_20', 100, 100);
    await fx.consume(workOrderId, s1, 60, INPUT_AT).expect(201);

    const response = await fx.consume(workOrderId, s1, 50, INPUT_AT).expect(409);

    expect(response.body).toEqual({
      errors: [expect.objectContaining({ field: 'inputQty', code: 'WIP_QTY_EXCEEDED', message: '남은 수량을 넘습니다 (남은 40)' })],
      meta: { remainingQty: 40, producedQty: 100 },
    });
    expect(contractValidator('production-02생산실행.json', 'POST /production/material-consumptions', 409)(response.body)).toBe(true);
    // 남은 만큼은 들어간다 — 부분 투입이 허용된다(사용자 결정 2026-11-25).
    await fx.consume(workOrderId, s1, 40, INPUT_AT).expect(201);
    expect((await fx.getLot(s1.lotId).expect(200)).body.lot.wipRemainingQty).toBe(0);
  });

  it('US2-5·Q11·FR-011 — 남은 50 에 두 단말이 동시에 30·30 → 하나만 201, 하나는 409', async () => {
    const s1 = await semi('abc1_10', 50);
    const { workOrderId } = await fx.releasedWorkOrder('abc1_20', 100, 100);

    const responses = await Promise.all([fx.consume(workOrderId, s1, 30, INPUT_AT), fx.consume(workOrderId, s1, 30, INPUT_AT)]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.meta).toEqual({ remainingQty: 20, producedQty: 50 });
    expect(await prisma.material_consumption.count({ where: { lot_id: s1.lotId } })).toBe(1);
  });

  it('Q12·FR-009 — 같은 공정 마스터를 쓰는 다른 생산계획(다른 Rev) 공정 20 W/O 에 남은 S1 → 201', async () => {
    const s1 = await semi();
    const rev1 = await fx.releasedWorkOrder('abc1_20', 100, 100);
    await fx.consume(rev1.workOrderId, s1, 70, INPUT_AT).expect(201);
    const rev2 = await fx.releasedWorkOrder('abc2_20', 100, 100);

    await fx.consume(rev2.workOrderId, s1, 30, INPUT_AT).expect(201);

    expect((await fx.getLot(s1.lotId).expect(200)).body.lot.wipRemainingQty).toBe(0);
  });

  it('US2-7·Q15 — 공정 20 이 투입 없이 실적을 올리면 201 이고 계보가 없다', async () => {
    const { workOrderId, lots } = await fx.releasedWorkOrder('abc1_20', 10, 10);

    await fx.result(workOrderId, lots[0].lot_id, 10, NEXT_RESULT_AT).expect(201);

    expect(await prisma.lot_relation.count({ where: { target_lot_id: lots[0].lot_id } })).toBe(0);
  });

  it('FR-007 — 배포 전 PRODUCTION 중간 공정 LOT 을 다음 공정에 투입하면 지금처럼 400 「자재 명세에 없는 품목입니다.」', async () => {
    const legacy = await prisma.lot.create({ data: {
      lot_no: `${fx.prefix}-${fx.run}-LEGACY`, item_id: fx.ids.itemAbc, lot_type_code: 'PRODUCTION', plant_id: fx.ids.plant,
      initial_qty: 10, uom_id: fx.ids.uom, source_type_code: 'WORK_ORDER', source_id: await fx.plannedWorkOrder('abc1_10', 10),
      status_code: 'NORMAL', lifecycle_status_code: 'ACTIVE', work_order_lot_seq: 1,
    } });
    const { workOrderId } = await fx.releasedWorkOrder('abc1_20', 10, 10);

    const response = await fx.consume(workOrderId, { lotId: legacy.lot_id, itemId: fx.ids.itemAbc }, 10, INPUT_AT).expect(400);

    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'itemId', code: 'INVALID', message: '자재 명세에 없는 품목입니다.' })]);
  });

  it('SC-005 — 1공정 자재 투입은 지금처럼 BOM 줄로 받는다', async () => {
    const { workOrderId } = await fx.releasedWorkOrder('abc1_10', 10, 10);
    const material = await fx.materialLot();

    const response = await fx.consume(workOrderId, { lotId: material, itemId: fx.ids.itemA }, 999, INPUT_AT).expect(201);

    // 자재에는 수량 한도가 없다 — 반제품 규칙이 자재 흐름에 새지 않는다.
    expect(response.body.bomComponentId).toEqual(expect.any(Number));
  });
});
