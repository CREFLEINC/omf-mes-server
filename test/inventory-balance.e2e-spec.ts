/**
 * 재고 잔액 — 원장의 「지금」.
 *
 * ⭐ 마지막 검사가 이 스위트의 목적이다: **`balance = 트랜잭션의 합`**. 전략 문서가 코어
 * 불변식으로 적은 것을 계약 경로로 못 박는다.
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
import { InventoryPostingModule, InventoryPostingService } from '../src/core/inventory-posting';
import { PostingEndpoint, PostingInput } from '../src/core/inventory-posting/posting.types';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-invbal-probe';
const PASSWORD = '잔액-검사-비밀번호';
const PREFIX = 'INVBAL';
const ROLE = 'E2E_INVBAL';
const PERMISSIONS = ['W-01-07', 'M-01-04'];
const DAY = '2026-04-01';

/** 계약 응답에서 이 검사가 만지는 칸만 추린 형태. */
interface BalanceRow {
  groupBy: string;
  itemId: number;
  lotId: number | null;
  lotNo: string | null;
  warehouseId: number | null;
  locationCode: string | null;
  onHandQty: number;
  heldLotCount: number;
  earliestExpiryDate: string | null;
}
interface BalanceBody {
  items: BalanceRow[];
  page: { page: number; size: number; total: number };
  summary: { itemCount: number; lotCount: number; onHandQty: number; asOf: string };
  expiryUnknownCount: number;
  errors?: { field: string; code: string }[];
}

function validator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({
    $ref: 'https://omf-mes.invalid/contract#/paths/~1inventory~1balances/get/responses/200/content/application~1json/schema',
  });
}

