/**
 * 출하 LOT 배분 목록 — `GET /logistics/shipment-lot-allocations`(I-22 PR ⑦a).
 * 화면 `P-04-01`(납품라벨↔LOT 매칭) · `P-04-02`(발행 대상 목록).
 *
 * ⚠ **배분 생성 경로가 계약에 없다** — `shipment`·`shipment_line`·`shipment_lot_allocation` 은
 * Prisma 직접 INSERT 다(§8-0 `ALLOC-*`). `oqcPassed` 픽스처는 ③a·④ 의 검사 롤업 e2e
 * (L-25~L-33)와 같은 모양을 재사용한다 — 두 곳이 갈리면 「목록이 판정한 것」과 「검사 화면이
 * 보는 것」이 어긋난다(R-10).
 * ⭐ 이 스위트는 원장(`inventory_transaction*`)을 건드리지 않는다 — TRUNCATE 를 쓰지 않고
 * 접두어(`ALE2E`) DELETE 로만 정리한다(다른 세션의 `logistics-shipment-request` 계열과 공존).
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

const LOGIN_ID = 'e2e-shipment-allocation-probe';
const PASSWORD = 'SA-출하배분-비밀번호';
const PREFIX = 'ALE2E';
const BASE = '/api/logistics/shipment-lot-allocations';

function validator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8'),
  ) as object;
  const pointer =
    '/paths/~1logistics~1shipment-lot-allocations/get/responses/200/content/application~1json/schema';
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface AllocationBody {
  shipmentLotAllocationId: number;
  shipmentId: number;
  shipmentLineId: number;
  itemId: number;
  itemCode: string;
  lotId: number;
  lotNo?: string;
  handlingUnitId: number | null;
  warehouseId: number;
  allocatedQty: number;
  uomId: number;
  oqcPassed: boolean;
  packedQty: number;
}
interface ListBody {
  items: AllocationBody[];
  page: { page: number; size: number; total: number };
  match?: { matched: boolean; reasonCode?: string };
}

type Judgment = 'ACCEPTED' | 'REJECTED' | 'HELD';

describe('출하 LOT 배분 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = {
    plant: 0n,
    warehouse: 0n,
    uom: 0n,
    uom2: 0n,
    item1: 0n,
    item2: 0n,
    customer: 0n,
    shipTo: 0n,
    worker: 0n,
  };
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeUser();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── A-1 · A-5 · A-4 · A-28 — 스키마 · 조인 · packedQty · required 출처 ──────────────

  it('A-1 목록이 스키마를 만족한다 (handlingUnitId 는 null)', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1 });
    await makeAllocation(line, { lot: await makeLot('A1'), handlingUnitId: null });

    const body = await list({ shipmentId: shipment.shipmentId });
    const schema = validator();
    expect(schema(body)).toBe(true);
    expect(schema.errors ?? []).toEqual([]);
    const row = body.items[0];
    expect(row.handlingUnitId).toBeNull();
    expect(Object.keys(row)).toContain('handlingUnitId');
  });

  it('A-4 packedQty 는 HU 없으면 0, 있으면 allocatedQty 다', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1 });
    const hu = await makeHandlingUnit();
    const unpacked = await makeAllocation(line, { lot: await makeLot('A4-U'), handlingUnitId: null, qty: 30 });
    const packed = await makeAllocation(line, { lot: await makeLot('A4-P'), handlingUnitId: hu, qty: 45 });

    const body = await list({ shipmentLineId: line.shipmentLineId });
    const byId = new Map(body.items.map((row) => [row.shipmentLotAllocationId, row]));
    expect(byId.get(unpacked)?.packedQty).toBe(0);
    expect(byId.get(packed)?.packedQty).toBe(45);
  });

  it('A-5 itemCode·warehouseId 가 조인으로 실린다', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1 });
    await makeAllocation(line, { lot: await makeLot('A5') });

    const body = await list({ shipmentLineId: line.shipmentLineId });
    expect(body.items[0]).toMatchObject({ itemCode: `${PREFIX}-IT1`, warehouseId: Number(ids.warehouse) });
  });

  it('A-28 required 필수 칸 각각이 «제 출처»에서 온다(서로 다른 값 · packedQty ≠ allocatedQty)', async () => {
    // Nit ⑩ — 네 축(shipment·line·lot·HU) 시퀀스를 미리 벌려 둔다. 값 단언(아래)이 주 방어선이고
    // 이건 보조일 뿐이다 — 이 벌림 자체를 반증 근거로 쓰지 않는다(Set 크기 검사로 되돌리지 않는다).
    await makeShipment();
    await makeHandlingUnit();
    await makeLot('A28-burn');

    const shipmentA = await makeShipment();
    const lineA = await makeShipmentLine(shipmentA, { item: 1 });
    const hu = await makeHandlingUnit();
    const lot = await makeLot('A28');
    const allocationId = await makeAllocation(lineA, { lot, handlingUnitId: hu, qty: 77 });

    const body = await list({ shipmentLineId: lineA.shipmentLineId });
    const row = body.items.find((r) => r.shipmentLotAllocationId === allocationId);
    // ⭐ 값 단언 «전건»으로 잠근다(§6-3 ⑴) — `shipmentId`·`shipmentLineId`·`lotId`·
    //   `handlingUnitId` 는 저마다 «독립» 채번이라 우연히 같은 값이 나올 수 있어(§6-3 ⑵ · 두
    //   DB 시퀀스가 같은 정수를 낼 확률) 「집합 크기」가 아니라 «각 칸의 실제 저장값»과 대조한다.
    expect(row).toEqual({
      shipmentLotAllocationId: allocationId,
      shipmentId: shipmentA.shipmentId,
      shipmentLineId: lineA.shipmentLineId,
      itemId: Number(ids.item1),
      itemCode: `${PREFIX}-IT1`,
      lotId: Number(lot),
      lotNo: `${PREFIX}-A28`,
      handlingUnitId: Number(hu),
      warehouseId: Number(ids.warehouse),
      allocatedQty: 77,
      uomId: Number(ids.uom),
      oqcPassed: true,
      packedQty: 77,
    });
    // ⚠ 이 행은 HU 가 붙어 `packedQty = allocatedQty` 다(§5-3 정의) — `allocatedQty ≠ packedQty`
    //   인 행은 A-4 가 이미 세운다(HU 없음 · `packedQty = 0`). 두 시험이 함께 §6-3 ⑵ 를 채운다.

    // ⭐⭐ `itemId`·`itemCode`·`uomId` 의 출처가 «LOT»(`lt`)이 아니라 «라인/배분»(`sl`/`a`)임을
    //   잠근다 — 품목·UOM 이 늘 같은 픽스처에서는 `JOIN … i ON i.item_id = sl.item_id → lt.item_id`
    //   같은 뒤바꿈이 전건 초록이었다(Major-3). LOT 은 다른 품목·다른 UOM 으로 세운다.
    const mismatchedLot = await makeLot('A28-X', 2, 2);
    const allocationId2 = await makeAllocation(lineA, { lot: mismatchedLot, qty: 10 });
    const body2 = await list({ shipmentLineId: lineA.shipmentLineId });
    const row2 = body2.items.find((r) => r.shipmentLotAllocationId === allocationId2);
    expect(row2).toMatchObject({
      itemId: Number(ids.item1),
      itemCode: `${PREFIX}-IT1`,
      lotId: Number(mismatchedLot),
      uomId: Number(ids.uom),
    });
  });

  // ── A-2 · A-3 — 필터 절 ──────────────────────────────────────────────────

  it('A-2 shipmentId·shipmentLineId·lotId·handlingUnitId 각각이 안 걸리는 행을 뺀다', async () => {
    const shipment1 = await makeShipment();
    const shipment2 = await makeShipment();
    const line1 = await makeShipmentLine(shipment1, { item: 1 });
    const line2 = await makeShipmentLine(shipment2, { item: 1 });
    const lot1 = await makeLot('A2-1');
    const lot2 = await makeLot('A2-2');
    const hu = await makeHandlingUnit();
    const a1 = await makeAllocation(line1, { lot: lot1, handlingUnitId: hu });
    const a2 = await makeAllocation(line2, { lot: lot2, handlingUnitId: null });

    expect(ids_(await list({ shipmentId: shipment1.shipmentId }))).toEqual([a1]);
    expect(ids_(await list({ shipmentLineId: line1.shipmentLineId }))).toEqual([a1]);
    expect(ids_(await list({ lotId: Number(lot1) }))).toEqual([a1]);
    expect(ids_(await list({ handlingUnitId: Number(hu) }))).toEqual([a1]);
    expect(ids_(await list({ shipmentId: shipment2.shipmentId }))).toEqual([a2]);
  });

  it('A-3 unpackedOnly=true 가 HU 붙은 배분을 뺀다', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1 });
    const hu = await makeHandlingUnit();
    const unpacked = await makeAllocation(line, { lot: await makeLot('A3-U'), handlingUnitId: null });
    await makeAllocation(line, { lot: await makeLot('A3-P'), handlingUnitId: hu });

    const body = await list({ shipmentLineId: line.shipmentLineId, unpackedOnly: true });
    expect(body.items.map((r) => r.shipmentLotAllocationId)).toEqual([unpacked]);
  });

  // ── A-6 ~ A-10 — oqcPassed ───────────────────────────────────────────────

  it('A-6 shippingInspectionRequired=false 라인은 oqcPassed 가 true 다', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1, required: false });
    await makeAllocation(line, { lot: await makeLot('A6') });

    const body = await list({ shipmentLineId: line.shipmentLineId });
    expect(body.items[0].oqcPassed).toBe(true);
  });

  it('A-7·A-8 대상 라인 + 합격이면 true · 불합격이면 false', async () => {
    const shipment = await makeShipment();
    const passLine = await makeShipmentLine(shipment, { item: 1, required: true });
    const passLot = await makeLot('A7');
    await makePick(passLine.shipmentRequestLineId, passLot);
    await makeAllocation(passLine, { lot: passLot });
    await makeOqc('LOT', passLot, null, [{ judgment: 'ACCEPTED' }]);

    const failLine = await makeShipmentLine(shipment, { item: 1, required: true });
    const failLot = await makeLot('A8');
    await makePick(failLine.shipmentRequestLineId, failLot);
    await makeAllocation(failLine, { lot: failLot });
    await makeOqc('LOT', failLot, null, [{ judgment: 'REJECTED' }]);

    expect((await list({ shipmentLineId: passLine.shipmentLineId })).items[0].oqcPassed).toBe(true);
    expect((await list({ shipmentLineId: failLine.shipmentLineId })).items[0].oqcPassed).toBe(false);
  });

  it('A-9 재검사 2회차 합격이 oqcPassed=true 로 덮는다', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1, required: true });
    const lot = await makeLot('A9');
    await makePick(line.shipmentRequestLineId, lot);
    await makeAllocation(line, { lot });
    await makeOqc('LOT', lot, null, [{ judgment: 'REJECTED', round: 1 }, { judgment: 'ACCEPTED', round: 2 }]);

    expect((await list({ shipmentLineId: line.shipmentLineId })).items[0].oqcPassed).toBe(true);
  });

  it('Major-1 ⭐⭐ oqcPassed 모집단은 «이 라인이 피킹한 LOT 전체»다 — 이번 출하에 배정되지 않은 LOT의 불합격도 반영한다', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1, required: true });
    const lotA = await makeLot('M1-A');
    const lotB = await makeLot('M1-B');
    // 둘 다 «피킹»했지만 이번 출하엔 A 만 «배분»됐다 — B 는 다른 출하(또는 아직 미배정)의 몫이다.
    await makePick(line.shipmentRequestLineId, lotA);
    await makePick(line.shipmentRequestLineId, lotB);
    const allocationId = await makeAllocation(line, { lot: lotA });
    // ⭐ A 자신은 «합격»이어야 두 축이 진짜로 갈린다 — «배분 축»으로 되돌리면 모집단이 {A} 뿐이라
    //   결과가 인구 0(PENDING→false)이 아니라 «PASSED(true)» 로 나온다(A 만 보고 «통과»로 오판).
    await makeOqc('LOT', lotA, null, [{ judgment: 'ACCEPTED' }]);
    await makeOqc('LOT', lotB, null, [{ judgment: 'REJECTED' }]);

    const body = await list({ shipmentLineId: line.shipmentLineId });
    // ⛔ 배분(`shipment_lot_allocation`) 축으로 모집단을 세우면 B 가 안 보여 A 홀로 PASSED(true) —
    //   그러면 검사 화면은 불합격인데 이 목록은 A 의 납품라벨을 뽑게 허용한다(Major-1).
    expect(body.items.find((r) => r.shipmentLotAllocationId === allocationId)?.oqcPassed).toBe(false);
  });

  it('Major-2 ⭐ oqcPassed 는 부르는 필터에 따라 갈리지 않는다 — LOT 모집단은 후보 행이 아니라 라인 전건', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1, required: true });
    const lotA = await makeLot('M2-A');
    const lotB = await makeLot('M2-B');
    const hu = await makeHandlingUnit();
    await makePick(line.shipmentRequestLineId, lotA);
    await makePick(line.shipmentRequestLineId, lotB);
    const allocA = await makeAllocation(line, { lot: lotA, handlingUnitId: hu });
    await makeAllocation(line, { lot: lotB, handlingUnitId: null });
    await makeOqc('LOT', lotA, null, [{ judgment: 'ACCEPTED' }]);
    await makeOqc('LOT', lotB, null, [{ judgment: 'REJECTED' }]);

    // `handlingUnitId` 로 좁히면 후보 행에 B(REJECTED)가 안 보인다 — 별도 조회로 세우지 않으면
    // 이 호출만 다른 값을 낸다(초과 54줄이 사는 이유 · Major-2).
    const fromHu = (await list({ handlingUnitId: Number(hu) })).items.find(
      (r) => r.shipmentLotAllocationId === allocA,
    )?.oqcPassed;
    const fromLine = (await list({ shipmentLineId: line.shipmentLineId })).items.find(
      (r) => r.shipmentLotAllocationId === allocA,
    )?.oqcPassed;
    expect(fromHu).toBe(fromLine);
    expect(fromHu).toBe(false);
  });

  it('A-10 ⭐⭐ 헤더 대상 OQC 만 있는 출하의 배분이 oqcPassed=true 다(R-10)', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1, required: true });
    const lot = await makeLot('A10');
    await makeAllocation(line, { lot });
    // LOT 축 결과는 «없다» — 헤더 대상(target_type_code=SHIPMENT_REQUEST · lot_id NULL)뿐이다.
    await makeOqc('SHIPMENT_REQUEST', line.shipmentRequestId, null, [{ judgment: 'ACCEPTED' }]);

    const body = await list({ shipmentLineId: line.shipmentLineId });
    // ⛔ LOT 축만 보면 false 다 — 「합격인데 라벨을 영원히 못 뽑는」 영구 상태가 된다.
    expect(body.items[0].oqcPassed).toBe(true);
  });

  it('A-11 oqcPassed=true 필터가 false 행을 뺀다', async () => {
    const shipment = await makeShipment();
    const passLine = await makeShipmentLine(shipment, { item: 1, required: false });
    const passId = await makeAllocation(passLine, { lot: await makeLot('A11-P') });
    const failLine = await makeShipmentLine(shipment, { item: 1, required: true });
    const failLot = await makeLot('A11-F');
    await makePick(failLine.shipmentRequestLineId, failLot);
    await makeAllocation(failLine, { lot: failLot });
    await makeOqc('LOT', failLot, null, [{ judgment: 'REJECTED' }]);

    const body = await list({ shipmentId: shipment.shipmentId, oqcPassed: true });
    expect(body.items.map((r) => r.shipmentLotAllocationId)).toEqual([passId]);
    // Minor ⑤ — `total` 이 필터 «전» 건수(2)로 접혀도 그전까진 초록이었다.
    expect(body.page.total).toBe(1);
  });

  // ── A-12 — q ──────────────────────────────────────────────────────────

  it('A-12 ⭐ q 를 아무 값(HU 번호와 «같은» 값 포함)으로 줘도 빈 목록이고 404 가 아니다', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1 });
    const hu = await makeHandlingUnit();
    await makeAllocation(line, { lot: await makeLot('A12'), handlingUnitId: hu });
    const huRow = await prisma.handling_unit.findUniqueOrThrow({ where: { handling_unit_id: hu } });

    // ⛔ `handling_unit_no` 에 얹으면 이 값이 걸려 목록이 안 빈다(R-8).
    const body = await list({ shipmentId: shipment.shipmentId, q: huRow.handling_unit_no });
    expect(body.items).toEqual([]);
    expect(body.page.total).toBe(0);
  });

  // ── A-13 ~ A-17 — match 삼분기 ────────────────────────────────────────────

  it('A-13 lotQ 없이 부르면 match 키가 없다', async () => {
    const shipment = await makeShipment();
    const body = await list({ shipmentId: shipment.shipmentId });
    expect(body).not.toHaveProperty('match');
  });

  it('A-14 ⭐⭐ matched=true 면 reasonCode 키가 없다(R-8 · null 을 실으면 ajv 가 깨진다)', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1 });
    const lot = await makeLot('A14');
    await makeAllocation(line, { lot });
    const lotRow = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lot } });

    const body = await list({ shipmentId: shipment.shipmentId, lotQ: lotRow.lot_no });
    const schema = validator();
    expect(schema(body)).toBe(true);
    expect(schema.errors ?? []).toEqual([]);
    expect(body.match).toEqual({ matched: true });
    expect(body.match).not.toHaveProperty('reasonCode');
  });

  it('A-15 LOT_NOT_ALLOCATED — 품목은 같은데 이 출하에 배분되지 않은 LOT', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1 });
    await makeAllocation(line, { lot: await makeLot('A15-ALLOC') });
    // 같은 품목의 다른 LOT — 배분되지 않았다.
    await makeLot('A15-OUT', 1);

    const body = await list({ shipmentId: shipment.shipmentId, lotQ: `${PREFIX}-A15-OUT` });
    expect(body.match).toEqual({ matched: false, reasonCode: 'LOT_NOT_ALLOCATED' });
  });

  it('Minor-7 lotQ 가 어떤 LOT 도 못 찾으면 LOT_NOT_ALLOCATED 다', async () => {
    const shipment = await makeShipment();
    await makeShipmentLine(shipment, { item: 1 });

    const body = await list({ shipmentId: shipment.shipmentId, lotQ: `${PREFIX}-NOSUCH` });
    expect(body.match).toEqual({ matched: false, reasonCode: 'LOT_NOT_ALLOCATED' });
  });

  it('A-16 LABEL_ITEM_MISMATCH — 이 출하의 어느 라인 품목과도 다른 LOT', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1 });
    await makeAllocation(line, { lot: await makeLot('A16-ALLOC') });
    await makeLot('A16-OTHER', 2);

    const body = await list({ shipmentId: shipment.shipmentId, lotQ: `${PREFIX}-A16-OTHER` });
    expect(body.match).toEqual({ matched: false, reasonCode: 'LABEL_ITEM_MISMATCH' });
  });

  it('A-17 lotQ 만 주고 shipmentId 를 안 주면 match 가 없다', async () => {
    const lot = await makeLot('A17');
    const lotRow = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lot } });
    const body = await list({ lotQ: lotRow.lot_no });
    expect(body).not.toHaveProperty('match');
  });

  // ── A-18 — 정렬 ───────────────────────────────────────────────────────

  it('A-18 정렬이 PK 역순이다(배열 통째 단언)', async () => {
    const shipment = await makeShipment();
    const line = await makeShipmentLine(shipment, { item: 1 });
    const a = await makeAllocation(line, { lot: await makeLot('A18-1') });
    const b = await makeAllocation(line, { lot: await makeLot('A18-2') });
    const c = await makeAllocation(line, { lot: await makeLot('A18-3') });

    const body = await list({ shipmentLineId: line.shipmentLineId });
    // 생성 순서(a<b<c)의 역순 그대로 — 방향을 뒤집으면 이 배열이 통째로 반증한다.
    expect(body.items.map((r) => r.shipmentLotAllocationId)).toEqual([c, b, a]);
  });

  // ───────────────────────────────────────────────────────────────────────

  async function list(query: Record<string, unknown>): Promise<ListBody> {
    const search = Object.entries(query)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join('&');
    const response = await request(app.getHttpServer())
      .get(`${BASE}?${search}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as ListBody;
  }

  function ids_(body: ListBody): number[] {
    return body.items.map((row) => row.shipmentLotAllocationId);
  }

  async function makeShipment(): Promise<{ shipmentId: number; shipmentRequestId: bigint }> {
    seq += 1;
    const header = await prisma.shipment_request.create({
      data: {
        shipment_request_no: `${PREFIX}-SR-${seq}`,
        customer_id: ids.customer,
        ship_to_partner_id: ids.shipTo,
        requested_ship_date: new Date('2026-08-13T00:00:00.000Z'),
        status_code: 'STORED-NOT-EMITTED',
      },
    });
    const shipment = await prisma.shipment.create({
      data: {
        shipment_no: `${PREFIX}-SH-${seq}`,
        shipment_request_id: header.shipment_request_id,
        warehouse_id: ids.warehouse,
        status_code: 'REGISTERED',
      },
    });
    return { shipmentId: Number(shipment.shipment_id), shipmentRequestId: header.shipment_request_id };
  }

  async function makeShipmentLine(
    shipment: { shipmentId: number; shipmentRequestId: bigint },
    spec: { item: 1 | 2; required?: boolean; lineNo?: number },
  ): Promise<{ shipmentLineId: number; shipmentRequestId: bigint; shipmentRequestLineId: number }> {
    seq += 1;
    const itemId = spec.item === 2 ? ids.item2 : ids.item1;
    const requestLine = await prisma.shipment_request_line.create({
      data: {
        shipment_request_id: shipment.shipmentRequestId,
        line_no: spec.lineNo ?? seq,
        item_id: itemId,
        requested_qty: 100,
        allocated_qty: 100,
        shipped_qty: 0,
        uom_id: ids.uom,
        shipping_inspection_required: spec.required ?? false,
      },
    });
    const line = await prisma.shipment_line.create({
      data: {
        shipment_id: BigInt(shipment.shipmentId),
        line_no: spec.lineNo ?? seq,
        shipment_request_line_id: requestLine.shipment_request_line_id,
        item_id: itemId,
        // ⚠ `ck_shipment_line`(`shipped_qty > 0`) — 이 표는 「이미 나간 수량」이라 0 을 안 받는다.
        shipped_qty: 1,
        uom_id: ids.uom,
      },
    });
    return {
      shipmentLineId: Number(line.shipment_line_id),
      shipmentRequestId: shipment.shipmentRequestId,
      shipmentRequestLineId: Number(requestLine.shipment_request_line_id),
    };
  }

  /**
   * 라인의 「피킹」— `inventory_reservation`(`SHIPMENT_REQUEST_LINE` 축). ③b/④ `picksByLine()` 과
   * 같은 축이고, ⑦a `oqcPassedByLine()` 의 LOT 모집단이 «이것»에서 온다(Major-1) — 배분
   * (`shipment_lot_allocation`) 이 아니다. 배분됐다고 자동으로 피킹된 것은 아니라 필요한 시험마다
   * 명시적으로 세운다.
   */
  async function makePick(shipmentRequestLineId: number, lot: bigint, qty = 10): Promise<void> {
    seq += 1;
    await prisma.inventory_reservation.create({
      data: {
        reservation_no: `${PREFIX}-RS-${seq}`,
        reservation_type_code: 'SHIPMENT',
        source_document_type_code: 'SHIPMENT_REQUEST_LINE',
        source_document_id: BigInt(shipmentRequestLineId),
        item_id: ids.item1,
        lot_id: lot,
        warehouse_id: ids.warehouse,
        reserved_qty: qty,
        uom_id: ids.uom,
        status_code: 'REGISTERED',
      },
    });
  }

  async function makeAllocation(
    line: { shipmentLineId: number },
    spec: { lot: bigint; handlingUnitId?: bigint | null; qty?: number },
  ): Promise<number> {
    const allocation = await prisma.shipment_lot_allocation.create({
      data: {
        shipment_line_id: BigInt(line.shipmentLineId),
        lot_id: spec.lot,
        handling_unit_id: spec.handlingUnitId ?? null,
        allocated_qty: spec.qty ?? 50,
        uom_id: ids.uom,
      },
    });
    return Number(allocation.shipment_lot_allocation_id);
  }

  async function makeHandlingUnit(): Promise<bigint> {
    seq += 1;
    const hu = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-HU-${seq}`,
        handling_unit_type_code: 'PALLET',
        warehouse_id: ids.warehouse,
        status_code: 'OPEN',
      },
    });
    return hu.handling_unit_id;
  }

  async function makeLot(key: string, item: 1 | 2 = 1, uom: 1 | 2 = 1): Promise<bigint> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-${key}`,
        item_id: item === 2 ? ids.item2 : ids.item1,
        lot_type_code: 'PRODUCT',
        plant_id: ids.plant,
        initial_qty: 1_000,
        uom_id: uom === 2 ? ids.uom2 : ids.uom,
        source_type_code: 'WORK_ORDER',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    return lot.lot_id;
  }

  async function makeOqc(
    targetTypeCode: 'LOT' | 'SHIPMENT_REQUEST',
    targetId: bigint,
    lotId: bigint | null,
    results: { judgment: Judgment; round?: number }[],
  ): Promise<void> {
    seq += 1;
    const req = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-IRQ-${seq}`,
        inspection_type_code: 'OQC',
        target_type_code: targetTypeCode,
        target_id: targetId,
        item_id: ids.item1,
        lot_id: lotId,
        target_qty: 10,
        uom_id: ids.uom,
        status_code: 'COMPLETED',
        requested_at: new Date('2026-08-12T00:00:00.000Z'),
      },
    });
    for (const result of results) {
      seq += 1;
      await prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-IRS-${seq}`,
          inspection_request_id: req.inspection_request_id,
          inspection_round: result.round ?? 1,
          inspected_qty: 10,
          accepted_qty: result.judgment === 'ACCEPTED' ? 10 : 0,
          rejected_qty: result.judgment === 'REJECTED' ? 10 : 0,
          held_qty: result.judgment === 'HELD' ? 10 : 0,
          uom_id: ids.uom,
          inspector_id: ids.worker,
          inspected_at: new Date('2026-08-12T01:00:00.000Z'),
          status_code: 'CONFIRMED',
          overall_judgment_code: result.judgment,
          idempotency_key: `${PREFIX}-IRK-${seq}`,
        },
      });
    }
  }

  async function makeMasters(): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.plant = plant.plant_id;
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    const [uom, uom2] = await prisma.uom.findMany({ take: 2, orderBy: { uom_id: 'asc' } });
    ids.uom = uom.uom_id;
    ids.uom2 = uom2.uom_id;

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: ids.plant,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '출하배분검사창고',
        warehouse_type_code: 'FINISHED',
        management_level_code: 'WAREHOUSE',
      },
    });
    ids.warehouse = warehouse.warehouse_id;

    for (const [key, suffix] of [
      ['item1', 'IT1'],
      ['item2', 'IT2'],
    ] as const) {
      const item = await prisma.item.create({
        data: {
          item_code: `${PREFIX}-${suffix}`,
          item_name: `출하배분검사품목${suffix}`,
          item_type_code: 'FINISHED',
          base_uom_id: ids.uom,
        },
      });
      ids[key] = item.item_id;
    }

    for (const [key, suffix] of [
      ['customer', 'C1'],
      ['shipTo', 'SH1'],
    ] as const) {
      const partner = await prisma.partner.create({
        data: { partner_code: `${PREFIX}-${suffix}`, partner_name: `출하배분검사파트너${suffix}` },
      });
      ids[key] = partner.partner_id;
    }

    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-WK`,
        worker_name: '출하배분검사원',
        business_unit_id: unit.business_unit_id,
        plant_id: ids.plant,
        status_code: 'EMPLOYED',
      },
    });
    ids.worker = worker.worker_id;
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '출하배분검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login(LOGIN_ID);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.shipment_lot_allocation
       WHERE shipment_line_id IN (SELECT shipment_line_id FROM logistics.shipment_line sl
              JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
             WHERE s.shipment_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.shipment_line
       WHERE shipment_id IN (SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.shipment_request_line
       WHERE shipment_request_id IN (SELECT shipment_request_id FROM logistics.shipment_request
              WHERE shipment_request_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM quality.inspection_result WHERE inspection_result_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM quality.inspection_request WHERE inspection_request_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_reservation WHERE reservation_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`);

    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
  }
});
