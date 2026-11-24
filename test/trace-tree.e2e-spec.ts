/**
 * 피처 015 계보 — GET /trace/forward-tree (contracts §3) · GET /trace/backward-tree (contracts §4).
 *
 * 계보 사슬(quickstart 「준비」, 2026-09-10)에 더해:
 * - 여러 길: 자재 X → W/O M1(계보)·M2(계보 없음) → 반제품 S1·S2 → 둘 다 W/O M3 → 완제품 F.
 * - 순환: 반제품 Q 가 자기 W/O CYC(계보 없음)에 다시 투입돼 Q 를 만든다.
 * - 상한: 자재 CAP → W/O CAPWO(계보 없음) → 생산 LOT 5,001개.
 * - 응답 시간: 자재 R → W/O RWO → 생산 LOT 199개(항목 약 200).
 * - 투입 안 된 자재 U(재고만), 옛 입하 자재 LEG(공급사 LOT 이 입하 줄에만), 다른 공장 LOT.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { Body, ChainIds, TraceTreeFixture, conformsTo, dropTraceUser, traceLogin } from './support/trace-tree-fixture';

const PREFIX = 'TTRE2E';
const DAY = '2026-09-10';
const USERS = { both: `${PREFIX}-both`, material: `${PREFIX}-material`, product: `${PREFIX}-product` };
const at = TraceTreeFixture.at;

describe('피처 015 계보 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: TraceTreeFixture;
  let chain: ChainIds;
  const cookies = {} as Record<keyof typeof USERS, string[]>;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new TraceTreeFixture(prisma, PREFIX);
    await fx.cleanup();
    await fx.setup();
    chain = await fx.chain(DAY);
    await extras();
    // 갓 복사한 시험 DB 는 통계가 비어 있다 — 방금 넣은 LOT 수천 개를 플래너가 0 으로 보고 중첩 반복을 골라 Q23 시간이
    // 운영과 동떨어진다(실측 6초 → 통계 뒤 60ms). 운영 DB 는 자동 ANALYZE 가 돈다.
    await prisma.$executeRawUnsafe('ANALYZE trace.lot, trace.lot_relation, production.material_consumption, production.production_result_lot_allocation');
    cookies.both = await traceLogin(app, prisma, USERS.both, ['W-02-13', 'W-02-14']);
    cookies.material = await traceLogin(app, prisma, USERS.material, ['W-02-13']);
    cookies.product = await traceLogin(app, prisma, USERS.product, ['W-02-14']);
  }, 300_000);

  afterAll(async () => {
    await fx.cleanup();
    for (const loginId of Object.values(USERS)) await dropTraceUser(prisma, loginId);
    await app.close();
  });

  const tree = (path: 'forward-tree' | 'backward-tree', lotId: bigint, extra: Record<string, string> = {}, who: keyof typeof USERS = 'both') =>
    request(app.getHttpServer()).get(`/api/trace/${path}`).query({ plantId: Number(fx.ids.plant), lotId: Number(lotId), ...extra }).set('Cookie', cookies[who]);
  const short = (no: string) => no.replace(`${PREFIX}-`, '');
  /** 줄을 「보낸 쪽 → 받는 쪽 종류」 글로 — 항목 키를 번호로 바꿔 읽기 쉽게. */
  const edgeText = (body: Body) => {
    const label = new Map((body.nodes as Body[]).map((node) => [node.nodeKey, nodeLabel(node)]));
    return (body.edges as Body[]).map((edge) => `${label.get(edge.from)} -${edge.kind}-> ${label.get(edge.to)}`);
  };
  const nodeLabel = (node: Body): string => {
    if (node.lot) return short(node.lot.lotNo);
    if (node.workOrder) return short(node.workOrder.workOrderNo);
    if (node.shipment) return short(node.shipment.shipmentNo);
    if (node.kind === 'STOCK') return `재고(${short(node.location.code)})`;
    if (node.kind === 'SERIAL' || node.kind === 'COMPONENT_SERIAL') return short(node.serialNo);
    if (node.kind === 'INBOUND_LOT') return short(node.inboundLot.inboundLotNo);
    return node.nodeKey;
  };

  describe('정방향 GET /trace/forward-tree', () => {
    it('US1-1 US1-3 Q3 A 에서 반제품·분할·분리를 지나 고객·재고까지 한 응답으로 — [보기] 없이', async () => {
      const body = (await tree('forward-tree', chain.a).expect(200)).body as Body;

      conformsTo('/trace/forward-tree', 'get', body);
      expect(body.root).toBe(`L:${chain.a}`);
      expect(edgeText(body).sort()).toEqual([
        'A -CONSUMED-> WO-1', 'A -SPLIT-> A-S1', 'A-S1 -CONSUMED-> WO-3',
        'P1 -CONSUMED-> WO-2', 'P2 -STOCKED-> 재고(P-LOC)', 'P3 -SHIPPED-> SH-1',
        'P4 -SPLIT-> P4-S1', 'P4 -STOCKED-> 재고(P-LOC)', 'P4-S1 -SHIPPED-> SH-2',
        'WO-1 -PRODUCED-> P1', 'WO-1 -PRODUCED-> P2', 'WO-2 -PRODUCED-> P3', 'WO-3 -PRODUCED-> P4',
      ].sort());
      const byKey = new Map((body.nodes as Body[]).map((node) => [node.nodeKey, node]));
      expect(byKey.get(`L:${chain.a}`)).toMatchObject({
        kind: 'MATERIAL_LOT', lot: { lotNo: fx.no('A'), statusCode: 'NORMAL' }, qty: 100,
        // F-6 — 005 이후 공급사 LOT 은 lot_external_identifier 에만 있다.
        material: { inboundLotNo: fx.no('IL-1'), supplier: { code: `${PREFIX}-SUP-S` }, supplierLotNo: fx.no('SUP-A'), receivedAt: at(DAY, 7).toISOString() },
      });
      expect(byKey.get(`L:${chain.aS1}`)).toMatchObject({ kind: 'SPLIT_LOT', split: { splitAt: at(DAY, 13).toISOString() } });
      expect(byKey.get(`L:${chain.p1}`)).toMatchObject({ kind: 'PRODUCTION_LOT', producedAt: at(DAY, 9).toISOString() });
      expect(byKey.get(`W:${chain.wo1}`)).toMatchObject({ kind: 'WORK_ORDER', workOrder: { workOrderNo: fx.no('WO-1') }, item: { code: `${PREFIX}-SEMI` } });
      expect(byKey.get(`S:${chain.sh1}`)).toMatchObject({ kind: 'SHIPMENT', shipment: { shipmentNo: fx.no('SH-1'), shippedAt: at(DAY, 12).toISOString(),
        customer: { code: `${PREFIX}-CUS-X` } } });
      const consumed = (body.edges as Body[]).find((edge) => edge.from === `L:${chain.a}` && edge.kind === 'CONSUMED');
      expect(consumed).toMatchObject({ qty: 40, basis: 'RECORDED', firstAt: at(DAY, 8).toISOString(), lastAt: at(DAY, 8).toISOString() });
      expect((body.edges as Body[]).find((edge) => edge.to === `L:${chain.p1}`)).toMatchObject({ qty: 20, basis: 'LOT_GENEALOGY_ESTIMATE' });
      expect(body.limit).toEqual({ exceeded: false, maxDepthReached: false, lotCount: 7, lotCap: 5000 });
    });

    it('US1-2 Q3 반제품 P1 을 고르면 W/O 2 → P3 → SH-1(X) 가 한 응답에 있다', async () => {
      const body = (await tree('forward-tree', chain.p1).expect(200)).body as Body;
      expect(edgeText(body).sort()).toEqual(['P1 -CONSUMED-> WO-2', 'P3 -SHIPPED-> SH-1', 'WO-2 -PRODUCED-> P3']);
    });

    it('경계-여러 길 같은 W/O 에 두 길로 닿아도 줄은 길마다, 항목은 하나 — 근거는 W/O 마다(계보·W/O 단위)', async () => {
      const body = (await tree('forward-tree', ids.x).expect(200)).body as Body;
      const edges = body.edges as Body[];
      expect(edges.filter((edge) => edge.to === `W:${ids.m3}`).map((edge) => edge.from).sort()).toEqual([`L:${ids.s1}`, `L:${ids.s2}`].sort());
      expect((body.nodes as Body[]).filter((node) => node.nodeKey === `L:${ids.f}`)).toHaveLength(1);
      expect(edges.find((edge) => edge.to === `L:${ids.s1}`)?.basis).toBe('LOT_GENEALOGY_ESTIMATE');
      expect(edges.find((edge) => edge.to === `L:${ids.s2}`)?.basis).toBe('WORK_ORDER_ESTIMATE');
    });

    it('Q15 경계-순환 자기 W/O 로 되돌아와도 정상 응답 — 되돌아가는 줄을 싣는다', async () => {
      const body = (await tree('forward-tree', ids.q).expect(200)).body as Body;
      expect(edgeText(body)).toEqual(expect.arrayContaining(['Q -CONSUMED-> WO-CYC', 'WO-CYC -PRODUCED-> Q']));
      expect(body.limit).toMatchObject({ exceeded: false, maxDepthReached: false });
    });

    it('Q15 경계-상한 겹치지 않는 LOT 5,001 이면 limit.exceeded', async () => {
      const body = (await tree('forward-tree', ids.cap).expect(200)).body as Body;
      expect(body.limit).toEqual({ exceeded: true, maxDepthReached: false, lotCount: 5002, lotCap: 5000 });
    });

    it('US1-4 Q16 투입되지 않은 LOT 은 LOT 과 현재 위치만', async () => {
      const body = (await tree('forward-tree', ids.u).expect(200)).body as Body;
      conformsTo('/trace/forward-tree', 'get', body);
      expect(edgeText(body)).toEqual(['U -STOCKED-> 재고(P-LOC)']);
      expect(body.limit.lotCount).toBe(1);
    });

    it('경계-공급사 LOT 옛 입하 LOT 의 공급사 LOT 은 입하 줄 칸에서 읽는다', async () => {
      const body = (await tree('forward-tree', ids.leg).expect(200)).body as Body;
      expect((body.nodes as Body[])[0]).toMatchObject({ kind: 'MATERIAL_LOT',
        material: { inboundLotNo: null, supplier: { code: `${PREFIX}-SUP-S` }, supplierLotNo: 'SUP-LEG', receivedAt: at(DAY, 5).toISOString() } });
    });

    it('Q23 SC-002 항목 약 200 계보 응답 시간을 기록한다 — 목표 3초', async () => {
      const started = Date.now();
      const body = (await tree('forward-tree', ids.r).expect(200)).body as Body;
      const elapsed = Date.now() - started;
      expect((body.nodes as Body[]).length).toBeGreaterThanOrEqual(200);
      // eslint-disable-next-line no-console -- 응답 시간 기록(verification SC-002 · Q23)
      console.log(`[Q23] forward-tree 항목 ${(body.nodes as Body[]).length}개 ${elapsed}ms`);
      expect(elapsed).toBeLessThan(3000);
    });

    it('US1-1 Q4 최종 LOT 목록 — 출하(고객)·재고(창고·위치)·남은 재고·분리 자식, 반제품 P1 은 없고 요약 수가 표와 같다', async () => {
      const body = (await tree('forward-tree', chain.a).expect(200)).body as Body;

      conformsTo('/trace/forward-tree', 'get', body);
      const rows = body.endRows as Body[];
      expect(rows.map((row) => [short(row.lot.lotNo), row.fate])).toEqual([['P2', 'IN_STOCK'], ['P3', 'SHIPPED'], ['P4', 'IN_STOCK'], ['P4-S1', 'SHIPPED']]);
      expect(rows[0]).toMatchObject({ producedQty: 20, shipments: [], viaWorkOrders: [fx.no('WO-1')],
        stock: [{ warehouse: { code: `${PREFIX}-P-WH` }, location: { code: `${PREFIX}-P-LOC` }, qty: 20 }] });
      expect(rows[1]).toMatchObject({ viaWorkOrders: [fx.no('WO-2')], stock: [],
        shipments: [{ shipmentNo: fx.no('SH-1'), customer: { code: `${PREFIX}-CUS-X` }, shippedAt: at(DAY, 12).toISOString(), qty: 20 }] });
      // 분리 자식은 W/O 를 원래 LOT 에서 잇는다 — 원래 LOT P4 는 남은 재고가 있어 함께 선다.
      expect(rows[3]).toMatchObject({ viaWorkOrders: [fx.no('WO-3')], shipments: [{ shipmentNo: fx.no('SH-2'), customer: { code: `${PREFIX}-CUS-Y` }, qty: 10 }] });
      expect(body.summary).toEqual({ lotCount: 7, workOrderCount: 3, endLotCount: 4, shippedLotCount: 2, customerCount: 2, stockLotCount: 2 });
    });

    it('US1-2 반제품 P1 기준 최종 LOT 은 완제품 P3 하나다', async () => {
      const body = (await tree('forward-tree', chain.p1).expect(200)).body as Body;
      expect((body.endRows as Body[]).map((row) => short(row.lot.lotNo))).toEqual(['P3']);
    });

    it('경계-여러 길 같은 LOT 이 두 길로 와도 최종 LOT 목록·요약은 한 번만 센다', async () => {
      const body = (await tree('forward-tree', ids.x).expect(200)).body as Body;
      expect((body.endRows as Body[]).map((row) => short(row.lot.lotNo))).toEqual(['F']);
      expect(body.summary).toMatchObject({ lotCount: 4, workOrderCount: 3, endLotCount: 1 });
      expect((body.endRows as Body[])[0]).toMatchObject({ fate: 'CONSUMED_OUT', viaWorkOrders: [fx.no('WO-M3')] });
    });

    it('US1-4 Q16 투입되지 않은 LOT 은 최종 LOT 목록이 비어 있다', async () => {
      const body = (await tree('forward-tree', ids.u).expect(200)).body as Body;
      expect(body.endRows).toEqual([]);
      expect(body.summary).toMatchObject({ lotCount: 1, endLotCount: 0 });
    });

    it('Q15 상한에 걸리면 최종 LOT·요약은 본 데까지다', async () => {
      const body = (await tree('forward-tree', ids.cap).expect(200)).body as Body;
      expect(body.summary).toMatchObject({ lotCount: 5002, endLotCount: 5001 });
    });

    it('US1-1 다른 공장·없는 LOT 은 404, W-02-13 이 없으면 403', async () => {
      await tree('forward-tree', ids.other).expect(404);
      await tree('forward-tree', 999_999_999n).expect(404);
      await tree('forward-tree', chain.a, {}, 'product').expect(403);
    });
  });

  async function extras(): Promise<void> {
    const t = (hour: number, minute = 0) => at(DAY, hour, minute);
    // 여러 길
    ids.x = await fx.lot('X', fx.ids.mat);
    const m1 = await fx.workOrder('M1', fx.ids.semi);
    const m2 = await fx.workOrder('M2', fx.ids.semi);
    ids.m3 = await fx.workOrder('M3', fx.ids.fg);
    ids.s1 = await fx.productionLot('S1', fx.ids.semi, m1);
    ids.s2 = await fx.productionLot('S2', fx.ids.semi, m2);
    ids.f = await fx.productionLot('F', fx.ids.fg, ids.m3);
    await fx.consume(m1, ids.x, 10, t(8));
    await fx.consume(m2, ids.x, 10, t(8));
    await fx.produce(m1, ids.s1, 10, t(9), [ids.x]);
    await fx.produce(m2, ids.s2, 10, t(9), []);
    await fx.consume(ids.m3, ids.s1, 10, t(10));
    await fx.consume(ids.m3, ids.s2, 10, t(10));
    await fx.produce(ids.m3, ids.f, 20, t(11), [ids.s1, ids.s2]);
    // 순환
    const cyc = await fx.workOrder('CYC', fx.ids.semi);
    ids.q = await fx.productionLot('Q', fx.ids.semi, cyc);
    await fx.consume(cyc, ids.q, 1, t(8));
    await fx.produce(cyc, ids.q, 5, t(9), []);
    // 상한 — 계보 없는 W/O 의 실적 배분 LOT 5,001개(W/O 단위 추정으로 모두 잇는다).
    ids.cap = await fx.lot('CAP', fx.ids.mat);
    const capWo = await fx.workOrder('CAPWO', fx.ids.fg);
    await fx.consume(capWo, ids.cap, 1, t(8));
    await bulkProduce(capWo, 'CAPP', 5001, t(9));
    // 응답 시간 — 생산 LOT 199개(계보 있음).
    ids.r = await fx.lot('R', fx.ids.mat);
    const rWo = await fx.workOrder('RWO', fx.ids.fg);
    await fx.consume(rWo, ids.r, 1, t(8));
    await bulkProduce(rWo, 'RP', 199, t(9), ids.r);
    // 투입 안 된 LOT·옛 입하·다른 공장
    ids.u = await fx.lot('U', fx.ids.mat);
    await fx.stock(ids.u, 100);
    ids.leg = await fx.lot('LEG', fx.ids.mat, { source: 'INBOUND_RECEIPT_LINE' });
    await fx.legacyInbound('LEG', ids.leg, fx.ids.mat, fx.ids.supplierS, t(5), 'SUP-LEG');
    ids.other = await fx.lot('OTHER', fx.ids.mat, { plant: fx.ids.otherPlant });
  }

  /** 실적 하나에 생산 LOT `count` 개를 배분한다. `source` 를 주면 LOT 마다 계보(CONSUMED)를 남긴다. */
  async function bulkProduce(workOrderId: bigint, prefix: string, count: number, when: Date, source?: bigint): Promise<void> {
    await prisma.lot.createMany({ data: Array.from({ length: count }, (_, i) => ({
      lot_no: fx.no(`${prefix}-${String(i).padStart(4, '0')}`), item_id: fx.ids.fg, lot_type_code: 'PRODUCTION', plant_id: fx.ids.plant, initial_qty: 1,
      uom_id: fx.ids.uom, source_type_code: 'WORK_ORDER', source_id: workOrderId, status_code: 'NORMAL',
    })) });
    const lots = await prisma.lot.findMany({ where: { plant_id: fx.ids.plant, lot_no: { startsWith: fx.no(`${prefix}-`) } }, select: { lot_id: true } });
    const result = await prisma.production_result.create({ data: {
      production_result_no: fx.no(`PR-${prefix}`), work_order_id: workOrderId, result_sequence: 1, good_qty: count, uom_id: fx.ids.uom,
      result_source_code: 'POP', occurred_at: when, worker_id: fx.ids.worker, status_code: 'CONFIRMED', idempotency_key: fx.no(`PR-${prefix}-key`),
    } });
    await prisma.production_result_lot_allocation.createMany({ data: lots.map((lot) => ({
      production_result_id: result.production_result_id, lot_id: lot.lot_id, allocated_qty: 1, uom_id: fx.ids.uom,
    })) });
    if (source === undefined) return;
    await prisma.lot_relation.createMany({ data: lots.map((lot) => ({
      source_lot_id: source, target_lot_id: lot.lot_id, relation_type_code: 'CONSUMED', relation_qty: 1, uom_id: fx.ids.uom,
      source_event_type_code: 'PRODUCTION_RESULT', source_event_id: result.production_result_id, allocation_method_code: 'INPUT_TIME_WINDOW',
      trace_accuracy_code: 'ESTIMATED', occurred_at: when,
    })) });
  }
});
