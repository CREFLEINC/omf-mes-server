/**
 * 피처 010 시안 차이 보완(omf-all-around#305) — 승인 시안(버전 3)이 그리는 표시 칸을 응답에 싣는다 (e2e).
 *
 * - 지시서 상세: 수주 번호, 라인의 품목 코드·이름·단위·수주 라인(수주·출하 수량), LOT 몫의 위치 역할(적치 대기), OQC 판정 근거
 * - `:lookup`: LOT 의 창고·위치 몫·단위, 교체된 LOT
 * - 출하 목록·상세: 지시서·고객·납품처·수주, 창고별 출고 전표·수량·위치, `q` 의 범위(출하번호·지시서·고객)
 *
 * 시험 이름 앞의 ID 는 `specs/010-shipping-simplification/verification.md`·`quickstart.md` 의 항목이다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { MadeRequest, SS_PREFIX, ShipmentSimplifiedFixture } from './support/shipment-simplified-fixture';

function validator(path: string, method: string, status: string): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8')) as object;
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface PortionBody { warehouseId: number; locationId: number | null; locationSystemRoleCode: string | null; qty: number }
interface LotBody {
  shipmentRequestLotId: number;
  lotId: number;
  statusCode: string;
  oqcLotStatus: string | null;
  portions: PortionBody[];
  oqcResult: { inspectionResultId: number; resultNo: string; round: number; resultAt: string } | null;
  replacement: { resultRound: number } | null;
}

describe('출하 공정 단순화 — 시안 표시 칸 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let f: ShipmentSimplifiedFixture;
  let staging = 0n;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    f = new ShipmentSimplifiedFixture(app, prisma);
    await f.setup();
    const code = `${SS_PREFIX}-STG`;
    // 창고마다 적치 대기 자리는 하나다(유일 제약) — 이미 있으면 그것을 쓴다.
    staging = ((await prisma.location.findFirst({ where: { warehouse_id: f.ids.wh1, system_role_code: 'PUTAWAY_STAGING' } }))
      ?? await prisma.location.create({ data: {
        warehouse_id: f.ids.wh1, location_code: code, location_name: '출하단순화적치대기', system_role_code: 'PUTAWAY_STAGING',
      } })).location_id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const detailOf = async (made: MadeRequest) =>
    (await f.asSession(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`)).expect(200)).body as Record<string, unknown> & {
      lines: (Record<string, unknown> & { lots: LotBody[] })[];
    };

  /** 적치 대기 자리에 몫이 있는 LOT — 픽스처의 잔액 행에 적치 대기 자리 행 하나를 더한다. */
  const lotWithStaging = async (qty: number, stagingQty: number): Promise<{ lotId: number; lotNo: string }> => {
    const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty }] });
    await prisma.inventory_balance.create({ data: {
      legal_entity_id: f.ids.entity, business_unit_id: f.ids.unit, plant_id: f.ids.plant, warehouse_id: f.ids.wh1, location_id: staging,
      item_id: f.ids.itemA, lot_id: BigInt(lot.lotId), quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE',
      ownership_type_code: 'OWNED', on_hand_qty: stagingQty, uom_id: f.ids.uom,
    } });
    return lot;
  };

  describe('지시서 상세(PDA 피킹 · W-04-02)', () => {
    it('D-16·Q3 수주 번호와 라인의 품목·단위·수주 라인(수주·출하 수량)이 실린다 — 수주를 넘겨 출하하면 출하 수량이 수주보다 크다', async () => {
      const made = await f.request([{ allocated: 30, salesOrdered: 20, inspection: false }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 30 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      await f.complete(made).expect(200);

      const response = await f.asSession(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`)).expect(200);

      const validate = validator('/logistics/shipment-requests/{shipmentRequestId}', 'get', '200');
      expect(validate(response.body) ? [] : validate.errors).toEqual([]);
      const order = await prisma.sales_order_line.findUniqueOrThrow({
        where: { sales_order_line_id: BigInt(made.salesOrderLineIds[0] as number) }, include: { sales_order: true },
      });
      const uom = await prisma.uom.findUniqueOrThrow({ where: { uom_id: f.ids.uom } });
      expect(response.body.salesOrderNo).toBe(order.sales_order.sales_order_no);
      expect(response.body.lines[0]).toMatchObject({
        itemCode: `${SS_PREFIX}-A`, itemName: '출하단순화품목A', uomCode: uom.uom_code,
        salesOrderLine: {
          salesOrderLineId: made.salesOrderLineIds[0], salesOrderNo: order.sales_order.sales_order_no, lineNo: 1,
          orderedQty: 20, shippedQty: 30, cancelled: false,
        },
      });
    });

    it('D-16 수주 없는 지시서는 수주 번호·수주 라인이 null 이다 · 목록 행에도 같은 칸이 실린다', async () => {
      const made = await f.request([{ item: 'B', allocated: 10 }]);

      const detail = await detailOf(made);
      const list = await f.asSession(f.http().get('/api/logistics/shipment-requests')
        .query({ shipDateFrom: '2026-11-18', shipDateTo: '2026-11-18', q: made.requestNo, size: 100 })).expect(200);

      expect(detail.salesOrderNo).toBeNull();
      expect(detail.lines[0]).toMatchObject({ itemCode: `${SS_PREFIX}-B`, itemName: '출하단순화품목B', salesOrderLine: null });
      const row = (list.body.items as { shipmentRequestId: number; lines: { itemName: string }[] }[]).find((item) => item.shipmentRequestId === made.requestId);
      expect(row?.lines[0].itemName).toBe('출하단순화품목B');
    });

    it('R-2·Q2 적치 대기 자리 몫은 위치 역할(PUTAWAY_STAGING)이 실리고 보통 자리는 null 이다', async () => {
      const made = await f.request([{ allocated: 100 }]);
      const lot = await lotWithStaging(20, 10);

      const picked = await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);

      const portions = picked.body.pickedLot.portions as PortionBody[];
      expect(portions).toEqual(expect.arrayContaining([
        expect.objectContaining({ locationId: Number(f.ids.loc1a), locationSystemRoleCode: null, qty: 20 }),
        expect.objectContaining({ locationId: Number(staging), locationSystemRoleCode: 'PUTAWAY_STAGING', qty: 10 }),
      ]));
      expect((await detailOf(made)).lines[0].lots[0].portions).toHaveLength(2);
    });

    it('US2-1 OQC 판정의 근거 결과(번호·회차·시각)가 LOT 마다 실린다 — 미검사는 null, 교체 이력에는 근거 결과의 회차', async () => {
      const made = await f.request([{ allocated: 110 }]);
      const lotIds: number[] = [];
      for (const qty of [40, 40, 30]) {
        const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty }] });
        await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
        lotIds.push(lot.lotId);
      }
      const accepted = await f.oqcResult(made.oqcRequestIds.A, { matchedLotIds: [lotIds[0], lotIds[1]], overallJudgmentCode: 'ACCEPTED' }).expect(201);
      const rejected = await f.oqcResult(made.oqcRequestIds.A, {
        matchedLotIds: [lotIds[2]], overallJudgmentCode: 'REJECTED',
      }).expect(201);

      const lots = (await detailOf(made)).lines[0].lots;

      expect(lots.map((lot) => lot.oqcLotStatus)).toEqual(['ACCEPTED', 'ACCEPTED', 'REJECTED']);
      expect(lots[0].oqcResult).toMatchObject({ inspectionResultId: accepted.body.inspectionResultId, round: 1 });
      expect(lots[2].oqcResult).toEqual({
        inspectionResultId: rejected.body.inspectionResultId, resultNo: rejected.body.inspectionResultNo,
        round: 2, resultAt: '2026-11-18T03:00:00.000Z',
      });

      await f.replaceLot(lots[2].shipmentRequestLotId).expect(200);
      const next = await f.lot({ balances: [{ warehouse: 'wh1', qty: 30 }] });
      await f.pickLot(made, 0, { lotId: next.lotId }).expect(200);
      const after = (await detailOf(made)).lines[0].lots;
      const replaced = after.find((lot) => lot.lotId === lotIds[2]);
      const fresh = after.find((lot) => lot.lotId === next.lotId);

      expect(replaced).toMatchObject({ statusCode: 'REPLACED', oqcResult: null, replacement: { resultRound: 2 } });
      expect(fresh).toMatchObject({ oqcLotStatus: 'NOT_INSPECTED', oqcResult: null });
    });
  });

  describe('POP 출하 완료 확인(:lookup · P-04-07)', () => {
    it('US4-5·US3-5 LOT 마다 창고·위치 몫(적치 대기 포함)과 단위가 실리고, 교체된 LOT 은 replacedLots 로 따로 실린다', async () => {
      const made = await f.request([{ allocated: 60, salesOrdered: 60 }]);
      const split = await f.lot({ balances: [{ warehouse: 'wh1', location: 'loc1a', qty: 20 }, { warehouse: 'wh2', qty: 20 }] });
      const bad = await lotWithStaging(20, 10);
      await f.pickLot(made, 0, { lotId: split.lotId }).expect(200);
      await f.pickLot(made, 0, { lotId: bad.lotId }).expect(200);
      await f.oqcResult(made.oqcRequestIds.A, { matchedLotIds: [split.lotId], overallJudgmentCode: 'ACCEPTED' }).expect(201);
      await f.oqcResult(made.oqcRequestIds.A, { matchedLotIds: [bad.lotId], overallJudgmentCode: 'REJECTED' }).expect(201);
      const badRow = (await detailOf(made)).lines[0].lots.find((lot) => lot.lotId === bad.lotId) as LotBody;
      const replaced = await f.replaceLot(badRow.shipmentRequestLotId).expect(200);

      const response = await f.lookup(`SHPREQ:${made.requestNo}`).expect(200);

      const validate = validator('/logistics/shipment-requests:lookup', 'get', '200');
      expect(validate(response.body) ? [] : validate.errors).toEqual([]);
      const uom = await prisma.uom.findUniqueOrThrow({ where: { uom_id: f.ids.uom } });
      expect(response.body.lines[0]).toMatchObject({ uomCode: uom.uom_code, lotCount: 1 });
      expect(response.body.lots).toHaveLength(1);
      expect(response.body.lots[0]).toMatchObject({ lotId: split.lotId, uomId: Number(f.ids.uom), uomCode: uom.uom_code });
      expect((response.body.lots[0].portions as PortionBody[]).map((row) => [row.warehouseId, row.locationId, row.qty]).sort()).toEqual([
        [Number(f.ids.wh1), Number(f.ids.loc1a), 20], [Number(f.ids.wh2), Number(f.ids.loc2), 20],
      ].sort());
      expect(response.body.replacedLots).toEqual([expect.objectContaining({
        shipmentRequestLotId: badRow.shipmentRequestLotId, lineNo: 1, lotId: bad.lotId, lotNo: bad.lotNo, qty: 30,
        uomCode: uom.uom_code, judgment: 'REJECTED', nonconformanceNo: replaced.body.nonconformanceNo,
        replacedAt: expect.any(String),
      })]);
      expect((response.body.replacedLots[0].portions as PortionBody[]).find((row) => row.locationSystemRoleCode === 'PUTAWAY_STAGING')?.qty).toBe(10);
    });
  });

  describe('출하 내역(W-04-12)', () => {
    async function completed(): Promise<{ made: MadeRequest; shipmentId: number }> {
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
      const shipmentId = (await f.complete(made).expect(200)).body.shipmentId as number;
      return { made, shipmentId };
    }

    it('US7-1·D-15·Q15 목록·상세에 지시서·고객·납품처·수주가, 상세 창고마다 출고 전표·빠진 수량·위치별 수량이 실린다', async () => {
      const { made, shipmentId } = await completed();

      const list = await f.asSession(f.http().get('/api/logistics/shipments')
        .query({ shipDateFrom: '2026-11-18', shipDateTo: '2026-11-18', shipmentRequestId: made.requestId, size: 100 })).expect(200);
      const detail = (await f.shipment(shipmentId)).body as unknown as Record<string, unknown> & {
        warehouses: { warehouseId: number; goodsIssueNos: string[]; qty: number; locations: { locationId: number; qty: number }[] }[];
      };

      const validateList = validator('/logistics/shipments', 'get', '200');
      expect(validateList(list.body) ? [] : validateList.errors).toEqual([]);
      const validateDetail = validator('/logistics/shipments/{shipmentId}', 'get', '200');
      expect(validateDetail(detail) ? [] : validateDetail.errors).toEqual([]);
      const order = await prisma.sales_order.findFirstOrThrow({ where: { sales_order_line: { some: { sales_order_line_id: BigInt(made.salesOrderLineIds[0] as number) } } } });
      const head = {
        shipmentRequestNo: made.requestNo, salesOrderNo: order.sales_order_no,
        customer: { partnerId: Number(f.ids.customer), partnerCode: `${SS_PREFIX}-C`, partnerName: '출하단순화C' },
        shipTo: { partnerId: Number(f.ids.shipTo), partnerCode: `${SS_PREFIX}-S`, partnerName: '출하단순화S' },
      };
      expect(list.body.items).toEqual([expect.objectContaining({ shipmentId, ...head })]);
      expect(detail).toMatchObject(head);
      const issues = await prisma.goods_issue.findMany({ where: { source_document_type_code: 'SHIPMENT', source_document_id: BigInt(shipmentId) } });
      const noOf = (warehouseId: bigint) => issues.filter((row) => row.source_warehouse_id === warehouseId).map((row) => row.goods_issue_no);
      const byWarehouse = new Map(detail.warehouses.map((row) => [row.warehouseId, row]));
      expect(byWarehouse.get(Number(f.ids.wh1))).toMatchObject({ goodsIssueNos: noOf(f.ids.wh1), qty: 70 });
      expect(byWarehouse.get(Number(f.ids.wh1))?.locations.map((row) => [row.locationId, row.qty]).sort()).toEqual([
        [Number(f.ids.loc1a), 40], [Number(f.ids.loc1b), 30],
      ].sort());
      expect(byWarehouse.get(Number(f.ids.wh2))).toMatchObject({ goodsIssueNos: noOf(f.ids.wh2), qty: 40, locations: [{ locationId: Number(f.ids.loc2), qty: 40 }] });
    });

    it('US7-3 목록 q 는 출하번호·지시서 번호·고객(코드·이름)으로 찾는다 — LOT 번호로는 찾지 않는다', async () => {
      const { made, shipmentId } = await completed();
      const search = async (q: string): Promise<number[]> => {
        const response = await f.asSession(f.http().get('/api/logistics/shipments')
          .query({ shipDateFrom: '2026-11-18', shipDateTo: '2026-11-18', q, size: 100 })).expect(200);
        return (response.body.items as { shipmentId: number }[]).map((row) => row.shipmentId);
      };
      const shipmentNo = (await f.shipment(shipmentId)).body.shipmentNo as string;
      const lotNo = (await prisma.lot.findFirstOrThrow({ where: { shipment_lot_allocation: { some: { shipment_line: { shipment_id: BigInt(shipmentId) } } } } })).lot_no;

      expect(await search(shipmentNo)).toEqual([shipmentId]);
      expect(await search(made.requestNo)).toEqual([shipmentId]);
      expect(await search(`${SS_PREFIX}-C`)).toContain(shipmentId);
      expect(await search('출하단순화C')).toContain(shipmentId);
      expect(await search(lotNo)).not.toContain(shipmentId);
    });
  });

  describe('검증 1회차 보탬 — 고객·납품처, POP 지시서 상세, ERP 송신 건수, OQC 품목 칸', () => {
    it('US4-4·Q10 지시서 목록·상세에 고객·납품처(코드·이름)가 실린다 — PDA 카드·POP 찾기가 쓴다', async () => {
      const made = await f.request([{ allocated: 10 }]);
      const head = {
        customer: { partnerId: Number(f.ids.customer), partnerCode: `${SS_PREFIX}-C`, partnerName: '출하단순화C' },
        shipTo: { partnerId: Number(f.ids.shipTo), partnerCode: `${SS_PREFIX}-S`, partnerName: '출하단순화S' },
      };

      const detail = await detailOf(made);
      const list = await f.asTerminal(f.http().get('/api/logistics/shipment-requests')
        .query({ shipDateFrom: '2026-11-18', shipDateTo: '2026-11-18', q: made.requestNo, size: 100 }), f.pda).expect(200);

      expect(detail).toMatchObject(head);
      const validate = validator('/logistics/shipment-requests/{shipmentRequestId}', 'get', '200');
      expect(validate(detail) ? [] : validate.errors).toEqual([]);
      expect((list.body.items as { shipmentRequestId: number }[]).find((row) => row.shipmentRequestId === made.requestId)).toMatchObject(head);
    });

    it('US3-1 POP 단말은 자기 공장 지시서 상세를 읽는다(P-04-06 머리·피킹 LOT 몫) — PDA 는 401', async () => {
      const made = await f.request([{ allocated: 10 }]);

      const pop = await f.asTerminal(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`), f.pop).expect(200);
      await f.asTerminal(f.http().get(`/api/logistics/shipment-requests/${made.requestId}`), f.pda).expect(401);

      expect(pop.body).toMatchObject({ shipmentRequestId: made.requestId, customer: { partnerName: '출하단순화C' } });
    });

    it('US7-2·Q15 출하 목록에 ERP 송신 상태별 건수가 실린다 — 송신 상태 거르기를 걸어도 다른 조건으로만 센다', async () => {
      const made = await f.request([{ allocated: 10, salesOrdered: 10, inspection: false }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 10 }] });
      await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      await f.complete(made).expect(200);
      const query = { shipDateFrom: '2026-11-18', shipDateTo: '2026-11-18', shipmentRequestId: made.requestId, size: 100 };

      const all = await f.asSession(f.http().get('/api/logistics/shipments').query(query)).expect(200);
      const sent = await f.asSession(f.http().get('/api/logistics/shipments').query({ ...query, erpSendStatus: 'SENT' })).expect(200);

      expect(all.body.erpSendStatusCounts).toEqual({ PENDING: 1 });
      expect(sent.body.items).toEqual([]);
      expect(sent.body.erpSendStatusCounts).toEqual({ PENDING: 1 });
      const validate = validator('/logistics/shipments', 'get', '200');
      expect(validate(all.body) ? [] : validate.errors).toEqual([]);
    });

    it('US3-1 출하 OQC 의뢰 목록·상세에 품목 코드·이름·단위와 (목록) 피킹 수량 합이 실린다 — POP 카드 「FG · 피킹 LOT n개 · 합 EA」', async () => {
      const made = await f.request([{ allocated: 100 }]);
      for (const qty of [40, 30]) {
        const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty }] });
        await f.pickLot(made, 0, { lotId: lot.lotId }).expect(200);
      }
      const requestId = made.oqcRequestIds.A;

      const detail = await f.asTerminal(f.http().get(`/api/quality/inspection-requests/${requestId}`), f.pop).expect(200);
      const list = await f.asTerminal(f.http().get('/api/quality/inspection-requests').query({ inspectionTypeCode: 'OQC', size: 200 }), f.pop).expect(200);

      const item = { itemCode: `${SS_PREFIX}-A`, itemName: '출하단순화품목A' };
      expect(detail.body).toMatchObject({ ...item, uomCode: expect.any(String) });
      expect((list.body.items as { inspectionRequestId: number }[]).find((row) => row.inspectionRequestId === requestId))
        .toMatchObject({ ...item, pickedLotCount: 2, pickedQty: 70 });
    });
  });
});
