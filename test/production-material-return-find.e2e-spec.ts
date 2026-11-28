/**
 * 반납 입고 「W/O 로 찾기」(피처 019 US4 · omf-all-around#367) — 라벨 없는 자재를 W/O → LOT 으로 골라 반납한다.
 * 시험 이름 앞의 ID 는 verification.md 의 것이다. 최종 마감(017)은 대역으로 만든다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { DocumentIssueRenditionService } from '../src/app/document-issue/document-issue-rendition.service';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { FinalCloseProbe } from '../src/production/material-return/final-close';
import { FinalCloseFake, MaterialReturnFixture, RETURNS } from './support/material-return-fixture';
import { contractValidator } from './support/wip-lot-fixture';

const CONTRACT = 'production-02생산실행.json';
const LOGISTICS = 'logistics-01자재창고.json';

interface WorkOrderItem {
  workOrderId: number; workOrderNo: string; finalized: boolean; returnableLotCount: number; unprintedLotCount: number;
  returnableMaterial: { item: { itemId: number; itemCode: string; itemName: string }; otherItemCount: number };
}
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

  it('목록 줄의 나간 자재 — 가장 최근 출고 LOT 의 자재 품목(같은 시각이면 품목 코드 순)·나머지 품목 수, 다 반납한 품목은 세지 않는다', async () => {
    const material = async (wo: { workOrderNo: string; workOrderId: bigint }) => {
      const response = await workOrders(wo.workOrderNo).expect(200);
      expect(contractValidator(CONTRACT, 'GET /production/material-returns/work-orders')(response.body)).toBe(true);
      const row = (response.body.items as WorkOrderItem[]).find((item) => item.workOrderId === Number(wo.workOrderId));
      return row?.returnableMaterial;
    };
    const itemOf = (key: 'A' | 'B' | 'C') => ({ itemId: Number(fx.item(key)), itemCode: `MRT19-${key}` });

    // 자재 셋 — 가장 최근 출고는 B, 나머지 A·C 둘. W/O 생산 품목(item)은 그대로다.
    const three = await fx.workOrder();
    for (const [key, at] of [['A', '01:00'], ['B', '03:00'], ['C', '02:00']] as const) {
      await fx.issue((await fx.lot(key)).lotId, 10, three.workOrderId, { at: `2026-11-27T${at}:00.000Z` });
    }
    expect(await material(three)).toEqual({ item: expect.objectContaining(itemOf('B')), otherItemCount: 2 });
    const threeRow = ((await workOrders(three.workOrderNo).expect(200)).body.items as (WorkOrderItem & { item: { itemId: number } })[])[0];
    expect(threeRow.item.itemId).toBe(Number(fx.ids.product));

    // 출고 시각이 같으면 품목 코드 오름차순 첫 품목(A < C).
    const tie = await fx.workOrder();
    await fx.issue((await fx.lot('C')).lotId, 10, tie.workOrderId, { at: '2026-11-27T05:00:00.000Z' });
    await fx.issue((await fx.lot('A')).lotId, 10, tie.workOrderId, { at: '2026-11-27T05:00:00.000Z' });
    expect(await material(tie)).toEqual({ item: expect.objectContaining(itemOf('A')), otherItemCount: 1 });

    // 자재 한 종(LOT 둘)이면 0.
    const single = await fx.workOrder();
    await fx.issue((await fx.lot('A')).lotId, 10, single.workOrderId, { at: '2026-11-27T01:00:00.000Z' });
    await fx.issue((await fx.lot('A')).lotId, 10, single.workOrderId, { at: '2026-11-27T02:00:00.000Z' });
    expect(await material(single)).toEqual({ item: expect.objectContaining(itemOf('A')), otherItemCount: 0 });

    // 다 반납한 품목(B, 가장 최근 출고)은 대표에서도 수에서도 빠진다.
    const returned = await fx.workOrder();
    await fx.issue((await fx.lot('A')).lotId, 10, returned.workOrderId, { at: '2026-11-27T01:00:00.000Z' });
    const done = await fx.lot('B');
    await fx.issue(done.lotId, 10, returned.workOrderId, { at: '2026-11-27T04:00:00.000Z' });
    expect(await material(returned)).toEqual({ item: expect.objectContaining(itemOf('B')), otherItemCount: 1 });
    await fx.receive([{ lotId: done.lotId, returnQty: 10 }]).expect(201);
    expect(await material(returned)).toEqual({ item: expect.objectContaining(itemOf('A')), otherItemCount: 0 });
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

  it('P-01-02 라벨 수량 — 출고 300 → 반납 40 이면 qty 40(지금 재고), 재고가 없으면 최근 반납 수량, 반납 없는 LOT 은 initial_qty, 렌디션도 같다', async () => {
    const splitQty = async (lotId: bigint) => {
      const list = await fx.as(fx.http().get('/api/logistics/split-material-lots').query({ plantId: Number(fx.ids.plant), labelState: 'UNPRINTED', size: 200 }), fx.pop).expect(200);
      expect(contractValidator(LOGISTICS, 'GET /logistics/split-material-lots')(list.body)).toBe(true);
      return (list.body.items as { lotId: number; qty: number }[]).find((row) => row.lotId === Number(lotId))?.qty;
    };
    const wo = await fx.workOrder();
    const returned = await splitIssued(wo.workOrderId, 300, '2026-11-27T02:00:00.000Z', 'NONE');
    const untouched = await splitIssued(wo.workOrderId, 120, '2026-11-27T03:00:00.000Z', 'NONE');
    // 분할 LOT 의 initial_qty 는 분할(출고) 수량이다.
    await prisma.lot.update({ where: { lot_id: returned.lotId }, data: { initial_qty: 300 } });
    await prisma.lot.update({ where: { lot_id: untouched.lotId }, data: { initial_qty: 120 } });
    expect(await splitQty(returned.lotId)).toBe(300);

    await fx.receive([{ lotId: returned.lotId, returnQty: 40, workOrderId: wo.workOrderId }]).expect(201);
    expect(await splitQty(returned.lotId)).toBe(40);
    expect(await splitQty(untouched.lotId)).toBe(120);

    // 재고가 다 나가면(합성) 가장 최근 반납 줄의 반납 수량.
    await prisma.inventory_balance.updateMany({ where: { lot_id: returned.lotId }, data: { on_hand_qty: 0 } });
    expect(await splitQty(returned.lotId)).toBe(40);
    await fx.receive([{ lotId: returned.lotId, returnQty: 15, workOrderId: wo.workOrderId }]).expect(201);
    expect(await splitQty(returned.lotId)).toBe(15);
    await prisma.inventory_balance.updateMany({ where: { lot_id: returned.lotId }, data: { on_hand_qty: 0 } });
    expect(await splitQty(returned.lotId)).toBe(15);

    // 서버 자재 LOT 라벨 렌디션도 같은 수량을 찍는다.
    const issue = await prisma.document_issue_log.create({ data: {
      document_type_code: 'MATERIAL_LOT_LABEL', target_type_code: 'LOT', target_id: returned.lotId, lot_id: returned.lotId, issue_seq: 1,
      issued_worker_id: fx.pop.workerId, terminal_id: fx.pop.terminalId,
    } });
    const tspl = (await app.get(DocumentIssueRenditionService).rendition(Number(issue.document_issue_log_id), 'tspl')).toString('utf8');
    expect(tspl).toContain('QTY: 15 ');
  });

  it('US1-6 「반납 가능」이 꺼진 POP 은 W/O 로 찾기도 403', async () => {
    const wo = await fx.workOrder();
    await workOrders(fx.run, fx.popOff).expect(403);
    await lotsOf(wo.workOrderId, fx.popOff).expect(403);
  });
});
