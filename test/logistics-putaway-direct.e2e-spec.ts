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
import { PrismaService } from '../src/prisma/prisma.service';
import {
  InboundLotFixture, IssuedMaterialLot, closeInboundLotFixture, issueAndReceive, passInboundLotIqc, sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'E9PD';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const LIST = '/api/logistics/putaway-pending-lots';
const LOOKUP = '/api/logistics/putaway-pending-lots:lookup';

interface PendingItem {
  lotId: number; lotNo: string; itemId: number; itemCode: string; qty: number; uomCode: string; lotStatusCode: string;
  inboundLotId?: number; inboundLotNo?: string; supplierName?: string; inboundClosedAt?: string;
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
    il1 = await passed(ids.s1, ids.x, 3);
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

  it('US1-1 Q1 US5-3 US5-7 단말 목록 — IL-1 3개·IL-2 2개(불량)·IL-5·이전 흐름 LOT, 입하 중·검사 대기·처분·제품·다른 공장 LOT 은 없다', async () => {
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

  // ── 도우미 ─────────────────────────────────────────────────────

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
      codes[`${key}${system.system_role_code === 'WAREHOUSE_WHOLE' ? 'WHOLE' : 'STAGING'}`] = system.location_code;
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
