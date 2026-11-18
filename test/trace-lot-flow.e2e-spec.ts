/**
 * LOT 추적 정방향·역방향(장부 P-119) — 사슬 하나로 목록 둘과 LOT 하나의 사슬 둘을 본다.
 *
 * 자재 LOT M1 ─ 입하(공급사 LOT)·자재입고
 *   ├ W/O G(계보) → 생산 LOT G1 ─ 생산입고(+취소 완료 1)·포장(확정 HU1 · 열린 HU2)·출하(HU1 로 · LOT 직접 · 취소 1)
 *   │                               (G2 는 실적 없는 선발행 슬롯 — 안 보여야 한다)
 *   ├ W/O L(계보 없음) → L1 (W/O 단위 추정)
 *   ├ W/O N(실적 없음) → 이은 LOT 없음(linkBasis null)
 *   ├ W/O T(계보 · M1 은 이어지지 않음) → 빈 목록(linkBasis 계보)
 *   └ W/O S(계보) → 반제품 S1 ─ W/O G·T 에 다시 투입
 * 자재 LOT M2 ─ 자재입고만
 * 반제품 C1 ─ 자기 W/O C(계보 없음)에 다시 투입 — W/O 단위 추정으로 C1 → C1(순환)
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';
import { LotFlowChainService, PRODUCTION_LOTS_SHOWN } from '../src/trace/flow/lot-flow-chain.service';

const PREFIX = 'TLFE2E';
const DAY = '2026-08-12';
/** 분할 사슬(피처 008)은 다른 날·다른 품목에 둔다 — 기존 기간·품목 기대값을 흔들지 않는다. */
const SPLIT_DAY = '2026-08-14';
const USERS = { allowed: `${PREFIX}-allowed`, denied: `${PREFIX}-denied` };
const PASSWORD = 'TL-추적-비밀번호';
const CONTRACT = 'logistics-01자재창고.json';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function validator(path: string): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts', CONTRACT), 'utf8')) as object;
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/get/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

function conforms(path: string, body: unknown): void {
  const validate = validator(path);
  if (!validate(body)) throw new Error(JSON.stringify(validate.errors));
}

