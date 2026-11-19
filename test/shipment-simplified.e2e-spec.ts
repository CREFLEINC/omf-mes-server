/**
 * 피처 010 출하 공정 단순화(omf-all-around#305) — 피킹(LOT 통째) → OQC → POP 출하 완료 (e2e).
 *
 * 시험 이름 앞의 ID 는 `specs/010-shipping-simplification/verification.md`·`quickstart.md` 의 항목이다.
 * 바탕(공장·창고·품목·단말)은 `support/shipment-simplified-fixture.ts` 가 만든다.
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
import { ShipmentSimplifiedFixture } from './support/shipment-simplified-fixture';

interface LotBody {
  shipmentRequestLotId: number;
  lotId: number;
  lotNo: string;
  pickedQty: number;
  statusCode: string;
  portions: { warehouseId: number; locationId: number | null; qty: number }[];
}
interface LineBody {
  shipmentRequestLineId: number;
  pickedQty: number;
  allocatedQty: number;
  overQty: number;
  lots: LotBody[];
}

function validator(path: string, method: string, status: string): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8')) as object;
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('출하 공정 단순화 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let f: ShipmentSimplifiedFixture;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    f = new ShipmentSimplifiedFixture(app, prisma);
    await f.setup();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const lineOf = async (requestId: number, index = 0): Promise<LineBody> => {
    const response = await f.asSession(f.http().get(`/api/logistics/shipment-requests/${requestId}`)).expect(200);
    return response.body.lines[index] as LineBody;
  };

  describe('피킹 — LOT 통째(:pick-lot)', () => {
    it('US1-1·SC-008·Q1 목표 100 에 LOT 40·40·30 을 피킹하면 합 110·초과 10 이고 피킹 LOT 행 셋이 PICKED 다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lots = [];
      for (const qty of [40, 40, 30]) lots.push(await f.lot({ balances: [{ warehouse: 'wh1', qty }] }));

      let last: { body: { pickedLot: LotBody; line: LineBody } } | undefined;
      for (const lot of lots) last = await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);

      const validate = validator('/logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick-lot', 'post', '200');
      expect(validate(last?.body)).toBe(true);
      expect(last?.body.pickedLot).toMatchObject({ lotId: lots[2].lotId, pickedQty: 30, statusCode: 'PICKED' });
      expect(last?.body.line).toMatchObject({ allocatedQty: 100, pickedQty: 110, overQty: 10 });
      expect(last?.body.line.lots.map((lot) => lot.statusCode)).toEqual(['PICKED', 'PICKED', 'PICKED']);
      const rows = await prisma.shipment_request_lot.findMany({ where: { shipment_request_line_id: BigInt(made.lineIds[0]) } });
      expect(rows.map((row) => [Number(row.picked_qty), row.status_code, row.picked_worker_id])).toEqual([
        [40, 'PICKED', f.pda.workerId], [40, 'PICKED', f.pda.workerId], [30, 'PICKED', f.pda.workerId],
      ]);
      const detail = await f.asSession(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`)).expect(200);
      expect(detail.body).toMatchObject({ shipmentProgressCode: 'PICKED', code: `SHPREQ:${made.requestNo}` });
    });

    it('US1-2·Q1 목표를 채운 뒤 다른 LOT 은 409 LOT_TARGET_REACHED 이고 재고·피킹이 그대로다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      await f.pickLot(made, 0, { lotId: (await f.lot({ balances: [{ warehouse: 'wh1', qty: 110 }] })).lotId }).expect(200);
      const extra = await f.lot({ balances: [{ warehouse: 'wh1', qty: 50 }] });

      const response = await f.pickLot(made, 0, { lotId: extra.lotId }).expect(409);

      expect(response.body).toMatchObject({ code: 'LOT_TARGET_REACHED' });
      expect(response.body.message).toContain('목표 수량을 채웠습니다');
      const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: BigInt(extra.lotId) } });
      expect(Number(balance.picked_qty)).toBe(0);
      expect((await lineOf(made.requestId)).lots).toHaveLength(1);
    });

    it('R-2·Q2 두 창고·위치에 나뉜 LOT 은 공장 안 합계로 통째 피킹되고 몫이 창고·위치별로 실린다 — 불량창고 몫은 빠진다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lot = await f.lot({ balances: [
        { warehouse: 'wh1', location: 'loc1a', qty: 10 }, { warehouse: 'wh1', location: 'loc1b', qty: 15 },
        { warehouse: 'wh2', qty: 20 }, { warehouse: 'defect', qty: 5 },
      ] });

      const response = await f.pickLot(made, 0, { lotNo: lot.lotNo }).expect(200);

      expect(response.body.pickedLot.pickedQty).toBe(45);
      expect(response.body.pickedLot.portions).toEqual(expect.arrayContaining([
        expect.objectContaining({ warehouseId: Number(f.ids.wh1), locationId: Number(f.ids.loc1a), qty: 10 }),
        expect.objectContaining({ warehouseId: Number(f.ids.wh1), locationId: Number(f.ids.loc1b), qty: 15 }),
        expect.objectContaining({ warehouseId: Number(f.ids.wh2), locationId: Number(f.ids.loc2), qty: 20 }),
      ]));
      expect(response.body.pickedLot.portions).toHaveLength(3);
      const reservations = await prisma.inventory_reservation.findMany({
        where: { source_document_type_code: 'SHIPMENT_REQUEST_LINE', source_document_id: BigInt(made.lineIds[0]) },
      });
      // 잔액 행마다 예약 하나 — 걸고 곧바로 피킹으로 옮긴다(consumed = reserved).
      expect(reservations.map((row) => [Number(row.reserved_qty), Number(row.consumed_qty)]).sort()).toEqual([[10, 10], [15, 15], [20, 20]]);
      const balances = await prisma.inventory_balance.findMany({ where: { lot_id: BigInt(lot.lotId) }, orderBy: { inventory_balance_id: 'asc' } });
      expect(balances.map((row) => [Number(row.on_hand_qty), Number(row.picked_qty), Number(row.reserved_qty)])).toEqual([
        [10, 10, 0], [15, 15, 0], [20, 20, 0], [5, 0, 0],
      ]);
      const detail = await f.asSession(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`)).expect(200);
      expect(detail.body.pickingWarehouses.map((row: { warehouseId: number }) => row.warehouseId)).toEqual([Number(f.ids.wh1), Number(f.ids.wh2)]);
    });

    it('FR-006 다른 예약·피킹이 걸린 LOT 은 409 LOT_ALREADY_RESERVED 다 — 통째로 잡을 수 없다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 10 }, { warehouse: 'wh2', qty: 20, picked: 5 }] });

      const response = await f.pickLot(made, 0, { lotId: lot.lotId }).expect(409);

      expect(response.body.code).toBe('LOT_ALREADY_RESERVED');
      expect(await prisma.shipment_request_lot.count({ where: { lot_id: BigInt(lot.lotId) } })).toBe(0);
    });

    it('FR-006·Q21 이미 이 지시서에 피킹한 LOT 을 다시 스캔하면 409 LOT_ALREADY_PICKED 다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 40 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);

      const response = await f.pickLot(made, 0, { lotNo: lot.lotNo }).expect(409);

      expect(response.body.code).toBe('LOT_ALREADY_PICKED');
    });

    it('FR-006·Q21 지시서에 그 품목 라인이 없으면 409 NO_LINE_FOR_ITEM 이다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lot = await f.lot({ item: 'B', balances: [{ warehouse: 'wh1', qty: 40 }] });

      const response = await f.pickLot(made, 0, { lotId: lot.lotId }).expect(409);

      expect(response.body.code).toBe('NO_LINE_FOR_ITEM');
    });

    it('FR-006 보류 LOT 은 409, NORMAL 이 아닌 LOT 은 400 — 지금 메시지로 거절한다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const held = await f.lot({ balances: [{ warehouse: 'wh1', qty: 40 }] });
      await prisma.lot_hold.create({ data: {
        lot_id: BigInt(held.lotId), reason_code: 'SSE2E-HOLD', status_code: 'HELD', held_by: f.ids.userId, held_at: new Date('2026-11-18T00:00:00.000Z'),
      } });
      const defective = await f.lot({ balances: [{ warehouse: 'wh1', qty: 40 }], status: 'DEFECTIVE' });

      const hold = await f.pickLot(made, 0, { lotId: held.lotId }).expect(409);
      const status = await f.pickLot(made, 0, { lotId: defective.lotId }).expect(400);

      expect(hold.body).toMatchObject({ code: 'INVALID_STATE' });
      expect(hold.body.message).toContain('보류 중인 LOT');
      expect(status.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('FR-006 다른 공장 LOT 번호는 400 이다(이 공장의 LOT 이 아니다)', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const foreign = await f.lot({ balances: [], plant: f.ids.plant2 });

      const response = await f.pickLot(made, 0, { lotNo: foreign.lotNo }).expect(400);

      expect(response.body.errors[0]).toMatchObject({ field: 'lotNo', code: 'INVALID' });
    });

    it('USE_PICK_LOT 옛 수량 피킹(:pick)은 409 USE_PICK_LOT 이다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 40 }] });

      const response = await f.asTerminal(f.http()
        .post(`/api/logistics/shipment-requests/${made.requestId}/lines/${made.lineIds[0]}:pick`)
        .set('Idempotency-Key', randomUUID())
        .send({ lotId: lot.lotId, pickedQty: 10, uomId: Number(f.ids.uom) }), f.pda).expect(409);

      expect(response.body.code).toBe('USE_PICK_LOT');
    });

    it('SC-009 단말 권한 — POP 단말과 남의 공장 PDA 는 :pick-lot 을 부를 수 없다(401)', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 40 }] });

      await f.pickLot(made, 0, { lotId: lot.lotId }, f.pop).expect(401);
      await f.pickLot(made, 0, { lotNo: lot.lotNo }, f.foreignPda).expect(401);
      expect(await prisma.shipment_request_lot.count({ where: { lot_id: BigInt(lot.lotId) } })).toBe(0);
    });

    it('계정 세션(M-04-01)도 :pick-lot 을 부를 수 있다 — 작업자 없이 만든 이가 남는다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 40 }] });

      await f.pickLot(made, 0, { lotId: lot.lotId }, 'session').expect(200);

      const row = await prisma.shipment_request_lot.findFirstOrThrow({ where: { lot_id: BigInt(lot.lotId) } });
      expect(row).toMatchObject({ picked_worker_id: null, created_by: f.ids.userId });
    });
  });
  /** 지시서(품목 A 목표 110) + LOT 40·40·30 피킹 — OQC 묶음 하나. */
  async function pickedThree(): Promise<{ made: Awaited<ReturnType<ShipmentSimplifiedFixture['request']>>; lotIds: number[]; oqc: number }> {
    const made = await f.request([{ allocated: 110 }]);
    const lotIds: number[] = [];
    for (const qty of [40, 40, 30]) {
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      lotIds.push(lot.lotId);
    }
    return { made, lotIds, oqc: made.oqcRequestIds.A };
  }

  describe('OQC — LOT 매칭·판정만(새 흐름)', () => {
    it('US3-1·Q4 매칭 LOT 없이 저장하면 400 MATCHED_LOT_REQUIRED, 이 지시서·품목의 피킹 LOT 이 아니면 400', async () => {
      const { oqc } = await pickedThree();
      const stranger = await f.lot({ balances: [{ warehouse: 'wh1', qty: 10 }] });

      const none = await f.oqcResult(oqc, { overallJudgmentCode: 'ACCEPTED' }).expect(400);
      const foreign = await f.oqcResult(oqc, { matchedLotIds: [stranger.lotId], overallJudgmentCode: 'ACCEPTED' }).expect(400);

      expect(none.body.errors[0]).toMatchObject({ field: 'matchedLotIds', code: 'MATCHED_LOT_REQUIRED' });
      expect(foreign.body.errors[0]).toMatchObject({ field: 'matchedLotIds', code: 'INVALID' });
      expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(oqc) } })).toBe(0);
    });

    it('US3-2·US3-4·Q4·Q22 LOT 1·2 합격·LOT 3 불합격 — 수량은 서버가 채우고 작성중으로 쌓이며 의뢰가 진행이 된다', async () => {
      const { made, lotIds, oqc } = await pickedThree();

      const first = await f.oqcResult(oqc, { matchedLotIds: [lotIds[0], lotIds[1]], overallJudgmentCode: 'ACCEPTED' }).expect(201);
      expect((await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(oqc) } })).status_code).toBe('IN_PROGRESS');
      await f.oqcResult(oqc, { matchedLotIds: [lotIds[2]], overallJudgmentCode: 'REJECTED' }, 'session').expect(201);

      expect(first.body).toMatchObject({ statusCode: 'DRAFT', overallJudgmentCode: 'ACCEPTED', inspectionRound: 1 });
      const rows = await prisma.inspection_result.findMany({ where: { inspection_request_id: BigInt(oqc) }, orderBy: { inspection_round: 'asc' } });
      expect(rows.map((row) => [row.inspection_round, row.status_code, Number(row.inspected_qty), Number(row.accepted_qty), Number(row.rejected_qty)]))
        .toEqual([[1, 'DRAFT', 80, 80, 0], [2, 'DRAFT', 30, 0, 30]]);
      expect((await f.lotsOf(made)).map((lot) => lot.oqcLotStatus)).toEqual(['ACCEPTED', 'ACCEPTED', 'REJECTED']);
      const detail = await f.asSession(f.http().get(`/api/quality/inspection-requests/${oqc}`)).expect(200);
      expect(detail.body.shipmentRequestNo).toBe(made.requestNo);
      expect(detail.body.lotJudgments.map((row: { lotId: number; judgmentCode: string }) => [row.lotId, row.judgmentCode]))
        .toEqual([[lotIds[0], 'ACCEPTED'], [lotIds[1], 'ACCEPTED'], [lotIds[2], 'REJECTED']]);
      expect(detail.body.lots.map((row: { lotQty: number; pickStatusCode: string }) => [row.lotQty, row.pickStatusCode]))
        .toEqual([[40, 'PICKED'], [40, 'PICKED'], [30, 'PICKED']]);
      const list = await f.asTerminal(f.http().get('/api/quality/inspection-requests')
        .query({ inspectionTypeCode: 'OQC', pendingOnly: true, size: 100 }), f.pop).expect(200);
      const row = (list.body.items as { inspectionRequestId: number }[]).find((item) => item.inspectionRequestId === oqc);
      expect(row).toMatchObject({ shipmentRequestNo: made.requestNo, pickedLotCount: 3, lotJudgmentSummary: { notInspected: 0, accepted: 2, rejected: 1, held: 0 } });
    });

    it('US3-3·FR-010·Q5 LOT 3 만 다시 합격으로 덮으면 재검 사유가 필수이고, 사유와 함께면 LOT 3 이 합격이 된다', async () => {
      const { made, lotIds, oqc } = await pickedThree();
      await f.oqcResult(oqc, { matchedLotIds: lotIds, overallJudgmentCode: 'REJECTED' }).expect(201);

      const missing = await f.oqcResult(oqc, { matchedLotIds: [lotIds[2]], overallJudgmentCode: 'ACCEPTED' }).expect(400);
      await f.oqcResult(oqc, { matchedLotIds: [lotIds[2]], overallJudgmentCode: 'ACCEPTED', reinspectionReasonCode: 'RETEST' }).expect(201);

      expect(missing.body.errors[0]).toMatchObject({ code: 'REINSPECTION_REASON_REQUIRED' });
      expect((await f.lotsOf(made)).map((lot) => lot.oqcLotStatus)).toEqual(['REJECTED', 'REJECTED', 'ACCEPTED']);
    });

    it('US3-6 피킹이 끝나지 않은 묶음에도 결과를 기록한다 — 지금 피킹된 LOT 만 매칭 대상이다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 40 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);

      await f.oqcResult(made.oqcRequestIds.A, { matchedLotIds: [lot.lotId], overallJudgmentCode: 'HELD' }).expect(201);

      expect((await f.lotsOf(made))[0].oqcLotStatus).toBe('HELD');
    });

    it('FR-011·Q7 다른 지시서에서 그 LOT 을 합격시킨 결과는 잇지 않는다 — 이 지시서에서는 미검사다', async () => {
      const other = await f.request([{ allocated: 100 }]);
      const made = await f.request([{ allocated: 100 }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 40 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      const foreign = await prisma.inspection_result.create({ data: {
        inspection_result_no: `SSE2E-${f.run}-IRS-${f.next()}`, inspection_request_id: BigInt(other.oqcRequestIds.A), inspection_round: 1,
        inspected_qty: 40, accepted_qty: 40, uom_id: f.ids.uom, overall_judgment_code: 'ACCEPTED', inspector_id: f.pop.workerId,
        inspected_at: new Date('2026-11-18T03:00:00.000Z'), status_code: 'CONFIRMED', idempotency_key: `SSE2E-${f.run}-${f.next()}`,
      } });
      await prisma.inspection_result_lot.create({ data: { inspection_result_id: foreign.inspection_result_id, lot_id: BigInt(lot.lotId) } });

      expect((await f.lotsOf(made))[0].oqcLotStatus).toBe('NOT_INSPECTED');
    });

    it('검사 불필요 라인의 LOT 은 NOT_REQUIRED 다', async () => {
      const made = await f.request([{ item: 'B', allocated: 100 }]);
      const lot = await f.lot({ item: 'B', balances: [{ warehouse: 'wh1', qty: 40 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);

      expect((await f.lotsOf(made))[0].oqcLotStatus).toBe('NOT_REQUIRED');
    });

    it('R-5 새 흐름 의뢰의 :confirm(의뢰·결과)과 확정 저장은 409 CONFIRMED_BY_SHIPMENT_COMPLETION 이다', async () => {
      const { lotIds, oqc } = await pickedThree();
      const saved = await f.oqcResult(oqc, { matchedLotIds: lotIds, overallJudgmentCode: 'ACCEPTED' }).expect(201);

      const confirmed = await f.oqcResult(oqc, { matchedLotIds: lotIds, overallJudgmentCode: 'ACCEPTED', statusCode: 'CONFIRMED' }).expect(409);
      const requestConfirm = await f.asSession(f.http().post(`/api/quality/inspection-requests/${oqc}:confirm`)
        .set('Idempotency-Key', randomUUID()).send({ versionNo: 1 })).expect(409);
      const resultConfirm = await f.asSession(f.http().post(`/api/quality/inspection-results/${saved.body.inspectionResultId}:confirm`)
        .set('Idempotency-Key', randomUUID()).set('If-Match', '"1"').send({})).expect(409);

      for (const response of [confirmed, requestConfirm, resultConfirm]) expect(response.body.code).toBe('CONFIRMED_BY_SHIPMENT_COMPLETION');
      expect((await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(saved.body.inspectionResultId) } })).status_code).toBe('DRAFT');
    });

    it('R-5 작성중 결과를 PUT 으로 고치면 매칭·판정이 바뀌고 수량이 다시 채워진다', async () => {
      const { made, lotIds, oqc } = await pickedThree();
      const saved = await f.oqcResult(oqc, { matchedLotIds: [lotIds[0]], overallJudgmentCode: 'ACCEPTED' }, 'session').expect(201);

      await f.asSession(f.http().put(`/api/quality/inspection-results/${saved.body.inspectionResultId}`)
        .set('Idempotency-Key', randomUUID()).set('If-Match', '"1"')
        .send({ matchedLotIds: [lotIds[0], lotIds[2]], overallJudgmentCode: 'HELD' })).expect(200);

      const row = await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(saved.body.inspectionResultId) } });
      expect([Number(row.inspected_qty), Number(row.held_qty), Number(row.accepted_qty)]).toEqual([70, 70, 0]);
      expect((await f.lotsOf(made)).map((lot) => lot.oqcLotStatus)).toEqual(['HELD', 'NOT_INSPECTED', 'HELD']);
    });

    it('R-5 시리얼 OK/NG 는 작성중 저장에서도 받는다 — 매칭 LOT 밖 시리얼은 400', async () => {
      const { lotIds, oqc } = await pickedThree();
      const serial = async (lotId: number) => (await prisma.serial_number.create({ data: {
        serial_no: `SSE2E-${f.run}-SN-${f.next()}`, item_id: f.ids.itemA, lot_id: BigInt(lotId), status_code: 'ACTIVE',
      } })).serial_number_id;
      const inside = await serial(lotIds[0]);
      const outside = await serial(lotIds[1]);

      await f.oqcResult(oqc, { matchedLotIds: [lotIds[0]], overallJudgmentCode: 'ACCEPTED', serials: [{ serialNumberId: Number(outside), judgmentCode: 'OK' }] }).expect(400);
      await f.oqcResult(oqc, { matchedLotIds: [lotIds[0]], overallJudgmentCode: 'ACCEPTED', serials: [{ serialNumberId: Number(inside), judgmentCode: 'OK' }] }).expect(201);

      expect((await prisma.oqc_serial_result.findUniqueOrThrow({ where: { serial_number_id: inside } })).final_judgment_code).toBe('OK');
    });
  });
});
