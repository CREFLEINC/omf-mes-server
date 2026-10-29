/**
 * 같은 창고 안 위치 이동 — `POST /logistics/location-moves`(사용자 결정 2026-10-29).
 *
 * ⚠ 원장은 지울 수 없어(append-only) LOT·위치·창고를 FK 로 잡는다 — 마스터는 코드로 찾아 다시 쓰고 LOT 은 시험마다 새로 세운다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-location-move-probe';
const PASSWORD = '위치이동-검사-비밀번호';
const PREFIX = 'LMVE2E';
const ROLE = 'LMVE2E-ROLE';
const RUN = Date.now().toString(36).toUpperCase();
const DAY = '2026-10-29';

interface MoveBody {
  stockTransfer: { stockTransferId: number; transferTypeCode: string; fromWarehouseId: number; toWarehouseId: number; receivedAt: string | null };
  lines: { lotId: number; fromLocationId: number; toLocationId: number; receivedQty: number }[];
}

describe('위치 이동 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
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
    await makeUser();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 같은 창고 안 A → B 를 한 번에 옮긴다 — 이동 전표 LOCATION_MOVE·도착 완료 · 원장 한 줄 · 잔액이 옮겨진다', async () => {
    const lot = await seedLot(10);

    const body = (await move([line(lot, ids.a, ids.b, 4)], 201)) as unknown as MoveBody;

    expect(body.stockTransfer).toMatchObject({
      transferTypeCode: 'LOCATION_MOVE',
      fromWarehouseId: Number(ids.warehouse),
      toWarehouseId: Number(ids.warehouse),
    });
    expect(body.stockTransfer.receivedAt).not.toBeNull();
    expect(body.lines).toEqual([
      expect.objectContaining({ lotId: Number(lot), fromLocationId: Number(ids.a), toLocationId: Number(ids.b), receivedQty: 4 }),
    ]);
    expect([await onHand(lot, ids.a), await onHand(lot, ids.b)]).toEqual([6, 4]);
    const ledger = await prisma.inventory_transaction_line.findMany({
      where: { lot_id: lot },
      select: { from_location_id: true, to_location_id: true, qty: true },
    });
    expect(ledger).toEqual([{ from_location_id: ids.a, to_location_id: ids.b, qty: expect.anything() }]);
  });

  // 하위가 있는 도착은 재고 코어가 막는다(`test/inventory-posting.e2e-spec.ts`).
  it('⛔ 다른 창고 위치 · 같은 위치는 400 INVALID — 잔액 그대로', async () => {
    const lot = await seedLot(10);

    const foreign = await move([line(lot, ids.a, ids.foreign, 1)], 400);
    expect(foreign.errors).toEqual([expect.objectContaining({ field: 'lines[0].toLocationId', code: 'INVALID' })]);
    const same = await move([line(lot, ids.a, ids.a, 1)], 400);
    expect(same.errors).toEqual([expect.objectContaining({ field: 'lines[0].toLocationId', code: 'INVALID' })]);
    expect(await onHand(lot, ids.a)).toBe(10);
  });

  it('⛔ 옮길 수 있는 수량(예약·피킹·보류를 뺀 수량)보다 많으면 400 NEGATIVE_BALANCE', async () => {
    const lot = await seedLot(10, 7);

    const rejected = await move([line(lot, ids.a, ids.b, 4)], 400);

    expect(rejected.errors).toEqual([expect.objectContaining({ field: 'lines[0].qty', code: 'NEGATIVE_BALANCE' })]);
    await move([line(lot, ids.a, ids.b, 3)], 201);
  });

  it('⛔ HU 에 담긴 LOT 은 400 STATE_LOCKED — 잔액만 옮기면 상자의 위치와 어긋난다', async () => {
    const lot = await seedLot(10);
    await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-HU-${RUN}-${seq}`,
        handling_unit_type_code: 'PALLET',
        status_code: 'PACKED',
        location_id: ids.a,
        handling_unit_content: { create: [{ item_id: ids.item, lot_id: lot, qty: 10, uom_id: ids.uom }] },
      },
    });

    const rejected = await move([line(lot, ids.a, ids.b, 1)], 400);

    expect(rejected.errors).toEqual([expect.objectContaining({ field: 'lines[0].lotId', code: 'STATE_LOCKED' })]);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function line(lotId: bigint, from: bigint, to: bigint, qty: number): Record<string, unknown> {
    return {
      lotId: Number(lotId),
      fromLocationId: Number(from),
      toLocationId: Number(to),
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
      qty,
    };
  }

  async function move(lines: Record<string, unknown>[], expected: number): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/location-moves')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ warehouseId: Number(ids.warehouse), businessDate: DAY, occurredAt: '2026-10-29T02:00:00Z', lines })
      .expect(expected);
    return response.body as Record<string, unknown>;
  }

  async function onHand(lotId: bigint, locationId: bigint): Promise<number> {
    const row = await prisma.inventory_balance.findFirst({
      where: { lot_id: lotId, location_id: locationId, quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE' },
      select: { on_hand_qty: true },
    });
    return row === null ? 0 : Number(row.on_hand_qty);
  }

  async function seedLot(qty: number, reserved = 0): Promise<bigint> {
    seq += 1;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${RUN}-${seq}`,
        item_id: ids.item,
        lot_type_code: 'PRODUCT',
        plant_id: ids.plant,
        initial_qty: qty,
        uom_id: ids.uom,
        source_type_code: 'SHIPMENT',
        source_id: 1n,
        status_code: 'NORMAL',
      },
    });
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: ids.legal,
        business_unit_id: ids.unit,
        plant_id: ids.plant,
        warehouse_id: ids.warehouse,
        location_id: ids.a,
        item_id: ids.item,
        lot_id: lot.lot_id,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        uom_id: ids.uom,
        on_hand_qty: qty,
        reserved_qty: reserved,
      },
    });
    return lot.lot_id;
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
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    Object.assign(ids, { plant: plant.plant_id, unit: unit.business_unit_id, legal: plant.legal_entity_id });
    const warehouse = (code: string) => ensure(prisma.warehouse, { warehouse_code: code }, {
      plant_id: plant.plant_id,
      business_unit_id: unit.business_unit_id,
      warehouse_code: code,
      warehouse_name: code,
      warehouse_type_code: 'FINISHED',
      management_level_code: 'WAREHOUSE',
    });
    const location = async (warehouseId: bigint, code: string): Promise<bigint> =>
      (await ensure(prisma.location, { warehouse_id: warehouseId, location_code: code }, {
        warehouse_id: warehouseId,
        location_code: code,
        location_name: code,
        location_level_code: 'ZONE',
      })).location_id;
    ids.warehouse = (await warehouse(`${PREFIX}-WH`)).warehouse_id;
    ids.a = await location(ids.warehouse, `${PREFIX}-A`);
    ids.b = await location(ids.warehouse, `${PREFIX}-B`);
    ids.foreign = await location((await warehouse(`${PREFIX}-WH2`)).warehouse_id, `${PREFIX}-X`);
    const uom = await prisma.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } });
    ids.uom = uom.uom_id;
    ids.item = (await ensure(prisma.item, { item_code: `${PREFIX}-IT` }, {
      item_code: `${PREFIX}-IT`, item_name: '위치이동검사품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id,
    })).item_id;
  }

  async function makeUser(): Promise<void> {
    const user = await ensure(prisma.app_user, { login_id: LOGIN_ID }, { login_id: LOGIN_ID, user_name: '위치이동프로브', status_code: 'EMPLOYED' });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '위치이동검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'M-01-10' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    // ⛔ 원장·이동 전표·LOT 은 안 지운다 — 원장이 append-only 이고 그것들을 FK 로 잡는다.
    await prisma.$executeRawUnsafe(`DELETE FROM inventory.handling_unit_content WHERE handling_unit_id IN (
      SELECT handling_unit_id FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'`);
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
