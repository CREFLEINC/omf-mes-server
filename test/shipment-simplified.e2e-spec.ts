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
import { goodsIssueBuilder } from '../src/integration/erp/send/goods-issue.send';
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

    it('US3-1·FR-009·T052 새 흐름 결과도 검사 항목 측정을 저장한다 — 측정 조회에 나오고, PUT 으로 고치면 바뀐다', async () => {
      const { lotIds, oqc } = await pickedThree();
      const plan = await prisma.inspection_plan.create({ data: {
        inspection_plan_code: `${f.run}-OQC-PLAN-${randomUUID().slice(0, 6)}`, inspection_plan_name: '출하단순화측정기준', item_id: f.ids.itemA, inspection_type_code: 'OQC',
      } });
      const version = await prisma.inspection_plan_version.create({ data: {
        inspection_plan_id: plan.inspection_plan_id, plan_version: 1, effective_from: new Date('2026-01-01T00:00:00.000Z'),
        sampling_method_code: 'FULL', inspection_frequency_code: 'EVERY_LOT', status_code: 'DRAFT',
      } });
      const spec = await prisma.inspection_item_spec.create({ data: {
        inspection_plan_version_id: version.inspection_plan_version_id, sequence_no: 1, inspection_item_code: 'LEN', inspection_item_name: '길이',
        data_type_code: 'NUMERIC', uom_id: f.ids.uom,
      } });
      const measured = (value: number, judgmentCode: string) => [{
        inspectionItemSpecId: Number(spec.inspection_item_spec_id), sampleNo: 1, numericValue: value, judgmentCode, measuredAt: '2026-11-18T03:00:00.000Z',
      }];
      const measurementsOf = async (resultId: number) =>
        ((await f.asSession(f.http().get(`/api/quality/inspection-results/${resultId}/measurements`)).expect(200)).body as
          { items: { inspectionItemSpecId: number; numericValue: number | null; judgmentCode: string }[] }).items;

      const saved = await f.oqcResult(oqc, { matchedLotIds: [lotIds[0]], overallJudgmentCode: 'ACCEPTED', measurements: measured(1.5, 'ACCEPTED') }, 'session').expect(201);

      expect((await measurementsOf(saved.body.inspectionResultId as number)).map((row) => [row.inspectionItemSpecId, row.numericValue, row.judgmentCode]))
        .toEqual([[Number(spec.inspection_item_spec_id), 1.5, 'ACCEPTED']]);

      await f.asSession(f.http().put(`/api/quality/inspection-results/${saved.body.inspectionResultId}`)
        .set('Idempotency-Key', randomUUID()).set('If-Match', '"1"')
        .send({ measurements: measured(2.5, 'REJECTED') })).expect(200);

      expect((await measurementsOf(saved.body.inspectionResultId as number)).map((row) => [row.numericValue, row.judgmentCode])).toEqual([[2.5, 'REJECTED']]);
      // 수량은 여전히 서버가 매칭 LOT 피킹 합으로 채운다(R-5 — 판정만은 「수량은 받지 않음」으로 읽는다).
      const row = await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(saved.body.inspectionResultId) } });
      expect([Number(row.inspected_qty), Number(row.accepted_qty)]).toEqual([40, 40]);
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
  /** LOT 1·2 합격, LOT 3 불합격까지 — 교체 시험의 출발점. */
  async function judgedThree(): Promise<Awaited<ReturnType<typeof pickedThree>> & { lots: Awaited<ReturnType<ShipmentSimplifiedFixture['lotsOf']>> }> {
    const picked = await pickedThree();
    await f.oqcResult(picked.oqc, { matchedLotIds: [picked.lotIds[0], picked.lotIds[1]], overallJudgmentCode: 'ACCEPTED' }).expect(201);
    await f.oqcResult(picked.oqc, { matchedLotIds: [picked.lotIds[2]], overallJudgmentCode: 'REJECTED' }).expect(201);
    return { ...picked, lots: await f.lotsOf(picked.made) };
  }

  describe('교체 — OQC 불합격 피킹 LOT(:replace)', () => {
    it('US2-1·US2-2·US2-3·FR-013·FR-014·Q6 [교체] 한 번에 예약 해제·LOT 불량·부적합 1건이 생기고 라인이 다시 받는다 — 새 LOT 은 미검사다', async () => {
      const { made, lotIds, oqc, lots } = await judgedThree();
      expect(lots.map((lot) => lot.oqcLotStatus)).toEqual(['ACCEPTED', 'ACCEPTED', 'REJECTED']);

      const replaced = await f.replaceLot(lots[2].shipmentRequestLotId).expect(200);

      expect(replaced.body.replacedLot).toMatchObject({ statusCode: 'REPLACED', oqcLotStatus: null, replacement: { judgment: 'REJECTED' } });
      expect(replaced.body.replacedLot.replacement.worker).toMatchObject({ workerNo: f.pda.workerNo });
      expect(replaced.body.nonconformanceNo).toEqual(expect.any(String));
      expect(replaced.body.line).toMatchObject({ pickedQty: 80, overQty: 0 });
      expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotIds[2]) } })).status_code).toBe('DEFECTIVE');
      const nonconformances = await prisma.nonconformance.findMany({ where: { nonconformance_lot: { some: { lot_id: BigInt(lotIds[2]) } } } });
      expect(nonconformances.map((row) => [row.status_code, Number(row.inspection_request_id), row.nonconformance_no]))
        .toEqual([['PENDING_DECISION', oqc, replaced.body.nonconformanceNo]]);
      const reservations = await prisma.inventory_reservation.findMany({ where: { source_document_type_code: 'SHIPMENT_REQUEST_LINE', lot_id: BigInt(lotIds[2]) } });
      expect(reservations.map((row) => [Number(row.reserved_qty), Number(row.released_qty), Number(row.consumed_qty)])).toEqual([[30, 30, 0]]);
      const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: BigInt(lotIds[2]) } });
      expect(Number(balance.picked_qty)).toBe(0);
      expect((await prisma.lot_status_event.findMany({ where: { lot_id: BigInt(lotIds[2]) } })).map((row) => row.transition_code)).toEqual(['C6']);

      const next = await f.lot({ balances: [{ warehouse: 'wh1', qty: 30 }] });
      const repicked = await f.pickLot(made, 0, { lotId: next.lotId }).expect(200);

      expect(repicked.body.line).toMatchObject({ pickedQty: 110 });
      expect(repicked.body.pickedLot.oqcLotStatus).toBe('NOT_INSPECTED');
    });

    it('US2-7·FR-015·Q19 지시서 목록·상세에 교체 수와 교체 이력이 실리고 hasReplacement 로 거른다', async () => {
      const { made, lots } = await judgedThree();
      await f.replaceLot(lots[2].shipmentRequestLotId).expect(200);

      const list = await f.asSession(f.http().get('/api/logistics/shipment-requests')
        .query({ shipDateFrom: '2026-11-18', shipDateTo: '2026-11-18', hasReplacement: true, size: 100 })).expect(200);
      const row = (list.body.items as { shipmentRequestId: number; replacementCount: number }[]).find((item) => item.shipmentRequestId === made.requestId);

      expect(row?.replacementCount).toBe(1);
      const history = (await f.lotsOf(made)).find((lot) => lot.shipmentRequestLotId === lots[2].shipmentRequestLotId) as unknown as { replacement: object };
      expect(history.replacement).toMatchObject({ judgment: 'REJECTED', nonconformanceNo: expect.any(String), resultNo: expect.any(String) });
    });

    it('US2-6 교체 전에 재검 합격이 들어오면 [교체]는 409 LOT_NOT_REJECTED 다 — 합격·미검사·이미 교체한 LOT 도 같다', async () => {
      const { lotIds, oqc, lots } = await judgedThree();
      await f.oqcResult(oqc, { matchedLotIds: [lotIds[2]], overallJudgmentCode: 'ACCEPTED', reinspectionReasonCode: 'RETEST' }).expect(201);

      const retested = await f.replaceLot(lots[2].shipmentRequestLotId).expect(409);
      const accepted = await f.replaceLot(lots[0].shipmentRequestLotId).expect(409);

      expect(retested.body).toMatchObject({ code: 'LOT_NOT_REJECTED' });
      expect(retested.body.message).toContain('재검 합격');
      expect(accepted.body.code).toBe('LOT_NOT_REJECTED');
      const other = await judgedThree();
      await f.replaceLot(other.lots[2].shipmentRequestLotId).expect(200);
      expect((await f.replaceLot(other.lots[2].shipmentRequestLotId).expect(409)).body.code).toBe('LOT_NOT_REJECTED');
    });

    it('US3-5 교체된 LOT 은 매칭 대상에서 빠지고 OQC 의뢰 상세에 이력으로만 남는다', async () => {
      const { lotIds, oqc, lots } = await judgedThree();
      await f.replaceLot(lots[2].shipmentRequestLotId).expect(200);

      await f.oqcResult(oqc, { matchedLotIds: [lotIds[2]], overallJudgmentCode: 'ACCEPTED', reinspectionReasonCode: 'RETEST' }).expect(400);
      const detail = await f.asSession(f.http().get(`/api/quality/inspection-requests/${oqc}`)).expect(200);

      expect(detail.body.lots.map((lot: { lotId: number; pickStatusCode: string }) => [lot.lotId, lot.pickStatusCode]))
        .toEqual([[lotIds[0], 'PICKED'], [lotIds[1], 'PICKED'], [lotIds[2], 'REPLACED']]);
    });

    it('R-6 교체가 만든 부적합의 LOT 이 처분 후보(W-03-10)에 뜬다', async () => {
      const { lotIds, lots } = await judgedThree();
      await f.replaceLot(lots[2].shipmentRequestLotId).expect(200);

      const candidates = await f.asSession(f.http().get('/api/quality/disposition-candidates').query({ lotId: lotIds[2] })).expect(200);

      expect(candidates.body.items).toHaveLength(1);
      expect(candidates.body.items[0]).toMatchObject({ lotId: lotIds[2], sourceCode: 'PRODUCT', nonconformanceNo: expect.any(String) });
    });

    it('SC-009 POP·남의 공장 PDA 는 [교체]를 부를 수 없다(401)', async () => {
      const { lots } = await judgedThree();

      await f.replaceLot(lots[2].shipmentRequestLotId, f.pop).expect(401);
      await f.replaceLot(lots[2].shipmentRequestLotId, f.foreignPda).expect(401);
    });
  });

  describe('출하 관리 코드(US5)', () => {
    it('US5-1·US5-3·US5-4·Q12 스캔·입력한 코드가 저장되고, 같은 코드를 다른 LOT 에 넣어도 되며, 고치거나 지울 수 있다', async () => {
      const ids = await pickedLotRowIds();

      const saved = await f.saveCode(ids[0], 'BOX-0001').expect(200);
      await f.saveCode(ids[1], 'BOX-0001').expect(200);
      await f.saveCode(ids[0], 'BOX-0002', 'session').expect(200);
      await f.saveCode(ids[1], null).expect(200);

      expect(saved.body).toMatchObject({ managementCode: 'BOX-0001', statusCode: 'PICKED' });
      const rows = await prisma.shipment_request_lot.findMany({ where: { shipment_request_lot_id: { in: ids.slice(0, 2).map(BigInt) } }, orderBy: { shipment_request_lot_id: 'asc' } });
      expect(rows.map((row) => row.management_code)).toEqual(['BOX-0002', null]);
    });

    it('US5-2·SC-005 101자는 400 — 「100자까지」', async () => {
      const ids = await pickedLotRowIds();

      const response = await f.saveCode(ids[0], 'X'.repeat(101)).expect(400);

      expect(response.body.errors[0]).toMatchObject({ field: 'managementCode', code: 'RANGE' });
      await f.saveCode(ids[0], 'X'.repeat(100)).expect(200);
    });

    it('FR-021 교체한 LOT 의 코드는 고칠 수 없다(409) · POP 은 부를 수 없다(401)', async () => {
      const { lots } = await judgedThree();
      await f.replaceLot(lots[2].shipmentRequestLotId).expect(200);

      await f.saveCode(lots[2].shipmentRequestLotId, 'BOX-9').expect(409);
      await f.saveCode(lots[0].shipmentRequestLotId, 'BOX-9', f.pop).expect(401);
    });
  });

  /** `pickedThree()` 의 피킹 LOT 행 id(라인 순서). */
  async function pickedLotRowIds(): Promise<number[]> {
    const { made } = await pickedThree();
    return (await f.lotsOf(made)).map((lot) => lot.shipmentRequestLotId);
  }
  /** 수주 연결 라인(목표 100) + LOT 40(창고1 위치 A)·40(창고2)·30(창고1 위치 B) 피킹 + 셋 다 합격. */
  async function readyRequest(): Promise<{ made: Awaited<ReturnType<ShipmentSimplifiedFixture['request']>>; lotIds: number[] }> {
    const made = await f.request([{ allocated: 100, salesOrdered: 100 }]);
    const lotIds: number[] = [];
    for (const balance of [
      { warehouse: 'wh1', location: 'loc1a', qty: 40 }, { warehouse: 'wh2', qty: 40 }, { warehouse: 'wh1', location: 'loc1b', qty: 30 },
    ] as const) {
      const lot = await f.lot({ balances: [balance] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      lotIds.push(lot.lotId);
    }
    await f.oqcResult(made.oqcRequestIds.A, { matchedLotIds: lotIds, overallJudgmentCode: 'ACCEPTED' }).expect(201);
    return { made, lotIds };
  }

  describe('출하 완료 — POP(:lookup · :complete)', () => {
    it('US1-3·SC-002·SC-009·Q9·Q2 완료 한 번에 출하 하나·창고마다 출고 기록·재고 차감·수주 출하 수량·OQC 확정·ERP 송신 대기가 함께 생긴다', async () => {
      const { made, lotIds } = await readyRequest();
      const firstLot = (await f.lotsOf(made))[0];
      await f.saveCode(firstLot.shipmentRequestLotId, 'BOX-0001').expect(200);

      const looked = await f.lookup(`SHPREQ:${made.requestNo}`).expect(200);
      expect(looked.body).toMatchObject({ shipmentRequestId: made.requestId, blockers: [], completedShipment: null });
      expect(looked.body.warehouses.map((row: { warehouseId: number; qty: number; lotCount: number }) => [row.warehouseId, row.qty, row.lotCount]))
        .toEqual([[Number(f.ids.wh1), 70, 2], [Number(f.ids.wh2), 40, 1]]);
      expect(looked.body.lines[0]).toMatchObject({ targetQty: 100, pickedQty: 110, overQty: 10, lotCount: 3 });
      expect(JSON.stringify(looked.body)).not.toMatch(/erp/i);

      const done = await f.complete(made).expect(200);

      const shipment = await prisma.shipment.findUniqueOrThrow({ where: { shipment_id: BigInt(done.body.shipmentId) } });
      expect(shipment).toMatchObject({
        status_code: 'CONFIRMED', warehouse_id: null, completed_terminal_id: f.pop.terminalId, completed_worker_id: f.pop.workerId, created_by: null,
      });
      expect(await prisma.shipment.count({ where: { shipment_request_id: BigInt(made.requestId) } })).toBe(1);
      const issues = await prisma.goods_issue.findMany({ where: { source_document_type_code: 'SHIPMENT', source_document_id: shipment.shipment_id }, orderBy: { goods_issue_id: 'asc' } });
      expect(issues.map((row) => row.source_warehouse_id).sort()).toEqual([f.ids.wh1, f.ids.wh2].sort());
      const allocations = await prisma.shipment_lot_allocation.findMany({ where: { shipment_line: { shipment_id: shipment.shipment_id } } });
      expect(allocations.map((row) => Number(row.allocated_qty)).sort()).toEqual([30, 40, 40]);
      for (const lotId of lotIds) {
        const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: BigInt(lotId) } });
        expect([Number(balance.on_hand_qty), Number(balance.picked_qty)]).toEqual([0, 0]);
      }
      const line = await prisma.shipment_request_line.findUniqueOrThrow({ where: { shipment_request_line_id: BigInt(made.lineIds[0]) }, include: { sales_order_line: true } });
      expect([Number(line.shipped_qty), Number(line.sales_order_line?.shipped_qty)]).toEqual([110, 110]);
      expect((await prisma.shipment_request_lot.findMany({ where: { lot_id: { in: lotIds.map(BigInt) } } })).map((row) => [row.status_code, row.shipment_id]))
        .toEqual(lotIds.map(() => ['SHIPPED', shipment.shipment_id]));
      const oqc = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(made.oqcRequestIds.A) }, include: { inspection_result: true } });
      expect([oqc.status_code, oqc.overall_judgment_code, oqc.inspection_result.map((row) => row.status_code)]).toEqual(['COMPLETED', 'ACCEPTED', ['CONFIRMED']]);
      expect((await prisma.lot_status_event.findMany({ where: { lot_id: { in: lotIds.map(BigInt) } } })).map((row) => row.transition_code)).toEqual(['C4', 'C4', 'C4']);
      const messages = await prisma.integration_message.findMany({ where: { target_type_code: 'SHIPMENT', target_id: shipment.shipment_id } });
      expect(messages.map((row) => [row.message_key, row.status_code])).toEqual([[`IF-SHIPMENT-PGI-SEND:${shipment.shipment_no}`, 'PENDING']]);
      expect(done.body.completion).toMatchObject({ completedShipment: { shipmentNo: shipment.shipment_no }, blockers: [{ code: 'ALREADY_COMPLETED' }] });
      const detail = await f.asSession(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`)).expect(200);
      expect(detail.body.shipmentProgressCode).toBe('SHIPPED');
      // US5 — 출하 완료 뒤에는 출하 관리 코드를 고칠 수 없다.
      await f.saveCode(firstLot.shipmentRequestLotId, 'BOX-0002').expect(409);
    });

    describe.each([
      ['같은 창고 두 위치', [{ warehouse: 'wh1', location: 'loc1a', qty: 10 }, { warehouse: 'wh1', location: 'loc1b', qty: 15 }]],
      ['보통 자리 + 적치 대기', [{ warehouse: 'wh1', location: 'loc1a', qty: 20 }, { warehouse: 'wh1', location: 'staging1', qty: 5 }]],
      ['두 창고', [{ warehouse: 'wh1', location: 'loc1a', qty: 10 }, { warehouse: 'wh2', qty: 15 }]],
    ] as const)('R-2·FR-004a·Q2 한 LOT 의 잔액이 %s 에 나뉘어 있어도', (_, balances) => {
      it('Q2 완료된다 — 배분은 LOT 하나로 합치고, 창고마다 출고 전표·위치마다 출고 라인으로 그 몫만 빠진다', async () => {
        const made = await f.request([{ allocated: 25, salesOrdered: 25 }]);
        const lot = await f.lot({ balances: [...balances] });
        await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
        await f.oqcResult(made.oqcRequestIds.A, { matchedLotIds: [lot.lotId], overallJudgmentCode: 'ACCEPTED' }).expect(201);

        const done = await f.complete(made).expect(200);

        const shipmentId = BigInt(done.body.shipmentId);
        expect(await prisma.shipment.count({ where: { shipment_request_id: BigInt(made.requestId) } })).toBe(1);
        const allocations = await prisma.shipment_lot_allocation.findMany({ where: { shipment_line: { shipment_id: shipmentId } } });
        expect(allocations.map((row) => [Number(row.lot_id), Number(row.allocated_qty)])).toEqual([[lot.lotId, 25]]);
        const shipmentLines = await prisma.shipment_line.findMany({ where: { shipment_id: shipmentId } });
        expect(shipmentLines.map((row) => Number(row.shipped_qty))).toEqual([25]);
        const issues = await prisma.goods_issue.findMany({
          where: { source_document_type_code: 'SHIPMENT', source_document_id: shipmentId },
          include: { goods_issue_line: true },
        });
        const warehouseIds = [...new Set(balances.map((balance) => String(f.ids[balance.warehouse])))].sort();
        expect(issues.map((row) => String(row.source_warehouse_id)).sort()).toEqual(warehouseIds);
        const locationOf = (balance: (typeof balances)[number]): bigint => ('location' in balance ? f.ids[balance.location] : f.ids.loc2);
        expect(issues.flatMap((row) => row.goods_issue_line.map((line) => [String(row.source_warehouse_id), String(line.source_location_id), Number(line.issue_qty)])).sort())
          .toEqual(balances.map((balance) => [String(f.ids[balance.warehouse]), String(locationOf(balance)), balance.qty]).sort());
        const left = await prisma.inventory_balance.findMany({ where: { lot_id: BigInt(lot.lotId) } });
        expect(left.map((row) => [Number(row.on_hand_qty), Number(row.picked_qty)])).toEqual(balances.map(() => [0, 0]));
        const line = await prisma.shipment_request_line.findUniqueOrThrow({ where: { shipment_request_line_id: BigInt(made.lineIds[0]) }, include: { sales_order_line: true } });
        expect([Number(line.shipped_qty), Number(line.sales_order_line?.shipped_qty)]).toEqual([25, 25]);
      });
    });

    it('US1-4·US1-7·US2-5·FR-016·SC-004·Q8 피킹 부족·미검사·불합격·보류면 409 COMPLETION_BLOCKED 와 이유 목록 — 출하가 생기지 않는다', async () => {
      const short = await f.request([{ allocated: 100 }]);
      const lots = [];
      for (const qty of [40, 20, 20]) {
        const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty }] });
        await f.pickLot(short, 0, { lotId: lot.lotId }).expect(200);
        lots.push(lot);
      }
      await f.oqcResult(short.oqcRequestIds.A, { matchedLotIds: [lots[1].lotId], overallJudgmentCode: 'REJECTED' }).expect(201);
      await f.oqcResult(short.oqcRequestIds.A, { matchedLotIds: [lots[2].lotId], overallJudgmentCode: 'HELD' }).expect(201);

      const blocked = await f.complete(short).expect(409);

      expect(blocked.body).toMatchObject({ code: 'COMPLETION_BLOCKED' });
      expect(blocked.body.blockers).toEqual([
        { code: 'PICKING_SHORT', lineNo: 1 }, { code: 'NOT_INSPECTED', lotNo: lots[0].lotNo },
        { code: 'REJECTED', lotNo: lots[1].lotNo }, { code: 'HELD', lotNo: lots[2].lotNo },
      ]);
      expect(await prisma.shipment.count({ where: { shipment_request_id: BigInt(short.requestId) } })).toBe(0);
      expect((await f.lookup(`SHPREQ:${short.requestNo}`).expect(200)).body.blockers).toEqual(blocked.body.blockers);
    });

    it('US1-5 검사 불필요 품목만 있는 지시서는 OQC 없이 완료된다 · US7-2·Q15 수주 없는 지시서는 ERP 송신 대기를 쌓지 않는다', async () => {
      const made = await f.request([{ item: 'B', allocated: 30 }]);
      const lot = await f.lot({ item: 'B', balances: [{ warehouse: 'wh1', qty: 30 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);

      const done = await f.complete(made).expect(200);

      expect(await prisma.integration_message.count({ where: { target_type_code: 'SHIPMENT', target_id: BigInt(done.body.shipmentId) } })).toBe(0);
      expect(await prisma.goods_issue.count({ where: { source_document_type_code: 'SHIPMENT', source_document_id: BigInt(done.body.shipmentId) } })).toBe(1);
    });

    it('FR-019·Q11·US1-6 다시 완료하면 409 ALREADY_COMPLETED, 두 POP 이 동시에 완료해도 하나만 성공한다', async () => {
      const { made } = await readyRequest();

      const results = await Promise.all([f.complete(made), f.complete(made)]);

      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(results.find((response) => response.status === 409)?.body.code).toBe('ALREADY_COMPLETED');
      expect((await f.complete(made).expect(409)).body.code).toBe('ALREADY_COMPLETED');
      expect(await prisma.shipment.count({ where: { shipment_request_id: BigInt(made.requestId) } })).toBe(1);
    });

    it('Q3·D-16 수주 잔량 20 인 라인에 30 LOT 이 통째로 나간다 — 수주 출하 수량이 수주 수량을 넘고 송신 행에 30 이 실린다', async () => {
      const made = await f.request([{ allocated: 20, salesOrdered: 20, inspection: false }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 30 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);

      const done = await f.complete(made).expect(200);

      const orderLine = await prisma.sales_order_line.findUniqueOrThrow({ where: { sales_order_line_id: BigInt(made.salesOrderLineIds[0] as number) } });
      expect([Number(orderLine.ordered_qty), Number(orderLine.shipped_qty)]).toEqual([20, 30]);
      const message = await prisma.integration_message.findFirstOrThrow({ where: { target_type_code: 'SHIPMENT', target_id: BigInt(done.body.shipmentId) } });
      expect((message.payload as { lines: { shippedQty: number }[] }).lines[0].shippedQty).toBe(30);
    });

    it('Q16 OQC 생략된 지시서는 생략 뒤 피킹한 LOT 까지 완료 때 C27 이 남는다', async () => {
      const made = await f.request([{ allocated: 40 }]);
      await prisma.inspection_request.update({ where: { inspection_request_id: BigInt(made.oqcRequestIds.A) }, data: { status_code: 'SKIPPED', skip_basis_code: 'APPROVAL' } });
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 40 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      expect((await f.lotsOf(made))[0].oqcLotStatus).toBe('SKIPPED');

      await f.complete(made).expect(200);

      expect((await prisma.lot_status_event.findMany({ where: { lot_id: BigInt(lot.lotId) } })).map((row) => row.transition_code)).toEqual(['C27']);
    });

    it('Q21 수주 라인이 취소된 지시서는 막힌다(담당자에게 문의)', async () => {
      const made = await f.request([{ allocated: 30, salesOrdered: 30, inspection: false }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 30 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      await prisma.sales_order_line.update({ where: { sales_order_line_id: BigInt(made.salesOrderLineIds[0] as number) }, data: { cancelled_at: new Date() } });

      const blocked = await f.complete(made).expect(409);

      expect(blocked.body.blockers).toEqual([{ code: 'SALES_ORDER_LINE_CANCELLED', lineNo: 1 }]);
    });

    it('US4-3·Q10·Q21 지시서 코드가 아니면 400 NOT_SHIPMENT_REQUEST_CODE, 없는 지시서·남의 공장은 404 SHIPMENT_REQUEST_NOT_FOUND', async () => {
      const made = await f.request([{ allocated: 10 }]);

      const notCode = await f.lookup('SSE2E-LOT-1').expect(400);
      const missing = await f.lookup('SHPREQ:SR-00000000-9999').expect(404);
      await f.lookup(`SHPREQ:${made.requestNo}`, f.foreignPda).expect(404);
      await f.lookup(`SHPREQ:${made.requestNo}`, f.pda).expect(200);

      expect(notCode.body.errors[0]).toMatchObject({ field: 'code', code: 'NOT_SHIPMENT_REQUEST_CODE' });
      expect(missing.body.errors[0]).toMatchObject({ code: 'SHIPMENT_REQUEST_NOT_FOUND' });
    });

    it('US4-4·Q10 POP 찾기 — 번호·고객·품목 q 와 완료 대기만, 막힌 지시서는 blockerSummary 가 실린다', async () => {
      const { made: ready } = await readyRequest();
      const pending = await f.request([{ allocated: 30 }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 30 }] });
      await f.pickLot(pending, 0, { lotId: lot.lotId }).expect(200);
      const search = (query: Record<string, unknown>) => f.asTerminal(f.http().get('/api/logistics/shipment-requests')
        .query({ shipDateFrom: '2026-11-18', shipDateTo: '2026-11-18', size: 100, ...query }), f.pop).expect(200);

      const readyOnly = await search({ q: `SSE2E-${f.run}`, completionReadyOnly: true });
      const all = await search({ q: `SSE2E-${f.run}` });
      const byItem = await search({ q: '출하단순화품목A', completionReadyOnly: true });

      const ids = (body: { items: { shipmentRequestId: number }[] }) => body.items.map((item) => item.shipmentRequestId);
      expect(ids(readyOnly.body)).toContain(ready.requestId);
      expect(ids(readyOnly.body)).not.toContain(pending.requestId);
      expect(ids(byItem.body)).toContain(ready.requestId);
      const row = (all.body.items as { shipmentRequestId: number; blockerSummary: object; lotJudgmentSummary: object }[])
        .find((item) => item.shipmentRequestId === pending.requestId);
      expect(row).toMatchObject({ blockerSummary: { NOT_INSPECTED: 1 }, lotJudgmentSummary: { notInspected: 1 } });
      for (const item of readyOnly.body.items as { completionBlockers: unknown[] }[]) expect(item.completionBlockers).toEqual([]);
    });

    it('SC-009 PDA 는 :complete 를 부를 수 없고(401) 계정 세션은 403 이다', async () => {
      const { made } = await readyRequest();

      await f.complete(made, f.pda).expect(401);
      await f.complete(made, 'session').expect(403);
      expect(await prisma.shipment.count({ where: { shipment_request_id: BigInt(made.requestId) } })).toBe(0);
    });
  });
  describe('송신 전 취소(US6)·출하 내역(US7)', () => {
    beforeAll(async () => f.ensureCancelRoute());

    it('US6-1·SC-006·Q13 완료 직후 취소를 상신·승인·실행하면 재고·전표·출하 수량이 되돌아가고, 메시지가 CANCELLED, 피킹 LOT 이 PICKED 로 예약이 다시 잡힌다', async () => {
      const { made, lotIds } = await readyRequest();
      const done = await f.complete(made).expect(200);
      const shipmentId = done.body.shipmentId as number;

      const requested = await f.requestCancel(shipmentId);
      expect(requested.status).toBe(200);
      expect((await f.shipment(shipmentId)).body).toMatchObject({ cancelRequestPending: true, erpSendStatus: 'PENDING' });
      const cancelled = await f.cancelApproved(shipmentId);

      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ statusCode: 'CANCELLED', erpSendStatus: 'CANCELLED' });
      expect((await prisma.goods_issue.findMany({ where: { source_document_type_code: 'SHIPMENT', source_document_id: BigInt(shipmentId) } }))
        .map((row) => row.status_code)).toEqual(['CANCELLED', 'CANCELLED']);
      const balances = await prisma.inventory_balance.findMany({ where: { lot_id: { in: lotIds.map(BigInt) } }, orderBy: { lot_id: 'asc' } });
      expect(balances.map((row) => [Number(row.on_hand_qty), Number(row.picked_qty)])).toEqual([[40, 40], [40, 40], [30, 30]]);
      const line = await prisma.shipment_request_line.findUniqueOrThrow({ where: { shipment_request_line_id: BigInt(made.lineIds[0]) }, include: { sales_order_line: true } });
      expect([Number(line.shipped_qty), Number(line.sales_order_line?.shipped_qty)]).toEqual([0, 0]);
      expect((await prisma.shipment_request_lot.findMany({ where: { lot_id: { in: lotIds.map(BigInt) } } })).map((row) => [row.status_code, row.shipment_id]))
        .toEqual(lotIds.map(() => ['PICKED', null]));
      expect((await prisma.integration_message.findFirstOrThrow({ where: { target_type_code: 'SHIPMENT', target_id: BigInt(shipmentId) } })).status_code).toBe('CANCELLED');
      // OQC 결과는 판정 근거로 남는다 — 지시서는 「출하 완료 전」이고 다시 완료할 수 있다.
      expect((await prisma.inspection_result.findMany({ where: { inspection_request_id: BigInt(made.oqcRequestIds.A) } })).map((row) => row.status_code)).toEqual(['CONFIRMED']);
      const detail = await f.asSession(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`)).expect(200);
      expect(detail.body).toMatchObject({ shipmentProgressCode: 'PICKED', completedShipment: null, completionBlockers: [] });
      expect(detail.body.lines[0]).toMatchObject({ pickedQty: 110, shippedQty: 0 });
      await f.complete(made).expect(200);
    });

    it('US6-1·Q13·Q2 두 창고·적치 대기에 나뉜 LOT 의 출하를 취소하면 몫마다 제자리로 돌아가고 예약이 다시 잡힌다', async () => {
      const made = await f.request([{ allocated: 30, salesOrdered: 30 }]);
      const lot = await f.lot({ balances: [
        { warehouse: 'wh1', location: 'loc1a', qty: 10 }, { warehouse: 'wh1', location: 'staging1', qty: 5 }, { warehouse: 'wh2', qty: 15 },
      ] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      await f.oqcResult(made.oqcRequestIds.A, { matchedLotIds: [lot.lotId], overallJudgmentCode: 'ACCEPTED' }).expect(201);
      const shipmentId = (await f.complete(made).expect(200)).body.shipmentId as number;
      expect((await f.requestCancel(shipmentId)).status).toBe(200);

      expect((await f.cancelApproved(shipmentId)).status).toBe(200);

      const balances = await prisma.inventory_balance.findMany({ where: { lot_id: BigInt(lot.lotId) }, orderBy: { inventory_balance_id: 'asc' } });
      expect(balances.map((row) => [String(row.location_id), Number(row.on_hand_qty), Number(row.picked_qty)])).toEqual([
        [String(f.ids.loc1a), 10, 10], [String(f.ids.staging1), 5, 5], [String(f.ids.loc2), 15, 15],
      ]);
      const reservations = await prisma.inventory_reservation.findMany({
        where: { source_document_type_code: 'SHIPMENT_REQUEST_LINE', source_document_id: BigInt(made.lineIds[0]), lot_id: BigInt(lot.lotId) },
      });
      expect(reservations.filter((row) => Number(row.consumed_qty) - Number(row.released_qty) > 0).map((row) => Number(row.consumed_qty) - Number(row.released_qty)).sort((a, b) => a - b))
        .toEqual([5, 10, 15]);
      await f.complete(made).expect(200);
    });

    /** 완료한 출하의 PGI 메시지를 송신 오류로 둔다 — 러너가 보내다 실패한 모양(재시도 1회, 오류 문구). */
    const failSend = async (shipmentId: number, rowStatus?: string): Promise<bigint> => {
      const message = await prisma.integration_message.findFirstOrThrow({ where: { target_type_code: 'SHIPMENT', target_id: BigInt(shipmentId) } });
      await prisma.integration_message.update({
        where: { integration_message_id: message.integration_message_id },
        data: { status_code: 'FAILED', retry_count: 1, last_error_message: '중계 DB 거절' },
      });
      if (rowStatus !== undefined) {
        await prisma.erp_outbound_row.create({ data: {
          integration_message_id: message.integration_message_id, relay_table_name: 'RCV_DN', document_no: `DN-${shipmentId}`,
          relay_key: `K-${shipmentId}-${randomUUID().slice(0, 6)}`, create_type_code: 'A', row_values: {}, status_code: rowStatus,
        } });
      }
      return message.integration_message_id;
    };

    it('FR-023·Q14 송신 오류(FAILED, ERP 반영 행 없음) 출하도 취소를 상신·실행한다 — 메시지는 CANCELLED 라 다시 보내지 않는다', async () => {
      const { made } = await readyRequest();
      const shipmentId = (await f.complete(made).expect(200)).body.shipmentId as number;
      const messageId = await failSend(shipmentId, 'REJECTED');
      expect((await f.shipment(shipmentId)).body).toMatchObject({ erpSendStatus: 'SEND_ERROR' });

      expect((await f.requestCancel(shipmentId)).status).toBe(200);
      const cancelled = await f.cancelApproved(shipmentId);

      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ statusCode: 'CANCELLED', erpSendStatus: 'CANCELLED' });
      // CANCELLED 는 러너가 잡지 않고(PENDING 만) 재처리도 받지 않는다(FAILED 만) — 다시 시도되지 않는다.
      expect((await prisma.integration_message.findUniqueOrThrow({ where: { integration_message_id: messageId } })).status_code).toBe('CANCELLED');
    });

    it('FR-023·Q14 송신 오류라도 ERP 에 들어간 행(INSERTED·APPLIED)이 있으면 보낸 것으로 보고 409 ERP_ALREADY_SENT', async () => {
      for (const rowStatus of ['INSERTED', 'APPLIED']) {
        const { made } = await readyRequest();
        const shipmentId = (await f.complete(made).expect(200)).body.shipmentId as number;
        await failSend(shipmentId, rowStatus);

        const response = await f.requestCancel(shipmentId);

        expect([rowStatus, response.status, response.body.code]).toEqual([rowStatus, 409, 'ERP_ALREADY_SENT']);
      }
    });

    it('Q14 ERP 반영이 끝난(DONE) 출하도 409 ERP_ALREADY_SENT 다', async () => {
      const { made } = await readyRequest();
      const shipmentId = (await f.complete(made).expect(200)).body.shipmentId as number;
      await prisma.integration_message.updateMany({
        where: { target_type_code: 'SHIPMENT', target_id: BigInt(shipmentId) },
        data: { status_code: 'DONE', sent_at: new Date(), completed_at: new Date() },
      });

      const response = await f.requestCancel(shipmentId);

      expect([response.status, response.body.code]).toEqual([409, 'ERP_ALREADY_SENT']);
    });

    it('US6-1·FR-023 취소 실행이 출하 OQC 의뢰를 진행으로 다시 연다 — 새로 피킹한 LOT 에 결과를 넣고 다시 완료한다', async () => {
      const { made, lotIds } = await readyRequest();
      const shipmentId = (await f.complete(made).expect(200)).body.shipmentId as number;
      expect((await f.requestCancel(shipmentId)).status).toBe(200);
      expect((await f.cancelApproved(shipmentId)).status).toBe(200);

      const reopened = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(made.oqcRequestIds.A) }, include: { inspection_result: true } });
      expect([reopened.status_code, reopened.overall_judgment_code, reopened.confirmed_at]).toEqual(['IN_PROGRESS', null, null]);
      // 확정됐던 결과는 확정 그대로 남는다(판정 근거) — 새 결과는 작성중으로 쌓인다.
      expect(reopened.inspection_result.map((row) => row.status_code)).toEqual(['CONFIRMED']);

      // 다시 열린 의뢰에 결과를 더한다 — LOT 3 을 재검 불합격으로 덮고 PDA 에서 교체한 뒤, 새 LOT 을 피킹해 판정한다.
      await f.oqcResult(made.oqcRequestIds.A, { matchedLotIds: [lotIds[2]], overallJudgmentCode: 'REJECTED', reinspectionReasonCode: 'RETEST' }).expect(201);
      const third = (await f.lotsOf(made)).find((lot) => lot.lotId === lotIds[2]);
      await f.replaceLot(third?.shipmentRequestLotId as number).expect(200);
      const extra = await f.lot({ balances: [{ warehouse: 'wh2', qty: 25 }] });
      await f.pickLot(made, 0, { lotId: extra.lotId }).expect(200);
      expect((await f.lookup(`SHPREQ:${made.requestNo}`).expect(200)).body.blockers).toEqual([{ code: 'NOT_INSPECTED', lotNo: extra.lotNo }]);
      await f.oqcResult(made.oqcRequestIds.A, { matchedLotIds: [extra.lotId], overallJudgmentCode: 'ACCEPTED' }).expect(201);

      const again = await f.complete(made).expect(200);

      expect(again.body.shipmentId).not.toBe(shipmentId);
      const closed = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(made.oqcRequestIds.A) }, include: { inspection_result: { orderBy: { inspection_round: 'asc' } } } });
      expect([closed.status_code, closed.overall_judgment_code, closed.inspection_result.map((row) => row.status_code)])
        .toEqual(['COMPLETED', 'ACCEPTED', ['CONFIRMED', 'CONFIRMED', 'CONFIRMED']]);
      const shipped = await prisma.shipment_request_lot.findMany({
        where: { lot_id: { in: [lotIds[0], lotIds[1], extra.lotId].map(BigInt) }, shipment_id: BigInt(again.body.shipmentId) },
      });
      expect(shipped).toHaveLength(3);
    });

    it('US6-2·Q14 ERP 로 이미 보낸 출하는 취소 상신이 409 ERP_ALREADY_SENT 다', async () => {
      const { made } = await readyRequest();
      const done = await f.complete(made).expect(200);
      await prisma.integration_message.updateMany({
        where: { target_type_code: 'SHIPMENT', target_id: BigInt(done.body.shipmentId) },
        data: { status_code: 'PROCESSING', sent_at: new Date() },
      });

      const response = await f.requestCancel(done.body.shipmentId as number);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ERP_ALREADY_SENT');
      expect((await f.shipment(done.body.shipmentId as number)).body).toMatchObject({ erpSendStatus: 'SENT', cancelRequestPending: false });
    });

    it('US6-1 수주 없는 출하(보낼 것이 없다)도 송신 전으로 보고 취소된다', async () => {
      const made = await f.request([{ item: 'B', allocated: 30 }]);
      const lot = await f.lot({ item: 'B', balances: [{ warehouse: 'wh1', qty: 30 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      const done = await f.complete(made).expect(200);

      expect((await f.requestCancel(done.body.shipmentId as number)).status).toBe(200);
      const cancelled = await f.cancelApproved(done.body.shipmentId as number);

      expect(cancelled.body).toMatchObject({ statusCode: 'CANCELLED', erpSendStatus: 'NOT_SENT_NO_SALES_ORDER' });
    });

    it('US7-1~4·SC-007·Q15 출하 내역 — 창고 둘·완료 단말·작업자·LOT 별 출하 관리 코드·ERP 송신 상태와 그 필터', async () => {
      const { made } = await readyRequest();
      const firstLot = (await f.lotsOf(made))[0];
      await f.saveCode(firstLot.shipmentRequestLotId, 'BOX-7').expect(200);
      const withOrder = (await f.complete(made).expect(200)).body.shipmentId as number;
      const plain = await f.request([{ item: 'B', allocated: 30 }]);
      const lot = await f.lot({ item: 'B', balances: [{ warehouse: 'wh2', qty: 30 }] });
      await f.pickLot(plain, 0, { lotId: lot.lotId }).expect(200);
      const noOrder = (await f.complete(plain).expect(200)).body.shipmentId as number;

      const detail = (await f.shipment(withOrder)).body as unknown as Record<string, unknown> & {
        lines: { allocations: { lotId: number; managementCode: string | null; warehouseId: number }[] }[];
      };
      expect(detail).toMatchObject({
        warehouseId: null, statusCode: 'CONFIRMED', erpSendStatus: 'PENDING', cancelRequestPending: false,
        completedTerminal: { terminalId: Number(f.pop.terminalId) }, completedWorker: { workerNo: f.pop.workerNo },
      });
      expect((detail.warehouses as { warehouseId: number }[]).map((row) => row.warehouseId).sort()).toEqual([Number(f.ids.wh1), Number(f.ids.wh2)].sort());
      const allocation = detail.lines[0].allocations.find((row) => row.lotId === firstLot.lotId);
      expect(allocation).toMatchObject({ managementCode: 'BOX-7', warehouseId: Number(f.ids.wh1) });
      const filtered = await f.asSession(f.http().get('/api/logistics/shipments')
        .query({ shipDateFrom: '2026-11-18', shipDateTo: '2026-11-18', erpSendStatus: 'NOT_SENT_NO_SALES_ORDER', size: 100 })).expect(200);
      const ids = (filtered.body.items as { shipmentId: number; erpSendStatus: string }[]).map((row) => row.shipmentId);
      expect(ids).toContain(noOrder);
      expect(ids).not.toContain(withOrder);
      for (const row of filtered.body.items as { erpSendStatus: string }[]) expect(row.erpSendStatus).toBe('NOT_SENT_NO_SALES_ORDER');

      await prisma.integration_message.updateMany({ where: { target_type_code: 'SHIPMENT', target_id: BigInt(withOrder) }, data: { status_code: 'FAILED' } });
      expect((await f.shipment(withOrder)).body.erpSendStatus).toBe('SEND_ERROR');
    });

    it('US7-4·Q15 수주 라인과 수주 없는 라인이 섞인 지시서는 수주 라인만 송신 행이 된다', async () => {
      const made = await f.request([{ allocated: 30, salesOrdered: 30, inspection: false }, { item: 'B', allocated: 20 }]);
      const a = await f.lot({ balances: [{ warehouse: 'wh1', qty: 30 }] });
      const b = await f.lot({ item: 'B', balances: [{ warehouse: 'wh1', qty: 20 }] });
      await f.pickLot(made, 0, { lotId: a.lotId }).expect(200);
      await f.pickLot(made, 1, { lotId: b.lotId }).expect(200);
      const shipmentId = (await f.complete(made).expect(200)).body.shipmentId as number;
      const message = await prisma.integration_message.findFirstOrThrow({ where: { target_type_code: 'SHIPMENT', target_id: BigInt(shipmentId) } });

      const rows = await goodsIssueBuilder(prisma).build({
        id: message.integration_message_id, interfaceCode: message.interface_code, targetTypeCode: 'SHIPMENT', targetId: BigInt(shipmentId), payload: message.payload,
      });

      expect(rows.map((row) => [row.values.DN_REQ_SEQ, row.values.GI_QTY, row.values.PLANT_CD])).toEqual([[1, '30', 'SSE2E-P1']]);
    });
  });
});
