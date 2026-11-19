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
});
