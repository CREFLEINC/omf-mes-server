/**
 * 창고 배치도.
 *
 * 첫 저장 전에는 배치도 행이 없는데 계약은 `If-Match` 를 필수로 건다. 그 값을 어디서
 * 얻는가가 이 자원의 전부이고, 검사가 그 흐름을 처음부터 끝까지 한 번 돈다.
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

const LOGIN_ID = 'e2e-mdmlayout-probe';
const NOPERM_ID = 'e2e-mdmlayout-noperm';
const PASSWORD = '배치도-검사-비밀번호';
const PREFIX = 'MDMLAYOUT';
const ROLE = 'E2E_MDMLAYOUT';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('창고 배치도 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let warehouseId: number;
  let otherWarehouseId: number;
  let locationIds: number[];
  let outsiderLocationId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '배치도검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '배치도검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-CO-08' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    warehouseId = await createWarehouse(`${PREFIX}-WH1`);
    otherWarehouseId = await createWarehouse(`${PREFIX}-WH2`);
    locationIds = [
      await createLocation(warehouseId, `${PREFIX}-L1`),
      await createLocation(warehouseId, `${PREFIX}-L2`),
    ];
    outsiderLocationId = await createLocation(otherWarehouseId, `${PREFIX}-L3`);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 배치도가 없어도 200 이다 — 이 자리의 404 는 «창고»가 없다는 뜻이다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/warehouses/{warehouseId}/layout');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // 「도면이 없으면 점만 온다」 — 계약이 그렇게 적었다.
    expect(response.body.markers).toEqual([]);
    expect(response.body.drawingAttachmentId).toBeUndefined();
    // ⛔ 저장 전에도 ETag 가 있어야 첫 PUT 의 If-Match 를 채울 수 있다.
    expect(response.headers.etag).toMatch(/^\d+$/);
  });

  it('⛔ 없는 창고는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/warehouses/999999999/layout')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⛔ 권한이 없으면 저장이 403 이다', async () => {
    const current = await getLayout();
    await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', current.etag)
      .send({ markers: [] })
      .expect(403);
  });

  it('⭐ 첫 저장이 조회의 ETag 로 돈다 — 그 값이 없으면 이 자원은 못 쓴다', async () => {
    const before = await getLayout();

    const saved = await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', before.etag)
      .send({
        drawingAttachmentId: 1001,
        markers: [
          { locationId: locationIds[0], x: 0.42, y: 0.18 },
          { locationId: locationIds[1], x: 0.9, y: 0.75 },
        ],
      })
      .expect(200);

    const validate = validator('PUT /mdm/warehouses/{warehouseId}/layout');
    expect(validate(saved.body)).toBe(true);
    expect(saved.body.markers).toHaveLength(2);
    expect(saved.body.drawingAttachmentId).toBe(1001);
    // 저장하면 ETag 가 «반드시» 바뀐다 — 같은 값으로 두 번 저장해 앞의 것을 덮지 못한다.
    expect(Number(saved.headers.etag)).toBe(Number(before.etag) + 1);

    const reread = await getLayout();
    expect(reread.body.markers).toEqual(saved.body.markers);
    expect(reread.etag).toBe(saved.headers.etag);
  });

  it('⛔ 낡은 If-Match 는 409 STALE_VERSION 이다', async () => {
    const stale = (await getLayout()).etag;
    await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', stale)
      .send({ markers: [] })
      .expect(200);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', stale)
      .send({ markers: [] })
      .expect(409);
    expect(rejected.body.errors[0].code).toBe('STALE_VERSION');
  });

  it('⭐ 저장은 통째로 바꾼다 — 점 하나만 보내면 나머지는 사라진다', async () => {
    const before = await getLayout();
    await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', before.etag)
      .send({
        markers: [
          { locationId: locationIds[0], x: 0.1, y: 0.1 },
          { locationId: locationIds[1], x: 0.2, y: 0.2 },
        ],
      })
      .expect(200);

    const shrunk = await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', (await getLayout()).etag)
      .send({ markers: [{ locationId: locationIds[0], x: 0.5, y: 0.5 }] })
      .expect(200);

    expect(shrunk.body.markers).toEqual([{ locationId: locationIds[0], x: 0.5, y: 0.5 }]);
  });

  it('⛔ 다른 창고의 위치는 찍을 수 없다 — jsonb 라 FK 가 없다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', (await getLayout()).etag)
      .send({ markers: [{ locationId: outsiderLocationId, x: 0.5, y: 0.5 }] })
      .expect(400);

    expect(rejected.body.errors).toEqual([
      {
        scope: 'field',
        field: 'markers[0].locationId',
        code: 'INVALID',
        message: expect.any(String),
      },
    ]);
  });

  it('⛔ 같은 위치를 두 번 찍으면 몇 번째인지 짚는다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', (await getLayout()).etag)
      .send({
        markers: [
          { locationId: locationIds[0], x: 0.1, y: 0.1 },
          { locationId: locationIds[0], x: 0.9, y: 0.9 },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'markers[1].locationId',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['locationId'],
    });
  });

  it('⛔ 좌표는 도면 비율이다 — 1 을 넘으면 계약 검증이 거른다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', (await getLayout()).etag)
      .send({ markers: [{ locationId: locationIds[0], x: 1.5, y: 0.5 }] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'markers[0].x', code: 'RANGE' });
  });

  it('⛔ 거절된 저장은 아무것도 바꾸지 않는다 — 한 트랜잭션이다', async () => {
    const before = await getLayout();

    await request(app.getHttpServer())
      .put(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', before.etag)
      .send({ markers: [{ locationId: outsiderLocationId, x: 0.5, y: 0.5 }] })
      .expect(400);

    const after = await getLayout();
    expect(after.etag).toBe(before.etag);
    expect(after.body.markers).toEqual(before.body.markers);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function getLayout(): Promise<{ etag: string; body: { markers: unknown[] } }> {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/warehouses/${warehouseId}/layout`)
      .set('Cookie', cookie)
      .expect(200);
    return { etag: response.headers.etag, body: response.body };
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
        management_level_code: await firstCode('MANAGEMENT_LEVEL'),
      },
    });
    return Number(created.warehouse_id);
  }

  async function createLocation(inWarehouse: number, locationCode: string): Promise<number> {
    const created = await prisma.location.create({
      data: {
        warehouse_id: inWarehouse,
        location_code: locationCode,
        location_name: locationCode,
        location_type_code: await firstCode('LOCATION_TYPE'),
      },
    });
    return Number(created.location_id);
  }

  async function firstCode(groupCode: string): Promise<string> {
    const value = await prisma.code_value.findFirstOrThrow({
      where: { is_active: true, code_group: { group_code: groupCode } },
      orderBy: { display_order: 'asc' },
    });
    return value.code;
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
    const warehouses = await prisma.warehouse.findMany({
      where: { warehouse_code: { startsWith: PREFIX } },
      select: { warehouse_id: true },
    });
    const ids = warehouses.map((w) => w.warehouse_id);
    await prisma.warehouse_layout.deleteMany({ where: { warehouse_id: { in: ids } } });
    await prisma.location.deleteMany({ where: { warehouse_id: { in: ids } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
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
