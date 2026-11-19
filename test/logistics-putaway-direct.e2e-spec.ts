/**
 * 피처 009 — 적치 지시 없는 구매 입고 적치(omf-all-around#294). 적치 대기 LOT 목록·LOT 확인·위치 판정(S3)과
 * 적치·임시 적치(S4)를 실제 API 로 본다. 입하 LOT 은 도우미(발행 → 받기 → 마감 → IQC 합격)로 세우고, 불합격·처분 같은
 * 판정 결과는 LOT 상태만 직접 세운다(판정 경로는 이 피처 밖이다).
 *
 * 공장 P1: 일반 창고 A(구역 Z01 · 랙 R1{X} R2{} R3{Y} R4{} R5{Y} R6{Y} · 꺼진 랙 R7), 일반 창고 B(위치 없음 — 「창고 전체」),
 * 불량창고 D(랙 D1{X}). 공장 P2: 창고 C(랙 C1). 품목 X(IQC 대상) · Z(검사 비대상) · Y.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { localDate } from '../src/planning/production-plan/plan-window';
import { InventoryPostingService } from '../src/core/inventory-posting';
import { DocumentCancelExecuteService } from '../src/logistics/document-progress/document-cancel-execute.service';
import { postReceipt } from '../src/logistics/goods-receipt/receipt-posting';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  InboundLotFixture, IssuedMaterialLot, closeInboundLotFixture, idempotencyKey, issueAndReceive, passInboundLotIqc, sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'E9PD';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const LIST = '/api/logistics/putaway-pending-lots';
const LOOKUP = '/api/logistics/putaway-pending-lots:lookup';
const AT = `${DAY}T04:00:00.000Z`;

interface PendingItem {
  lotId: number; lotNo: string; itemId: number; itemCode: string; qty: number; uomCode: string; lotStatusCode: string;
  inboundLotId?: number; inboundLotNo?: string; supplierName?: string; inboundClosedAt?: string;
}
interface PutawayResult {
  goodsReceiptId: number; goodsReceiptNo: string; lotId: number; lotNo: string; qty: number; uomCode: string; warehouseId: number; warehouseName: string;
  locationId: number; locationCode: string; locationPath: string; putawayModeCode: string; itemDesignationAdded: boolean;
}
interface DesignatedGroup { warehouseId: number; warehouseName: string; isDefect: boolean; locations: { locationId: number; locationCode: string; locationPath: string }[] }
interface LookupBody {
  found: boolean; eligible: boolean; reasonCode?: string; lot?: PendingItem; designated?: DesignatedGroup[];
  temporaryWarehouses?: { warehouseId: number; warehouseName: string; isDefect: boolean; designatedCount: number }[];
  putAway?: { warehouseName: string; locationCode: string; locationPath: string; putawayModeCode?: string };
  putawayTaskIds?: number[];
}

describe('피처 009 — 적치 지시 없는 구매 입고 적치 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let mobile: string;
  let mobileP2: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const codes: Record<string, string> = {};
  const keys = new Set<string>();
  const users: Record<string, string> = {};
  let terminalSeq = 0;
  let il1: IssuedMaterialLot[];
  let il2: IssuedMaterialLot[];
  let il3: IssuedMaterialLot[];
  let il4: IssuedMaterialLot[];
  let il5: IssuedMaterialLot[];
  const extra: Record<string, { lotId: bigint; lotNo: string }> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code));
    users.m0105 = await makeUser('M0105', ['M-01-05']);
    users.m0107 = await makeUser('M0107', ['M-01-07']);
    users.none = await makeUser('NONE', ['W-01-09']);
    await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W2`, worker_name: '적치검사자', business_unit_id: ids.unit, plant_id: ids.p1, app_user_id: ids.user, status_code: 'EMPLOYED' },
    });
    mobile = await terminalToken('MOBILE', ids.p1);
    mobileP2 = await terminalToken('MOBILE', ids.p2);
    fx = {
      app, issuer: terminalAuth(await terminalToken('POP', ids.p1), WORKER_NO), receiver: terminalAuth(mobile, WORKER_NO),
      businessDate: DAY, keys, inspector: sessionAuth(cookie), prisma,
    };
    ids.po = await purchaseOrder(ids.s1, ids.x, 1000);
    il1 = await passed(ids.s1, ids.x, 12);
    il2 = await closedLots(ids.s2, ids.x, 2);
    await prisma.lot.updateMany({ where: { lot_id: { in: il2.map((lot) => BigInt(lot.lotId)) } }, data: { status_code: 'DEFECTIVE' } });
    il3 = (await issueAndReceive(fx, batch(ids.s3, ids.x, 1))).lots;
    il4 = await closedLots(ids.s4, ids.x, 1);
    il5 = await closedLots(ids.s5, ids.z, 1);
    extra.legacy = await directLot(ids.p1, 'LEGACY', 'INBOUND_RECEIPT_LINE', 'NORMAL', ids.x);
    extra.scrapped = await directLot(ids.p1, 'SCRAP', 'INBOUND_RECEIPT_LINE', 'SCRAPPED', ids.x);
    extra.product = await directLot(ids.p1, 'PROD', 'WORK_ORDER', 'NORMAL', ids.x);
    extra.otherPlant = await directLot(ids.p2, 'P2', 'INBOUND_RECEIPT_LINE', 'NORMAL', ids.x);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── 목록 · LOT 확인 · 위치 판정(S3) ─────────────────────────────

  it('US1-1 Q1 US5-3 US5-7 단말 목록 — IL-1 전부·IL-2 2개(불량)·IL-5·이전 흐름 LOT, 입하 중·검사 대기·처분·제품·다른 공장 LOT 은 없다', async () => {
    const response = await asMobile(request(app.getHttpServer()).get(LIST)).expect(200);
    const items = response.body.items as PendingItem[];
    const lotNos = items.map((item) => item.lotNo);

    expect(lotNos.sort()).toEqual([...il1, ...il2, ...il5].map((lot) => lot.lotNo).concat(extra.legacy.lotNo).sort());
    expect(response.body.page).toMatchObject({ total: items.length });
    for (const absent of [...il3, ...il4, extra.scrapped, extra.product, extra.otherPlant]) expect(lotNos).not.toContain(absent.lotNo);
    expect(items.filter((item) => item.lotStatusCode === 'DEFECTIVE').map((item) => item.lotNo).sort()).toEqual(il2.map((lot) => lot.lotNo).sort());
    const first = items.find((item) => item.lotNo === il1[0].lotNo) as PendingItem;
    expect(first).toMatchObject({ itemCode: `${PREFIX}-X`, qty: il1[0].lotQty, uomCode: 'EA', lotStatusCode: 'NORMAL', supplierName: `${PREFIX} 공급사 1` });
    expect(first.inboundLotNo).toEqual(expect.any(String));
    expect(first.inboundClosedAt).toEqual(expect.any(String));
    // 이전 흐름(입하 LOT 없음)은 입하 LOT 칸이 없다.
    expect(items.find((item) => item.lotNo === extra.legacy.lotNo)?.inboundLotNo).toBeUndefined();
  });

  it('US1-1 목록 정렬 — 입하 마감 오래된 순 → 입하 LOT → LOT 번호, lotId 로 한 LOT 만', async () => {
    const items = (await asMobile(request(app.getHttpServer()).get(LIST)).expect(200)).body.items as PendingItem[];
    const closed = items.filter((item) => item.inboundClosedAt !== undefined);
    const keysOf = closed.map((item) => `${item.inboundClosedAt as string}|${item.inboundLotNo as string}|${item.lotNo}`);
    expect(keysOf).toEqual([...keysOf].sort());

    const one = await asMobile(request(app.getHttpServer()).get(LIST).query({ lotId: il1[1].lotId })).expect(200);
    expect((one.body.items as PendingItem[]).map((item) => item.lotNo)).toEqual([il1[1].lotNo]);
  });

  it('FR-041 Q22 세션 목록은 plantId 가 필수, 다른 공장 단말 범위 밖은 401', async () => {
    await request(app.getHttpServer()).get(LIST).set('Cookie', cookie).expect(400);
    const session = await request(app.getHttpServer()).get(LIST).set('Cookie', cookie).query({ plantId: Number(ids.p1) }).expect(200);
    expect(session.body.page.total).toBe(il1.length + il2.length + il5.length + 1);
    await asMobile(request(app.getHttpServer()).get(LIST).query({ plantId: Number(ids.p2) })).expect(401);
  });

  it('US1-2 Q2 FR-014 LOT 확인 — 지정 위치는 A › R1 과 B 「창고 전체」, 불량창고 D·다른 공장 C 는 없다', async () => {
    const body = await lookup(il1[0].lotNo);

    expect(body).toMatchObject({ found: true, eligible: true, lot: { lotNo: il1[0].lotNo, lotStatusCode: 'NORMAL' } });
    const designated = body.designated as DesignatedGroup[];
    expect(designated.map((group) => group.warehouseId).sort()).toEqual([ids.a, ids.b].map(Number).sort());
    expect(designated.find((group) => group.warehouseId === Number(ids.a))?.locations.map((l) => l.locationCode)).toEqual([codes.R1]);
    expect(designated.find((group) => group.warehouseId === Number(ids.a))?.locations[0].locationPath).toBe(`${PREFIX} 창고 A › Z01 구역 › R1 랙`);
    expect(designated.find((group) => group.warehouseId === Number(ids.b))?.locations.map((l) => l.locationCode)).toEqual([codes.BWHOLE]);
  });

  it('US4-1 LOT 확인 — 임시 적치 창고는 불량 규칙에 맞는 활성 창고, 지정 위치가 있는 창고가 위', async () => {
    const body = await lookup(il1[0].lotNo);
    const warehouses = body.temporaryWarehouses as NonNullable<LookupBody['temporaryWarehouses']>;
    expect(warehouses.map((w) => w.warehouseId).sort()).toEqual([ids.a, ids.b].map(Number).sort());
    expect(warehouses.every((w) => !w.isDefect)).toBe(true);
    expect(warehouses.map((w) => w.designatedCount)).toEqual([1, 1]);

    const defect = await lookup(il2[0].lotNo);
    expect(defect.temporaryWarehouses?.map((w) => w.warehouseId)).toEqual([Number(ids.d)]);
  });

  it('US3-1 Q9 불합격 LOT — 「불량」, 지정 목록은 불량창고 D 만', async () => {
    const body = await lookup(il2[0].lotNo);
    expect(body).toMatchObject({ eligible: true, lot: { lotStatusCode: 'DEFECTIVE' } });
    expect(body.designated?.map((group) => [group.warehouseId, group.isDefect, group.locations.map((l) => l.locationCode)]))
      .toEqual([[Number(ids.d), true, [codes.D1]]]);
  });

  it('US5-1 US5-2 US5-5 FR-011 Q13 숨김 이유 — 입하 마감 전·IQC 판정 전·처분·다른 공장·입하 LOT 아님·없는 번호', async () => {
    expect(await lookup(il3[0].lotNo)).toMatchObject({ found: true, eligible: false, reasonCode: 'RECEIVING' });
    expect(await lookup(il4[0].lotNo)).toMatchObject({ found: true, eligible: false, reasonCode: 'INSPECTION' });
    expect(await lookup(extra.scrapped.lotNo)).toMatchObject({ found: true, eligible: false, reasonCode: 'DISPOSED' });
    expect(await lookup(extra.product.lotNo)).toMatchObject({ found: true, eligible: false, reasonCode: 'NOT_INBOUND' });
    const other = await lookup(extra.otherPlant.lotNo);
    expect(other).toMatchObject({ found: true, eligible: false, reasonCode: 'OTHER_PLANT' });
    expect(other.lot).toBeUndefined();
    expect(await lookup(`${PREFIX}-NOPE`)).toMatchObject({ found: false, eligible: false });
  });

  it('US1-3 US2-1 US2-4 US2-5 US2-6 FR-019 Q7 위치 판정 — 지정·미지정·없음·비활성·다른 공장·적치 대기·맨 아래 아님', async () => {
    const lot = il1[0].lotId;
    expect(await check(lot, codes.R1)).toMatchObject({ verdictCode: 'DESIGNATED', locationId: Number(ids.R1), warehouseId: Number(ids.a), locationPath: `${PREFIX} 창고 A › Z01 구역 › R1 랙` });
    expect(await check(lot, codes.R2)).toMatchObject({ verdictCode: 'UNDESIGNATED', warehouseName: `${PREFIX} 창고 A` });
    // 다른 품목만 지정된 위치도 미지정 위치다(2026-11-18 결정 — 품목 지정은 안내).
    expect(await check(lot, codes.R3)).toMatchObject({ verdictCode: 'UNDESIGNATED' });
    expect(await check(lot, `${PREFIX}-NOPE`)).toMatchObject({ verdictCode: 'NOT_FOUND', locationCode: `${PREFIX}-NOPE` });
    expect(await check(lot, codes.R7)).toMatchObject({ verdictCode: 'INACTIVE' });
    expect(await check(lot, codes.C1)).toMatchObject({ verdictCode: 'OTHER_PLANT' });
    expect(await check(lot, codes.ASTAGING)).toMatchObject({ verdictCode: 'STAGING' });
    expect(await check(lot, codes.Z01)).toMatchObject({ verdictCode: 'NOT_LEAF' });
    // 위치가 없는 창고의 「창고 전체」는 지정 위치, 나뉜 창고의 「창고 전체」는 미지정 위치다(FR-014).
    expect(await check(lot, codes.BWHOLE)).toMatchObject({ verdictCode: 'DESIGNATED' });
    expect(await check(lot, codes.AWHOLE)).toMatchObject({ verdictCode: 'UNDESIGNATED' });
  });

  it('US3-3 US3-4 Q10 불량 양방향 — 불량 LOT 은 일반 창고 막힘, 정상 LOT 은 불량창고 막힘', async () => {
    expect(await check(il2[0].lotId, codes.R1)).toMatchObject({ verdictCode: 'DEFECT_LOT_NEEDS_DEFECT_WAREHOUSE', isDefectWarehouse: false });
    expect(await check(il1[0].lotId, codes.D1)).toMatchObject({ verdictCode: 'NORMAL_LOT_IN_DEFECT_WAREHOUSE', isDefectWarehouse: true });
    expect(await check(il2[0].lotId, codes.D1)).toMatchObject({ verdictCode: 'DESIGNATED' });
  });

  it('US2-8 Q27 「지정 품목만 받기」 켠 위치({Y})에 X → RESTRICTED_LOCATION', async () => {
    await prisma.location.update({ where: { location_id: ids.R5 }, data: { item_restricted: true } });
    try {
      expect(await check(il1[0].lotId, codes.R5)).toMatchObject({ verdictCode: 'RESTRICTED_LOCATION' });
      expect(await check(il1[0].lotId, codes.R6)).toMatchObject({ verdictCode: 'UNDESIGNATED' });
    } finally {
      await prisma.location.update({ where: { location_id: ids.R5 }, data: { item_restricted: false } });
    }
  });

  it('위치 판정 — 적치 대기가 아닌 LOT 은 409 와 이유', async () => {
    const response = await asMobile(request(app.getHttpServer()).get(`${LIST}/${String(il3[0].lotId)}/location-check`).query({ locationCode: codes.R1 })).expect(409);
    expect(JSON.stringify(response.body)).toContain('RECEIVING');
  });

  it('FR-041 Q22 읽기 권한 — 목록·LOT 확인은 M-01-05·M-01-07, 위치 판정은 M-01-05 만', async () => {
    const plant = { plantId: Number(ids.p1) };
    for (const user of [users.m0105, users.m0107]) {
      await request(app.getHttpServer()).get(LIST).set('Cookie', user).query(plant).expect(200);
      await request(app.getHttpServer()).get(LOOKUP).set('Cookie', user).query({ lotNo: il1[0].lotNo }).expect(200);
    }
    await request(app.getHttpServer()).get(LIST).set('Cookie', users.none).query(plant).expect(403);
    const path = `${LIST}/${String(il1[0].lotId)}/location-check`;
    await request(app.getHttpServer()).get(path).set('Cookie', users.m0105).query({ locationCode: codes.R1 }).expect(200);
    await request(app.getHttpServer()).get(path).set('Cookie', users.m0107).query({ locationCode: codes.R1 }).expect(403);
  });

  it('다른 공장 단말은 그 공장의 LOT 만 보고, P1 LOT 확인은 OTHER_PLANT', async () => {
    const items = (await request(app.getHttpServer()).get(LIST).set('Authorization', `Bearer ${mobileP2}`).set('X-Worker-No', WORKER_NO).expect(200)).body.items as PendingItem[];
    expect(items.map((item) => item.lotNo)).toEqual([extra.otherPlant.lotNo]);
    const body = (await request(app.getHttpServer()).get(LOOKUP).set('Authorization', `Bearer ${mobileP2}`).query({ lotNo: il1[0].lotNo }).expect(200)).body as LookupBody;
    expect(body).toMatchObject({ found: true, eligible: false, reasonCode: 'OTHER_PLANT' });
  });

  // ── 적치 · 임시 적치(S4) ──────────────────────────────────────

  it('US1-3 US1-4 US1-5 Q3 SC-003 FR-033 지정 위치 R1 적치 — 입고 1건·라인 1줄·DESIGNATED·원장 to 만·STAGING 없음·작업자 감사·지시 없음·목록에서 빠짐', async () => {
    const lot = il1[0];
    const body = (await putaway(lot.lotId, { locationId: Number(ids.R1) }).expect(201)).body as PutawayResult;

    expect(body).toMatchObject({
      lotId: lot.lotId, lotNo: lot.lotNo, qty: lot.lotQty, uomCode: 'EA', warehouseId: Number(ids.a), locationId: Number(ids.R1),
      locationCode: codes.R1, locationPath: `${PREFIX} 창고 A › Z01 구역 › R1 랙`, putawayModeCode: 'DESIGNATED', itemDesignationAdded: false,
    });
    const receipts = await prisma.goods_receipt.findMany({ where: { goods_receipt_line: { some: { lot_id: BigInt(lot.lotId) } } }, include: { goods_receipt_line: true } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status_code: 'POSTED', receipt_type_code: 'MATERIAL', warehouse_id: ids.a, source_document_type_code: 'INBOUND_RECEIPT', created_by: null });
    expect(receipts[0].goods_receipt_line).toHaveLength(1);
    expect(receipts[0].goods_receipt_line[0]).toMatchObject({
      destination_location_id: ids.R1, putaway_mode_code: 'DESIGNATED', quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE',
    });
    expect(Number(receipts[0].goods_receipt_line[0].receipt_qty)).toBe(lot.lotQty);
    const ledger = await prisma.inventory_transaction_line.findMany({ where: { lot_id: BigInt(lot.lotId) }, include: { inventory_transaction: true } });
    expect(ledger.map((line) => [line.inventory_transaction.transaction_type_code, line.from_location_id, line.to_location_id]))
      .toEqual([['GOODS_RECEIPT', null, ids.R1]]);
    const balances = await prisma.inventory_balance.findMany({ where: { lot_id: BigInt(lot.lotId) } });
    expect(balances.map((row) => [row.location_id, Number(row.on_hand_qty)])).toEqual([[ids.R1, lot.lotQty]]);
    expect(await prisma.putaway_task.count({ where: { lot_id: BigInt(lot.lotId) } })).toBe(0);
    expect(await prisma.audit_event.count({ where: { target_type_code: 'GOODS_RECEIPT', target_id: BigInt(body.goodsReceiptId) } })).toBe(1);
    // 새 흐름 입하 LOT 은 입고 때 ERP 로 보내지 않는다(최종 마감 때 · #265).
    expect(await prisma.integration_message.count({ where: { message_key: `IF-GR-SEND:${body.goodsReceiptNo}` } })).toBe(0);

    const left = ((await asMobile(request(app.getHttpServer()).get(LIST)).expect(200)).body.items as PendingItem[]).map((item) => item.lotNo);
    expect(left).not.toContain(lot.lotNo);
    expect(left).toContain(il1[1].lotNo);
    expect(await lookup(lot.lotNo)).toMatchObject({ eligible: false, reasonCode: 'ALREADY_PUT_AWAY', putAway: { locationCode: codes.R1, putawayModeCode: 'DESIGNATED' } });
  });

  it('같은 Idempotency-Key 재전송 → 같은 응답, 입고 1건', async () => {
    const key = idempotencyKey(fx);
    const first = (await putaway(il1[11].lotId, { locationId: Number(ids.R1) }, key).expect(201)).body as PutawayResult;
    const again = (await putaway(il1[11].lotId, { locationId: Number(ids.R1) }, key).expect(201)).body as PutawayResult;
    expect(again).toEqual(first);
    expect(await prisma.goods_receipt_line.count({ where: { lot_id: BigInt(il1[11].lotId) } })).toBe(1);
  });

  it('FR-030 Q16 SC-004 같은 LOT 동시 적치 두 번 → 201 하나·409 ALREADY_PUT_AWAY 하나, 입고 1건', async () => {
    const lot = il1[1].lotId;
    const [a, b] = await Promise.all([putaway(lot, { locationId: Number(ids.R1) }), putaway(lot, { locationId: Number(ids.R1) })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const rejected = a.status === 409 ? a : b;
    expect(JSON.stringify(rejected.body)).toContain('ALREADY_PUT_AWAY');
    expect(JSON.stringify(rejected.body)).toContain('R1 랙');
    expect(await prisma.goods_receipt_line.count({ where: { lot_id: BigInt(lot) } })).toBe(1);
  });

  it('US2-1 US2-2 Q6 미지정 위치 R2 — 확인 없이 409 UNDESIGNATED_NEEDS_CONFIRM, 확인하면 UNDESIGNATED·품목 지정이 더해진다', async () => {
    const lot = il1[2].lotId;
    const refused = await putaway(lot, { locationId: Number(ids.R2) }).expect(409);
    expect(JSON.stringify(refused.body)).toContain('UNDESIGNATED_NEEDS_CONFIRM');
    expect(await prisma.goods_receipt_line.count({ where: { lot_id: BigInt(lot) } })).toBe(0);

    const body = (await putaway(lot, { locationId: Number(ids.R2), confirmUndesignated: true }).expect(201)).body as PutawayResult;
    expect(body).toMatchObject({ putawayModeCode: 'UNDESIGNATED', itemDesignationAdded: true, warehouseId: Number(ids.a) });
    expect(await itemsOf(ids.R2)).toEqual([ids.x]);
    const added = await prisma.location_item.findUniqueOrThrow({ where: { location_id_item_id: { location_id: ids.R2, item_id: ids.x } } });
    expect(added.created_by).toBeNull();
    expect(await prisma.audit_event.count({ where: { target_type_code: 'LOCATION_ITEM', target_id: ids.R2 } })).toBe(1);
  });

  it('US2-3 다른 창고 위치(B 「창고 전체」) → 입고 창고 = 그 위치의 창고', async () => {
    const body = (await putaway(il1[3].lotId, { locationId: Number(ids.BWHOLE) }).expect(201)).body as PutawayResult;
    expect(body).toMatchObject({ warehouseId: Number(ids.b), locationCode: codes.BWHOLE, putawayModeCode: 'DESIGNATED' });
  });

  it('US2-4 US2-5 FR-019 Q7 막히는 위치 — 없음·꺼짐·다른 공장·적치 대기·맨 아래 아님은 400 판정 코드, 기록 없음', async () => {
    const lot = il1[7].lotId;
    for (const [locationId, code] of [
      [99999999, 'NOT_FOUND'], [ids.R7, 'INACTIVE'], [ids.C1, 'OTHER_PLANT'], [ids.ASTAGING, 'STAGING'], [ids.Z01, 'NOT_LEAF'],
    ] as const) {
      const response = await putaway(lot, { locationId: Number(locationId), confirmUndesignated: true }).expect(400);
      expect(JSON.stringify(response.body)).toContain(code);
    }
    expect(await prisma.goods_receipt_line.count({ where: { lot_id: BigInt(lot) } })).toBe(0);
  });

  it('US2-6 US2-7 Q8 SC-007 다른 품목만 지정된 R3({Y}) — 확인 뒤 적치·R3 = {Y, X}, 다음 LOT 은 확인 없이 DESIGNATED', async () => {
    expect(await check(il1[4].lotId, codes.R3)).toMatchObject({ verdictCode: 'UNDESIGNATED' });
    await putaway(il1[4].lotId, { locationId: Number(ids.R3), confirmUndesignated: true }).expect(201);
    expect(await itemsOf(ids.R3)).toEqual([ids.x, ids.y].sort());

    expect(await check(il1[5].lotId, codes.R3)).toMatchObject({ verdictCode: 'DESIGNATED' });
    expect((await lookup(il1[5].lotNo)).designated?.find((group) => group.warehouseId === Number(ids.a))?.locations.map((l) => l.locationCode)).toContain(codes.R3);
    const body = (await putaway(il1[5].lotId, { locationId: Number(ids.R3) }).expect(201)).body as PutawayResult;
    expect(body).toMatchObject({ putawayModeCode: 'DESIGNATED', itemDesignationAdded: false });
  });

  it('Q24 FR-017a 나뉜 창고 A 의 「창고 전체」 미지정 적치 — 판정이 designationAddable false 를 알리고, 기록되지만 품목 지정은 더하지 않는다', async () => {
    // 판정 응답이 미리 알려 준다 — 시스템 자리는 UNDESIGNATED 여도 designationAddable false, 사람이 만든 미지정 위치는 true.
    expect(await check(il1[6].lotId, codes.AWHOLE)).toMatchObject({ verdictCode: 'UNDESIGNATED', designationAddable: false });
    expect(await check(il1[6].lotId, codes.R4)).toMatchObject({ verdictCode: 'UNDESIGNATED', designationAddable: true });
    expect(await check(il1[6].lotId, codes.BWHOLE)).toMatchObject({ verdictCode: 'DESIGNATED', designationAddable: false });
    expect(await check(il1[6].lotId, codes.R1)).toMatchObject({ verdictCode: 'DESIGNATED', designationAddable: false });
    expect(await check(il1[6].lotId, codes.ASTAGING)).toMatchObject({ verdictCode: 'STAGING', designationAddable: false });
    expect(await check(il1[6].lotId, `${PREFIX}-NOPE`)).toMatchObject({ verdictCode: 'NOT_FOUND', designationAddable: false });
    const body = (await putaway(il1[6].lotId, { locationId: Number(ids.AWHOLE), confirmUndesignated: true }).expect(201)).body as PutawayResult;
    expect(body).toMatchObject({ putawayModeCode: 'UNDESIGNATED', itemDesignationAdded: false });
    expect(await itemsOf(ids.AWHOLE)).toEqual([]);
  });

  it('US2-8 Q27 FR-017d 「지정 품목만 받기」 R5({Y})에 X — 확인 표시가 있어도 400 RESTRICTED_LOCATION, 지정 그대로', async () => {
    await prisma.location.update({ where: { location_id: ids.R5 }, data: { item_restricted: true } });
    try {
      const response = await putaway(il1[7].lotId, { locationId: Number(ids.R5), confirmUndesignated: true }).expect(400);
      expect(JSON.stringify(response.body)).toContain('RESTRICTED_LOCATION');
      expect(await itemsOf(ids.R5)).toEqual([ids.y]);
    } finally {
      await prisma.location.update({ where: { location_id: ids.R5 }, data: { item_restricted: false } });
    }
  });

  it('US2-9 Q28 판정 뒤 R6 옵션을 켜고 기록 → 400 RESTRICTED_LOCATION, LOT 은 목록에 남고 R6 지정 그대로 {Y}', async () => {
    expect(await check(il1[7].lotId, codes.R6)).toMatchObject({ verdictCode: 'UNDESIGNATED' });
    await prisma.location.update({ where: { location_id: ids.R6 }, data: { item_restricted: true } });
    try {
      const response = await putaway(il1[7].lotId, { locationId: Number(ids.R6), confirmUndesignated: true }).expect(400);
      expect(JSON.stringify(response.body)).toContain('RESTRICTED_LOCATION');
      expect(await itemsOf(ids.R6)).toEqual([ids.y]);
      const left = ((await asMobile(request(app.getHttpServer()).get(LIST)).expect(200)).body.items as PendingItem[]).map((item) => item.lotNo);
      expect(left).toContain(il1[7].lotNo);
    } finally {
      await prisma.location.update({ where: { location_id: ids.R6 }, data: { item_restricted: false } });
    }
  });

  it('US3-3 US3-4 Q10 불량 양방향 — 확인 표시가 있어도 막히고 품목 지정은 더해지지 않는다', async () => {
    const defect = await putaway(il2[1].lotId, { locationId: Number(ids.R2), confirmUndesignated: true }).expect(400);
    expect(JSON.stringify(defect.body)).toContain('DEFECT_LOT_NEEDS_DEFECT_WAREHOUSE');
    const normal = await putaway(il1[7].lotId, { locationId: Number(ids.D1), confirmUndesignated: true }).expect(400);
    expect(JSON.stringify(normal.body)).toContain('NORMAL_LOT_IN_DEFECT_WAREHOUSE');
    expect(await itemsOf(ids.D1)).toEqual([ids.x]);
  });

  it('US3-2 Q9 FR-033 불합격 LOT 을 불량창고 D1 에 — 라인 품질 DEFECTIVE·재고 ON_HOLD, ERP 적재 없음', async () => {
    const body = (await putaway(il2[0].lotId, { locationId: Number(ids.D1) }).expect(201)).body as PutawayResult;
    expect(body).toMatchObject({ warehouseId: Number(ids.d), putawayModeCode: 'DESIGNATED' });
    const line = await prisma.goods_receipt_line.findFirstOrThrow({ where: { lot_id: BigInt(il2[0].lotId) } });
    expect(line).toMatchObject({ quality_status_code: 'DEFECTIVE', inventory_status_code: 'ON_HOLD' });
    expect(await prisma.integration_message.count({ where: { message_key: `IF-GR-SEND:${body.goodsReceiptNo}` } })).toBe(0);
  });

  it('US4-2 Q11 Q24 임시 적치 — 창고 B 「창고 전체」·TEMPORARY·사유 없음·품목 지정 안 더함', async () => {
    const body = (await temporary(il1[8].lotId, { warehouseId: Number(ids.b) }).expect(201)).body as PutawayResult;
    expect(body).toMatchObject({ warehouseId: Number(ids.b), locationCode: codes.BWHOLE, putawayModeCode: 'TEMPORARY', itemDesignationAdded: false });
    const line = await prisma.goods_receipt_line.findFirstOrThrow({ where: { lot_id: BigInt(il1[8].lotId) }, include: { goods_receipt: true } });
    expect(line.putaway_mode_code).toBe('TEMPORARY');
    expect(line.goods_receipt.reason_code).toBeNull();
    expect(await itemsOf(ids.BWHOLE)).toEqual([]);
  });

  it('US4-4 임시 적치 창고 판정 — 불량 LOT 은 불량창고만, 정상 LOT 은 불량창고 불가, 없음·꺼짐·다른 공장 400', async () => {
    expect(JSON.stringify((await temporary(il2[1].lotId, { warehouseId: Number(ids.b) }).expect(400)).body)).toContain('DEFECT_LOT_NEEDS_DEFECT_WAREHOUSE');
    expect(JSON.stringify((await temporary(il1[7].lotId, { warehouseId: Number(ids.d) }).expect(400)).body)).toContain('NORMAL_LOT_IN_DEFECT_WAREHOUSE');
    expect(JSON.stringify((await temporary(il1[7].lotId, { warehouseId: 99999999 }).expect(400)).body)).toContain('NOT_FOUND');
    expect(JSON.stringify((await temporary(il1[7].lotId, { warehouseId: Number(ids.c) }).expect(400)).body)).toContain('OTHER_PLANT');
    expect(JSON.stringify((await temporary(il1[7].lotId, { warehouseId: Number(ids.e) }).expect(400)).body)).toContain('INACTIVE');
    const body = (await temporary(il2[1].lotId, { warehouseId: Number(ids.d) }).expect(201)).body as PutawayResult;
    expect(body).toMatchObject({ warehouseId: Number(ids.d), putawayModeCode: 'TEMPORARY' });
  });

  it('FR-041 Q22 쓰기 권한 — 적치는 M-01-05, 임시 적치는 M-01-07', async () => {
    const lot = il1[7].lotId;
    await request(app.getHttpServer()).post(`${LIST}/${String(lot)}:putaway`).set('Cookie', users.m0107)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ locationId: Number(ids.R1), businessDate: DAY, occurredAt: AT }).expect(403);
    await request(app.getHttpServer()).post(`${LIST}/${String(lot)}:putaway-temporary`).set('Cookie', users.m0105)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ warehouseId: Number(ids.b), businessDate: DAY, occurredAt: AT }).expect(403);
    await request(app.getHttpServer()).post(`${LIST}/${String(lot)}:putaway`).set('Cookie', users.none)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ locationId: Number(ids.R1), businessDate: DAY, occurredAt: AT }).expect(403);
    expect(await prisma.goods_receipt_line.count({ where: { lot_id: BigInt(lot) } })).toBe(0);
  });

  it('Q17 FR-035 판정 확정이 취소돼 검사 대기로 돌아간 LOT 의 기록 → 409 INSPECTION', async () => {
    await prisma.lot.update({ where: { lot_id: BigInt(il1[7].lotId) }, data: { status_code: 'INSPECTION_PENDING' } });
    try {
      const response = await putaway(il1[7].lotId, { locationId: Number(ids.R1) }).expect(409);
      expect(JSON.stringify(response.body)).toContain('INSPECTION');
    } finally {
      await prisma.lot.update({ where: { lot_id: BigInt(il1[7].lotId) }, data: { status_code: 'NORMAL' } });
    }
  });

  it('US6-2 Q15 이전 흐름 LOT(입하 LOT 없음) 적치 → 입고·ERP 구매입고 적재 1건', async () => {
    const body = (await putaway(Number(extra.legacy.lotId), { locationId: Number(ids.R2), confirmUndesignated: true }).expect(201)).body as PutawayResult;
    expect(await prisma.integration_message.count({ where: { message_key: `IF-GR-SEND:${body.goodsReceiptNo}` } })).toBe(1);
  });

  it('R-11 FR-032 Q18 적치 직후 입고 취소 → 역처리는 그 위치, LOT 은 목록에 다시 나온다', async () => {
    const lot = il1[9];
    const body = (await putaway(lot.lotId, { locationId: Number(ids.R1) }).expect(201)).body as PutawayResult;
    await prisma.goods_receipt.update({ where: { goods_receipt_id: BigInt(body.goodsReceiptId) }, data: { status_code: 'CANCEL_REQUESTED' } });
    const version = (await prisma.goods_receipt.findUniqueOrThrow({ where: { goods_receipt_id: BigInt(body.goodsReceiptId) } })).version_no;
    const cancelled = await app.get(DocumentCancelExecuteService).cancel('GOODS_RECEIPT', BigInt(body.goodsReceiptId), version, Number(ids.user));
    expect(cancelled.statusCode).toBe('CANCELLED');
    const balance = await prisma.inventory_balance.findMany({ where: { lot_id: BigInt(lot.lotId) } });
    expect(balance.map((row) => [row.location_id, Number(row.on_hand_qty)])).toEqual([[ids.R1, 0]]);
    expect(await lookup(lot.lotNo)).toMatchObject({ eligible: true });
  });

  it('FR-031 Q18 PDA 적치로 입고된 LOT 이 있으면 IQC 확정 취소·입하 마감 취소는 지금처럼 409 GOODS_RECEIVED', async () => {
    const iqc = await prisma.inspection_request.findFirstOrThrow({ where: { inbound_lot: { lot: { some: { lot_id: BigInt(il1[0].lotId) } } }, status_code: 'COMPLETED' } });
    const cancel = await request(app.getHttpServer()).post(`/api/quality/inspection-requests/${String(iqc.inspection_request_id)}:cancel-confirm`)
      .set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx)).send({ versionNo: iqc.version_no }).expect(409);
    expect((cancel.body.errors as { code: string }[]).map((error) => error.code)).toContain('GOODS_RECEIVED');

    await putaway(il5[0].lotId, { locationId: Number(ids.BWHOLE) }).expect(201);
    const inbound = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(il5[0].lotId) }, include: { inbound_lot: true } });
    const reopen = await request(app.getHttpServer()).post(`/api/logistics/inbound-lots/${String(inbound.inbound_lot_id)}:reopen-receipt`)
      .set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx)).send({ versionNo: inbound.inbound_lot?.version_no }).expect(409);
    expect((reopen.body.errors as { code: string }[]).map((error) => error.code)).toContain('GOODS_RECEIVED');
  });

  it('US5-6 US6-1 SC-005 Q14 배포 전 구매 입고 지시가 있는 LOT — 목록에 없고 확인은 HAS_TASK·지시 id', async () => {
    const lot = il1[10];
    await prisma.$transaction((tx) => postReceipt(tx, app.get(InventoryPostingService), {
      receiptTypeCode: 'MATERIAL', plantId: Number(ids.p1), warehouseId: Number(ids.a), receiptDatetime: AT, businessDate: DAY,
      lines: [{ itemId: Number(ids.x), lotId: lot.lotId, receiptQty: lot.lotQty, uomId: Number(ids.ea), qualityStatusCode: 'NORMAL',
        inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(ids.ASTAGING) }],
    }, Number(ids.user), `${PREFIX}-GR-OLD`, [`${PREFIX}-PT-OLD`]));
    const task = await prisma.putaway_task.findFirstOrThrow({ where: { lot_id: BigInt(lot.lotId) } });
    const body = await lookup(lot.lotNo);
    expect(body).toMatchObject({ eligible: false, reasonCode: 'HAS_TASK', putawayTaskIds: [Number(task.putaway_task_id)] });
    const left = ((await asMobile(request(app.getHttpServer()).get(LIST)).expect(200)).body.items as PendingItem[]).map((item) => item.lotNo);
    expect(left).not.toContain(lot.lotNo);
  });

  it('세션 호출도 적치한다(created_by = 계정)', async () => {
    const response = await request(app.getHttpServer()).post(`${LIST}/${String(il1[7].lotId)}:putaway`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ locationId: Number(ids.R1), businessDate: DAY, occurredAt: AT }).expect(201);
    const receipt = await prisma.goods_receipt.findUniqueOrThrow({ where: { goods_receipt_id: BigInt((response.body as PutawayResult).goodsReceiptId) } });
    expect(receipt.created_by).toBe(ids.user);
  });

  it('D-2 H5 :putaway·:putaway-temporary 는 전표에 작업자·단말을 쓰고, 세션 적치·지시 입고 전표는 NULL', async () => {
    const worker = await prisma.worker.findFirstOrThrow({ where: { worker_no: WORKER_NO, plant_id: ids.p1 } });
    const terminalId = BigInt((jwt.decode(mobile) as { sub: number }).sub);
    const receiptOf = (lot: { lotId: number }) => prisma.goods_receipt.findFirstOrThrow({ where: { goods_receipt_line: { some: { lot_id: BigInt(lot.lotId) } } } });
    for (const lot of [il1[0], il1[8]]) {
      expect(await receiptOf(lot)).toMatchObject({ putaway_worker_id: worker.worker_id, putaway_terminal_id: terminalId });
    }
    // 세션 적치(il1[7])와 배포 전 지시 입고(il1[10])는 채우지 않는다.
    for (const lot of [il1[7], il1[10]]) {
      expect(await receiptOf(lot)).toMatchObject({ putaway_worker_id: null, putaway_terminal_id: null });
    }
  });

  // ── 관리웹 단계·입고 조회·배지(S5) ─────────────────────────────

  it('US1-5 US1-6 US4-2 Q4 Q11 D-7 D-8 W-01-09 LOT 단계 — 적치한 LOT 「완료」+ 적치 방식·자리, 임시 적치 「임시 적치」, 남은 LOT 「적치 대기」', async () => {
    const response = await request(app.getHttpServer()).get(`/api/logistics/purchase-orders/${String(ids.po)}/inbound-progress`).set('Cookie', cookie).expect(200);
    type Row = { lotNo: string; stageCode: string; nextActionCode: string | null; putawayModeCode: string | null; putawayLocation: { locationCode: string } | null; putaway: unknown };
    const rows = new Map((response.body.items as Row[]).map((row) => [row.lotNo, row]));
    expect(rows.get(il1[0].lotNo)).toMatchObject({ stageCode: 'COMPLETED', putawayModeCode: 'DESIGNATED', putawayLocation: { locationCode: codes.R1 }, putaway: null });
    expect(rows.get(il1[2].lotNo)).toMatchObject({ stageCode: 'COMPLETED', putawayModeCode: 'UNDESIGNATED', putawayLocation: { locationCode: codes.R2 } });
    expect(rows.get(il1[8].lotNo)).toMatchObject({ stageCode: 'PUTAWAY_TEMPORARY', nextActionCode: 'PUTAWAY', putawayModeCode: 'TEMPORARY', putawayLocation: { locationCode: codes.BWHOLE } });
    expect(rows.get(il1[9].lotNo)).toMatchObject({ stageCode: 'PUTAWAY_PENDING', nextActionCode: 'PUTAWAY', putawayModeCode: null, putawayLocation: null });
    // 배포 전 지시로 입고한 LOT 은 지금처럼 지시 단계다.
    expect(rows.get(il1[10].lotNo)).toMatchObject({ stageCode: 'PUTAWAY_PENDING', putawayModeCode: null });
    expect([...rows.values()].some((row) => row.stageCode === 'RECEIPT_READY' || row.nextActionCode === 'POST_RECEIPT')).toBe(false);
  });

  it('D-4 입고 상세·라인이 적치 방식을 싣는다', async () => {
    const line = await prisma.goods_receipt_line.findFirstOrThrow({ where: { lot_id: BigInt(il1[8].lotId) } });
    const detail = await request(app.getHttpServer()).get(`/api/logistics/goods-receipts/${String(line.goods_receipt_id)}`).set('Cookie', cookie).expect(200);
    expect(detail.body.lines[0]).toMatchObject({ putawayModeCode: 'TEMPORARY', putawayTaskId: null });
    const lines = await request(app.getHttpServer()).get(`/api/logistics/goods-receipts/${String(line.goods_receipt_id)}/lines`).set('Cookie', cookie).expect(200);
    expect(lines.body.items[0]).toMatchObject({ putawayModeCode: 'TEMPORARY' });
  });

  it('Q21 R-2 SC-001 옛 관리웹 입고 처리로 구매 입하 LOT 을 보내면 409 USE_PDA_PUTAWAY', async () => {
    const lot = il1[9];
    const response = await request(app.getHttpServer()).post('/api/logistics/goods-receipts').set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx))
      .send({
        receiptTypeCode: 'MATERIAL', plantId: Number(ids.p1), warehouseId: Number(ids.a), receiptDatetime: AT, businessDate: DAY,
        lines: [{ itemId: Number(ids.x), lotId: lot.lotId, receiptQty: lot.lotQty, uomId: Number(ids.ea), qualityStatusCode: 'NORMAL',
          inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(ids.ASTAGING) }],
      }).expect(409);
    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'lines[0].lotId', code: 'USE_PDA_PUTAWAY' })]);
    const defaults = await request(app.getHttpServer()).get('/api/logistics/goods-receipts:defaults').query({ lotIds: String(lot.lotId) }).set('Cookie', cookie).expect(200);
    expect(defaults.body.items[0].issues).toEqual([expect.objectContaining({ code: 'USE_PDA_PUTAWAY' })]);
  });

  it('US5-7 D-11 PDA 배지 putaway = PENDING 지시 + 적치 대기 LOT', async () => {
    const counts = (await request(app.getHttpServer()).get('/api/app/terminal-work-counts').set('Authorization', `Bearer ${mobile}`).expect(200)).body as { putaway: number };
    const pending = (await asMobile(request(app.getHttpServer()).get(LIST)).expect(200)).body.page.total as number;
    const tasks = (await asMobile(request(app.getHttpServer()).get('/api/logistics/putaway-tasks').query({ statusCode: 'PENDING', size: 100 })).expect(200)).body.page.total as number;
    expect(tasks).toBe(1);
    expect(counts.putaway).toBe(pending + tasks);
  });

  // ── 도우미 ─────────────────────────────────────────────────────

  async function purchaseOrder(supplier: bigint, item: bigint, qty: number): Promise<bigint> {
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-1`, supplier_id: supplier, business_unit_id: ids.unit, plant_id: ids.p1,
        order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
      },
    });
    await prisma.purchase_order_line.create({
      data: { purchase_order_id: order.purchase_order_id, line_no: 1, item_id: item, uom_id: ids.ea, ordered_qty: qty, received_qty: 0 },
    });
    return order.purchase_order_id;
  }

  function putaway(lotId: number, body: Record<string, unknown>, key = idempotencyKey(fx)): request.Test {
    return asMobile(request(app.getHttpServer()).post(`${LIST}/${String(lotId)}:putaway`)).set('Idempotency-Key', key)
      .send({ businessDate: DAY, occurredAt: AT, ...body });
  }

  function temporary(lotId: number, body: Record<string, unknown>): request.Test {
    return asMobile(request(app.getHttpServer()).post(`${LIST}/${String(lotId)}:putaway-temporary`)).set('Idempotency-Key', idempotencyKey(fx))
      .send({ businessDate: DAY, occurredAt: AT, ...body });
  }

  async function itemsOf(locationId: bigint): Promise<bigint[]> {
    return (await prisma.location_item.findMany({ where: { location_id: locationId }, orderBy: { item_id: 'asc' } })).map((row) => row.item_id);
  }

  function asMobile(test: request.Test): request.Test {
    return test.set('Authorization', `Bearer ${mobile}`).set('X-Worker-No', WORKER_NO);
  }

  async function lookup(lotNo: string): Promise<LookupBody> {
    return (await asMobile(request(app.getHttpServer()).get(LOOKUP).query({ lotNo })).expect(200)).body as LookupBody;
  }

  async function check(lotId: number, locationCode: string): Promise<Record<string, unknown>> {
    return (await asMobile(request(app.getHttpServer()).get(`${LIST}/${String(lotId)}/location-check`).query({ locationCode })).expect(200)).body as Record<string, unknown>;
  }

  function batch(supplier: bigint, item: bigint, lotCount: number) {
    return { plantId: Number(ids.p1), supplierId: Number(supplier), itemId: Number(item), lotQty: 10, lotCount };
  }

  async function passed(supplier: bigint, item: bigint, lotCount: number): Promise<IssuedMaterialLot[]> {
    const { inboundLot } = await issueAndReceive(fx, batch(supplier, item, lotCount));
    return passInboundLotIqc(fx, inboundLot.inboundLotId);
  }

  async function closedLots(supplier: bigint, item: bigint, lotCount: number): Promise<IssuedMaterialLot[]> {
    const { inboundLot, lots } = await issueAndReceive(fx, batch(supplier, item, lotCount));
    await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    return lots;
  }

  let directSeq = 0;
  /** 입하 LOT 없는 LOT — 이전 흐름(입하 줄에서 온 LOT)·제품 LOT·처분 LOT. 입하 줄은 공장마다 하나를 함께 쓴다. */
  async function directLot(plant: bigint, tag: string, source: string, status: string, item: bigint): Promise<{ lotId: bigint; lotNo: string }> {
    directSeq += 1;
    const header = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-${String(directSeq)}`, supplier_id: ids.s1, plant_id: plant, receipt_datetime: new Date(), status_code: 'REGISTERED' },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: { inbound_receipt_id: header.inbound_receipt_id, line_no: 1, item_id: item, received_qty: 10, uom_id: ids.ea,
        supplier_lot_missing: false, supplier_lot_label_attached: true, inspection_required: false, status_code: 'REGISTERED' },
    });
    const lotNo = `${PREFIX}-${tag}`;
    const lot = await prisma.lot.create({
      data: { lot_no: lotNo, item_id: item, lot_type_code: 'MATERIAL', plant_id: plant, initial_qty: 10, uom_id: ids.ea,
        source_type_code: source, source_id: source === 'INBOUND_RECEIPT_LINE' ? line.inbound_receipt_line_id : 1n, status_code: status },
    });
    return { lotId: lot.lot_id, lotNo };
  }

  async function terminalToken(type: 'POP' | 'MOBILE', plant: bigint): Promise<string> {
    terminalSeq += 1;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T${String(terminalSeq)}`, plant_id: plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(plant),
    });
  }

  async function warehouse(plant: bigint, key: string, isDefect = false): Promise<bigint> {
    const row = await prisma.warehouse.create({
      data: { plant_id: plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-WH${key}`, warehouse_name: `${PREFIX} 창고 ${key}`,
        warehouse_type_code: 'MATERIAL', management_level_code: 'LOCATION', is_defect: isDefect },
    });
    for (const system of await prisma.location.findMany({ where: { warehouse_id: row.warehouse_id, system_role_code: { not: null } } })) {
      const name = `${key}${system.system_role_code === 'WAREHOUSE_WHOLE' ? 'WHOLE' : 'STAGING'}`;
      codes[name] = system.location_code;
      ids[name] = system.location_id;
    }
    return row.warehouse_id;
  }

  async function location(wh: bigint, key: string, name: string, parent: bigint | null = null, items: bigint[] = [], active = true): Promise<bigint> {
    const row = await prisma.location.create({
      data: { warehouse_id: wh, location_code: `${PREFIX}-${key}`, location_name: name, parent_location_id: parent, is_active: active },
    });
    for (const item of items) await prisma.location_item.create({ data: { location_id: row.location_id, item_id: item } });
    ids[key] = row.location_id;
    codes[key] = row.location_code;
    return row.location_id;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '적치법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '적치사업부' },
    })).business_unit_id;
    for (const plant of ['p1', 'p2']) {
      ids[plant] = (await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-${plant.toUpperCase()}`, plant_name: `적치공장 ${plant}`, timezone_code: TZ },
      })).plant_id;
    }
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    for (const [key, inspection] of [['x', true], ['y', false], ['z', false]] as const) {
      ids[key] = (await prisma.item.create({
        data: { item_code: `${PREFIX}-${key.toUpperCase()}`, item_name: `적치자재 ${key.toUpperCase()}`, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: inspection },
      })).item_id;
    }
    for (let index = 1; index <= 9; index += 1) {
      ids[`s${String(index)}`] = (await prisma.partner.create({
        data: { partner_code: `${PREFIX}-S${String(index)}`, partner_name: `${PREFIX} 공급사 ${String(index)}`, erp_partner_code: `S900${String(index)}` },
      })).partner_id;
    }
    for (const plant of [ids.p1, ids.p2]) {
      await prisma.worker.create({
        data: { worker_no: plant === ids.p1 ? WORKER_NO : `${PREFIX}-W1P2`, worker_name: '적치작업자', business_unit_id: ids.unit, plant_id: plant, status_code: 'EMPLOYED' },
      });
    }
    ids.a = await warehouse(ids.p1, 'A');
    ids.b = await warehouse(ids.p1, 'B');
    ids.d = await warehouse(ids.p1, 'D', true);
    ids.c = await warehouse(ids.p2, 'C');
    ids.e = await warehouse(ids.p1, 'E');
    await prisma.warehouse.update({ where: { warehouse_id: ids.e }, data: { is_active: false } });
    const zone = await location(ids.a, 'Z01', 'Z01 구역');
    await location(ids.a, 'R1', 'R1 랙', zone, [ids.x]);
    await location(ids.a, 'R2', 'R2 랙', zone);
    await location(ids.a, 'R3', 'R3 랙', zone, [ids.y]);
    await location(ids.a, 'R4', 'R4 랙', zone);
    await location(ids.a, 'R5', 'R5 랙', zone, [ids.y]);
    await location(ids.a, 'R6', 'R6 랙', zone, [ids.y]);
    await location(ids.a, 'R7', 'R7 랙', zone, [ids.x], false);
    await location(ids.d, 'D1', 'D1 랙', null, [ids.x]);
    await location(ids.c, 'C1', 'C1 랙', null, [ids.x]);
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `적치 ${suffix}`, status_code: 'EMPLOYED' } });
    ids.user ??= user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `적치 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    const warehouses = `SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const inboundLots = `SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants})`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (${items})`;
    const results = `SELECT inspection_result_id FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`;
    const goodsReceipts = `SELECT goods_receipt_id FROM logistics.goods_receipt WHERE plant_id IN (${plants})`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))
         OR (aggregate_type_code = 'INBOUND_LOT' AND aggregate_id IN (${inboundLots}))
         OR (aggregate_type_code = 'LOT' AND aggregate_id IN (${lots}))
         OR (aggregate_type_code = 'GOODS_RECEIPT' AND aggregate_id IN (${goodsReceipts}))`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const receiptKeys = `SELECT 'IF-GR-SEND:' || goods_receipt_no FROM logistics.goods_receipt WHERE plant_id IN (${plants})
      UNION ALL SELECT 'IF-GR-SEND:CANCEL:' || goods_receipt_no FROM logistics.goods_receipt WHERE plant_id IN (${plants})`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    await prisma.$executeRawUnsafe(`DELETE FROM integration.erp_outbound_row WHERE integration_message_id IN (
      SELECT integration_message_id FROM integration.integration_message WHERE message_key IN (${receiptKeys}))`);
    await prisma.$executeRawUnsafe(`DELETE FROM integration.integration_message WHERE message_key IN (${receiptKeys})`);
    await prisma.$executeRawUnsafe('TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.document_cancellation WHERE document_id IN (${goodsReceipts}) AND document_type_code = 'GOODS_RECEIPT'`,
      `DELETE FROM inventory.inventory_balance WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.putaway_task WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.lot_four_m_change WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.item_inspection_level_history WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN (${plants}))`,
      `DELETE FROM logistics.purchase_order WHERE plant_id IN (${plants})`,
      `DELETE FROM mdm.location_item WHERE item_id IN (${items})`,
      `DELETE FROM mdm.location WHERE warehouse_id IN (${warehouses}) AND parent_location_id IS NOT NULL`,
      `DELETE FROM mdm.location WHERE warehouse_id IN (${warehouses})`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM audit.audit_event WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      ...(keyList === '' ? [] : [`DELETE FROM app.idempotency_record WHERE idempotency_key IN (${keyList})`]),
      `DELETE FROM app.idempotency_record WHERE app_user_id IN (${users})`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (${roles})`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
