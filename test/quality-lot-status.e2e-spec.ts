/**
 * `GET /quality/lot-statuses` (I-20 PR ①a1). `W-03-01`·`W-03-02`·`W-03-03` 이 함께 쓴다(§4-1).
 *
 * ⭐ 이 파일 하나가 이 PR 의 전건이다 — `lot-status-summary`(①a2)·`lot-status-transitions`(①c)
 * 는 여기 없다. LOT 갈래 7(L1~L7)은 슬라이스 계획 §8-1 을 그대로 쓴다(창고·수량 4칸을
 * `inventory_balance` 로 접는 §0 #5 · 정렬의 NULL 자리·2차 정렬 키 R-10 · 3값 논리 함정을
 * `EXISTS`/`NOT EXISTS` 로 피하는 §0 #5 를 전건 반증한다).
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

const LOGIN_ID = 'e2e-lot-status-probe';
const PASSWORD = 'LOT상태-검사-비밀번호';
const PREFIX = 'I20QA';
const ROLE = 'E2E_LOT_STATUS';
const PERMISSION = 'W-03-01';

// 최근 전이 시각 축 — 정렬·기간 경계 단언이 이 값들로 순서를 못 박는다(브리프 §7).
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';
const T4 = '2026-01-04T00:00:00.000Z';
const T5 = '2026-01-05T00:00:00.000Z';

function validator(status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8'),
  ) as object;
  const pointer = `/paths/~1quality~1lot-statuses/get/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface LotStatusItem {
  lotId: number;
  lotNo: string;
  itemId: number;
  lotTypeCode: string;
  lotStatusCode: string;
  versionNo: number;
  warehouseId?: number;
  locationId?: number;
  onHandQty?: number;
  heldQty?: number;
  availableQty?: number;
  uomId?: number;
  openHoldCount: number;
  fullyHeld: boolean;
  latestTransitionAt?: string;
  latestReasonCode?: string;
}
interface LotStatusListBody {
  items: LotStatusItem[];
  page: { page: number; size: number; total: number };
}

describe('LOT 품질 상태 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let plantId: number;
  let itemId: number;
  let uomId: number;
  let warehouse1Id: number;
  let location1Id: number;
  let warehouse2Id: number;
  let location2Id: number;

  const lotId: Record<string, number> = {};
  const lotNo: Record<string, string> = {
    L1: `${PREFIX}-LOT-G1`,
    L2: `${PREFIX}-LOT-F2`,
    L3: `${PREFIX}-LOT-E3`,
    L4: `${PREFIX}-LOT-D4`,
    L5: `${PREFIX}-LOT-C5`,
    L6: `${PREFIX}-LOT-B6`,
    L7: `${PREFIX}-LOT-A7`,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeUser();
    await makeLots();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록 — 기본 정렬이 latestTransitionDesc 다 (↩ 기본 sort 를 바꾸면 깨진다)', async () => {
    const body = await list(`plantId=${plantId}`);
    expect(body.items.map((i) => i.lotNo)).toEqual(
      ['L5', 'L4', 'L3', 'L2', 'L7', 'L6', 'L1'].map((k) => lotNo[k]),
    );
  });

  it('목록 — sort=lotNoAsc 가 서버 «전체»를 정렬한다(페이지 2에서 확인) (↩ 현재 페이지만 정렬하면 깨진다)', async () => {
    const body = await list(`plantId=${plantId}&sort=lotNoAsc&page=2&size=3`);
    expect(body.items.map((i) => i.lotNo)).toEqual(['L4', 'L3', 'L2'].map((k) => lotNo[k]));
  });

  it('목록 — 허용 밖 sort 는 400 INVALID (↩ enum 검증을 빼면 깨진다 · 계약 가드가 낸다)', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`/api/quality/lot-statuses?sort=없는정렬`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'sort', code: 'INVALID' });
  });

  it('목록 — 보류가 «없는» LOT(L6)이 excludeFullyHeld=true 에서 사라지지 않는다 · 전량 보류(L2·L4)는 사라진다 (↩ NOT EXISTS 를 nullable 조인 칸의 NOT(…) 으로 바꾸면 L6 이 사라진다)', async () => {
    const body = await list(`plantId=${plantId}&excludeFullyHeld=true`);
    const names = body.items.map((i) => i.lotNo);
    expect(names).toContain(lotNo.L6);
    expect(names).not.toContain(lotNo.L2);
    expect(names).not.toContain(lotNo.L4);
  });

  it('목록 — heldOnly=true 는 열린 보류가 있는 것만(L2·L3·L4) 이다 (↩ released_at 조건을 빼면 깨진다)', async () => {
    const body = await list(`plantId=${plantId}&heldOnly=true`);
    expect(body.items.map((i) => i.lotNo).sort()).toEqual(
      [lotNo.L2, lotNo.L3, lotNo.L4].sort(),
    );
  });

  it('목록 — 해제된 보류만 있는 L5 는 heldOnly 에서 빠진다 (↩ 위와 같은 자리)', async () => {
    const body = await list(`plantId=${plantId}&heldOnly=true`);
    expect(body.items.map((i) => i.lotNo)).not.toContain(lotNo.L5);
  });

  it('목록 — 창고가 둘인 L6 은 warehouseId·locationId 칸이 «없다» · 창고가 하나뿐인 L1 은 «있다» (↩ 첫 행을 고르게 바꾸면 L6 에 값이 생긴다)', async () => {
    const body = await list(`plantId=${plantId}`);
    const l6 = itemOf(body, lotNo.L6);
    const l1 = itemOf(body, lotNo.L1);
    expect(l6.warehouseId).toBeUndefined();
    expect(l6.locationId).toBeUndefined();
    expect(l1.warehouseId).toBe(warehouse1Id);
    expect(l1.locationId).toBe(location1Id);
  });

  it('목록 — 잔액 행이 0인 L7 도 나온다(LEFT JOIN) — onHandQty 키가 «없다» (↩ INNER JOIN 으로 바꾸면 L7 이 사라진다)', async () => {
    const body = await list(`plantId=${plantId}`);
    const l7 = itemOf(body, lotNo.L7);
    expect(l7).toBeDefined();
    expect(l7.onHandQty).toBeUndefined();
  });

  it('목록 — 전량 보류인 L2 는 heldQty 가 onHandQty 와 같다 (↩ SUM(hold_qty)(NULL→0)로 두면 0 이 나온다)', async () => {
    const body = await list(`plantId=${plantId}`);
    const l2 = itemOf(body, lotNo.L2);
    expect(l2.onHandQty).toBe(1000);
    expect(l2.heldQty).toBe(1000);
  });

  it('목록 — availableQty = onHandQty − heldQty 이고 blocked_qty 를 안 본다 (↩ inventory_balance.available_qty 를 그대로 실으면 다른 값이 나온다)', async () => {
    // L3 의 inventory_balance.blocked_qty=999(미끼) — inventory_balance 의 GENERATED
    // available_qty(=on_hand-reserved-picked-blocked=4000-999=3001)를 그대로 실으면
    // 이 값(3500=4000-500)과 달라져 이 단언이 잡는다.
    const body = await list(`plantId=${plantId}`);
    const l3 = itemOf(body, lotNo.L3);
    expect(l3.onHandQty).toBe(4000);
    expect(l3.heldQty).toBe(500);
    expect(l3.availableQty).toBe(3500);
  });

  it('목록 — fullyHeld 는 «해제되지 않은» 전량 보류만 본다(L5 는 false) (↩ released_at 조건을 빼면 L5 가 true 로 나온다)', async () => {
    const body = await list(`plantId=${plantId}`);
    expect(itemOf(body, lotNo.L2).fullyHeld).toBe(true);
    expect(itemOf(body, lotNo.L5).fullyHeld).toBe(false);
    expect(itemOf(body, lotNo.L3).fullyHeld).toBe(false);
  });

  it('목록 — versionNo 가 trace.lot.version_no 다(POST 본문에 그대로 실린다) (↩ 칸을 빼면 계약 required 위반)', async () => {
    const body = await list(`plantId=${plantId}`);
    expect(itemOf(body, lotNo.L1).versionNo).toBe(1);
  });

  it('목록 — transitionFrom 만 보내면 400 PAIR (↩ 쌍 검사를 빼면 깨진다)', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`/api/quality/lot-statuses?transitionFrom=${T1}`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'transitionTo', code: 'PAIR' });
  });

  it('목록 — transitionTo 와 «같은 시각»의 행은 빠진다(반열림) (↩ < 를 <= 로 바꾸면 L5 가 나온다)', async () => {
    const body = await list(
      `plantId=${plantId}&transitionFrom=${T1}&transitionTo=${T5}`,
    );
    const names = body.items.map((i) => i.lotNo);
    expect(names).toEqual(expect.arrayContaining([lotNo.L2, lotNo.L3, lotNo.L4]));
    expect(names).not.toContain(lotNo.L5);
    expect(names).not.toContain(lotNo.L1);
    expect(names).not.toContain(lotNo.L6);
    expect(names).not.toContain(lotNo.L7);
  });

  it('목록 — q 는 lot_no 부분 일치다(정확 일치가 아니다)', async () => {
    const body = await list(`plantId=${plantId}&q=E3`);
    expect(body.items.map((i) => i.lotNo)).toEqual([lotNo.L3]);
  });

  it('목록 — page.total 이 필터 전체 기준이다(페이지 안에서 세지 않는다)', async () => {
    const body = await list(`plantId=${plantId}&heldOnly=true&size=2&page=1`);
    expect(body.items).toHaveLength(2);
    expect(body.page.total).toBe(3);
  });

  it('목록·상세 — 계약 스키마를 통과한다(ajv)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-statuses?plantId=${plantId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator();
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function itemOf(body: LotStatusListBody, lotNoValue: string): LotStatusItem {
    const found = body.items.find((i) => i.lotNo === lotNoValue);
    if (!found) throw new Error(`픽스처 누락: ${lotNoValue}`);
    return found;
  }

  async function list(query: string): Promise<LotStatusListBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-statuses?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as LotStatusListBody;
  }

  async function login(): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'LOT상태검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'LOT상태검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: PERMISSION } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'LOT상태검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'LOT상태검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'LOT상태검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: 'LOT상태검사품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    itemId = Number(item.item_id);

    const wh1 = await prisma.warehouse.create({
      data: { plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH1`, warehouse_name: 'LOT상태검사창고1', warehouse_type_code: 'RAW', management_level_code: 'LOCATION' },
    });
    warehouse1Id = Number(wh1.warehouse_id);
    const loc1 = await prisma.location.create({
      data: { warehouse_id: wh1.warehouse_id, location_code: `${PREFIX}-LOC1`, location_name: 'LOT상태검사위치1', location_type_code: 'BIN' },
    });
    location1Id = Number(loc1.location_id);

    const wh2 = await prisma.warehouse.create({
      data: { plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH2`, warehouse_name: 'LOT상태검사창고2', warehouse_type_code: 'RAW', management_level_code: 'LOCATION' },
    });
    warehouse2Id = Number(wh2.warehouse_id);
    const loc2 = await prisma.location.create({
      data: { warehouse_id: wh2.warehouse_id, location_code: `${PREFIX}-LOC2`, location_name: 'LOT상태검사위치2', location_type_code: 'BIN' },
    });
    location2Id = Number(loc2.location_id);
  }

  /** LOT 갈래 7(계획 §8-1) — plant_code 접두어 `I20QA` 아래. */
  async function makeLots(): Promise<void> {
    lotId.L1 = await newLot('L1', 'NORMAL');
    lotId.L2 = await newLot('L2', 'INSPECTION_PENDING');
    lotId.L3 = await newLot('L3', 'INSPECTION_PENDING');
    lotId.L4 = await newLot('L4', 'DEFECTIVE');
    lotId.L5 = await newLot('L5', 'NORMAL');
    lotId.L6 = await newLot('L6', 'NORMAL');
    lotId.L7 = await newLot('L7', 'SCRAPPED');

    await newBalance(lotId.L1, warehouse1Id, location1Id, 4000);
    await newBalance(lotId.L2, warehouse1Id, location1Id, 1000);
    await newBalance(lotId.L3, warehouse1Id, location1Id, 4000, { blockedQty: 999 });
    await newBalance(lotId.L4, warehouse1Id, location1Id, 800);
    await newBalance(lotId.L5, warehouse1Id, location1Id, 2000);
    await newBalance(lotId.L6, warehouse1Id, location1Id, 300);
    await newBalance(lotId.L6, warehouse2Id, location2Id, 300);
    // L7 — 잔액 행 0 (LEFT JOIN 반증).

    // L2 — 전량 보류(열림) · INCOMING_INSPECTION_WAIT.
    await prisma.lot_hold.create({
      data: { lot_id: lotId.L2, reason_code: 'INCOMING_INSPECTION_WAIT', status_code: 'HELD', held_at: new Date(T2) },
    });
    // L3 — 부분 보류(열림 500).
    await prisma.lot_hold.create({
      data: { lot_id: lotId.L3, hold_qty: 500, uom_id: uomId, reason_code: 'DIMENSION_ABNORMAL', status_code: 'HELD', held_at: new Date(T3) },
    });
    // L4 — 전량 보류(열림) · CLAIM_RECALL.
    await prisma.lot_hold.create({
      data: { lot_id: lotId.L4, reason_code: 'CLAIM_RECALL', status_code: 'HELD', held_at: new Date(T4) },
    });
    // L5 — 전량 보류(해제됨). held=T1 · released=T5(경계값) — fullyHeld·기간 반열림 단언이 이 값을 쓴다.
    await prisma.lot_hold.create({
      data: {
        lot_id: lotId.L5,
        reason_code: 'APPEARANCE_ABNORMAL',
        status_code: 'HELD',
        held_at: new Date(T1),
        released_at: new Date(T5),
        release_reason_code: 'INVESTIGATION_CLEARED',
      },
    });
  }

  async function newLot(key: string, statusCode: string): Promise<number> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: lotNo[key],
        item_id: BigInt(itemId),
        lot_type_code: 'MATERIAL',
        plant_id: BigInt(plantId),
        initial_qty: 100,
        uom_id: BigInt(uomId),
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: BigInt(plantId),
        status_code: statusCode,
      },
    });
    return Number(lot.lot_id);
  }

  async function newBalance(
    forLotId: number,
    forWarehouseId: number,
    forLocationId: number,
    onHandQty: number,
    options: { blockedQty?: number } = {},
  ): Promise<void> {
    const plant = await prisma.plant.findUniqueOrThrow({ where: { plant_id: BigInt(plantId) } });
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: plant.legal_entity_id,
        business_unit_id: (await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: BigInt(forWarehouseId) } })).business_unit_id,
        plant_id: BigInt(plantId),
        warehouse_id: BigInt(forWarehouseId),
        location_id: BigInt(forLocationId),
        item_id: BigInt(itemId),
        lot_id: BigInt(forLotId),
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: onHandQty,
        blocked_qty: options.blockedQty ?? 0,
        uom_id: BigInt(uomId),
      },
    });
  }

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot_hold
       WHERE lot_id IN (SELECT lot_id FROM trace.lot
                         WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'))`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
