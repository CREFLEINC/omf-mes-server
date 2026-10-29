/**
 * 위치 계층 — 창고 › 구역 › 랙 › 층 › 셀(장부 P-154).
 *
 * 단계는 서버가 상위를 보고 정하고, 재고는 맨 아래 위치에만 둔다 — 재고가 있는 위치는 하위를 받지 않는다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-lochier-probe';
const PASSWORD = '위치-계층-검사-비밀번호';
const PREFIX = 'LOCHIER';
const ROLE = 'E2E_LOCHIER';

const key = (): string => randomUUID();

interface LocationBody {
  locationId: number;
  locationCode: string;
  locationLevelCode: string | null;
  isLeaf: boolean;
}

describe('위치 계층 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let warehouseId: number;
  let serial = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '계층검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '계층검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-06-07' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    warehouseId = await createWarehouse(`${PREFIX}-WH1`);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 상위가 없으면 구역 · 구역 밑 랙 · 랙 밑 층 · 층 밑 셀 — 단계는 서버가 정한다', async () => {
    const zone = await create();
    const rack = await create(zone.locationId);
    const level = await create(rack.locationId);
    const cell = await create(level.locationId);

    expect([zone, rack, level, cell].map((row) => row.locationLevelCode)).toEqual(['ZONE', 'RACK', 'LEVEL', 'CELL']);
  });

  it('⛔ 셀 밑에는 둘 수 없다 — 400 INVALID(parentLocationId)', async () => {
    const cell = await chain(4);

    const rejected = await send({ parentLocationId: cell.locationId }, 400);

    expect(rejected.errors).toEqual([expect.objectContaining({ field: 'parentLocationId', code: 'INVALID' })]);
  });

  it('⭐ 서버가 만든 자리는 구역이고 그 밑에는 둘 수 없다', async () => {
    const system = await prisma.location.findMany({
      where: { warehouse_id: warehouseId, NOT: { system_role_code: null } },
      select: { location_id: true, location_level_code: true },
    });
    expect(system.map((row) => row.location_level_code)).toEqual(['ZONE', 'ZONE']);

    for (const row of system) {
      const rejected = await send({ parentLocationId: Number(row.location_id) }, 400);
      expect(rejected.errors).toEqual([expect.objectContaining({ field: 'parentLocationId', code: 'INVALID' })]);
    }
  });

  it('⛔ 보낸 단계가 상위와 맞지 않으면 400 INVALID(locationLevelCode) · 맞으면 그대로 받는다', async () => {
    const zone = await create();

    const rejected = await send({ parentLocationId: zone.locationId, locationLevelCode: 'CELL' }, 400);
    expect(rejected.errors).toEqual([expect.objectContaining({ field: 'locationLevelCode', code: 'INVALID' })]);

    const accepted = await send({ parentLocationId: zone.locationId, locationLevelCode: 'RACK' }, 201);
    expect(accepted.locationLevelCode).toBe('RACK');
  });

  it('⛔ 재고가 있는 위치 밑에는 둘 수 없다 — 400 STATE_LOCKED(parentLocationId) · 재고가 0 이면 된다', async () => {
    const zone = await create();
    const balanceId = await stock(zone.locationId, 5);

    const rejected = await send({ parentLocationId: zone.locationId }, 400);
    expect(rejected.errors).toEqual([expect.objectContaining({ field: 'parentLocationId', code: 'STATE_LOCKED' })]);

    await prisma.inventory_balance.update({ where: { inventory_balance_id: balanceId }, data: { on_hand_qty: 0 } });
    await send({ parentLocationId: zone.locationId }, 201);
  });

  it('⛔ 재고가 있는 위치의 꺼진 하위는 켤 수 없다 — 400 STATE_LOCKED', async () => {
    const zone = await create();
    const rack = await create(zone.locationId);
    const off = await transition(rack.locationId, 'deactivate', 200);
    expect(off.isActive).toBe(false);
    await stock(zone.locationId, 3);

    const rejected = await transition(rack.locationId, 'activate', 400);

    expect(rejected.errors).toEqual([expect.objectContaining({ scope: 'screen', code: 'STATE_LOCKED' })]);
  });

  it('⛔ 상위는 바꿀 수 없다 — 다른 값이면 400 INVALID(parentLocationId) · 저장된 값을 실어 보내면 받는다', async () => {
    const zone = await create();
    const otherZone = await create();
    const rack = await create(zone.locationId);

    const rejected = await update(rack.locationId, { parentLocationId: otherZone.locationId }, 400);
    expect(rejected.errors).toEqual([expect.objectContaining({ field: 'parentLocationId', code: 'INVALID' })]);
    const kept = await update(rack.locationId, { parentLocationId: zone.locationId, locationName: '고친 랙' }, 200);
    expect(kept).toMatchObject({ parentLocationId: zone.locationId, locationName: '고친 랙' });
  });

  it('⭐ 코드는 서버가 발행한다 — Z01 · Z01-R001 · -L01 · -C01 · 같은 상위 안 다음 번호 · 꺼진 번호도 다시 쓰지 않는다', async () => {
    const fresh = await createWarehouse(`${PREFIX}-WH2`);
    // 화면이 코드를 실어 보내도 쓰지 않는다.
    const zone = await send({ warehouseId: fresh, locationCode: 'MINE' }, 201);
    const rack = await send({ warehouseId: fresh, parentLocationId: zone.locationId }, 201);
    const level = await send({ warehouseId: fresh, parentLocationId: rack.locationId }, 201);
    const cell = await send({ warehouseId: fresh, parentLocationId: level.locationId }, 201);
    expect([zone, rack, level, cell].map((row) => row.locationCode))
      .toEqual(['Z01', 'Z01-R001', 'Z01-R001-L01', 'Z01-R001-L01-C01']);

    const second = await send({ warehouseId: fresh, parentLocationId: zone.locationId }, 201);
    await transition(second.locationId, 'deactivate', 200);
    const third = await send({ warehouseId: fresh, parentLocationId: zone.locationId }, 201);
    expect([second.locationCode, third.locationCode]).toEqual(['Z01-R002', 'Z01-R003']);
  });

  it('⭐ 목록을 상위·단계로 나눠 받는다', async () => {
    const fresh = await createWarehouse(`${PREFIX}-WH3`);
    const zone = await send({ warehouseId: fresh }, 201);
    const rack = await send({ warehouseId: fresh, parentLocationId: zone.locationId }, 201);
    await send({ warehouseId: fresh, parentLocationId: rack.locationId }, 201);

    const children = await list(fresh, { parentLocationId: String(zone.locationId) });
    expect(children.map((row) => row.locationId)).toEqual([rack.locationId]);
    const zones = await list(fresh, { locationLevelCode: 'ZONE' });
    expect(zones.map((row) => row.locationCode).sort()).toEqual(['SYS-STAGING', 'SYS-WHOLE', 'Z01']);
  });

  it('⭐ 목록·상세가 단계와 isLeaf 를 싣는다 — 하위를 끄면 다시 맨 아래다', async () => {
    const zone = await create();
    const rack = await create(zone.locationId);

    expect(await detail(zone.locationId)).toMatchObject({ locationLevelCode: 'ZONE', isLeaf: false });
    expect(await detail(rack.locationId)).toMatchObject({ locationLevelCode: 'RACK', isLeaf: true });
    const list = await request(app.getHttpServer())
      .get(`/api/mdm/locations?warehouseId=${warehouseId}&size=200`)
      .set('Cookie', cookie)
      .expect(200);
    const listed = (list.body.items as LocationBody[]).find((row) => row.locationId === zone.locationId);
    expect(listed).toMatchObject({ locationLevelCode: 'ZONE', isLeaf: false });

    await transition(rack.locationId, 'deactivate', 200);
    expect(await detail(zone.locationId)).toMatchObject({ isLeaf: true });
  });

  it('⭐ 랙 하나 만들기 — 랙 1 · 층 3 · 층마다 셀 2 를 한 번에, 코드는 {구역}-R001-L01-C01 꼴', async () => {
    const zone = await create();

    const rack = await buildRack(zone.locationId, 3, 2, 201);

    expect(rack).toMatchObject({ locationCode: `${zone.locationCode}-R001`, locationLevelCode: 'RACK', isLeaf: false });
    const levels = await childrenOf(rack.locationId as number);
    expect(levels.map((row) => row.location_code)).toEqual(['L01', 'L02', 'L03'].map((tail) => `${rack.locationCode}-${tail}`));
    const cells = await childrenOf(Number(levels[2].location_id));
    expect(cells.map((row) => [row.location_code, row.location_level_code]))
      .toEqual([[`${rack.locationCode}-L03-C01`, 'CELL'], [`${rack.locationCode}-L03-C02`, 'CELL']]);
  });

  it('⛔ 랙은 사람이 만든 켜진 구역 밑에만 — 랙 밑 · 서버가 만든 자리 밑 400 INVALID · 재고 있는 구역 400 STATE_LOCKED · 하나도 안 만든다', async () => {
    const zone = await create();
    const rack = await create(zone.locationId);
    const staging = await prisma.location.findFirstOrThrow({
      where: { warehouse_id: warehouseId, system_role_code: 'PUTAWAY_STAGING' },
      select: { location_id: true },
    });
    const stocked = await create();
    await stock(stocked.locationId, 4);
    const before = await prisma.location.count({ where: { warehouse_id: warehouseId } });

    for (const parent of [rack.locationId, Number(staging.location_id)]) {
      const rejected = await buildRack(parent, 2, 2, 400);
      expect(rejected.errors).toEqual([expect.objectContaining({ field: 'parentLocationId', code: 'INVALID' })]);
    }
    const full = await buildRack(stocked.locationId, 2, 2, 400);
    expect(full.errors).toEqual([expect.objectContaining({ field: 'parentLocationId', code: 'STATE_LOCKED' })]);
    expect(await prisma.location.count({ where: { warehouse_id: warehouseId } })).toBe(before);
  });

  it('⭐ 안 쓰인 위치는 밑의 위치까지 함께 지운다 — 지운 번호는 다시 발행된다', async () => {
    const zone = await create();
    const rack = await buildRack(zone.locationId, 2, 3, 201);

    await removeLocation(rack.locationId as number, 204);

    expect(await prisma.location.count({ where: { warehouse_id: warehouseId, location_code: { startsWith: rack.locationCode as string } } })).toBe(0);
    const again = await buildRack(zone.locationId, 1, 1, 201);
    expect(again.locationCode).toBe(rack.locationCode);
    await removeLocation(zone.locationId, 204);
    expect(await prisma.location.count({ where: { warehouse_id: warehouseId, location_code: { startsWith: zone.locationCode } } })).toBe(0);
  });

  it('⛔ 가지 안의 하나라도 쓰였으면 지우지 않는다 — 400 STATE_LOCKED · 하나도 안 지운다 · 서버가 만든 자리도 400', async () => {
    const zone = await create();
    const rack = await buildRack(zone.locationId, 1, 2, 201);
    const [level] = await childrenOf(rack.locationId as number);
    const [cell] = await childrenOf(Number(level.location_id));
    await stock(Number(cell.location_id), 0);

    const rejected = await removeLocation(zone.locationId, 400);

    expect(rejected.errors).toEqual([expect.objectContaining({ scope: 'screen', code: 'STATE_LOCKED' })]);
    expect(await prisma.location.count({ where: { warehouse_id: warehouseId, location_code: { startsWith: zone.locationCode } } })).toBe(5);
    const staging = await prisma.location.findFirstOrThrow({
      where: { warehouse_id: warehouseId, system_role_code: 'PUTAWAY_STAGING' },
      select: { location_id: true },
    });
    await removeLocation(Number(staging.location_id), 400);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function create(parentLocationId?: number): Promise<LocationBody> {
    return (await send(parentLocationId === undefined ? {} : { parentLocationId }, 201)) as unknown as LocationBody;
  }

  /** 구역부터 `depth` 단계 내려간 맨 아래 위치. */
  async function chain(depth: number): Promise<LocationBody> {
    let last = await create();
    for (let n = 1; n < depth; n += 1) last = await create(last.locationId);
    return last;
  }

  async function send(extra: Record<string, unknown>, expected: number): Promise<Record<string, unknown> & LocationBody> {
    serial += 1;
    const code = `${PREFIX}-${serial}`;
    const response = await request(app.getHttpServer())
      .post('/api/mdm/locations')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ warehouseId, locationName: code, ...extra })
      .expect(expected);
    return response.body as Record<string, unknown> & LocationBody;
  }

  async function update(
    locationId: number,
    extra: Record<string, unknown>,
    expected: number,
  ): Promise<Record<string, unknown>> {
    const current = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${locationId}`)
      .set('Cookie', cookie)
      .expect(200);
    const location = current.body.location as Record<string, unknown>;
    const response = await request(app.getHttpServer())
      .put(`/api/mdm/locations/${locationId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', current.headers.etag)
      .send({ locationName: location.locationName, ...extra })
      .expect(expected);
    return response.body as Record<string, unknown>;
  }

  async function transition(
    locationId: number,
    action: 'activate' | 'deactivate',
    expected: number,
  ): Promise<Record<string, unknown>> {
    const current = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${locationId}`)
      .set('Cookie', cookie)
      .expect(200);
    const response = await request(app.getHttpServer())
      .post(`/api/mdm/locations/${locationId}:${action}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', current.headers.etag)
      .expect(expected);
    return response.body as Record<string, unknown>;
  }

  async function buildRack(
    parentLocationId: number,
    levelCount: number,
    cellCountPerLevel: number,
    expected: number,
  ): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer())
      .post('/api/mdm/locations:rack')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ parentLocationId, levelCount, cellCountPerLevel })
      .expect(expected);
    return response.body as Record<string, unknown>;
  }

  async function removeLocation(locationId: number, expected: number): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer())
      .delete(`/api/mdm/locations/${locationId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(expected);
    return response.body as Record<string, unknown>;
  }

  function childrenOf(locationId: number): Promise<{ location_id: bigint; location_code: string; location_level_code: string | null }[]> {
    return prisma.location.findMany({
      where: { parent_location_id: locationId },
      select: { location_id: true, location_code: true, location_level_code: true },
      orderBy: { location_code: 'asc' },
    });
  }

  async function list(inWarehouse: number, query: Record<string, string>): Promise<LocationBody[]> {
    const response = await request(app.getHttpServer())
      .get('/api/mdm/locations')
      .query({ warehouseId: String(inWarehouse), size: '200', ...query })
      .set('Cookie', cookie)
      .expect(200);
    return response.body.items as LocationBody[];
  }

  async function detail(locationId: number): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/locations/${locationId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body.location as Record<string, unknown>;
  }

  /** 그 위치에 재고 한 행 — 잔량만 보면 되므로 LOT 없이 둔다. */
  async function stock(locationId: number, qty: number): Promise<bigint> {
    const warehouse = await prisma.warehouse.findUniqueOrThrow({
      where: { warehouse_id: warehouseId },
      include: { plant: { select: { legal_entity_id: true } } },
    });
    const item = await prisma.item.findUniqueOrThrow({ where: { item_code: `${PREFIX}-IT` } });
    const row = await prisma.inventory_balance.create({
      data: {
        legal_entity_id: warehouse.plant.legal_entity_id,
        business_unit_id: warehouse.business_unit_id,
        plant_id: warehouse.plant_id,
        warehouse_id: warehouse.warehouse_id,
        location_id: locationId,
        item_id: item.item_id,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        uom_id: item.base_uom_id,
        on_hand_qty: qty,
      },
    });
    return row.inventory_balance_id;
  }

  async function createWarehouse(warehouseCode: string): Promise<number> {
    const plant = await prisma.plant.findFirstOrThrow();
    const unit = await prisma.business_unit.findFirstOrThrow();
    const created = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: warehouseCode,
        warehouse_name: warehouseCode,
        warehouse_type_code: await firstCode('WAREHOUSE_TYPE'),
        management_level_code: 'WAREHOUSE',
      },
    });
    if (warehouseCode.endsWith('WH1')) {
      const uom = await prisma.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } });
      await prisma.item.create({
        data: { item_code: `${PREFIX}-IT`, item_name: '계층검사품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id },
      });
    }
    return Number(created.warehouse_id);
  }

  async function firstCode(groupCode: string): Promise<string> {
    const value = await prisma.code_value.findFirstOrThrow({
      where: { is_active: true, code_group: { group_code: groupCode } },
      orderBy: { display_order: 'asc' },
    });
    return value.code;
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

  async function cleanup(): Promise<void> {
    await prisma.inventory_balance.deleteMany({ where: { item: { item_code: `${PREFIX}-IT` } } });
    await prisma.item.deleteMany({ where: { item_code: `${PREFIX}-IT` } });
    // 자식 → 부모 순. 한 문장 안의 자기참조 FK 는 문장 끝에 본다.
    await prisma.location.deleteMany({
      where: { warehouse: { warehouse_code: { startsWith: PREFIX } }, NOT: { parent_location_id: null } },
    });
    await prisma.location.deleteMany({
      where: { warehouse: { warehouse_code: { startsWith: PREFIX } }, system_role_code: null },
    });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
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