describe('재고 잔액 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let posting: InventoryPostingService;
  let cookie: string[];
  const validate = validator();

  let plantId: number;
  let itemId: number;
  let uomId: number;
  let lotA: number;
  let lotB: number;
  let noExpiryLot: number;
  let hereA: PostingEndpoint;
  let hereB: PostingEndpoint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, InventoryPostingModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    posting = app.get(InventoryPostingService);

    await cleanup();
    await makeUsers();
    await makeMasters();
    await makeStock();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 창고·품목·LOT 이 다 비면 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .get('/api/inventory/balances')
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual([
      'warehouseId',
      'itemId',
      'lotId',
    ]);
  });

  it('⛔ 숫자 축에 글자가 오면 400 이다 — 500 으로 새지 않는다', async () => {
    await request(app.getHttpServer())
      .get('/api/inventory/balances?itemId=abc')
      .set('Cookie', cookie)
      .expect(400);
  });

  it('⛔ 정렬은 지정된 열만 받는다', async () => {
    const rejected = await list(`itemId=${itemId}&sort=onHandQty; DROP TABLE`, 400);
    expect(rejected.errors?.[0]).toMatchObject({ field: 'sort', code: 'INVALID' });
  });

  it('⭐ 기본은 품목으로 접는다 — 여러 LOT 이 한 줄이 된다', async () => {
    const body = await list(`itemId=${itemId}`);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ groupBy: 'ITEM', itemId, lotId: null, lotNo: null });
    // 10 + 6 + 4 = 20
    expect(body.items[0].onHandQty).toBe(20);
  });

  it('⭐ LOT 으로 접으면 LOT 마다 한 줄이고 lotNo 가 실린다', async () => {
    const body = await list(`itemId=${itemId}&groupBy=LOT`);
    expect(body.items).toHaveLength(3);
    const byLot = Object.fromEntries(body.items.map((r) => [r.lotId, r]));
    expect(byLot[lotA]).toMatchObject({ groupBy: 'LOT', onHandQty: 10, lotNo: `${PREFIX}-LOT-A` });
    expect(byLot[lotB].onHandQty).toBe(6);
  });

  it('⭐ 로케이션으로 접으면 위치마다 갈린다', async () => {
    const body = await list(`itemId=${itemId}&groupBy=LOCATION`);
    const warehouses = body.items.map((r) => r.warehouseId);
    expect(new Set(warehouses)).toEqual(new Set([hereA.warehouseId, hereB.warehouseId]));
    expect(body.items.every((r) => r.locationCode !== null)).toBe(true);
  });

  it('⭐ 창고로 좁히면 그 창고 것만 나온다', async () => {
    const body = await list(`warehouseId=${hereB.warehouseId}&groupBy=LOCATION`);
    expect(body.items.every((r) => r.warehouseId === hereB.warehouseId)).toBe(true);
  });

  it('⭐ 요약은 페이지가 아니라 필터 전체를 센다', async () => {
    const body = await list(`itemId=${itemId}&groupBy=LOT&size=1`);
    expect(body.items).toHaveLength(1);
    expect(body.page.total).toBe(3);
    // 요약은 쪽을 따르지 않는다.
    expect(body.summary).toMatchObject({ itemCount: 1, lotCount: 3, onHandQty: 20 });
  });

  it('⭐ asOf 는 서버 집계 시각이다', async () => {
    const before = Date.now();
    const body = await list(`itemId=${itemId}`);
    expect(Date.parse(body.summary.asOf)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('⭐ 잔액 0 은 기본으로 빠지고 includeZero 로 보인다', async () => {
    // B 창고의 재고를 전부 빼 0 으로 만든다.
    await post({
      transactionNo: `${PREFIX}-ZERO`,
      transactionTypeCode: 'ISSUE',
      sourceDocumentTypeCode: 'GOODS_ISSUE',
      lines: [{ itemId, lotId: lotB, qty: 6, uomId, from: hereB, ownershipTypeCode: 'OWNED' }],
    });

    const hidden = await list(`itemId=${itemId}&groupBy=LOT`);
    expect(hidden.items.map((r) => r.lotId)).not.toContain(lotB);

    const shown = await list(`itemId=${itemId}&groupBy=LOT&includeZero=true`);
    const zero = shown.items.find((r) => r.lotId === lotB);
    expect(zero?.onHandQty).toBe(0);
  });

  it('⭐ earliestExpiryDate 는 접힌 줄의 최솟값이다', async () => {
    // ⛔ includeZero 로 세 LOT 을 모두 세운다 — 앞선 검사가 무엇을 0 으로 만들었든
    // 결과가 같아야 한다(순서에 기대면 파일을 재배치하는 순간 조용히 깨진다).
    const folded = await list(`itemId=${itemId}&includeZero=true`);
    const perLot = await list(`itemId=${itemId}&groupBy=LOT&includeZero=true`);

    const earliest = perLot.items
      .map((r) => r.earliestExpiryDate)
      .filter((d): d is string => d !== null)
      .sort()[0];
    expect(folded.items[0].earliestExpiryDate).toBe(earliest);
    expect(earliest).toBe('2026-05-01');
  });

  it('⭐ 유효기한 없는 LOT 은 임박 필터에서 빠지고 expiryUnknownCount 로 세어진다', async () => {
    const near = await list(`itemId=${itemId}&groupBy=LOT&expiryDateTo=2026-12-31`);
    expect(near.items.map((r) => r.lotId)).not.toContain(noExpiryLot);
    // 「판정 불가」는 임박 필터를 빼고 센다 — 걸러낸 뒤 세면 언제나 0 이 된다.
    expect(near.expiryUnknownCount).toBe(1);
  });

  it('⭐ 유효기한 정렬이 판정 불가를 맨 뒤로 보낸다', async () => {
    const sorted = await list(`itemId=${itemId}&groupBy=LOT&sort=earliestExpiryDate`);
    expect(sorted.items[sorted.items.length - 1].lotId).toBe(noExpiryLot);
    expect(sorted.items[sorted.items.length - 1].earliestExpiryDate).toBeNull();
  });

  it('⭐ heldOnly 가 보류 LOT 을 가진 줄만 남긴다', async () => {
    const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    await prisma.lot_hold.create({
      data: {
        lot_id: lotA,
        reason_code: 'QUALITY',
        status_code: 'HELD',
        held_by: user.app_user_id,
        held_at: new Date(),
      },
    });

    const held = await list(`itemId=${itemId}&groupBy=LOT&heldOnly=true`);
    expect(held.items.map((r) => r.lotId)).toEqual([lotA]);
    expect(held.items[0].heldLotCount).toBe(1);

    const all = await list(`itemId=${itemId}&groupBy=LOT`);
    expect(all.items.length).toBeGreaterThan(1);
  });

  it('⭐ 원장 합계와 잔액이 같다 — balance = 트랜잭션의 합', async () => {
    const ledger = await prisma.$queryRawUnsafe<{ total: string }[]>(`
      SELECT coalesce(sum(
               CASE WHEN tl.to_warehouse_id IS NOT NULL THEN tl.qty ELSE 0 END
             - CASE WHEN tl.from_warehouse_id IS NOT NULL THEN tl.qty ELSE 0 END), 0) AS total
        FROM inventory.inventory_transaction_line tl
        JOIN mdm.item i ON i.item_id = tl.item_id
       WHERE i.item_code = '${PREFIX}-IT'`);

    const body = await list(`itemId=${itemId}&includeZero=true`);
    expect(Number(ledger[0].total)).toBe(body.summary.onHandQty);
    expect(body.items[0].onHandQty).toBe(body.summary.onHandQty);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function list(query: string, status = 200): Promise<BalanceBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/inventory/balances?${query}`)
      .set('Cookie', cookie)
      .expect(status);
    if (status === 200) {
      expect(validate(response.body)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
    }
    return response.body as BalanceBody;
  }

  async function post(
    over: Partial<PostingInput> & Pick<PostingInput, 'transactionNo' | 'lines'>,
  ): Promise<void> {
    const input: PostingInput = {
      businessDate: DAY,
      occurredAt: new Date(`${DAY}T02:00:00.000Z`),
      transactionTypeCode: 'RECEIPT',
      statusCode: 'POSTED',
      plantId,
      sourceDocumentTypeCode: 'GOODS_RECEIPT',
      sourceDocumentId: 1,
      idempotencyKey: `${PREFIX}-${randomUUID()}`,
      ...over,
    };
    await prisma.$transaction((tx) => posting.post(tx, input));
  }

  async function makeStock(): Promise<void> {
    await post({
      transactionNo: `${PREFIX}-GR1`,
      lines: [{ itemId, lotId: lotA, qty: 10, uomId, to: hereA, ownershipTypeCode: 'OWNED' }],
    });
    await post({
      transactionNo: `${PREFIX}-GR2`,
      lines: [{ itemId, lotId: lotB, qty: 6, uomId, to: hereB, ownershipTypeCode: 'OWNED' }],
    });
    await post({
      transactionNo: `${PREFIX}-GR3`,
      lines: [{ itemId, lotId: noExpiryLot, qty: 4, uomId, to: hereA, ownershipTypeCode: 'OWNED' }],
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '잔액검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '잔액검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '잔액검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '잔액검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    itemId = Number(item.item_id);

    lotA = await makeLot(item.item_id, plant.plant_id, uom.uom_id, 'A', '2026-06-01');
    lotB = await makeLot(item.item_id, plant.plant_id, uom.uom_id, 'B', '2026-05-01');
    noExpiryLot = await makeLot(item.item_id, plant.plant_id, uom.uom_id, 'N', null);

    hereA = await makeEndpoint(unit.business_unit_id, plant.plant_id, 'A');
    hereB = await makeEndpoint(unit.business_unit_id, plant.plant_id, 'B');
  }

  async function makeLot(
    item: bigint,
    plant: bigint,
    uom: bigint,
    suffix: string,
    expiry: string | null,
  ): Promise<number> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${suffix}`,
        item_id: item,
        lot_type_code: 'MATERIAL',
        plant_id: plant,
        initial_qty: 10,
        uom_id: uom,
        source_type_code: 'INBOUND_RECEIPT',
        source_id: 1,
        status_code: 'NORMAL',
        ...(expiry === null ? {} : { expiry_date: new Date(`${expiry}T00:00:00.000Z`) }),
      },
    });
    return Number(lot.lot_id);
  }

  async function makeEndpoint(
    businessUnitId: bigint,
    plantIdValue: bigint,
    suffix: string,
  ): Promise<PostingEndpoint> {
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plantIdValue,
        business_unit_id: businessUnitId,
        warehouse_code: `${PREFIX}-WH${suffix}`,
        warehouse_name: `잔액검사창고${suffix}`,
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC${suffix}`,
        location_name: `잔액검사위치${suffix}`,
        location_type_code: 'BIN',
      },
    });
    return {
      warehouseId: Number(warehouse.warehouse_id),
      locationId: Number(location.location_id),
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
    };
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '잔액검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '잔액검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — 수불 스위트와 같은 이유다. */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot_hold
       WHERE lot_id IN (SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
