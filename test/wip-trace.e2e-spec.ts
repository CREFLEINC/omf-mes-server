/**
 * 피처 016 반제품 계보 — 자재 A → 반제품 S1(공정 10) → 반제품 S2(공정 20) → 제품 P(공정 30) 와 투입 전 반제품 S3(공정 10)을
 * API(배포·투입·실적)로 세우고, 추적 두 화면의 계보(GET /trace/forward-tree·backward-tree)와 엑셀이 끝까지 잇는지 본다(omf-all-around#359).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Workbook, Worksheet } from 'exceljs';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { Body, conformsTo } from './support/trace-tree-fixture';
import { WipLotFixture } from './support/wip-lot-fixture';

type Row = (string | number | null)[];

describe('반제품 계보 (피처 016, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: WipLotFixture;
  const lots: Record<'a' | 's1' | 's2' | 's3' | 's4' | 's5' | 'p', { lotId: bigint; lotNo: string }> = {} as never;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new WipLotFixture(app, prisma, 'WIPTR', ['W-02-13', 'W-02-14']);
    await fx.setup();
    await chain();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const at = (hour: number) => `2026-11-25T0${hour}:00:00.000Z`;

  /** 한 공정 — 배포 → (투입) → 실적. 반환은 그 W/O 의 첫 슬롯. */
  async function step(operation: 'abc1_10' | 'abc1_20' | 'abc1_30', qty: number, input: { lotId: bigint; itemId: bigint }, hour: number) {
    const { workOrderId, lots: slots } = await fx.releasedWorkOrder(operation, qty, qty);
    await fx.consume(workOrderId, input, qty, at(hour)).expect(201);
    await fx.result(workOrderId, slots[0].lot_id, qty, at(hour + 1)).expect(201);
    return { lotId: slots[0].lot_id, lotNo: slots[0].lot_no };
  }

  async function chain(): Promise<void> {
    const a = await fx.materialLot(1000);
    lots.a = { lotId: a, lotNo: (await prisma.lot.findUniqueOrThrow({ where: { lot_id: a } })).lot_no };
    const material = { lotId: a, itemId: fx.ids.itemA };
    lots.s1 = await step('abc1_10', 100, material, 1);
    lots.s2 = await step('abc1_20', 100, { lotId: lots.s1.lotId, itemId: fx.ids.itemAbc }, 3);
    lots.p = await step('abc1_30', 100, { lotId: lots.s2.lotId, itemId: fx.ids.itemAbc }, 5);
    // 다음 공정에 아직 넣지 않은 반제품.
    lots.s3 = await step('abc1_10', 50, material, 1);
    // 실적 100 중 60 만 다음 공정에 넣은 반제품(남은 40) — 시안 ④ 「다음 공정 투입 전 · 남은 40」.
    lots.s4 = await step('abc1_10', 100, material, 1);
    lots.s5 = await step('abc1_20', 60, { lotId: lots.s4.lotId, itemId: fx.ids.itemAbc }, 3);
  }

  const tree = (path: 'forward-tree' | 'backward-tree', lotId: bigint) =>
    fx.http().get(`/api/trace/${path}`).query({ plantId: Number(fx.ids.plant), lotId: Number(lotId) }).set('Cookie', fx.cookie);
  const node = (body: Body, lotId: bigint): Body => (body.nodes as Body[]).find((one) => one.nodeKey === `L:${lotId}`) as Body;

  it('US2-6·Q13·SC-003 — 제품 P 역추적이 S2 → S1 → 자재 A 까지 잇고, 반제품 항목에 공정 순번·이름이 실린다', async () => {
    const body = (await tree('backward-tree', lots.p.lotId).expect(200)).body as Body;

    conformsTo('/trace/backward-tree', 'get', body);
    for (const key of ['s2', 's1', 'a'] as const) expect(node(body, lots[key].lotId)).toBeDefined();
    expect(node(body, lots.s2.lotId).lot).toMatchObject({ lotTypeCode: 'WIP', operationSeq: 20, processName: '조립' });
    expect(node(body, lots.s1.lotId).lot).toMatchObject({ lotTypeCode: 'WIP', operationSeq: 10, processName: '가공' });
    expect(node(body, lots.p.lotId).lot).toMatchObject({ lotTypeCode: 'PRODUCTION', operationSeq: null, processName: null });
    expect(node(body, lots.a.lotId).lot).toMatchObject({ lotTypeCode: 'MATERIAL', operationSeq: null, processName: null });
    // 최종 LOT(원자재)에는 A 만 선다 — 거쳐 간 반제품은 서지 않는다(FR-013).
    expect((body.endRows as Body[]).map((row) => row.lot.lotNo)).toEqual([lots.a.lotNo]);
  });

  it('Q14·FR-013 — 자재 A 정방향이 P 까지 잇고, 투입 전 반제품 S3 는 「다음 공정 투입 전」(WIP_PENDING)으로 선다 · 거쳐 간 S1·S2 는 최종 줄이 없다', async () => {
    const body = (await tree('forward-tree', lots.a.lotId).expect(200)).body as Body;

    conformsTo('/trace/forward-tree', 'get', body);
    const rows = new Map((body.endRows as Body[]).map((row) => [row.lot.lotNo, row]));
    // S5(공정 20, 투입 없음)도 투입 전 반제품이다. 다 투입된 S1·S2 는 서지 않는다.
    expect([...rows.keys()].sort()).toEqual([lots.p.lotNo, lots.s3.lotNo, lots.s4.lotNo, lots.s5.lotNo].sort());
    expect(rows.get(lots.s3.lotNo)).toMatchObject({ fate: 'WIP_PENDING', producedQty: 50, wipRemainingQty: 50, lot: { operationSeq: 10, processName: '가공' } });
    expect(rows.get(lots.p.lotNo)).toMatchObject({ wipRemainingQty: null });
    // P 는 입고 전이라 지금 규칙대로 소진(재고 0·출하 없음)이다.
    expect(rows.get(lots.p.lotNo)).toMatchObject({ fate: 'CONSUMED_OUT' });
    expect(node(body, lots.s2.lotId)).toBeDefined();
  });

  it('Q14·FR-013 — 일부만 다음 공정에 들어간 반제품은 나가는 투입이 있어도 「다음 공정 투입 전 · 남은 40」으로 선다 · 다 들어간 반제품은 안 선다', async () => {
    const body = (await tree('forward-tree', lots.a.lotId).expect(200)).body as Body;

    const rows = new Map((body.endRows as Body[]).map((row) => [row.lot.lotNo, row]));
    expect(rows.get(lots.s4.lotNo)).toMatchObject({ fate: 'WIP_PENDING', producedQty: 100, wipRemainingQty: 40, lot: { wipRemainingQty: 40 } });
    // 계보는 그대로 — S4 → (W/O 20) → S5 로 이어진다.
    expect(node(body, lots.s5.lotId)).toBeDefined();
    expect(rows.has(lots.s1.lotNo)).toBe(false);
    expect(node(body, lots.s1.lotId).lot).toMatchObject({ wipRemainingQty: 0 });
  });

  it('시안 ④ — 계보의 W/O 항목에 공정 순번이 실린다(반제품 여부 무관)', async () => {
    const body = (await tree('backward-tree', lots.p.lotId).expect(200)).body as Body;

    const orders = (body.nodes as Body[]).filter((one) => one.kind === 'WORK_ORDER').map((one) => one.workOrder.operationSeq).sort();
    expect(orders).toEqual([10, 20, 30]);
  });

  it('Q14 — 엑셀 「최종 LOT」 현황 열에 「다음 공정 투입 전」, 「LOT 계보」 단계 열에 「반제품 LOT · 공정 n」', async () => {
    const response = await fx.http().post('/api/trace/forward-exports').set('Cookie', fx.cookie)
      .send({ plantId: Number(fx.ids.plant), lotIds: [Number(lots.a.lotId)] })
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const book = new Workbook();
    await book.xlsx.load(response.body as unknown as ArrayBuffer);
    const [endHead, ...endRows] = rowsOf(book.getWorksheet('최종 LOT'));
    const fate = endHead.indexOf('현황');
    const lotNo = endHead.indexOf('제품 LOT');
    expect(endRows.find((row) => row[lotNo] === lots.s3.lotNo)?.[fate]).toBe('다음 공정 투입 전');
    const [lineageHead, ...lineage] = rowsOf(book.getWorksheet('LOT 계보'));
    const stage = lineageHead.indexOf('단계');
    const number = lineageHead.indexOf('번호');
    const stageOf = (no: string) => lineage.find((row) => row[number] === no)?.[stage];
    expect(stageOf(lots.s1.lotNo)).toBe('반제품 LOT · 공정 10');
    expect(stageOf(lots.s2.lotNo)).toBe('반제품 LOT · 공정 20');
    // 투입 전이어도 유형이 반제품이면 반제품 단계다.
    expect(stageOf(lots.s3.lotNo)).toBe('반제품 LOT · 공정 10');
    expect(stageOf(lots.p.lotNo)).toBe('생산 LOT');
    expect(lineage.some((row) => row[stage] === 'W/O · 공정 30')).toBe(true);
    expect(endRows.find((row) => row[lotNo] === lots.s4.lotNo)?.[fate]).toBe('다음 공정 투입 전');
  });
});

function rowsOf(sheet: Worksheet | undefined): Row[] {
  const rows: Row[] = [];
  const width = sheet?.columnCount ?? 0;
  sheet?.eachRow((row) => {
    const values = (row.values as (string | number | null)[]).slice(1);
    rows.push(Array.from({ length: width }, (_, index) => values[index] ?? null));
  });
  return rows;
}
