/**
 * 피처 013 생산 LOT 수량 분리(omf-all-around#303) — POP 스캔 조회·분리·확인 대기 목록·막는 조건 (e2e).
 *
 * 시험 이름 앞의 ID 는 `specs/013-product-lot-split/verification.md`·`quickstart.md` 의 항목이다.
 * 바탕(공장·창고·품목·W/O·단말)은 `support/product-lot-split-fixture.ts` 가 만든다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductLotSplitFixture } from './support/product-lot-split-fixture';

function validator(path: string, method: string, status: string): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8')) as object;
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('생산 LOT 수량 분리 (e2e)', () => {
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

  /** 분리 기록을 PDA 확인 없이 확인됨으로 — 재분리 시험의 바탕(확인 경로는 S3 시험이 따로 본다). */
  const markConfirmed = (splitId: number) => prisma.product_lot_split.update({
    where: { product_lot_split_id: BigInt(splitId) },
    data: { confirmed_at: new Date(), confirmed_terminal_id: f.pda.terminalId, confirmed_worker_no: f.pda.workerNo },
  });

  /** 막힌 요청 뒤 — LOT·재고·분리 기록이 그대로다. */
  const expectUnchanged = async (lotId: number, before: [number, number][]) => {
    expect(await f.onHand(lotId)).toEqual(before);
    expect(await prisma.lot.count({ where: { parent_lot_id: BigInt(lotId) } })).toBe(0);
    expect(await prisma.product_lot_split.count({ where: { parent_lot_id: BigInt(lotId) } })).toBe(0);
  };

  describe('스캔 조회 — GET :lookup', () => {
    it('Q24·FR-001 위치별 보유·고를 수 있음·라벨 수량을 낸다 — 불량 창고 몫은 빠지고 적치 대기·제품 창고 밖 몫은 막힌다', async () => {
      const { workOrderId, workOrderNo } = await f.workOrder();
      const lot = await f.lot({ workOrderId, balances: [
        { at: 'A', qty: 60 }, { at: 'B', qty: 40 }, { at: 'staging', qty: 20 }, { at: 'general', qty: 5 }, { at: 'defect', qty: 3 },
      ] });

      const response = await f.lookup(lot.lotNo).expect(200);

      expect(validator('/logistics/product-lot-splits:lookup', 'get', '200')(response.body)).toBe(true);
      expect(response.body.lot).toMatchObject({
        lotId: lot.lotId, lotNo: lot.lotNo, itemCode: 'PLSE2E-A', statusCode: 'NORMAL', workOrderNo, labelQty: 128,
      });
      expect(response.body.blocked).toBeNull();
      const byLocation = new Map((response.body.locations as { locationId: number }[]).map((row) => [row.locationId, row]));
      expect(byLocation.size).toBe(4);
      expect(byLocation.get(f.locationOf('A'))).toMatchObject({ onHandQty: 60, selectable: true, blocked: null, warehouseCode: 'PLSE2E-FG' });
      expect(byLocation.get(f.locationOf('B'))).toMatchObject({ onHandQty: 40, selectable: true, blocked: null });
      expect(byLocation.get(f.locationOf('A'))).toMatchObject({ systemRoleCode: null });
      expect(byLocation.get(f.locationOf('staging'))).toMatchObject({
        onHandQty: 20, selectable: false, blocked: { code: 'PUTAWAY_PENDING' }, systemRoleCode: 'PUTAWAY_STAGING',
      });
      expect(byLocation.get(f.locationOf('general'))).toMatchObject({ onHandQty: 5, selectable: false, blocked: { code: 'NOT_PRODUCT_WAREHOUSE' } });
    });

    it.each([
      ['Q8 피킹이 걸린 LOT', { balances: [{ at: 'A' as const, qty: 100, picked: 100 }] }, 'LOT_ALREADY_RESERVED'],
      ['Q9 불량 LOT', { status: 'DEFECTIVE', balances: [{ at: 'A' as const, qty: 100 }] }, 'INVALID_STATE'],
      ['Q21 시리얼 관리 품목 LOT', { item: 'S' as const, balances: [{ at: 'A' as const, qty: 100 }] }, 'SPLIT_SERIAL_LOT'],
      ['Q13 자재 LOT', { item: 'M' as const, balances: [{ at: 'A' as const, qty: 100 }] }, 'NOT_PRODUCTION_LOT'],
    ])('Q24 %s 은 LOT 단위 blocked.code 로 스캔 즉시 이유를 낸다', async (_name, spec, code) => {
      const lot = await f.lot(spec);

      const response = await f.lookup(lot.lotNo).expect(200);

      expect(response.body.blocked).toMatchObject({ code });
      expect(validator('/logistics/product-lot-splits:lookup', 'get', '200')(response.body)).toBe(true);
    });

    it('Q24 확인 대기 분리가 걸린 LOT 은 LOT_SPLIT_UNCONFIRMED 와 분리 시각을 detail 로 낸다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);

      const response = await f.lookup(lot.lotNo).expect(200);

      expect(response.body.blocked.code).toBe('LOT_SPLIT_UNCONFIRMED');
      expect(response.body.blocked.detail).toEqual(expect.any(String));
    });

    it('Q24 없는 번호·다른 공장 LOT 은 404, MOBILE 단말은 거절된다', async () => {
      const foreign = await f.lot({ plant: f.ids.plant2, initialQty: 10, balances: [] });

      await f.lookup(`${f.run}-없는-LOT`).expect(404);
      await f.lookup(foreign.lotNo).expect(404);
      const mobile = await f.lookup(foreign.lotNo, f.pda);
      expect([401, 403]).toContain(mobile.status);
    });
  });

  describe('분리 — POST', () => {
    it('US1-1·SC-002·Q1 100 에서 30 을 떼면 자식 30 이 같은 위치, 원래 70 — 원장 LOT_SPLIT 1건 2줄, 분리 기록 확인 대기', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });

      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);

      expect(validator('/logistics/product-lot-splits', 'post', '200')(response.body)).toBe(true);
      const child = response.body.childLot as { lotId: number; lotNo: string };
      expect(child.lotNo).toBe(`${lot.lotNo}-S1`);
      expect(await f.onHand(lot.lotId)).toEqual([[f.locationOf('A'), 70]]);
      expect(await f.onHand(child.lotId)).toEqual([[f.locationOf('A'), 30]]);
      const ledger = await prisma.inventory_transaction.findMany({
        where: { transaction_type_code: 'LOT_SPLIT', source_document_type_code: 'PRODUCT_LOT_SPLIT', source_document_id: BigInt(response.body.productLotSplitId) },
        include: { inventory_transaction_line: true },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].transaction_no).toBe(`PLS-${response.body.productLotSplitId}`);
      expect(ledger[0].inventory_transaction_line).toHaveLength(2);
      const split = await prisma.product_lot_split.findUniqueOrThrow({ where: { product_lot_split_id: BigInt(response.body.productLotSplitId) } });
      expect(split).toMatchObject({
        parent_lot_id: BigInt(lot.lotId), child_lot_id: BigInt(child.lotId), location_id: BigInt(f.locationOf('A')), warehouse_id: f.ids.fg,
        confirmed_at: null, split_worker_no: f.pop.workerNo, split_terminal_id: f.pop.terminalId,
      });
      expect(Number(split.split_qty)).toBe(30);
    });

    it('US1-2·Q2 자식은 품목·단위·상태·생애·유효기간·제조일·BOM·부모를 잇고 SPLIT 계보가 남는다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });

      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);

      const [parent, child] = await Promise.all([
        prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lot.lotId) } }),
        prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(response.body.childLot.lotId) } }),
      ]);
      expect(child).toMatchObject({
        item_id: parent.item_id, uom_id: parent.uom_id, status_code: parent.status_code, lifecycle_status_code: parent.lifecycle_status_code,
        expiry_date: parent.expiry_date, manufactured_at: parent.manufactured_at, bom_id: parent.bom_id, lot_type_code: parent.lot_type_code,
        parent_lot_id: parent.lot_id, source_type_code: 'PRODUCT_LOT_SPLIT', source_id: BigInt(response.body.productLotSplitId),
      });
      expect(Number(child.initial_qty)).toBe(30);
      const relation = await prisma.lot_relation.findFirstOrThrow({ where: { target_lot_id: child.lot_id } });
      expect(relation).toMatchObject({
        source_lot_id: parent.lot_id, relation_type_code: 'SPLIT', source_event_type_code: 'PRODUCT_LOT_SPLIT',
        source_event_id: BigInt(response.body.productLotSplitId),
      });
      expect(Number(relation.relation_qty)).toBe(30);
    });

    it('US1-3·Q3 발행 기록 2건 — 원래는 다음 회차·사유 LOT_SPLIT, 자식은 1회차·사유 없음, 응답 qty 는 70·30', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      await prisma.document_issue_log.create({ data: {
        document_type_code: 'PRODUCTION_LOT_LABEL', target_type_code: 'LOT', target_id: BigInt(lot.lotId), lot_id: BigInt(lot.lotId),
        issue_seq: 1, issued_by: f.ids.userId,
      } });

      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);

      expect(response.body.parentLot).toMatchObject({ lotId: lot.lotId, qty: 70, issueSeq: 2 });
      expect(response.body.childLot).toMatchObject({ qty: 30, issueSeq: 1 });
      const [parentIssue, childIssue] = await Promise.all([
        prisma.document_issue_log.findUniqueOrThrow({ where: { document_issue_log_id: BigInt(response.body.parentLot.documentIssueLogId) } }),
        prisma.document_issue_log.findUniqueOrThrow({ where: { document_issue_log_id: BigInt(response.body.childLot.documentIssueLogId) } }),
      ]);
      expect(parentIssue).toMatchObject({
        document_type_code: 'PRODUCTION_LOT_LABEL', lot_id: BigInt(lot.lotId), issue_seq: 2, reissue_reason_code: 'LOT_SPLIT',
        terminal_id: f.pop.terminalId, issued_worker_id: f.pop.workerId, print_outcome_code: 'PENDING',
      });
      expect(childIssue).toMatchObject({
        lot_id: BigInt(response.body.childLot.lotId), issue_seq: 1, reissue_reason_code: null, terminal_id: f.pop.terminalId,
      });
    });

    it('US1-4·US1-5·Q5 확인 뒤 다시 20 → -S2, -S1 을 10 → -S1-S1 — 번호·수량이 맞고 합이 그대로다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const first = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);
      await markConfirmed(first.body.productLotSplitId);

      const second = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 20 }).expect(200);
      const grand = await f.split({ lotId: first.body.childLot.lotId, locationId: f.locationOf('A'), qty: 10 }).expect(200);

      expect(second.body.childLot).toMatchObject({ lotNo: `${lot.lotNo}-S2`, qty: 20 });
      expect(second.body.parentLot).toMatchObject({ qty: 50 });
      expect(grand.body.childLot).toMatchObject({ lotNo: `${lot.lotNo}-S1-S1`, qty: 10 });
      expect(grand.body.parentLot).toMatchObject({ lotNo: `${lot.lotNo}-S1`, qty: 20 });
      const totals = await Promise.all([lot.lotId, first.body.childLot.lotId, second.body.childLot.lotId, grand.body.childLot.lotId]
        .map(async (id: number) => (await f.onHand(id)).reduce((sum, [, qty]) => sum + qty, 0)));
      expect(totals).toEqual([50, 20, 20, 10]);
    });

    it('US1-6·Q6 이송으로 두 위치에 있는 LOT 은 고른 위치 잔액만 쓰고, 원래 라벨 수량은 LOT 수량(100 − 20 = 80)이다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 60 }, { at: 'B', qty: 40 }] });

      await f.split({ lotId: lot.lotId, locationId: f.locationOf('B'), qty: 40 }).expect(400);
      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 20 }).expect(200);

      expect(response.body.parentLot.qty).toBe(80);
      expect(await f.onHand(lot.lotId)).toEqual([[f.locationOf('A'), 40], [f.locationOf('B'), 40]]);
    });

    it('US2-3·Q10 검사 대기 LOT 도 나뉘고 자식도 검사 대기다', async () => {
      const lot = await f.lot({ status: 'INSPECTION_PENDING', balances: [{ at: 'A', qty: 100, quality: 'INSPECTION_PENDING' }] });

      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);

      const child = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(response.body.childLot.lotId) } });
      expect(child.status_code).toBe('INSPECTION_PENDING');
      const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: child.lot_id } });
      expect(balance.quality_status_code).toBe('INSPECTION_PENDING');
    });

    it('FR-002 발행 단계에서 막히면(라벨 공정이 없는 POP) 자식·원장·분리 기록이 남지 않는다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });

      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }, f.popNoLabel);

      expect(response.status).toBe(403);
      await expectUnchanged(lot.lotId, [[f.locationOf('A'), 100]]);
      expect(await prisma.document_issue_log.count({ where: { lot_id: BigInt(lot.lotId) } })).toBe(0);
    });

    it('R-7 재발행 사유 LOT_SPLIT 을 고객이 꺼도 분리는 된다', async () => {
      const where = { code: 'LOT_SPLIT', code_group: { group_code: 'REISSUE_REASON' } };
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      await prisma.document_issue_log.create({ data: {
        document_type_code: 'PRODUCTION_LOT_LABEL', target_type_code: 'LOT', target_id: BigInt(lot.lotId), lot_id: BigInt(lot.lotId), issue_seq: 1, issued_by: f.ids.userId,
      } });
      await prisma.code_value.updateMany({ where, data: { is_active: false } });
      try {
        const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);
        expect(response.body.parentLot.issueSeq).toBe(2);
      } finally {
        await prisma.code_value.updateMany({ where, data: { is_active: true } });
      }
    });

    it('멱등 — 같은 Idempotency-Key 재전송은 같은 응답이고 자식은 하나다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const key = randomUUID();

      const first = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }, f.pop, key).expect(200);
      const again = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }, f.pop, key).expect(200);

      expect(again.body).toEqual(first.body);
      expect(await prisma.lot.count({ where: { parent_lot_id: BigInt(lot.lotId) } })).toBe(1);
    });

    it('동시 — 같은 LOT 두 요청이 겹치면 하나만 되고 다른 하나는 바뀐 상태로 거절된다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });

      const results = await Promise.all([
        f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }),
        f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 40 }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe('LOT_SPLIT_UNCONFIRMED');
      expect(await prisma.lot.count({ where: { parent_lot_id: BigInt(lot.lotId) } })).toBe(1);
    });

    it('권한 — MOBILE 단말·다른 공장 POP·사번 없음·계정 세션은 거절된다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const body = { lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 };

      expect([401, 403]).toContain((await f.split(body, f.pda)).status);
      expect([401, 403]).toContain((await f.split(body, f.foreignPop)).status);
      const noWorker = await f.http().post('/api/logistics/product-lot-splits').set('Idempotency-Key', randomUUID())
        .set('Authorization', `Bearer ${f.pop.token}`).send({ businessDate: '2026-11-20', ...body });
      expect([400, 401]).toContain(noWorker.status);
      expect((await f.split(body, 'session')).status).toBe(403);
      await expectUnchanged(lot.lotId, [[f.locationOf('A'), 100]]);
    });
  });

  describe('막는 조건 — 409 code·400 RANGE, 재고·LOT 불변', () => {
    it('US2-1·SC-006·Q8 예약·피킹이 걸린 LOT 은 409 LOT_ALREADY_RESERVED — 다른 위치에 걸려 있어도', async () => {
      const reserved = await f.lot({ balances: [{ at: 'A', qty: 100 }, { at: 'B', qty: 10, reserved: 5 }] });
      const picked = await f.lot({ balances: [{ at: 'A', qty: 100, picked: 100 }] });

      const one = await f.split({ lotId: reserved.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(409);
      const two = await f.split({ lotId: picked.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(409);

      expect([one.body.code, two.body.code]).toEqual(['LOT_ALREADY_RESERVED', 'LOT_ALREADY_RESERVED']);
      await expectUnchanged(reserved.lotId, [[f.locationOf('A'), 100], [f.locationOf('B'), 10]]);
      await expectUnchanged(picked.lotId, [[f.locationOf('A'), 100]]);
    });

    it.each([
      ['보류', 'HOLD'],
      ['불량', 'DEFECTIVE'],
      ['폐기', 'SCRAPPED'],
      ['무효(생애 VOIDED)', 'VOIDED'],
    ])('US2-2·Q9 %s LOT 은 409 INVALID_STATE', async (_name, kind) => {
      const lot = await f.lot({
        status: kind === 'DEFECTIVE' || kind === 'SCRAPPED' ? kind : 'NORMAL',
        lifecycle: kind === 'VOIDED' ? 'VOIDED' : 'ACTIVE',
        balances: [{ at: 'A', qty: 100 }],
      });
      if (kind === 'HOLD') {
        await prisma.lot_hold.create({ data: { lot_id: BigInt(lot.lotId), reason_code: 'QUALITY', status_code: 'HELD', held_at: new Date(), held_by: f.ids.userId } });
      }

      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(409);

      expect(response.body.code).toBe('INVALID_STATE');
      // 스캔 조회 blocked.detail 과 같은 값 — POP 문구가 상태를 고른다.
      expect(response.body.detail).toBe(kind);
      expect(validator('/logistics/product-lot-splits', 'post', '409')(response.body)).toBe(true);
      await expectUnchanged(lot.lotId, [[f.locationOf('A'), 100]]);
    });

    it.each([[0], [-1], [100], [101], [2.5]])('US2-4·Q11 수량 %s 는 400 RANGE(0 < 수량 < 위치 잔액, 정수 단위)', async (qty) => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });

      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty }).expect(400);

      expect(response.body.errors[0]).toMatchObject({ field: 'qty', code: 'RANGE' });
      await expectUnchanged(lot.lotId, [[f.locationOf('A'), 100]]);
    });

    it('US2-5·Q12 적치 대기 자리·그 자리에서 출발하는 열린 적치 지시는 409 PUTAWAY_PENDING', async () => {
      const staged = await f.lot({ balances: [{ at: 'staging', qty: 100 }] });
      const tasked = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const receipt = await prisma.goods_receipt.create({ data: {
        goods_receipt_no: `PLSE2E-${f.run}-GR-${f.next()}`, receipt_type_code: 'PRODUCTION', plant_id: f.ids.plant, warehouse_id: f.ids.fg,
        receipt_datetime: new Date(), status_code: 'POSTED',
        goods_receipt_line: { create: { line_no: 1, item_id: f.ids.itemA, lot_id: BigInt(tasked.lotId), receipt_qty: 100, uom_id: f.ids.uom,
          quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', destination_location_id: f.ids.locA } },
      }, include: { goods_receipt_line: true } });
      await prisma.putaway_task.create({ data: {
        putaway_task_no: `PLSE2E-${f.run}-PT-${f.next()}`, goods_receipt_line_id: receipt.goods_receipt_line[0].goods_receipt_line_id,
        item_id: f.ids.itemA, lot_id: BigInt(tasked.lotId), task_qty: 100, uom_id: f.ids.uom, from_location_id: f.ids.locA, status_code: 'PENDING',
      } });

      const one = await f.split({ lotId: staged.lotId, locationId: f.locationOf('staging'), qty: 30 }).expect(409);
      const two = await f.split({ lotId: tasked.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(409);

      expect([one.body.code, two.body.code]).toEqual(['PUTAWAY_PENDING', 'PUTAWAY_PENDING']);
      await expectUnchanged(staged.lotId, [[f.locationOf('staging'), 100]]);
      await expectUnchanged(tasked.lotId, [[f.locationOf('A'), 100]]);
    });

    it('US2-6·Q12 제품 창고가 아닌 위치·불량 창고 몫은 409 NOT_PRODUCT_WAREHOUSE', async () => {
      const lot = await f.lot({ balances: [{ at: 'general', qty: 50 }, { at: 'defect', qty: 50 }] });

      const one = await f.split({ lotId: lot.lotId, locationId: f.locationOf('general'), qty: 10 }).expect(409);
      const two = await f.split({ lotId: lot.lotId, locationId: f.locationOf('defect'), qty: 10 }).expect(409);

      expect([one.body.code, two.body.code]).toEqual(['NOT_PRODUCT_WAREHOUSE', 'NOT_PRODUCT_WAREHOUSE']);
      await expectUnchanged(lot.lotId, [[f.locationOf('defect'), 50], [f.locationOf('general'), 50]].sort((a, b) => a[0] - b[0]) as [number, number][]);
    });

    it('US2-7·Q13 확인 전 원래·자식 재분리는 409 LOT_SPLIT_UNCONFIRMED, 자재 LOT 은 409 NOT_PRODUCTION_LOT', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const material = await f.lot({ item: 'M', balances: [{ at: 'A', qty: 100 }] });
      const first = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);

      const parent = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 10 }).expect(409);
      const child = await f.split({ lotId: first.body.childLot.lotId, locationId: f.locationOf('A'), qty: 10 }).expect(409);
      const raw = await f.split({ lotId: material.lotId, locationId: f.locationOf('A'), qty: 10 }).expect(409);

      expect([parent.body.code, child.body.code, raw.body.code]).toEqual(['LOT_SPLIT_UNCONFIRMED', 'LOT_SPLIT_UNCONFIRMED', 'NOT_PRODUCTION_LOT']);
      // 409 detail 은 스캔 조회와 같은 값 — 확인 대기 분리 시각.
      expect(parent.body.detail).toBe(first.body.splitAt);
      expect(parent.body.detail).toBe((await f.lookup(lot.lotNo).expect(200)).body.blocked.detail);
      expect(await f.onHand(lot.lotId)).toEqual([[f.locationOf('A'), 70]]);
      await expectUnchanged(material.lotId, [[f.locationOf('A'), 100]]);
    });

    it('US2-9·Q21 시리얼 관리 품목 LOT 은 409 SPLIT_SERIAL_LOT', async () => {
      const lot = await f.lot({ item: 'S', balances: [{ at: 'A', qty: 100 }] });

      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(409);

      expect(response.body.code).toBe('SPLIT_SERIAL_LOT');
      await expectUnchanged(lot.lotId, [[f.locationOf('A'), 100]]);
    });

    it('R-8 한 위치에 품질·재고 상태가 다른 잔액 행이 섞이면 409 MIXED_STOCK_STATUS', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 60 }, { at: 'A', qty: 40, quality: 'INSPECTION_PENDING' }] });

      const response = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(409);

      expect(response.body.code).toBe('MIXED_STOCK_STATUS');
      expect(await prisma.lot.count({ where: { parent_lot_id: BigInt(lot.lotId) } })).toBe(0);
    });
  });

  describe('목록 — GET', () => {
    it('US1-7·FR-009 확인 대기 목록은 오래된 순·unconfirmedCount·lastPrint·쪽 나눔이고, 확인된 분리는 빠진다', async () => {
      const lots = [];
      for (let index = 0; index < 3; index += 1) lots.push(await f.lot({ balances: [{ at: 'A', qty: 100 }] }));
      const splits: { productLotSplitId: number; childLot: { documentIssueLogId: number } }[] = [];
      for (const lot of lots) splits.push((await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 10 }).expect(200)).body);
      await markConfirmed(splits[2].productLotSplitId);
      await prisma.document_issue_log.update({
        where: { document_issue_log_id: BigInt(splits[0].childLot.documentIssueLogId) }, data: {
          print_outcome_code: 'FAILED', print_failure_reason: '용지 없음', print_reported_at: new Date(), print_reported_worker_id: f.pop.workerId,
        },
      });

      const all = await f.list({ size: 200 }).expect(200);
      const page = await f.list({ page: 1, size: 1 }).expect(200);

      expect(validator('/logistics/product-lot-splits', 'get', '200')(all.body)).toBe(true);
      const ids = (all.body.items as { productLotSplitId: number }[]).map((row) => row.productLotSplitId);
      expect(ids).toEqual(expect.arrayContaining([splits[0].productLotSplitId, splits[1].productLotSplitId]));
      expect(ids).not.toContain(splits[2].productLotSplitId);
      expect(ids.indexOf(splits[0].productLotSplitId)).toBeLessThan(ids.indexOf(splits[1].productLotSplitId));
      expect(all.body.unconfirmedCount).toBe(all.body.page.total);
      const first = (all.body.items as { productLotSplitId: number }[]).find((row) => row.productLotSplitId === splits[0].productLotSplitId);
      expect(first).toMatchObject({
        status: 'UNCONFIRMED', parentLot: { lotNo: lots[0].lotNo, qty: 90 }, childLot: { qty: 10 },
        location: { locationId: f.locationOf('A') }, splitWorkerNo: f.pop.workerNo, confirmedAt: null,
        lastPrint: { parent: 'NONE', child: 'FAILED' },
      });
      expect(page.body.items).toHaveLength(1);
    });

    it('R-3 lotNo 로 찾으면 확인 대기 우선, 없으면 가장 최근 확인된 분리 하나, 둘 다 없으면 빈 목록', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const bare = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const first = (await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 10 }).expect(200)).body;
      await markConfirmed(first.productLotSplitId);

      const confirmed = await f.list({ lotNo: first.childLot.lotNo }, f.pda).expect(200);
      const second = (await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 10 }).expect(200)).body;
      const pending = await f.list({ lotNo: lot.lotNo, status: 'CONFIRMED' }, f.pda).expect(200);
      const none = await f.list({ lotNo: bare.lotNo }, f.pda).expect(200);

      expect(confirmed.body.items).toHaveLength(1);
      expect(confirmed.body.items[0]).toMatchObject({ productLotSplitId: first.productLotSplitId, status: 'CONFIRMED', confirmedWorkerNo: f.pda.workerNo });
      expect(pending.body.items).toHaveLength(1);
      expect(pending.body.items[0]).toMatchObject({ productLotSplitId: second.productLotSplitId, status: 'UNCONFIRMED' });
      expect(none.body.items).toEqual([]);
    });

    it('목록은 단말 전용 — 계정 세션은 403, 다른 공장 POP 에는 이 공장 분리가 보이지 않는다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 10 }).expect(200);

      await f.list({}, 'session').expect(403);
      const foreign = await f.list({ lotNo: lot.lotNo }, f.foreignPop).expect(200);

      expect(foreign.body.items).toEqual([]);
    });
  });
});
