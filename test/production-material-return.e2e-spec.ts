/**
 * 반납 입고(피처 019 · omf-all-around#367) — US1~US3 서버. 시험 이름 앞의 ID 는 verification.md 의 것이다.
 *
 * ⭐ 옛 「반출 요청」 시험(I-10 PR ③ 등록 · 조회 2건)은 새 본문 기준으로 다시 썼다 — 등록은 LOT·수량만 받고 바로 입고한다.
 * ⭐ 최종 마감(017) 판정은 대역(`FinalCloseFake`)으로 바꾼다 — 017 표가 아직 없어 진짜 판정은 늘 거짓이다(R-2).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { allocateStock } from '../src/core/picking';
import { PrismaService } from '../src/prisma/prisma.service';
import { FinalCloseProbe } from '../src/production/material-return/final-close';
import { FinalCloseFake, MaterialReturnFixture, RETURNS } from './support/material-return-fixture';
import { contractValidator } from './support/wip-lot-fixture';

const CONTRACT = 'production-02생산실행.json';
const OVER = (n: number) => `출고된 양보다 많이 반납할 수 없습니다 (반납 가능 ${n})`;

describe('반납 입고 (e2e)', () => {
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

  /** W/O 하나에 LOT 하나를 `qty` 만큼 출고한 상태. */
  async function issued(qty: number, key: 'A' | 'B' | 'C' = 'A', status?: string) {
    const wo = await fx.workOrder();
    const lot = await fx.lot(key, { status });
    const { goodsIssueLineId } = await fx.issue(lot.lotId, qty, wo.workOrderId);
    return { ...wo, ...lot, goodsIssueLineId };
  }

  describe('US1 창고 POP 반납 입고', () => {
    it('US1-1 LOT 스캔 → 품목·단위·반납 가능 양·귀속될 W/O·출고 생산창고', async () => {
      const a = await issued(120);
      const response = await fx.lookup(a.lotNo).expect(200);
      expect(response.body).toMatchObject({
        lotId: Number(a.lotId), lotNo: a.lotNo, returnableQty: 120, labelUnprinted: false,
        item: { itemId: Number(fx.ids.itemA) }, uom: { uomId: Number(fx.ids.uom) },
        workOrder: { workOrderId: Number(a.workOrderId), workOrderNo: a.workOrderNo, finalized: false },
        issueWarehouse: { warehouseId: Number(fx.ids.g) },
      });
      expect(contractValidator(CONTRACT, 'GET /production/material-returns/lot-lookup')(response.body)).toBe(true);
    });

    it('US1-2·Q1·SC-001 POP 에서 20 반납 → G 적치 대기 +20, 원장 「반납 입고」, 줄은 W/O 귀속(AUTO)', async () => {
      const a = await issued(120);
      const occurredAt = '2026-11-28T02:10:00.000Z';
      const response = await fx.receive([{ lotId: a.lotId, returnQty: 20 }], fx.pop, { occurredAt }).expect(201);
      expect(contractValidator(CONTRACT, 'POST /production/material-returns', 201)(response.body)).toBe(true);
      expect(response.body).toMatchObject({
        statusCode: 'RECEIVED', terminalKindCode: 'POP', businessDate: '2026-11-28', receivedAt: occurredAt,
        destinationWarehouseId: Number(fx.ids.g),
        lines: [{ lotId: Number(a.lotId), returnQty: 20, workOrderId: Number(a.workOrderId), workOrderNo: a.workOrderNo,
          attributionCode: 'AUTO_LATEST_ISSUE', destinationLocationId: Number(fx.ids.staging), labelUnprinted: false }],
      });
      expect(response.body).not.toHaveProperty('workOrderId');

      expect(await fx.onHand(a.lotId)).toEqual([[fx.ids.staging, 20, 'NORMAL', 'AVAILABLE']]);
      const header = await prisma.material_return.findUniqueOrThrow({ where: { material_return_id: BigInt(response.body.materialReturnId) } });
      expect(header).toMatchObject({ status_code: 'RECEIVED', terminal_kind_code: 'POP', received_by: fx.pop.workerId, work_order_id: null, source_location_id: null });
      expect(header.received_at?.toISOString()).toBe(occurredAt);
      const [line] = await fx.returnLines(response.body.materialReturnId);
      expect(line).toMatchObject({ work_order_id: a.workOrderId, goods_issue_line_id: a.goodsIssueLineId, attribution_code: 'AUTO_LATEST_ISSUE' });
      const ledger = await prisma.inventory_transaction_line.findUniqueOrThrow({
        where: { inventory_transaction_line_id: line.inventory_transaction_line_id as bigint }, include: { inventory_transaction: true },
      });
      expect(ledger.inventory_transaction).toMatchObject({
        transaction_type_code: 'MATERIAL_RETURN', source_document_type_code: 'MATERIAL_RETURN',
        source_document_id: BigInt(response.body.materialReturnId), transaction_no: response.body.materialReturnNo,
      });
      expect(ledger.inventory_transaction.business_date.toISOString().slice(0, 10)).toBe('2026-11-28');
      expect(ledger).toMatchObject({ from_location_id: null, to_location_id: fx.ids.staging, to_quality_status_code: 'NORMAL' });
      // FR-008 ERP 로 보내지 않는다 — 이 반납을 가리키는 연계 메시지가 없다.
      expect(await prisma.integration_message.count({ where: { target_id: BigInt(response.body.materialReturnId), target_type_code: 'MATERIAL_RETURN' } })).toBe(0);
    });

    it('US1-3·Q2·SC-002 남은 100 에 101 → 400 RANGE 「반납 가능 100」, 재고 그대로', async () => {
      const a = await issued(120);
      await fx.receive([{ lotId: a.lotId, returnQty: 20 }]).expect(201);
      const response = await fx.receive([{ lotId: a.lotId, returnQty: 101 }]).expect(400);
      expect(response.body.errors).toEqual([expect.objectContaining({ field: 'lines[0].returnQty', code: 'RANGE', message: OVER(100) })]);
      expect((await fx.lookup(a.lotNo).expect(200)).body.returnableQty).toBe(100);
      expect(await fx.onHand(a.lotId)).toEqual([[fx.ids.staging, 20, 'NORMAL', 'AVAILABLE']]);
    });

    it('US1-4·Q3·SC-002 입하만 된 LOT·반제품·제품 LOT 은 「반납할 수 있는 자재 LOT 이 아닙니다」, 다 반납한 LOT 은 「반납할 양이 남지 않았습니다」', async () => {
      const inboundOnly = await fx.lot('A');
      const wo = await fx.workOrder();
      const wip = await fx.lot('A', { lotType: 'WIP', source: ['WORK_ORDER', wo.workOrderId] });
      await fx.issue(wip.lotId, 10, wo.workOrderId);
      const product = await fx.lot('A', { lotType: 'PRODUCTION', source: ['WORK_ORDER', wo.workOrderId] });
      await fx.issue(product.lotId, 10, wo.workOrderId);
      for (const lot of [inboundOnly, wip, product]) {
        const response = await fx.lookup(lot.lotNo).expect(400);
        expect(response.body.errors).toEqual([expect.objectContaining({ code: 'NOT_RETURNABLE', message: '반납할 수 있는 자재 LOT 이 아닙니다' })]);
        const write = await fx.receive([{ lotId: lot.lotId, returnQty: 1 }]).expect(400);
        expect(write.body.errors[0]).toMatchObject({ field: 'lines[0].lotId', code: 'NOT_RETURNABLE' });
      }
      const done = await issued(30);
      await fx.receive([{ lotId: done.lotId, returnQty: 30 }]).expect(201);
      expect((await fx.lookup(done.lotNo).expect(400)).body.errors[0]).toMatchObject({ code: 'NOTHING_TO_RETURN', message: '반납할 양이 남지 않았습니다' });
      expect((await fx.receive([{ lotId: done.lotId, returnQty: 1 }]).expect(400)).body.errors[0]).toMatchObject({ code: 'NOTHING_TO_RETURN' });
      await fx.lookup(`${fx.run}-없는-LOT`).expect(404);
    });

    it('US1-5·Q4 LOT 셋을 한 번에 → 반납 한 건, 줄 셋', async () => {
      const lots = [await issued(50, 'A'), await issued(60, 'B'), await issued(70, 'C')];
      const response = await fx.receive(lots.map((lot, index) => ({ lotId: lot.lotId, returnQty: 10 * (index + 1) }))).expect(201);
      expect(response.body.lines.map((line: { lotId: number; returnQty: number }) => [line.lotId, line.returnQty]))
        .toEqual([[Number(lots[0].lotId), 10], [Number(lots[1].lotId), 20], [Number(lots[2].lotId), 30]]);
      expect(await prisma.material_return_line.count({ where: { material_return_id: BigInt(response.body.materialReturnId) } })).toBe(3);
      const ledger = await prisma.inventory_transaction.count({ where: { source_document_type_code: 'MATERIAL_RETURN', source_document_id: BigInt(response.body.materialReturnId) } });
      expect(ledger).toBe(1);
    });

    it('US1-6·Q5 「반납 가능」이 꺼진 POP 은 403(조회·등록 모두), 남의 공장 POP 은 이 공장 LOT 을 못 찾는다', async () => {
      const a = await issued(40);
      const lookup = await fx.lookup(a.lotNo, fx.popOff).expect(403);
      expect(lookup.body.errors[0].message).toContain('반납 가능');
      await fx.receive([{ lotId: a.lotId, returnQty: 1 }], fx.popOff).expect(403);
      await fx.lookup(a.lotNo, fx.foreignPop).expect(404);
      await fx.receive([{ lotId: a.lotId, returnQty: 1 }], fx.foreignPop).expect(400);
      expect(await fx.onHand(a.lotId)).toEqual([]);
    });

    it('FR-007 품질·재고 상태는 LOT 의 지금 상태 그대로 — 불량 LOT 은 DEFECTIVE/ON_HOLD', async () => {
      const bad = await issued(30, 'A', 'DEFECTIVE');
      await fx.receive([{ lotId: bad.lotId, returnQty: 5 }]).expect(201);
      expect(await fx.onHand(bad.lotId)).toEqual([[fx.ids.staging, 5, 'DEFECTIVE', 'ON_HOLD']]);
    });

    it('SC-003 동시성 — 남은 100 에 60·60 두 요청은 하나만 201 이다', async () => {
      const a = await issued(100);
      const results = await Promise.all([fx.receive([{ lotId: a.lotId, returnQty: 60 }]), fx.receive([{ lotId: a.lotId, returnQty: 60 }])]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 400]);
      expect(results.find((result) => result.status === 400)?.body.errors[0]).toMatchObject({ code: 'RANGE', message: OVER(40) });
      expect(await fx.onHand(a.lotId)).toEqual([[fx.ids.staging, 60, 'NORMAL', 'AVAILABLE']]);
    });

    it('C-9 같은 Idempotency-Key 두 번 → 한 건(같은 응답)', async () => {
      const a = await issued(50);
      const key = randomUUID();
      const first = await fx.receive([{ lotId: a.lotId, returnQty: 10 }], fx.pop, { key }).expect(201);
      const second = await fx.receive([{ lotId: a.lotId, returnQty: 10 }], fx.pop, { key }).expect(201);
      expect(second.body.materialReturnId).toBe(first.body.materialReturnId);
      expect(await fx.onHand(a.lotId)).toEqual([[fx.ids.staging, 10, 'NORMAL', 'AVAILABLE']]);
    });

    it('D-1 옛 본문(workOrderId·sourceLocationId·destinationWarehouseId 머리)은 400', async () => {
      const a = await issued(50);
      const response = await fx.receive([{ lotId: a.lotId, returnQty: 10 }], fx.pop, {
        extra: { workOrderId: Number(a.workOrderId), sourceLocationId: Number(fx.ids.s01), destinationWarehouseId: Number(fx.ids.g) },
      }).expect(400);
      expect(JSON.stringify(response.body.errors)).toContain('sourceLocationId');
      const old = await fx.as(fx.http().post(RETURNS).set('Idempotency-Key', randomUUID()).send({
        workOrderId: Number(a.workOrderId), sourceLocationId: Number(fx.ids.s01), destinationWarehouseId: Number(fx.ids.g),
        lines: [{ itemId: Number(fx.ids.itemA), lotId: Number(a.lotId), returnQty: 1, uomId: Number(fx.ids.uom) }],
      }), fx.pop).expect(400);
      expect(old.body.errors.length).toBeGreaterThan(0);
      expect(await fx.onHand(a.lotId)).toEqual([]);
    });

    it('FR-009 취소·상태 전이 경로가 없다 — 계약에도 라우트에도', async () => {
      const contract = (await import(`../contracts/${CONTRACT}`)) as { paths: Record<string, Record<string, unknown>> };
      const paths = Object.keys(contract.paths).filter((path) => path.startsWith('/production/material-returns'));
      expect(paths.filter((path) => path.includes(':'))).toEqual([]);
      expect(paths.flatMap((path) => Object.keys(contract.paths[path])).filter((method) => !['get', 'post'].includes(method))).toEqual([]);
      const a = await issued(10);
      const created = await fx.receive([{ lotId: a.lotId, returnQty: 5 }]).expect(201);
      await fx.as(fx.http().post(`${RETURNS}/${created.body.materialReturnId}:cancel`).set('Idempotency-Key', randomUUID()).send({}), 'session').expect(404);
    });

    it('R-3 #362 전 출고분 — 도착 위치에 남은 그 LOT 재고에서 빼서 옮기고, 모자라는 양만 입고한다', async () => {
      const wo = await fx.workOrder();
      const lot = await fx.lot('A');
      await fx.issue(lot.lotId, 80, wo.workOrderId, { destinationLocationId: fx.ids.fl01 });
      await fx.balance(lot.lotId, 'A', fx.ids.floor, fx.ids.fl01, 50);
      const moved = await fx.receive([{ lotId: lot.lotId, returnQty: 30 }]).expect(201);
      expect(await fx.onHand(lot.lotId)).toEqual([[fx.ids.staging, 30, 'NORMAL', 'AVAILABLE'], [fx.ids.fl01, 20, 'NORMAL', 'AVAILABLE']].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
      const [line] = await fx.returnLines(moved.body.materialReturnId);
      const ledger = await prisma.inventory_transaction_line.findUniqueOrThrow({ where: { inventory_transaction_line_id: line.inventory_transaction_line_id as bigint } });
      expect(ledger).toMatchObject({ from_location_id: fx.ids.fl01, to_location_id: fx.ids.staging });
      expect(Number(ledger.qty)).toBe(30);
      // 남은 현장 재고 20 + 새로 들어오는 20.
      await fx.receive([{ lotId: lot.lotId, returnQty: 40 }]).expect(201);
      expect(await fx.onHand(lot.lotId)).toEqual([[fx.ids.staging, 70, 'NORMAL', 'AVAILABLE']]);
    });
  });

  describe('US2 PDA 반납 입고·적치', () => {
    it('US2-1·Q6·SC-001 PDA LOT·수량·위치 S-01 → S-01 +10, 단말 PDA', async () => {
      const a = await issued(120);
      const response = await fx.receive([{ lotId: a.lotId, returnQty: 10, destinationLocationId: fx.ids.s01 }], fx.pda).expect(201);
      expect(response.body).toMatchObject({ terminalKindCode: 'PDA', lines: [{ destinationLocationId: Number(fx.ids.s01), attributionCode: 'AUTO_LATEST_ISSUE' }] });
      expect(await fx.onHand(a.lotId)).toEqual([[fx.ids.s01, 10, 'NORMAL', 'AVAILABLE']]);
      expect((await prisma.material_return.findUniqueOrThrow({ where: { material_return_id: BigInt(response.body.materialReturnId) } })).received_by).toBe(fx.pda.workerId);
    });

    it('US2-3 「지정 품목만 받기」 위치에 다른 품목 → 400 RESTRICTED_LOCATION, 미지정 위치는 확인해야 받는다(409 → 확인 뒤 201·보관 품목 추가)', async () => {
      const a = await issued(50);
      const restricted = await fx.receive([{ lotId: a.lotId, returnQty: 5, destinationLocationId: fx.ids.r01 }], fx.pda).expect(400);
      expect(restricted.body.errors[0]).toMatchObject({ field: 'lines[0].destinationLocationId', code: 'RESTRICTED_LOCATION', message: '이 위치는 지정 품목만 받습니다.' });
      const staging = await fx.receive([{ lotId: a.lotId, returnQty: 5, destinationLocationId: fx.ids.staging }], fx.pda).expect(400);
      expect(staging.body.errors[0]).toMatchObject({ code: 'STAGING' });
      const u01 = await fx.freshLocation(fx.ids.g);
      const confirm = await fx.receive([{ lotId: a.lotId, returnQty: 5, destinationLocationId: u01 }], fx.pda).expect(409);
      expect(confirm.body.errors[0]).toMatchObject({ code: 'UNDESIGNATED_NEEDS_CONFIRM' });
      await fx.receive([{ lotId: a.lotId, returnQty: 5, destinationLocationId: u01, confirmUndesignated: true }], fx.pda).expect(201);
      expect(await fx.onHand(a.lotId)).toEqual([[u01, 5, 'NORMAL', 'AVAILABLE']]);
      expect(await prisma.location_item.count({ where: { location_id: u01, item_id: fx.ids.itemA } })).toBe(1);
    });

    it('US2-2·Q7 PDA 위치 없이 → 출고 생산창고 적치 대기', async () => {
      const a = await issued(50);
      await fx.receive([{ lotId: a.lotId, returnQty: 7 }], fx.pda).expect(201);
      expect(await fx.onHand(a.lotId)).toEqual([[fx.ids.staging, 7, 'NORMAL', 'AVAILABLE']]);
    });

    it('US2-2 경계 — 출고 창고와 다른 생산창고 위치를 스캔하면 그 창고로 받는다', async () => {
      const a = await issued(50);
      const s21 = await fx.freshLocation(fx.ids.g2);
      const response = await fx.receive([{ lotId: a.lotId, returnQty: 8, destinationLocationId: s21, confirmUndesignated: true }], fx.pda).expect(201);
      expect(response.body.lines[0]).toMatchObject({ destinationWarehouseId: Number(fx.ids.g2) });
      expect(await fx.onHand(a.lotId)).toEqual([[s21, 8, 'NORMAL', 'AVAILABLE']]);
    });

    it('US2-4·Q8 적치 대기의 반납분은 위치 이동으로 자리를 옮기고, 다른 W/O 피킹 후보로 잡힌다', async () => {
      const a = await issued(50, 'C');
      await fx.receive([{ lotId: a.lotId, returnQty: 20 }], fx.pda).expect(201);
      // ⭐ 다른 W/O 의 피킹 배정이 적치 대기의 반납분을 후보로 잡는다(출발 창고 G) — 앞 시험의 C 재고까지 다 집도록 넉넉히 요구한다.
      const allocation = await allocateStock(prisma as unknown as Prisma.TransactionClient, {
        plantId: fx.ids.plant, warehouseId: fx.ids.g, demands: [{ lineNo: 1, itemId: fx.ids.itemC, uomId: fx.ids.uom, qty: new Prisma.Decimal(100000) }],
      });
      const picked = allocation.orders.flatMap((order) => order.lines).filter((line) => line.lotId === a.lotId);
      expect(picked.map((line) => line.locationId)).toEqual([fx.ids.staging]);
      // ⭐ 자리 이동 — 적치 대기 → S-01(같은 창고 위치 이동).
      await fx.as(fx.http().post('/api/logistics/location-moves').set('Idempotency-Key', randomUUID()).send({
        warehouseId: Number(fx.ids.g), businessDate: '2026-11-28', occurredAt: '2026-11-28T03:00:00.000Z',
        lines: [{ lotId: Number(a.lotId), fromLocationId: Number(fx.ids.staging), toLocationId: Number(fx.ids.s01), qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', qty: 20 }],
      }), 'session').expect(201);
      expect(await fx.onHand(a.lotId)).toEqual([[fx.ids.s01, 20, 'NORMAL', 'AVAILABLE']]);
    });
  });

  describe('US3 W/O 자동 귀속', () => {
    it('US3-1 W/O 하나에만 출고된 LOT → 전량 그 W/O 귀속', async () => {
      const a = await issued(40);
      await fx.receive([{ lotId: a.lotId, returnQty: 15 }]).expect(201);
      await fx.receive([{ lotId: a.lotId, returnQty: 25 }], fx.pda).expect(201);
      expect(await fx.attributedSum(a.workOrderId, a.lotId)).toBe(40);
    });

    it('US3-2·Q9 출고 → 전량 반납 → 다른 W/O 로 다시 출고 → 반납: 새 W/O 귀속, 가능 양은 새 출고 기준', async () => {
      const a = await issued(120);
      await fx.receive([{ lotId: a.lotId, returnQty: 120 }]).expect(201);
      const wo12 = await fx.workOrder();
      const again = await fx.issue(a.lotId, 90, wo12.workOrderId, { at: '2026-11-28T05:00:00.000Z' });
      const lookup = await fx.lookup(a.lotNo).expect(200);
      expect(lookup.body).toMatchObject({ returnableQty: 90, workOrder: { workOrderId: Number(wo12.workOrderId) } });
      const response = await fx.receive([{ lotId: a.lotId, returnQty: 50 }]).expect(201);
      expect(response.body.lines[0]).toMatchObject({ workOrderId: Number(wo12.workOrderId), goodsIssueLineId: Number(again.goodsIssueLineId) });
      expect(await fx.attributedSum(a.workOrderId, a.lotId)).toBe(120);
      expect(await fx.attributedSum(wo12.workOrderId, a.lotId)).toBe(50);
      await fx.receive([{ lotId: a.lotId, returnQty: 41 }]).expect(400);
    });

    it('US3-3·Q10 최종 마감 W/O → 재고는 들어오고 줄은 귀속 없음(NONE_FINALIZED · W/O null)', async () => {
      const a = await issued(60);
      finalClose.finalized.add(a.workOrderId);
      expect((await fx.lookup(a.lotNo).expect(200)).body.workOrder.finalized).toBe(true);
      const response = await fx.receive([{ lotId: a.lotId, returnQty: 25 }]).expect(201);
      expect(response.body.lines[0]).toMatchObject({ workOrderId: null, workOrderNo: null, attributionCode: 'NONE_FINALIZED' });
      expect(await fx.onHand(a.lotId)).toEqual([[fx.ids.staging, 25, 'NORMAL', 'AVAILABLE']]);
      const [line] = await fx.returnLines(response.body.materialReturnId);
      expect(line).toMatchObject({ work_order_id: null, goods_issue_line_id: a.goodsIssueLineId, attribution_code: 'NONE_FINALIZED' });
      // 귀속 없음 줄도 그 출고 라인 뒤의 반납이라 반납 가능 양에서 빠진다.
      expect((await fx.lookup(a.lotNo).expect(200)).body.returnableQty).toBe(35);
    });

    it('Q15 오프라인 대기분(앞선 occurredAt)이 최종 마감 뒤 도착 → 도착 때 판정으로 귀속 없음', async () => {
      const a = await issued(60);
      const queuedAt = '2026-11-27T23:00:00.000Z';
      finalClose.finalized.add(a.workOrderId);
      const response = await fx.receive([{ lotId: a.lotId, returnQty: 10 }], fx.pop, { occurredAt: queuedAt, businessDate: '2026-11-28' }).expect(201);
      expect(response.body).toMatchObject({ receivedAt: queuedAt, lines: [{ attributionCode: 'NONE_FINALIZED', workOrderId: null }] });
    });

    it('SC-003 출고·반납 순서를 섞어도 W/O 별 귀속 합 ≤ 그 W/O 출고량, 귀속 W/O = 그때 가장 최근 출고 W/O', async () => {
      const lot = await fx.lot('B');
      const orders = [await fx.workOrder(), await fx.workOrder(), await fx.workOrder()];
      const issuedTo = new Map<bigint, number>();
      let seed = 19;
      const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
      let hour = 0;
      for (let round = 0; round < 6; round += 1) {
        const wo = orders[rand(3)];
        const qty = 20 + rand(30);
        hour += 1;
        await fx.issue(lot.lotId, qty, wo.workOrderId, { at: `2026-11-29T${String(hour).padStart(2, '0')}:00:00.000Z` });
        issuedTo.set(wo.workOrderId, (issuedTo.get(wo.workOrderId) ?? 0) + qty);
        const returnQty = 1 + rand(qty);
        const response = await fx.receive([{ lotId: lot.lotId, returnQty }]).expect(201);
        expect(response.body.lines[0].workOrderId).toBe(Number(wo.workOrderId));
      }
      for (const wo of orders) expect(await fx.attributedSum(wo.workOrderId, lot.lotId)).toBeLessThanOrEqual(issuedTo.get(wo.workOrderId) ?? 0);
    });

    it('US3-5·Q14(019 몫) 여러 반납 뒤 W/O·LOT 별 귀속 합 = 손계산, 귀속 없음 줄은 어느 W/O 합에도 없다', async () => {
      const a = await issued(100);
      const b = await issued(80, 'B');
      await fx.receive([{ lotId: a.lotId, returnQty: 10 }, { lotId: b.lotId, returnQty: 5 }]).expect(201);
      await fx.receive([{ lotId: a.lotId, returnQty: 15 }], fx.pda).expect(201);
      finalClose.finalized.add(b.workOrderId);
      await fx.receive([{ lotId: b.lotId, returnQty: 20 }]).expect(201);
      expect(await fx.attributedSum(a.workOrderId, a.lotId)).toBe(25);
      expect(await fx.attributedSum(b.workOrderId, b.lotId)).toBe(5);
      const unattributed = await prisma.material_return_line.aggregate({ where: { lot_id: b.lotId, work_order_id: null }, _sum: { return_qty: true } });
      expect(Number(unattributed._sum.return_qty)).toBe(20);
    });

    it('US3-4·Q13 LOT 거래 이력에 거래 유형 MATERIAL_RETURN 줄(W/O 칸 없음), 위치별 조회에 G 적치 대기 반납분', async () => {
      const a = await issued(30);
      await fx.receive([{ lotId: a.lotId, returnQty: 12 }]).expect(201);
      const history = await fx.as(fx.http().get('/api/inventory/transactions').query({
        lotId: Number(a.lotId), businessDateFrom: '2026-11-28', businessDateTo: '2026-11-28',
      }), 'session').expect(200);
      expect(history.body.items).toHaveLength(1);
      expect(history.body.items[0]).toMatchObject({ transactionTypeCode: 'MATERIAL_RETURN', sourceDocumentTypeCode: 'MATERIAL_RETURN' });
      expect(JSON.stringify(history.body.items[0])).not.toMatch(/workOrder/i);
      const balances = await fx.as(fx.http().get('/api/inventory/balances').query({ lotId: Number(a.lotId), warehouseId: Number(fx.ids.g) }), 'session').expect(200);
      expect(balances.body.items).toEqual([expect.objectContaining({ locationId: Number(fx.ids.staging), onHandQty: 12 })]);
    });
  });

  describe('§5 조회', () => {
    it('상세·목록이 반납 입고 줄을 새 칸과 함께 낸다(계약 모양)', async () => {
      const a = await issued(30);
      const created = await fx.receive([{ lotId: a.lotId, returnQty: 3 }]).expect(201);
      const detail = await fx.as(fx.http().get(`${RETURNS}/${created.body.materialReturnId}`), 'session').expect(200);
      expect(detail.body).toMatchObject({ materialReturnNo: created.body.materialReturnNo, statusCode: 'RECEIVED', lines: [{ attributionCode: 'AUTO_LATEST_ISSUE' }] });
      expect(detail.body.lines[0]).not.toHaveProperty('labelUnprinted');
      expect(contractValidator(CONTRACT, 'GET /production/material-returns/{materialReturnId}')(detail.body)).toBe(true);
      const list = await fx.as(fx.http().get(RETURNS).query({ statusCode: 'RECEIVED', size: 5 }), 'session').expect(200);
      expect(contractValidator(CONTRACT, 'GET /production/material-returns')(list.body)).toBe(true);
    });
  });
});
