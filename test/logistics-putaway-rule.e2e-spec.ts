/**
 * 적치 규칙.
 *
 * ⭐ 「규칙이 없는 품목」이 이 화면의 절반이다 — 등록된 것만 보이면 **비어 있다는 사실이
 * 어디에도 드러나지 않는다**(계약 · 공유계약 G-12). 규칙이 없으면 현장이 위치 검증 없이
 * 통과한다.
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
import { PUTAWAY_RULE_REFERRERS } from '../src/logistics/putaway/putaway-rule.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-putaway-probe';
const NOPERM_ID = 'e2e-putaway-noperm';
const PASSWORD = '적치규칙-검사-비밀번호';
const PREFIX = 'E2E_PUTAWAY';
const ROLE = 'E2E_PUTAWAY_ROLE';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const status = method === 'POST' && !path.includes(':') ? '201' : '200';
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('적치 규칙 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let warehouseId = 0;
  let otherWarehouseId = 0;
  let locationId = 0;
  let foreignLocationId = 0;
  let uomId = 0;
  let plantId = 0;
  let itemIds: number[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '적치검사', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '적치검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-14' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();

    const plant = await prisma.plant.findFirstOrThrow({ select: { plant_id: true } });
    plantId = Number(plant.plant_id);
    // ⚠ plant.business_unit_id 는 nullable 이라 창고의 NOT NULL 을 못 채운다 — 따로 읽는다.
    const businessUnitId = (
      await prisma.business_unit.findFirstOrThrow({ select: { business_unit_id: true } })
    ).business_unit_id;
    uomId = Number((await prisma.uom.findFirstOrThrow({ select: { uom_id: true } })).uom_id);

    warehouseId = await createWarehouse('W1', businessUnitId);
    otherWarehouseId = await createWarehouse('W2', businessUnitId);
    locationId = await createLocation(warehouseId, 'L1');
    foreignLocationId = await createLocation(otherWarehouseId, 'L2');

    itemIds = [];
    for (let i = 0; i < 3; i += 1) itemIds.push(await createItem(`I${i}`));
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 참조 목록이 DB 의 FK 와 정확히 같다', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table: string; column: string }[]>(`
      SELECT n.nspname || '.' || r.relname AS "table",
             (SELECT a.attname FROM unnest(c.conkey) k
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS "column"
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.confrelid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND tn.nspname = 'logistics' AND t.relname = 'putaway_rule'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(PUTAWAY_RULE_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
  });

  it('등록·목록·상세가 계약 스키마를 만족하고 상세가 ETag 를 준다', async () => {
    const id = await create(itemIds[0], { locationId });

    const list = await request(app.getHttpServer())
      .get(`/api/logistics/putaway-rules?warehouseId=${warehouseId}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /logistics/putaway-rules');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/logistics/putaway-rules/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /logistics/putaway-rules/{putawayRuleId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.headers.etag).toBe('1');
    expect(detail.body.putawayRule).toMatchObject({ locationId, priorityNo: 100 });
  });

  it('⛔ 같은 품목·창고·위치 조합은 두 번 등록되지 않는다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/logistics/putaway-rules')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ itemId: itemIds[0], warehouseId, locationId, capacityQty: 10, uomId })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['itemId', 'warehouseId', 'locationId'],
    });
  });

  it('⛔ 남의 창고 위치는 400 이다 — 현장이 갈 곳이 없다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/logistics/putaway-rules')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        itemId: itemIds[1],
        warehouseId,
        locationId: foreignLocationId,
        capacityQty: 10,
        uomId,
      })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'locationId', code: 'INVALID' });
  });

  it('⛔ 수용량 0 은 계약이 막는다 — 넣을 수 없는 규칙이다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/logistics/putaway-rules')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ itemId: itemIds[1], warehouseId, capacityQty: 0, uomId })
      .expect(400);
    expect(rejected.body.errors[0].code).toBe('RANGE');
  });

  it('⭐⭐ 같은 조합의 규칙은 «둘일 수 없다» — 중지된 것도 센다', async () => {
    const id = await create(itemIds[1], { priorityNo: 5 });

    // 중지해도 행은 남는다 — 물리 삭제가 없다.
    await request(app.getHttpServer())
      .post(`/api/logistics/putaway-rules/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(200);

    // ⛔ 그래서 같은 조합을 «새로» 만들 수 없다. uq_putaway_rule 이 부분 인덱스가 아니라
    // 활성 여부를 가리지 않기 때문이다 — 미리 안 보면 그 인덱스가 500 을 낸다.
    const rejected = await request(app.getHttpServer())
      .post('/api/logistics/putaway-rules')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ itemId: itemIds[1], warehouseId, capacityQty: 10, uomId })
      .expect(400);
    expect(rejected.body.errors[0].message).toContain('다시 사용');

    // 되살리는 것이 맞는 길이다.
    await request(app.getHttpServer())
      .post(`/api/logistics/putaway-rules/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '2')
      .expect(200);
  });

  it('⛔ 위치를 남의 규칙 자리로 옮길 수 없다 — 유일 인덱스가 그 조합을 막는다', async () => {
    // 같은 품목·창고에 「창고 수준(위치 없음)」과 「위치 지정」 둘을 세운다.
    const withLocation = await create(itemIds[0], { locationId: null, priorityNo: 9 });

    const rejected = await request(app.getHttpServer())
      .put(`/api/logistics/putaway-rules/${withLocation}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      // itemIds[0] 은 위 검사에서 (창고, locationId) 조합을 이미 쓰고 있다.
      .send({ locationId, capacityQty: 10, uomId })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['itemId', 'warehouseId', 'locationId'],
    });
  });

  it('⭐ 우선순위가 작을수록 먼저 나온다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/logistics/putaway-rules?warehouseId=${warehouseId}&includeInactive=true`)
      .set('Cookie', cookie)
      .expect(200);

    const priorities = list.body.items.map((r: { priorityNo: number }) => r.priorityNo);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it('⭐⭐ 규칙이 없는 품목을 창고 입고 이력에서 찾는다', async () => {
    // itemIds[2] 만 입고 이력을 만든다 — 규칙은 없다.
    await createReceipt(itemIds[2]);

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/putaway-rules/uncovered-items?warehouseId=${warehouseId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/putaway-rules/uncovered-items');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    expect(response.body.items.map((i: { itemId: number }) => i.itemId)).toEqual([itemIds[2]]);
    expect(response.body.items[0].lastReceivedAt).not.toBeNull();

    // 규칙을 세우면 목록에서 빠진다 — 「비어 있음」이 채워진 것이다.
    await create(itemIds[2], { locationId });
    const after = await request(app.getHttpServer())
      .get(`/api/logistics/putaway-rules/uncovered-items?warehouseId=${warehouseId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(after.body.items).toEqual([]);
  });

  it('⛔ 낡은 If-Match 는 409 이고 봉투는 ConflictResponse 다', async () => {
    const fresh = await createItem('IV');
    const id = await create(fresh, { locationId, priorityNo: 7 });

    await request(app.getHttpServer())
      .put(`/api/logistics/putaway-rules/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ capacityQty: 20, uomId, remarks: '한 번' })
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/logistics/putaway-rules/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ capacityQty: 30, uomId })
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⛔ 권한이 없으면 쓰기가 403 이고, 없는 규칙은 404 다', async () => {
    await request(app.getHttpServer())
      .post('/api/logistics/putaway-rules')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ itemId: itemIds[0], warehouseId: otherWarehouseId, capacityQty: 1, uomId })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/logistics/putaway-rules/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function create(
    itemId: number,
    extra: { locationId?: number | null; priorityNo?: number } = {},
  ): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/putaway-rules')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ itemId, warehouseId, capacityQty: 10, uomId, ...extra })
      .expect(201);
    const validate = validator('POST /logistics/putaway-rules');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body.putawayRuleId;
  }

  async function createWarehouse(suffix: string, businessUnitId: bigint): Promise<number> {
    const created = await prisma.warehouse.create({
      data: {
        plant_id: plantId,
        business_unit_id: businessUnitId,
        warehouse_code: `${PREFIX}-${suffix}`,
        warehouse_name: suffix,
        warehouse_type_code: 'MATERIAL',
        management_level_code: 'LOCATION',
      },
    });
    return Number(created.warehouse_id);
  }

  async function createLocation(inWarehouse: number, suffix: string): Promise<number> {
    const created = await prisma.location.create({
      data: {
        warehouse_id: inWarehouse,
        location_code: `${PREFIX}-${suffix}`,
        location_name: suffix,
        location_type_code: 'RACK',
      },
    });
    return Number(created.location_id);
  }

  async function createItem(suffix: string): Promise<number> {
    const created = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-${suffix}`,
        item_name: suffix,
        item_type_code: 'RAW',
        base_uom_id: uomId,
        lot_control_type_code: 'LOT',
      },
    });
    return Number(created.item_id);
  }

  /** 입고 이력을 세운다 — 창고 입고가 「규칙이 없는 품목」의 근거다. */
  async function createReceipt(itemId: number): Promise<void> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${itemId}`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 10,
        uom_id: uomId,
        source_type_code: 'RECEIPT',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    const receipt = await prisma.goods_receipt.create({
      data: {
        goods_receipt_no: `${PREFIX}-GR-${itemId}`,
        receipt_type_code: 'PURCHASE',
        plant_id: plantId,
        warehouse_id: warehouseId,
        receipt_datetime: new Date('2026-02-01T00:00:00.000Z'),
        status_code: 'COMPLETED',
      },
    });
    await prisma.goods_receipt_line.create({
      data: {
        goods_receipt_id: receipt.goods_receipt_id,
        line_no: 1,
        item_id: itemId,
        lot_id: lot.lot_id,
        receipt_qty: 10,
        uom_id: uomId,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        destination_location_id: locationId,
      },
    });
  }

  async function login(loginId: string = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    itemIds = [];
    const receipts = await prisma.goods_receipt.findMany({
      where: { goods_receipt_no: { startsWith: PREFIX } },
      select: { goods_receipt_id: true },
    });
    await prisma.goods_receipt_line.deleteMany({
      where: { goods_receipt_id: { in: receipts.map((r) => r.goods_receipt_id) } },
    });
    await prisma.goods_receipt.deleteMany({
      where: { goods_receipt_no: { startsWith: PREFIX } },
    });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });

    const items = await prisma.item.findMany({
      where: { item_code: { startsWith: PREFIX } },
      select: { item_id: true },
    });
    await prisma.putaway_rule.deleteMany({
      where: { item_id: { in: items.map((r) => r.item_id) } },
    });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });

    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
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
