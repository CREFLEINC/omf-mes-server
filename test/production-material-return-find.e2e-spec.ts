/**
 * 반납 입고 「W/O 로 찾기」(피처 019 US4 · omf-all-around#367) — 라벨 없는 자재를 W/O → LOT 으로 골라 반납한다.
 * 시험 이름 앞의 ID 는 verification.md 의 것이다. 최종 마감(017)은 대역으로 만든다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { FinalCloseProbe } from '../src/production/material-return/final-close';
import { FinalCloseFake, MaterialReturnFixture, RETURNS } from './support/material-return-fixture';
import { contractValidator } from './support/wip-lot-fixture';

const CONTRACT = 'production-02생산실행.json';

interface WorkOrderItem { workOrderId: number; workOrderNo: string; finalized: boolean; returnableLotCount: number; unprintedLotCount: number }
interface LotItem { lotId: number; returnableQty: number; labelUnprinted: boolean; issueQty: number }

describe('반납 입고 — W/O 로 찾기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: MaterialReturnFixture;
  const finalClose = new FinalCloseFake();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FinalCloseProbe).useValue(finalClose).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new MaterialReturnFixture(app, prisma);
    await fx.setup();
  });

  afterAll(async () => {
    await app.close();
  });

  const workOrders = (q: string, session = fx.pop) => fx.as(fx.http().get(`${RETURNS}/work-orders`).query({ q }), session);
  const lotsOf = (workOrderId: bigint, session = fx.pop) => fx.as(fx.http().get(`${RETURNS}/work-orders/${workOrderId}/lots`), session);

  /** 부분 출고 분할 LOT(008) — 부모에서 떼어 W/O 로 출고했다. 라벨 발행 기록은 `label` 대로. */
  async function splitIssued(workOrderId: bigint, qty: number, at: string, label: 'NONE' | 'FAILED' | 'SUCCEEDED') {
    const parent = await fx.lot('B');
    const child = await fx.lot('B', { parentLotId: parent.lotId, source: ['GOODS_ISSUE_SPLIT', 1n] });
    const { goodsIssueLineId } = await fx.issue(child.lotId, qty, workOrderId, { at });
    await prisma.lot.update({ where: { lot_id: child.lotId }, data: { source_id: goodsIssueLineId } });
    if (label !== 'NONE') {
      await prisma.document_issue_log.create({ data: {
        document_type_code: 'MATERIAL_LOT_LABEL', target_type_code: 'LOT', target_id: child.lotId, lot_id: child.lotId, issue_seq: 1,
        issued_worker_id: fx.pop.workerId, terminal_id: fx.pop.terminalId, print_outcome_code: label, print_reported_at: new Date(),
        print_reported_worker_id: fx.pop.workerId, print_failure_reason: label === 'FAILED' ? '종이 걸림(합성)' : null,
      } });
    }
    return child;
  }

  it('US4-1 반납 남은 W/O 만 최근 출고 순, W/O 번호 일부로 찾는다, 라벨 미발행 수·최종 마감 표시', async () => {
    const old = await fx.workOrder();
    const recent = await fx.workOrder();
    const done = await fx.workOrder();
    const oldLot = await fx.lot('A');
    await fx.issue(oldLot.lotId, 50, old.workOrderId, { at: '2026-11-26T01:00:00.000Z' });
    await splitIssued(recent.workOrderId, 30, '2026-11-27T05:00:00.000Z', 'NONE');
    const doneLot = await fx.lot('C');
    await fx.issue(doneLot.lotId, 10, done.workOrderId, { at: '2026-11-27T06:00:00.000Z' });
    await fx.receive([{ lotId: doneLot.lotId, returnQty: 10 }]).expect(201);

    const response = await workOrders(`${fx.run}-WO`).expect(200);
    expect(contractValidator(CONTRACT, 'GET /production/material-returns/work-orders')(response.body)).toBe(true);
    const mine = (response.body.items as WorkOrderItem[]).filter((row) => [old, recent, done].some((wo) => Number(wo.workOrderId) === row.workOrderId));
    expect(mine.map((row) => row.workOrderId)).toEqual([Number(recent.workOrderId), Number(old.workOrderId)]);
    expect(mine[0]).toMatchObject({ workOrderNo: recent.workOrderNo, finalized: false, returnableLotCount: 1, unprintedLotCount: 1 });
    expect(mine[1]).toMatchObject({ unprintedLotCount: 0 });

    const byPart = await workOrders(old.workOrderNo.slice(-8)).expect(200);
    expect((byPart.body.items as WorkOrderItem[]).map((row) => row.workOrderId)).toContain(Number(old.workOrderId));
    expect((byPart.body.items as WorkOrderItem[]).map((row) => row.workOrderId)).not.toContain(Number(recent.workOrderId));

    finalClose.finalized.add(old.workOrderId);
    const finalized = await workOrders(old.workOrderNo).expect(200);
    expect(finalized.body.items).toEqual([expect.objectContaining({ workOrderId: Number(old.workOrderId), finalized: true })]);
  });

  it('US4-2·US4-3 그 W/O 가 가장 최근 출고인 반납 가능 LOT — 라벨 미발행(발행 없음·마지막 인쇄 실패)이 맨 위, 그 안에서 출고 시각 순', async () => {
    const wo = await fx.workOrder();
    const plain = await fx.lot('A');
    await fx.issue(plain.lotId, 40, wo.workOrderId, { at: '2026-11-27T01:00:00.000Z' });
    const printed = await splitIssued(wo.workOrderId, 20, '2026-11-27T02:00:00.000Z', 'SUCCEEDED');
    const failed = await splitIssued(wo.workOrderId, 25, '2026-11-27T04:00:00.000Z', 'FAILED');
    const unprinted = await splitIssued(wo.workOrderId, 30, '2026-11-27T03:00:00.000Z', 'NONE');
    // 다른 W/O 로 다시 출고된 LOT 은 이 W/O 의 목록에서 빠진다(가장 최근 출고 W/O 가 아니다).
    const moved = await fx.lot('A');
    await fx.issue(moved.lotId, 10, wo.workOrderId, { at: '2026-11-27T01:30:00.000Z' });
    const other = await fx.workOrder();
    await fx.issue(moved.lotId, 10, other.workOrderId, { at: '2026-11-27T07:00:00.000Z' });

    const response = await lotsOf(wo.workOrderId).expect(200);
    expect(contractValidator(CONTRACT, 'GET /production/material-returns/work-orders/{workOrderId}/lots')(response.body)).toBe(true);
    const items = response.body.items as LotItem[];
    expect(items.map((row) => row.lotId)).toEqual([unprinted, failed, plain, printed].map((lot) => Number(lot.lotId)));
    expect(items.map((row) => row.labelUnprinted)).toEqual([true, true, false, false]);
    expect(items[0]).toMatchObject({ issueQty: 30, returnableQty: 30 });
    // LOT 조회가 같은 W/O·양을 낸다 — 목록 SQL 과 LOT 하나 판정이 같은 규칙이다.
    expect((await fx.lookup(unprinted.lotNo).expect(200)).body).toMatchObject({ returnableQty: 30, labelUnprinted: true, workOrder: { workOrderId: Number(wo.workOrderId) } });
    await lotsOf(999999999n).expect(404);
  });

  it('US4-4·Q11 B-S1(미발행) 40 을 W/O 로 찾아 반납 → 적치 대기, 고른 W/O 귀속(WORK_ORDER_PICKED), 응답 labelUnprinted', async () => {
    const wo11 = await fx.workOrder();
    const bs1 = await splitIssued(wo11.workOrderId, 300, '2026-11-27T02:00:00.000Z', 'NONE');
    const response = await fx.receive([{ lotId: bs1.lotId, returnQty: 40, workOrderId: wo11.workOrderId }]).expect(201);
    expect(response.body.lines[0]).toMatchObject({ workOrderId: Number(wo11.workOrderId), attributionCode: 'WORK_ORDER_PICKED', labelUnprinted: true, destinationLocationId: Number(fx.ids.staging) });
    expect(await fx.onHand(bs1.lotId)).toEqual([[fx.ids.staging, 40, 'NORMAL', 'AVAILABLE']]);
    expect((await lotsOf(wo11.workOrderId).expect(200)).body.items).toEqual([expect.objectContaining({ lotId: Number(bs1.lotId), returnableQty: 260 })]);
  });

  it('US4-4 고른 W/O 가 그 LOT 의 가장 최근 출고 W/O 가 아니면 400 WORK_ORDER_MISMATCH', async () => {
    const first = await fx.workOrder();
    const second = await fx.workOrder();
    const lot = await fx.lot('A');
    await fx.issue(lot.lotId, 20, first.workOrderId, { at: '2026-11-27T01:00:00.000Z' });
    await fx.issue(lot.lotId, 20, second.workOrderId, { at: '2026-11-27T02:00:00.000Z' });
    const response = await fx.receive([{ lotId: lot.lotId, returnQty: 5, workOrderId: first.workOrderId }]).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'lines[0].workOrderId', code: 'WORK_ORDER_MISMATCH' });
    expect(await fx.onHand(lot.lotId)).toEqual([]);
  });

  it('US4-6 최종 마감 W/O 를 골라 반납 → 재고는 받고 귀속 없음(NONE_FINALIZED)', async () => {
    const wo = await fx.workOrder();
    const lot = await fx.lot('C');
    await fx.issue(lot.lotId, 30, wo.workOrderId);
    finalClose.finalized.add(wo.workOrderId);
    const response = await fx.receive([{ lotId: lot.lotId, returnQty: 12, workOrderId: wo.workOrderId }], fx.pda).expect(201);
    expect(response.body.lines[0]).toMatchObject({ workOrderId: null, attributionCode: 'NONE_FINALIZED' });
    expect(await fx.onHand(lot.lotId)).toEqual([[fx.ids.staging, 12, 'NORMAL', 'AVAILABLE']]);
  });

  it('Q12 PDA 로 W/O 로 찾기 반납한 미발행 LOT 은 분할 LOT 라벨 목록(008)의 미발행에 계속 보인다', async () => {
    const wo = await fx.workOrder();
    const lot = await splitIssued(wo.workOrderId, 50, '2026-11-27T02:00:00.000Z', 'NONE');
    const response = await fx.receive([{ lotId: lot.lotId, returnQty: 20, workOrderId: wo.workOrderId }], fx.pda).expect(201);
    expect(response.body.lines[0]).toMatchObject({ labelUnprinted: true });
    const list = await fx.as(fx.http().get('/api/logistics/split-material-lots').query({ plantId: Number(fx.ids.plant), labelState: 'UNPRINTED', size: 200 }), fx.pop).expect(200);
    expect((list.body.items as { lotId: number }[]).map((row) => row.lotId)).toContain(Number(lot.lotId));
  });

  it('US1-6 「반납 가능」이 꺼진 POP 은 W/O 로 찾기도 403', async () => {
    const wo = await fx.workOrder();
    await workOrders(fx.run, fx.popOff).expect(403);
    await lotsOf(wo.workOrderId, fx.popOff).expect(403);
  });
});