describe('LOT 추적 정방향·역방향 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cookies: Record<keyof typeof USERS, string[]> = { allowed: [], denied: [] };
  const ids: Record<string, bigint> = {};
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeChain();
    await makeSplitChain();
    // W-03-01(LOT 상세·LOT 현황)·W-04-08(재고) — 분할 LOT 상세와 입하 LOT 축(피처 008)을 같은 계정으로 본다.
    cookies.allowed = await login(USERS.allowed, ['W-02-09', 'W-03-01', 'W-04-08']);
    cookies.denied = await login(USERS.denied, ['W-02-08']);
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const get = (path: string, query: Record<string, string | number> = {}, who: keyof typeof USERS = 'allowed') =>
    request(app.getHttpServer()).get(`/api/trace/${path}`).query(query).set('Cookie', cookies[who]);
  const no = (rows: Body[]) => rows.map((row) => row.lotNo as string);

  describe('정방향 목록 GET /trace/material-lot-flows', () => {
    const window = { itemId: 0, receiptDateFrom: DAY, receiptDateTo: DAY };
    const query = () => ({ ...window, itemId: Number(ids.material) });

    it('자재 LOT 마다 입하·입고와 단계를 싣고, 단계별 건수를 함께 준다', async () => {
      const body = (await get('material-lot-flows', query()).expect(200)).body as Body;

      conforms('/trace/material-lot-flows', body);
      expect(no(body.items)).toEqual([`${PREFIX}-M2`, `${PREFIX}-M1`]);
      expect(body.stageCounts).toEqual({ RECEIVED: 1, CONSUMED: 0, PRODUCED: 0, PRODUCTION_RECEIVED: 0, PACKED: 0, SHIPPED: 1 });
      const m1 = body.items[1];
      expect(m1).toMatchObject({
        currentStageCode: 'SHIPPED', basis: 'WORK_ORDER_ESTIMATE', receivedQty: 100, consumedQty: 50,
        inbound: { inboundReceiptNo: `${PREFIX}-IR`, supplierLotNo: 'SUP-LOT-1', supplier: { code: `${PREFIX}-SUP` } },
        // 포장은 확정(PACKED) 상자만, 출하는 취소를 빼고 HU 로 나간 것과 LOT 직접 배분을 함께 센다.
        stages: {
          received: { count: 1 }, consumed: { workOrderCount: 5 }, produced: { lotCount: 3 },
          productionReceived: { lotCount: 1 }, packed: { lotCount: 1, handlingUnitCount: 1 }, shipped: { lotCount: 1, shipmentCount: 2 },
        },
      });
      // 투입 없음 — 추정 이음이 없으니 근거도 없다(화면이 「추정 포함」을 띄우지 않는다).
      expect(body.items[0]).toMatchObject({ currentStageCode: 'RECEIVED', basis: null });
    });

    it('단계로 거르면 그 단계만 오지만 단계별 건수는 그대로다', async () => {
      const body = (await get('material-lot-flows', { ...query(), currentStageCode: 'RECEIVED,PACKED' }).expect(200)).body as Body;

      expect(no(body.items)).toEqual([`${PREFIX}-M2`]);
      expect(body.page.total).toBe(1);
      expect(body.stageCounts.SHIPPED).toBe(1);
    });

    it('단계가 아닌 조건(공급사)을 걸면 단계별 건수도 그 조건으로 센다', async () => {
      const body = (await get('material-lot-flows', { ...query(), supplierId: Number(ids.supplier) }).expect(200)).body as Body;

      expect(no(body.items)).toEqual([`${PREFIX}-M1`]);
      expect(body.stageCounts).toEqual({ RECEIVED: 0, CONSUMED: 0, PRODUCED: 0, PRODUCTION_RECEIVED: 0, PACKED: 0, SHIPPED: 1 });
    });

    it('입하 번호로 집으면 기간 없이도 된다', async () => {
      const body = (await get('material-lot-flows', { inboundReceiptNo: `${PREFIX}-IR` }).expect(200)).body as Body;
      expect(no(body.items)).toEqual([`${PREFIX}-M1`]);
    });

    it('기간만으로 조회한다 — 품목·번호 없이 그 기간의 자재 LOT 전체이고, 다른 칸은 거르는 조건이다', async () => {
      const all = (await get('material-lot-flows', { receiptDateFrom: DAY, receiptDateTo: DAY }).expect(200)).body as Body;
      conforms('/trace/material-lot-flows', all);
      expect(all.page.total).toBeGreaterThanOrEqual(2);
      expect(Object.values(all.stageCounts as Record<string, number>).reduce((sum, n) => sum + n, 0)).toBe(all.page.total);

      const inWarehouse = (await get('material-lot-flows', { receiptDateFrom: DAY, receiptDateTo: DAY, warehouseId: Number(ids.warehouse) }).expect(200)).body as Body;
      expect(no(inWarehouse.items)).toEqual([`${PREFIX}-M2`, `${PREFIX}-M1`]);
      // 기간 밖이면 없다 — 기간은 SQL 에서 건다.
      const before = (await get('material-lot-flows', { receiptDateFrom: '2026-08-11', receiptDateTo: '2026-08-11', warehouseId: Number(ids.warehouse) }).expect(200)).body as Body;
      expect(before.items).toEqual([]);
    });

    it('기간도 번호도 없으면 400 — receiptDateFrom 칸을 짚고 넣을 칸을 알린다 · 품목이나 LOT 번호 일부만으로는 부족하다', async () => {
      const message = '조회 기간이 없습니다. 입고일 시작(receiptDateFrom)을 넣거나 자재 LOT 번호(lotNo), 입하 번호(inboundReceiptNo) 중 하나를 넣어 다시 조회하세요. 기간은 최대 366일입니다.';
      for (const query of [{}, { itemId: Number(ids.material) }, { q: `${PREFIX}-M` }] as Record<string, string | number>[]) {
        const response = await get('material-lot-flows', query).expect(400);
        expect(response.body.errors).toEqual([{ scope: 'field', field: 'receiptDateFrom', code: 'REQUIRED', message }]);
      }
    });

    it('LOT 추적 권한이 없으면 403 이다', async () => {
      await get('material-lot-flows', query(), 'denied').expect(403);
    });
  });

  describe('정방향 사슬 GET /trace/lots/{lotId}/forward-flow', () => {
    it('투입 W/O 마다 이은 생산 LOT 과 그 뒤 문서를 싣는다 — 근거는 W/O 마다, 실적 없는 W/O 는 null', async () => {
      const body = (await get(`lots/${ids.m1}/forward-flow`).expect(200)).body as Body;

      conforms('/trace/lots/{lotId}/forward-flow', body);
      expect(body).toMatchObject({ basis: 'WORK_ORDER_ESTIMATE', truncated: false, totalProductionLotCount: 3, lot: { lotNo: `${PREFIX}-M1` } });
      const byNo = Object.fromEntries((body.workOrders as Body[]).map((wo) => [wo.workOrderNo, wo]));
      expect(Object.keys(byNo).sort()).toEqual([`${PREFIX}-WO-G`, `${PREFIX}-WO-L`, `${PREFIX}-WO-N`, `${PREFIX}-WO-S`, `${PREFIX}-WO-T`]);
      // 실적이 아예 없으면 null(투입만) · 실적은 있는데 이 LOT 이 이어지지 않았으면 계보 근거에 빈 목록.
      expect(byNo[`${PREFIX}-WO-N`]).toMatchObject({ linkBasis: null, productionLots: [] });
      expect(byNo[`${PREFIX}-WO-T`]).toMatchObject({ linkBasis: 'LOT_GENEALOGY_ESTIMATE', productionLots: [] });
      expect(byNo[`${PREFIX}-WO-L`]).toMatchObject({ linkBasis: 'WORK_ORDER_ESTIMATE' });
      expect(no(byNo[`${PREFIX}-WO-L`].productionLots)).toEqual([`${PREFIX}-L1`]);
      // 실적 없는 선발행 슬롯 G2 는 같은 W/O 여도 잇지 않는다.
      expect(no(byNo[`${PREFIX}-WO-G`].productionLots)).toEqual([`${PREFIX}-G1`]);
      expect(byNo[`${PREFIX}-WO-G`].productionLots[0]).toMatchObject({
        linkBasis: 'LOT_GENEALOGY_ESTIMATE', goodQty: 40, consumedFurther: 0, cyclic: false,
        // 취소 완료 입고·취소 출하는 빠지고, 한 LOT 이 상자 둘·출하 둘로 나뉜다.
        productionReceipts: [{ goodsReceiptNo: `${PREFIX}-GR-G1`, qty: 40 }],
        packages: [{ handlingUnitNo: `${PREFIX}-HU1`, statusCode: 'PACKED', qty: 30 }, { handlingUnitNo: `${PREFIX}-HU2`, statusCode: 'OPEN', qty: 5 }],
        shipments: [
          { shipmentNo: `${PREFIX}-SH1`, qty: 30, handlingUnitNo: `${PREFIX}-HU1`, customer: { code: `${PREFIX}-CUS` } },
          { shipmentNo: `${PREFIX}-SH2`, qty: 5, handlingUnitNo: null },
        ],
      });
      expect(byNo[`${PREFIX}-WO-G`].productionLots[0].productionReceipts).toHaveLength(1);
      expect(byNo[`${PREFIX}-WO-G`].productionLots[0].shipments).toHaveLength(2);
      // 반제품은 한 단만 — 다시 투입됐다는 표시만 준다.
      expect(byNo[`${PREFIX}-WO-S`].productionLots[0]).toMatchObject({ lotNo: `${PREFIX}-S1`, consumedFurther: 2 });
    });

    it('생산 LOT 이 상한을 넘으면 앞만 싣고 truncated·전체 수를 준다', async () => {
      const chains = app.get(LotFlowChainService);
      chains.productionLotsShown = 1;
      try {
        const body = (await get(`lots/${ids.m1}/forward-flow`).expect(200)).body as Body;
        expect(body).toMatchObject({ truncated: true, totalProductionLotCount: 3 });
        expect((body.workOrders as Body[]).flatMap((wo) => wo.productionLots)).toHaveLength(1);
      } finally {
        chains.productionLotsShown = PRODUCTION_LOTS_SHOWN;
      }
    });

    it('조회한 LOT 자신으로 되돌아오면 cyclic 이다 — 정방향·역방향 모두', async () => {
      const forward = (await get(`lots/${ids.c1}/forward-flow`).expect(200)).body as Body;
      expect(forward.workOrders[0].productionLots).toEqual([expect.objectContaining({ lotNo: `${PREFIX}-C1`, cyclic: true })]);

      const backward = (await get(`lots/${ids.c1}/backward-flow`).expect(200)).body as Body;
      expect(backward.inputMaterials).toEqual([expect.objectContaining({ lotNo: `${PREFIX}-C1`, cyclic: true })]);
    });

    it('없는 LOT 은 404 이다', async () => {
      await get('lots/999999999999/forward-flow').expect(404);
    });
  });

  describe('역방향 목록 GET /trace/product-lot-flows', () => {
    const query = () => ({ itemId: Number(ids.product), dateFrom: DAY, dateTo: DAY });

    it('실적 배분이 있는 생산 LOT 만 — 단계·근거·투입 자재 수·고객을 싣는다', async () => {
      const body = (await get('product-lot-flows', query()).expect(200)).body as Body;

      conforms('/trace/product-lot-flows', body);
      expect(no(body.items).sort()).toEqual([`${PREFIX}-G1`, `${PREFIX}-L1`]);
      expect(body.stageCounts).toEqual({ PRODUCED: 1, PRODUCTION_RECEIVED: 0, PACKED: 0, SHIPPED: 1 });
      const g1 = body.items.find((row: Body) => row.lotNo === `${PREFIX}-G1`);
      expect(g1).toMatchObject({
        currentStageCode: 'SHIPPED', basis: 'LOT_GENEALOGY_ESTIMATE', inputMaterialLotCount: 2, producedQty: 40,
        workOrder: { workOrderNo: `${PREFIX}-WO-G` },
        stages: { productionReceived: { count: 1, qty: 40 }, packed: { handlingUnitCount: 1, qty: 30 },
          shipped: { shipmentCount: 2, qty: 35, customerCount: 1, customers: [{ code: `${PREFIX}-CUS` }] } },
      });
      expect(body.items.find((row: Body) => row.lotNo === `${PREFIX}-L1`)).toMatchObject({
        currentStageCode: 'PRODUCED', basis: 'WORK_ORDER_ESTIMATE', inputMaterialLotCount: 1,
      });
    });

    it('출하 번호·W/O 번호로 집거나 출하일 축·LOT 번호 일부·단계로 거른다', async () => {
      expect(no((await get('product-lot-flows', { shipmentNo: `${PREFIX}-SH1` }).expect(200)).body.items)).toEqual([`${PREFIX}-G1`]);
      expect(no((await get('product-lot-flows', { workOrderNo: `${PREFIX}-WO-L` }).expect(200)).body.items)).toEqual([`${PREFIX}-L1`]);
      expect(no((await get('product-lot-flows', { ...query(), dateAxis: 'SHIPPED' }).expect(200)).body.items)).toEqual([`${PREFIX}-G1`]);
      expect(no((await get('product-lot-flows', { q: `${PREFIX}-L`, dateFrom: DAY, dateTo: DAY }).expect(200)).body.items)).toEqual([`${PREFIX}-L1`]);
      expect(no((await get('product-lot-flows', { ...query(), currentStageCode: 'PRODUCED' }).expect(200)).body.items)).toEqual([`${PREFIX}-L1`]);
    });

    it('기간만으로 조회한다 — 생산일 축·출하일 축 모두, 다른 칸은 거르는 조건이다', async () => {
      const all = (await get('product-lot-flows', { dateFrom: DAY, dateTo: DAY }).expect(200)).body as Body;
      conforms('/trace/product-lot-flows', all);
      expect(all.page.total).toBeGreaterThanOrEqual(2);

      const customer = Number(ids.customer);
      expect(no((await get('product-lot-flows', { dateFrom: DAY, dateTo: DAY, customerId: customer }).expect(200)).body.items)).toEqual([`${PREFIX}-G1`]);
      expect(no((await get('product-lot-flows', { dateAxis: 'SHIPPED', dateFrom: DAY, dateTo: DAY, customerId: customer }).expect(200)).body.items))
        .toEqual([`${PREFIX}-G1`]);
      expect((await get('product-lot-flows', { dateFrom: '2026-08-11', dateTo: '2026-08-11', customerId: customer }).expect(200)).body.items).toEqual([]);
    });

    it('기간도 번호도 없으면 400 이고 dateFrom 칸을 짚는다 — 문구는 축의 이름을 쓴다', async () => {
      const response = await get('product-lot-flows', { itemId: Number(ids.product), dateAxis: 'SHIPPED' }).expect(400);
      expect(response.body.errors).toEqual([{
        scope: 'field', field: 'dateFrom', code: 'REQUIRED',
        message: '조회 기간이 없습니다. 출하일 시작(dateFrom)을 넣거나 생산 LOT 번호(lotNo), 출하 번호(shipmentNo), W/O 번호(workOrderNo) 중 하나를 넣어 다시 조회하세요. 기간은 최대 366일입니다.',
      }]);
    });
  });

  describe('역방향 사슬 GET /trace/lots/{lotId}/backward-flow', () => {
    it('출하·포장·생산입고와 W/O 실적, 투입 자재의 입하(입하 번호·공급사 LOT)를 싣고 반제품은 만든 W/O 를 짚는다', async () => {
      const body = (await get(`lots/${ids.g1}/backward-flow`).expect(200)).body as Body;

      conforms('/trace/lots/{lotId}/backward-flow', body);
      expect(body).toMatchObject({
        basis: 'LOT_GENEALOGY_ESTIMATE', goodQty: 40,
        workOrder: { workOrderNo: `${PREFIX}-WO-G`, results: { count: 1, goodQty: 40 } },
        shipments: [{ shipmentNo: `${PREFIX}-SH1` }, { shipmentNo: `${PREFIX}-SH2` }],
        packages: [{ handlingUnitNo: `${PREFIX}-HU1` }, { handlingUnitNo: `${PREFIX}-HU2` }],
        productionReceipts: [{ goodsReceiptNo: `${PREFIX}-GR-G1` }],
      });
      // 첫 투입 시각이 같으면 LOT 번호순.
      expect(no(body.inputMaterials)).toEqual([`${PREFIX}-M1`, `${PREFIX}-S1`]);
      const inputs = Object.fromEntries((body.inputMaterials as Body[]).map((input) => [input.lotNo, input]));
      expect(inputs[`${PREFIX}-M1`]).toMatchObject({
        linkBasis: 'LOT_GENEALOGY_ESTIMATE', producedBy: null, cyclic: false, consumedQty: 10,
        inbound: { inboundReceiptNo: `${PREFIX}-IR`, supplierLotNo: 'SUP-LOT-1' },
        receipts: [{ goodsReceiptNo: `${PREFIX}-GR-M1` }],
      });
      expect(inputs[`${PREFIX}-S1`]).toMatchObject({ producedBy: { workOrderNo: `${PREFIX}-WO-S` }, inbound: null });
    });

    it('실적 배분이 없는 생산 LOT 은 W/O 만 싣고 투입 자재는 비운다 — 정방향이 잇지 않는 것과 같다', async () => {
      const body = (await get(`lots/${ids.g2}/backward-flow`).expect(200)).body as Body;

      conforms('/trace/lots/{lotId}/backward-flow', body);
      expect(body).toMatchObject({ goodQty: 0, basis: null, workOrder: { workOrderNo: `${PREFIX}-WO-G` }, inputMaterials: [] });
    });

    it('계보 없는 W/O 의 생산 LOT 은 W/O 단위 추정으로 그 W/O 의 투입 자재 전부다', async () => {
      const body = (await get(`lots/${ids.l1}/backward-flow`).expect(200)).body as Body;
      expect(body.basis).toBe('WORK_ORDER_ESTIMATE');
      expect(no(body.inputMaterials)).toEqual([`${PREFIX}-M1`]);
    });

    it('투입 없음 → 근거 null — 투입 없는 자재 LOT 의 정방향, 원천이 W/O 가 아닌 LOT 의 역방향', async () => {
      const forward = (await get(`lots/${ids.m2}/forward-flow`).expect(200)).body as Body;
      const backward = (await get(`lots/${ids.m2}/backward-flow`).expect(200)).body as Body;

      conforms('/trace/lots/{lotId}/forward-flow', forward);
      conforms('/trace/lots/{lotId}/backward-flow', backward);
      expect(forward).toMatchObject({ basis: null, workOrders: [], totalProductionLotCount: 0 });
      expect(backward).toMatchObject({ basis: null, workOrder: null, inputMaterials: [] });
    });

    it('권한이 없으면 403 이다', async () => {
      await get(`lots/${ids.g1}/backward-flow`, {}, 'denied').expect(403);
    });
  });

  describe('기간별 이력 GET /trace/material-input-lines · /trace/packing-lines', () => {
    const inputs = (query: Record<string, string | number>) => get('material-input-lines', { inputDateFrom: DAY, inputDateTo: DAY, ...query });
    const packings = (query: Record<string, string | number>) => get('packing-lines', { packedDateFrom: DAY, packedDateTo: DAY, ...query });

    it('투입: 기간 안의 투입 기록을 LOT·품목·W/O·수량과 함께 싣고, 합계는 필터 전체다', async () => {
      const body = (await inputs({ lotNo: `${PREFIX}-M1` }).expect(200)).body as Body;

      conforms('/trace/material-input-lines', body);
      expect(body.items).toHaveLength(5);
      expect(body.items[0]).toMatchObject({
        lotId: Number(ids.m1), lotNo: `${PREFIX}-M1`, item: { code: `${PREFIX}-MAT` }, inputQty: 10, correctsConsumptionId: null,
        plantId: Number(ids.plant),
      });
      expect(body.items.map((row: Body) => row.workOrder.workOrderNo).sort())
        .toEqual(['G', 'L', 'N', 'S', 'T'].map((suffix) => `${PREFIX}-WO-${suffix}`));
      expect(body.totals).toMatchObject({ lineCount: 5, qtyByUom: [{ uomId: Number(ids.uom), qty: 50 }] });
      expect(body.page.total).toBe(5);
    });

    it('투입: 정정된 원 투입은 빼고 정정 투입을 싣는다 · 기간 밖이면 없다 · 검색어는 W/O 번호도 본다', async () => {
      const corrected = (await inputs({ lotNo: `${PREFIX}-C1` }).expect(200)).body as Body;
      expect(corrected.items).toHaveLength(1);
      expect(corrected.items[0]).toMatchObject({ inputQty: 2, workOrder: { workOrderNo: `${PREFIX}-WO-C` } });
      expect(corrected.items[0].correctsConsumptionId).toEqual(expect.any(Number));

      expect((await inputs({ q: `${PREFIX}-WO-G` }).expect(200)).body.items).toHaveLength(2);
      expect((await get('material-input-lines', { inputDateFrom: '2026-08-11', inputDateTo: '2026-08-11', lotNo: `${PREFIX}-M1` })
        .expect(200)).body.items).toEqual([]);
    });

    it('포장: 확정된 상자의 구성 줄만 — 취급 단위·출하 단위·W/O 번호를 싣는다', async () => {
      const body = (await packings({ lotNo: `${PREFIX}-G1` }).expect(200)).body as Body;

      conforms('/trace/packing-lines', body);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        handlingUnitNo: `${PREFIX}-HU1`, lotId: Number(ids.g1), lotNo: `${PREFIX}-G1`, item: { code: `${PREFIX}-FG` }, qty: 30,
        workOrder: { workOrderNo: `${PREFIX}-WO-G` }, shippingUnit: { shippingUnitNo: `${PREFIX}-SU1` },
      });
      expect(body.totals).toMatchObject({ lineCount: 1, qtyByUom: [{ qty: 30 }] });
      expect((await packings({ q: `${PREFIX}-HU2` }).expect(200)).body.items).toEqual([]);
    });

    it('집는 번호(LOT·W/O·입하·출하 번호)가 있으면 기간 없이도 되고, 공급사·고객으로도 거른다', async () => {
      const count = async (path: string, query: Record<string, string | number>) => ((await get(path, query).expect(200)).body as Body).page.total as number;

      expect(await count('material-input-lines', { lotNo: `${PREFIX}-M1` })).toBe(5);
      expect(await count('material-input-lines', { workOrderNo: `${PREFIX}-WO-G` })).toBe(2);
      expect(await count('material-input-lines', { inboundReceiptNo: `${PREFIX}-IR` })).toBe(5);
      expect(await count('material-input-lines', { inputDateFrom: DAY, inputDateTo: DAY, supplierId: Number(ids.supplier) })).toBe(5);

      const bySh = (await get('packing-lines', { shipmentNo: `${PREFIX}-SH1` }).expect(200)).body as Body;
      expect(bySh.items.map((row: Body) => [row.handlingUnitNo, row.handlingUnitStatusCode])).toEqual([[`${PREFIX}-HU1`, 'PACKED']]);
      expect(await count('packing-lines', { workOrderNo: `${PREFIX}-WO-G` })).toBe(1);
      expect(await count('packing-lines', { packedDateFrom: DAY, packedDateTo: DAY, customerId: Number(ids.customer) })).toBe(1);
    });

    it('기간도 집는 번호도 없으면 그 칸을 짚는 400, 권한이 없으면 403 이다', async () => {
      expect((await get('material-input-lines', { supplierId: Number(ids.supplier) }).expect(400)).body.errors[0])
        .toMatchObject({ field: 'inputDateFrom', code: 'REQUIRED' });
      expect((await get('packing-lines', { customerId: Number(ids.customer) }).expect(400)).body.errors[0])
        .toMatchObject({ field: 'packedDateFrom', code: 'REQUIRED' });
      await get('material-input-lines', { inputDateFrom: DAY }, 'denied').expect(403);
      await get('packing-lines', { packedDateFrom: DAY }, 'denied').expect(403);
    });
  });

  describe('분할 추적 (피처 008 · omf-all-around#289)', () => {
    it('US4-1·SC-003 분할 LOT 을 투입한 생산 LOT 을 거꾸로 — 투입 자재에 분할 조상(부모 → 뿌리)과 뿌리의 입하가 붙는다', async () => {
      const body = (await get(`lots/${ids.p1}/backward-flow`).expect(200)).body as Body;

      conforms('/trace/lots/{lotId}/backward-flow', body);
      expect(no(body.inputMaterials)).toEqual([`${PREFIX}-SA-S1-S1`]);
      const [input] = body.inputMaterials as Body[];
      expect(input.splitAncestry.map((link: Body) => [link.relationTypeCode, link.lot.lotNo, link.qty])).toEqual([
        ['SPLIT', `${PREFIX}-SA-S1`, 30],
        ['SPLIT', `${PREFIX}-SA`, 60],
      ]);
      expect(input.splitAncestry[0].goodsIssue).toMatchObject({ goodsIssueNo: `${PREFIX}-GI`, lineNo: 2 });
      // 분할 LOT 은 입하 LOT 칸이 비어 있다 — 뿌리의 입하가 보인다(FR-003).
      expect(input.inbound).toMatchObject({ inboundReceiptNo: `${PREFIX}-IR-SA`, supplierLotNo: 'SUP-LOT-SA' });
    });

    it('US4-2 원래 LOT 을 앞으로 — 분할 LOT 들(깊이 순)과 자손으로 투입된 W/O·생산 LOT 이 보인다', async () => {
      const body = (await get(`lots/${ids.sa}/forward-flow`).expect(200)).body as Body;

      conforms('/trace/lots/{lotId}/forward-flow', body);
      expect(body.splitFrom).toBeNull();
      expect(body.splits.map((link: Body) => [link.lot.lotNo, link.qty, link.goodsIssue?.lineNo])).toEqual([
        [`${PREFIX}-SA-S1`, 60, 1],
        [`${PREFIX}-SA-S1-S1`, 30, 2],
      ]);
      expect(body.workOrders).toHaveLength(1);
      expect(body.workOrders[0]).toMatchObject({
        workOrderNo: `${PREFIX}-WO-P`, consumedQty: 30, viaLot: { lotId: Number(ids.sa11), lotNo: `${PREFIX}-SA-S1-S1` },
      });
      expect(no(body.workOrders[0].productionLots)).toEqual([`${PREFIX}-P1`]);
      expect(body.totalProductionLotCount).toBe(1);

      const child = (await get(`lots/${ids.sa11}/forward-flow`).expect(200)).body as Body;
      conforms('/trace/lots/{lotId}/forward-flow', child);
      expect(child.splitFrom).toMatchObject({ relationTypeCode: 'SPLIT', lot: { lotNo: `${PREFIX}-SA-S1` }, qty: 30 });
      // 자기 자신이 투입된 W/O 는 viaLot 이 없다.
      expect(child.workOrders[0].viaLot).toBeNull();
      expect(child.inbound).toMatchObject({ inboundReceiptNo: `${PREFIX}-IR-SA` });
    });

    it('D-13 영향 생산 LOT·사용 시리얼·정방향 목록 단계는 원래 LOT 의 분할 자손 투입을 포함한다', async () => {
      const impact = (await get(`lots/${ids.sa}/affected-production-lots`).expect(200)).body as Body;
      expect(impact.items.map((row: Body) => row.lotNo)).toEqual([`${PREFIX}-P1`]);
      const serials = (await get(`lots/${ids.sa}/used-serials`).expect(200)).body as Body;
      expect(serials.items.map((row: Body) => row.serialNo)).toEqual([`${PREFIX}-SN-P1`]);

      const list = (await get('material-lot-flows', { lotNo: `${PREFIX}-SA` }).expect(200)).body as Body;
      conforms('/trace/material-lot-flows', list);
      expect(list.items[0]).toMatchObject({
        lotNo: `${PREFIX}-SA`, consumedQty: 30, stages: { consumed: { workOrderCount: 1 }, produced: { lotCount: 1 } },
      });
    });

    it('US4-3·FR-014 분할 LOT 상세에 부모 번호·분할 출고·분할 시각, 원래 LOT 에 분할 자손 수가 실린다', async () => {
      const child = (await request(app.getHttpServer()).get(`/api/trace/lots/${ids.sa11}`).set('Cookie', cookies.allowed).expect(200)).body as Body;
      expect(child.lot).toMatchObject({
        parentLotId: Number(ids.sa1), parentLotNo: `${PREFIX}-SA-S1`, splitChildCount: 0,
        splitGoodsIssue: { goodsIssueNo: `${PREFIX}-GI`, lineNo: 2 }, splitAt: (await local(SPLIT_DAY, '09:10')).toISOString(),
        // 분할 LOT 은 입하 LOT 칸이 비어 있다 — 뿌리의 입하 LOT 이 보인다(FR-003).
        inboundLotId: Number(ids.inboundLot), inboundLotNo: `${PREFIX}-IL-SA`,
      });
      const root = (await request(app.getHttpServer()).get(`/api/trace/lots/${ids.sa}`).set('Cookie', cookies.allowed).expect(200)).body as Body;
      expect(root.lot).toMatchObject({ parentLotNo: null, splitGoodsIssue: null, splitAt: null, splitChildCount: 2, inboundLotNo: `${PREFIX}-IL-SA` });
    });

    it('§8 입하 LOT 칸 — 재고·LOT 현황·투입 이력에서 분할 LOT 은 원래 LOT 의 입하 LOT 으로 나오고, 그 입하 LOT 으로 거르면 함께 나온다', async () => {
      const statuses = (await request(app.getHttpServer()).get('/api/quality/lot-statuses').query({ inboundLotId: Number(ids.inboundLot) })
        .set('Cookie', cookies.allowed).expect(200)).body as Body;
      expect(no(statuses.items).sort()).toEqual([`${PREFIX}-SA`, `${PREFIX}-SA-S1`, `${PREFIX}-SA-S1-S1`]);
      expect((statuses.items as Body[]).every((row) => row.inboundLotNo === `${PREFIX}-IL-SA`)).toBe(true);
      const byNo = (await request(app.getHttpServer()).get('/api/quality/lot-statuses').query({ inboundLotNo: `${PREFIX}-IL-SA` })
        .set('Cookie', cookies.allowed).expect(200)).body as Body;
      expect(byNo.items).toHaveLength(3);

      const balances = (await request(app.getHttpServer()).get('/api/inventory/balances')
        .query({ inboundLotId: Number(ids.inboundLot), groupBy: 'LOT' }).set('Cookie', cookies.allowed).expect(200)).body as Body;
      expect(balances.items.map((row: Body) => [row.lotId, row.inboundLotNo])).toEqual([[Number(ids.sa11), `${PREFIX}-IL-SA`]]);

      const inputs = (await get('material-input-lines', { inboundLotId: Number(ids.inboundLot) }).expect(200)).body as Body;
      expect(inputs.items.map((row: Body) => [row.lotNo, row.inboundLotNo])).toEqual([[`${PREFIX}-SA-S1-S1`, `${PREFIX}-IL-SA`]]);
    });

    it('분할이 없는 LOT 의 응답은 그대로다 — splitFrom null·splits 빈 목록·viaLot null·splitAncestry 빈 목록', async () => {
      const forward = (await get(`lots/${ids.m1}/forward-flow`).expect(200)).body as Body;
      expect(forward).toMatchObject({ splitFrom: null, splits: [] });
      expect((forward.workOrders as Body[]).every((wo) => wo.viaLot === null)).toBe(true);
      const backward = (await get(`lots/${ids.g1}/backward-flow`).expect(200)).body as Body;
      expect((backward.inputMaterials as Body[]).every((input) => input.splitAncestry.length === 0)).toBe(true);
    });
  });

  async function local(day: string, time: string): Promise<Date> {
    const [row] = await prisma.$queryRawUnsafe<{ at: Date }[]>(
      `SELECT ($1::timestamp AT TIME ZONE p.timezone_code) AS at FROM mdm.plant p WHERE p.plant_id = $2::bigint`, `${day} ${time}`, ids.plant,
    );
    return row.at;
  }

  async function ensure<T>(
    delegate: { findFirst: (a: unknown) => Promise<T | null>; create: (a: unknown) => Promise<T> },
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<T> {
    return (await delegate.findFirst({ where })) ?? (await delegate.create({ data }));
  }

  async function makeMasters(): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.plant = plant.plant_id;
    const [uom] = await prisma.uom.findMany({ take: 1, orderBy: { uom_id: 'asc' } });
    ids.uom = uom.uom_id;
    const warehouse = await ensure(prisma.warehouse, { warehouse_code: `${PREFIX}-WH` }, {
      plant_id: plant.plant_id, business_unit_id: plant.business_unit_id, warehouse_code: `${PREFIX}-WH`, warehouse_name: 'LOT추적창고',
      warehouse_type_code: 'FINISHED', management_level_code: 'WAREHOUSE',
    });
    ids.warehouse = warehouse.warehouse_id;
    ids.location = (await ensure(prisma.location, { location_code: `${PREFIX}-LOC` }, {
      warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: 'LOT추적위치', location_type_code: 'DEFAULT',
    })).location_id;
    for (const [key, code, type] of [['material', 'MAT', 'RAW_MATERIAL'], ['semi', 'SEMI', 'SEMI_FINISHED'], ['product', 'FG', 'FINISHED']] as const) {
      ids[key] = (await ensure(prisma.item, { item_code: `${PREFIX}-${code}` }, {
        item_code: `${PREFIX}-${code}`, item_name: `LOT추적${code}`, item_type_code: type, base_uom_id: uom.uom_id,
      })).item_id;
    }
    for (const [key, code] of [['supplier', 'SUP'], ['customer', 'CUS']] as const) {
      ids[key] = (await ensure(prisma.partner, { partner_code: `${PREFIX}-${code}` }, { partner_code: `${PREFIX}-${code}`, partner_name: `LOT추적${code}` })).partner_id;
    }
    ids.worker = (await ensure(prisma.worker, { worker_no: `${PREFIX}-W` }, {
      worker_no: `${PREFIX}-W`, worker_name: 'LOT추적작업자', business_unit_id: plant.business_unit_id, plant_id: plant.plant_id, status_code: 'ACTIVE',
    })).worker_id;
    const process = await ensure(prisma.process, { process_code: `${PREFIX}-PR` }, { process_code: `${PREFIX}-PR`, process_name: 'LOT추적공정', process_type_code: 'MOLDING' });
    const routing = await ensure(prisma.routing, { routing_code: `${PREFIX}-RT` }, { item_id: ids.product, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' });
    ids.operation = (await ensure(prisma.routing_operation, { routing_id: routing.routing_id }, {
      routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: 'LOT추적작업',
    })).routing_operation_id;
  }

  async function lot(suffix: string, itemId: bigint, type: string, sourceType: string, sourceId: bigint): Promise<bigint> {
    const found = await ensure(prisma.lot, { lot_no: `${PREFIX}-${suffix}` }, {
      lot_no: `${PREFIX}-${suffix}`, item_id: itemId, lot_type_code: type, plant_id: ids.plant, initial_qty: 100, uom_id: ids.uom,
      source_type_code: sourceType, source_id: sourceId, status_code: 'NORMAL',
    });
    // W/O 는 실행마다 새로 만들어 id 가 바뀐다 — 남아 있던 LOT 의 원천을 다시 잇는다.
    await prisma.lot.update({ where: { lot_id: found.lot_id }, data: { source_id: sourceId } });
    return found.lot_id;
  }

  async function workOrder(suffix: string, itemId: bigint): Promise<bigint> {
    return (await prisma.work_order.create({
      data: { work_order_no: `${PREFIX}-WO-${suffix}`, routing_operation_id: ids.operation, item_id: itemId, order_qty: 100, uom_id: ids.uom, status_code: 'IN_PROGRESS' },
    })).work_order_id;
  }

  async function consume(workOrderId: bigint, lotId: bigint, itemId: bigint, qty: number, at: Date): Promise<void> {
    seq += 1;
    await prisma.material_consumption.create({ data: {
      consumption_no: `${PREFIX}-MC-${seq}`, work_order_id: workOrderId, item_id: itemId, lot_id: lotId, consumption_type_code: 'NORMAL',
      input_qty: qty, uom_id: ids.uom, occurred_at: at, worker_id: ids.worker, status_code: 'RECORDED', idempotency_key: `${PREFIX}-MC-${seq}-${randomUUID()}`,
    } });
  }

  async function produce(workOrderId: bigint, lotId: bigint, qty: number, at: Date, sources: bigint[]): Promise<void> {
    seq += 1;
    const result = await prisma.production_result.create({ data: {
      production_result_no: `${PREFIX}-PR-${seq}`, work_order_id: workOrderId, result_sequence: 1, good_qty: qty, uom_id: ids.uom,
      result_source_code: 'POP', occurred_at: at, worker_id: ids.worker, status_code: 'CONFIRMED', idempotency_key: `${PREFIX}-PR-${seq}-${randomUUID()}`,
      production_result_lot_allocation: { create: [{ lot_id: lotId, allocated_qty: qty, uom_id: ids.uom }] },
    } });
    for (const source of sources) {
      await prisma.lot_relation.create({ data: {
        source_lot_id: source, target_lot_id: lotId, relation_type_code: 'CONSUMED', relation_qty: qty, uom_id: ids.uom,
        source_event_type_code: 'PRODUCTION_RESULT', source_event_id: result.production_result_id, allocation_method_code: 'INPUT_TIME_WINDOW',
        trace_accuracy_code: 'ESTIMATED', occurred_at: at,
      } });
    }
  }

  async function receive(
    suffix: string, type: string, lotId: bigint, itemId: bigint, qty: number, at: Date, inboundLineId?: bigint, status = 'POSTED',
  ): Promise<void> {
    await prisma.goods_receipt.create({ data: {
      goods_receipt_no: `${PREFIX}-GR-${suffix}`, receipt_type_code: type, plant_id: ids.plant, warehouse_id: ids.warehouse, receipt_datetime: at, status_code: status,
      goods_receipt_line: { create: [{ line_no: 1, item_id: itemId, lot_id: lotId, receipt_qty: qty, uom_id: ids.uom, quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE', destination_location_id: ids.location, inbound_receipt_line_id: inboundLineId ?? null }] },
    } });
  }

  async function makeChain(): Promise<void> {
    const wo = {
      G: await workOrder('G', ids.product), L: await workOrder('L', ids.product), N: await workOrder('N', ids.product),
      S: await workOrder('S', ids.semi), T: await workOrder('T', ids.semi), C: await workOrder('C', ids.semi),
    };
    ids.m1 = await lot('M1', ids.material, 'MATERIAL', 'INBOUND_RECEIPT_LINE', 1n);
    ids.m2 = await lot('M2', ids.material, 'MATERIAL', 'INBOUND_RECEIPT_LINE', 1n);
    ids.s1 = await lot('S1', ids.semi, 'PRODUCTION', 'WORK_ORDER', wo.S);
    ids.g1 = await lot('G1', ids.product, 'PRODUCTION', 'WORK_ORDER', wo.G);
    ids.g2 = await lot('G2', ids.product, 'PRODUCTION', 'WORK_ORDER', wo.G);
    ids.l1 = await lot('L1', ids.product, 'PRODUCTION', 'WORK_ORDER', wo.L);
    ids.n1 = await lot('N1', ids.product, 'PRODUCTION', 'WORK_ORDER', wo.N);
    ids.t1 = await lot('T1', ids.semi, 'PRODUCTION', 'WORK_ORDER', wo.T);
    ids.c1 = await lot('C1', ids.semi, 'PRODUCTION', 'WORK_ORDER', wo.C);

    const inbound = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR`, supplier_id: ids.supplier, plant_id: ids.plant, receipt_datetime: await local(DAY, '08:00'), status_code: 'RECEIVED',
        inbound_receipt_line: { create: [{ line_no: 1, item_id: ids.material, received_qty: 100, uom_id: ids.uom, inspection_required: false,
          supplier_lot_label_attached: true, supplier_lot_no: 'SUP-LOT-1', status_code: 'RECEIVED', lot_id: ids.m1 }] } },
      include: { inbound_receipt_line: true },
    });
    await receive('M1', 'MATERIAL', ids.m1, ids.material, 100, await local(DAY, '09:00'), inbound.inbound_receipt_line[0].inbound_receipt_line_id);
    await receive('M2', 'MATERIAL', ids.m2, ids.material, 50, await local(DAY, '09:30'));

    const at = await local(DAY, '10:00');
    for (const target of [wo.G, wo.L, wo.N, wo.S, wo.T]) await consume(target, ids.m1, ids.material, 10, at);
    await consume(wo.G, ids.s1, ids.semi, 5, at);
    await consume(wo.T, ids.s1, ids.semi, 5, at);
    await consume(wo.C, ids.c1, ids.semi, 1, at);
    // 정정 — 원 투입은 기간별 이력에서 빠지고 정정 투입만 남는다(장부 P-151).
    const original = await prisma.material_consumption.findFirstOrThrow({ where: { work_order_id: wo.C, lot_id: ids.c1 } });
    seq += 1;
    await prisma.material_consumption.create({ data: {
      consumption_no: `${PREFIX}-MC-${seq}`, work_order_id: wo.C, item_id: ids.semi, lot_id: ids.c1, consumption_type_code: 'NORMAL',
      input_qty: 2, uom_id: ids.uom, occurred_at: await local(DAY, '10:30'), worker_id: ids.worker, status_code: 'RECORDED',
      idempotency_key: `${PREFIX}-MC-${seq}-${randomUUID()}`, corrects_consumption_id: original.material_consumption_id,
    } });
    const later = await local(DAY, '11:00');
    await produce(wo.S, ids.s1, 20, later, [ids.m1]);
    await produce(wo.G, ids.g1, 40, later, [ids.m1, ids.s1]);
    await produce(wo.L, ids.l1, 25, later, []);
    // 실적은 있지만 그 구간에 M1 이 이어지지 않았다 — 계보 근거에 빈 목록.
    await produce(wo.T, ids.t1, 10, later, [ids.s1]);
    // 자기 자신을 다시 넣은 W/O — 계보 표는 자기 참조를 막으니(ck_lot_relation_self) 계보 없는 W/O 단위 추정으로만 생긴다.
    await produce(wo.C, ids.c1, 10, later, []);

    await receive('G1', 'PRODUCT', ids.g1, ids.product, 40, await local(DAY, '12:00'));
    await receive('G1-CXL', 'PRODUCT', ids.g1, ids.product, 9, await local(DAY, '12:30'), undefined, 'CANCELLED');
    // 구성 줄 생성 시각이 포장 시각이다(기간별 이력의 포장 줄 · 장부 P-151).
    const packedAt = await local(DAY, '13:00');
    const box = await prisma.handling_unit.create({ data: { handling_unit_no: `${PREFIX}-HU1`, handling_unit_type_code: 'BOX', status_code: 'PACKED',
      handling_unit_content: { create: [{ item_id: ids.product, lot_id: ids.g1, qty: 30, uom_id: ids.uom, created_at: packedAt }] } } });
    // 아직 확정 안 된 상자 — packages 에는 「포장 중」으로 실리지만 포장 단계·수에는 들지 않는다.
    await prisma.handling_unit.create({ data: { handling_unit_no: `${PREFIX}-HU2`, handling_unit_type_code: 'BOX', status_code: 'OPEN',
      handling_unit_content: { create: [{ item_id: ids.product, lot_id: ids.g1, qty: 5, uom_id: ids.uom, created_at: packedAt }] } } });
    const shipmentRequest = await prisma.shipment_request.create({
      data: { shipment_request_no: `${PREFIX}-SR`, customer_id: ids.customer, ship_to_partner_id: ids.customer, requested_ship_date: new Date(`${DAY}T00:00:00.000Z`),
        status_code: 'CONFIRMED', shipment_request_line: { create: [{ line_no: 1, item_id: ids.product, requested_qty: 30, uom_id: ids.uom }] } },
      include: { shipment_request_line: true },
    });
    const ship = async (suffix: string, status: string, time: string, qty: number, handlingUnitId: bigint | null) => prisma.shipment.create({ data: {
      shipment_no: `${PREFIX}-${suffix}`, shipment_request_id: shipmentRequest.shipment_request_id, warehouse_id: ids.warehouse, status_code: status,
      shipped_at: await local(DAY, time),
      shipment_line: { create: [{ line_no: 1, shipment_request_line_id: shipmentRequest.shipment_request_line[0].shipment_request_line_id, item_id: ids.product,
        shipped_qty: qty, uom_id: ids.uom, shipment_lot_allocation: { create: [{ lot_id: ids.g1, allocated_qty: qty, uom_id: ids.uom, handling_unit_id: handlingUnitId }] } }] },
    } });
    await ship('SH1', 'CONFIRMED', '15:00', 30, box.handling_unit_id);
    // 포장 없이 LOT 을 직접 배분한 출하 · 취소된 출하.
    const sh1 = await prisma.shipment.findFirstOrThrow({ where: { shipment_no: `${PREFIX}-SH1` } });
    await prisma.shipping_unit.create({ data: { shipping_unit_no: `${PREFIX}-SU1`, shipment_id: sh1.shipment_id, shipping_unit_type_code: 'PALLET',
      status_code: 'OPEN', shipping_unit_handling_unit: { create: [{ handling_unit_id: box.handling_unit_id, seq: 1 }] } } });
    await ship('SH2', 'CONFIRMED', '16:00', 5, null);
    await ship('SH-CXL', 'CANCELLED', '17:00', 7, null);
  }

  /** 부분 출고 분할 사슬 — SA(입하) → SA-S1(60) → SA-S1-S1(30), SA-S1-S1 을 W/O P 가 투입해 P1 을 만든다. */
  async function makeSplitChain(): Promise<void> {
    ids.splitItem = (await ensure(prisma.item, { item_code: `${PREFIX}-SPL` }, {
      item_code: `${PREFIX}-SPL`, item_name: 'LOT추적분할자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom,
    })).item_id;
    const wo = await workOrder('P', ids.product);
    ids.sa = await lot('SA', ids.splitItem, 'MATERIAL', 'INBOUND_RECEIPT_LINE', 1n);
    ids.p1 = await lot('P1', ids.product, 'PRODUCTION', 'WORK_ORDER', wo);
    const issue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-GI`, issue_type_code: 'PRODUCTION', source_document_type_code: 'PICKING_ORDER', source_document_id: 1,
        source_warehouse_id: ids.warehouse, issued_at: await local(SPLIT_DAY, '09:00'), status_code: 'POSTED',
      },
    });
    const line = (lineNo: number, qty: number) => prisma.goods_issue_line.create({
      data: { goods_issue_id: issue.goods_issue_id, line_no: lineNo, item_id: ids.splitItem, lot_id: ids.sa, issue_qty: qty, uom_id: ids.uom, source_location_id: ids.location },
    });
    const first = await line(1, 60);
    const second = await line(2, 30);
    ids.sa1 = await lot('SA-S1', ids.splitItem, 'MATERIAL', 'GOODS_ISSUE_SPLIT', first.goods_issue_line_id);
    ids.sa11 = await lot('SA-S1-S1', ids.splitItem, 'MATERIAL', 'GOODS_ISSUE_SPLIT', second.goods_issue_line_id);
    for (const [parent, child, qty, eventId, time] of [
      [ids.sa, ids.sa1, 60, first.goods_issue_line_id, '09:00'], [ids.sa1, ids.sa11, 30, second.goods_issue_line_id, '09:10'],
    ] as const) {
      await prisma.lot.update({ where: { lot_id: child }, data: { parent_lot_id: parent } });
      await prisma.lot_relation.create({ data: {
        source_lot_id: parent, target_lot_id: child, relation_type_code: 'SPLIT', relation_qty: qty, uom_id: ids.uom,
        source_event_type_code: 'GOODS_ISSUE_LINE', source_event_id: eventId, allocation_method_code: 'EXACT', trace_accuracy_code: 'EXACT',
        occurred_at: await local(SPLIT_DAY, time),
      } });
    }
    await prisma.goods_issue_line.update({ where: { goods_issue_line_id: first.goods_issue_line_id }, data: { lot_id: ids.sa1 } });
    await prisma.goods_issue_line.update({ where: { goods_issue_line_id: second.goods_issue_line_id }, data: { lot_id: ids.sa11 } });
    const inbound = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-SA`, supplier_id: ids.supplier, plant_id: ids.plant, receipt_datetime: await local(SPLIT_DAY, '08:00'), status_code: 'RECEIVED',
        inbound_receipt_line: { create: [{ line_no: 1, item_id: ids.splitItem, received_qty: 100, uom_id: ids.uom, inspection_required: false,
          supplier_lot_label_attached: true, supplier_lot_no: 'SUP-LOT-SA', status_code: 'RECEIVED', lot_id: ids.sa }] } },
      include: { inbound_receipt_line: true },
    });
    await receive('SA', 'MATERIAL', ids.sa, ids.splitItem, 100, await local(SPLIT_DAY, '08:30'), inbound.inbound_receipt_line[0].inbound_receipt_line_id);
    // 원래 LOT 의 입하 LOT(피처 005) — 분할 LOT 은 칸이 비어 있다.
    ids.inboundLot = (await prisma.inbound_lot.create({ data: {
      inbound_lot_no: `${PREFIX}-IL-SA`, plant_id: ids.plant, item_id: ids.splitItem, supplier_id: ids.supplier, uom_id: ids.uom, status_code: 'RECEIVING',
      receiving_date: new Date(`${SPLIT_DAY}T00:00:00.000Z`), erp_send_mode_code: 'PER_RECEIPT', open_since_date: new Date(`${SPLIT_DAY}T00:00:00.000Z`), inbound_receipt_line_id: inbound.inbound_receipt_line[0].inbound_receipt_line_id,
    } })).inbound_lot_id;
    await prisma.lot.update({ where: { lot_id: ids.sa }, data: { inbound_lot_id: ids.inboundLot } });
    await prisma.inventory_balance.create({ data: {
      legal_entity_id: (await prisma.plant.findUniqueOrThrow({ where: { plant_id: ids.plant } })).legal_entity_id,
      business_unit_id: (await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: ids.warehouse } })).business_unit_id,
      plant_id: ids.plant, warehouse_id: ids.warehouse, location_id: ids.location, item_id: ids.splitItem, lot_id: ids.sa11,
      quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED', on_hand_qty: 30, uom_id: ids.uom,
    } });
    await consume(wo, ids.sa11, ids.splitItem, 30, await local(SPLIT_DAY, '10:00'));
    await produce(wo, ids.p1, 30, await local(SPLIT_DAY, '11:00'), [ids.sa11]);
    await prisma.serial_number.deleteMany({ where: { serial_no: `${PREFIX}-SN-P1` } });
    await prisma.serial_number.create({ data: {
      serial_no: `${PREFIX}-SN-P1`, item_id: ids.product, lot_id: ids.p1, status_code: 'PRODUCED', produced_at: await local(SPLIT_DAY, '11:00'),
    } });
  }

  async function login(loginId: string, permissions: string[]): Promise<string[]> {
    const user = await prisma.app_user.create({ data: { login_id: loginId, user_name: loginId, status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: `${loginId}-ROLE`, role_name: loginId } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const response = await request(app.getHttpServer()).post('/api/app/sessions').set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD }).expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const OUR_LOTS = `SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`;
    const OUR_WOS = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM logistics.shipment_lot_allocation WHERE lot_id IN (${OUR_LOTS})`,
      `DELETE FROM logistics.shipment_line WHERE shipment_id IN (SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipping_unit_handling_unit WHERE shipping_unit_id IN (
         SELECT shipping_unit_id FROM logistics.shipping_unit WHERE shipping_unit_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipping_unit WHERE shipping_unit_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (
         SELECT shipment_request_id FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM inventory.handling_unit_content WHERE lot_id IN (${OUR_LOTS})`,
      `DELETE FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.goods_receipt_line WHERE goods_receipt_id IN (
         SELECT goods_receipt_id FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.serial_number WHERE serial_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.goods_issue_line WHERE goods_issue_id IN (SELECT goods_issue_id FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%'`,
      `DELETE FROM inventory.inventory_balance WHERE lot_id IN (${OUR_LOTS})`,
      `UPDATE trace.lot SET inbound_lot_id = NULL WHERE lot_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.inbound_lot WHERE inbound_lot_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (
         SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.lot_relation WHERE source_lot_id IN (${OUR_LOTS}) OR target_lot_id IN (${OUR_LOTS})`,
      `DELETE FROM production.production_result_lot_allocation WHERE lot_id IN (${OUR_LOTS})`,
      `DELETE FROM production.production_result WHERE work_order_id IN (${OUR_WOS})`,
      `DELETE FROM production.material_consumption WHERE work_order_id IN (${OUR_WOS})`,
      // ⛔ W/O 는 지운다 — 계획 없는 W/O 가 남으면 W/O 목록 e2e 의 계약 검증(productionPlanId 필수)이 깨진다.
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
      // 마스터(LOT·품목·창고·파트너·작업자)는 남겨 다음 실행이 `ensure()` 로 다시 쓴다.
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    for (const loginId of Object.values(USERS)) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (user) {
        await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
        await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
        await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
        await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
      }
      const role = await prisma.role.findUnique({ where: { role_code: `${loginId}-ROLE` } });
      if (role) {
        await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
        await prisma.role.delete({ where: { role_id: role.role_id } });
      }
    }
  }
});
