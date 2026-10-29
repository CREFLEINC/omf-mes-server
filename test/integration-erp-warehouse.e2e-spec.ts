/**
 * ERP 창고 목록(장부 P-147) — ERP 창고는 공통코드 SL_TYPE 으로 오고 공장이 없다. 그래서 ERP 코드마다 한 줄을 내고
 * 같은 코드의 MES 창고를 짝지어 싣는다. 짝이 없으면 「MES 창고 없음」이고 사람이 공장을 골라 만든다(사용자 결정 2026-10-29).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-ERPWH';
const PATH = '/api/integration/erp-sync/warehouses';
const PAIRED = `${PREFIX}-A`;
const UNPAIRED = `${PREFIX}-B`;
const STOPPED = `${PREFIX}-OFF`;

describe('ERP 창고 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cookies: Record<string, string> = {};
  let plantId = 0;
  let warehouseId = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    for (const [name, permission] of [['operator', 'W-06-10'], ['none', undefined]] as const) {
      const user = await prisma.app_user.create({
        data: { login_id: `${PREFIX}-${name}`, user_name: PREFIX, status_code: 'EMPLOYED' },
      });
      if (permission !== undefined) {
        const role = await prisma.role.create({ data: { role_code: `${PREFIX}-${name}`, role_name: PREFIX } });
        await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
        await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
      }
      cookies[name] = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
    }

    const group = await prisma.code_group.upsert({
      where: { group_code: 'SL_TYPE' },
      update: {},
      create: { group_code: 'SL_TYPE', group_name: '창고구분', is_system_owned: true },
    });
    for (const [code, active] of [[PAIRED, true], [UNPAIRED, true], [STOPPED, false]] as const) {
      await prisma.code_value.create({
        data: { code_group_id: group.code_group_id, code, code_name: `${code} 창고`, is_active: active },
      });
    }
    const plant = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    plantId = Number(plant.plant_id);
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: PAIRED,
        warehouse_name: 'MES 이름',
        warehouse_type_code: 'GENERAL',
        management_level_code: 'WAREHOUSE',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  const list = (query: Record<string, string>, cookie = cookies.operator) =>
    request(app.getHttpServer()).get(PATH).query({ q: PREFIX, ...query }).set('Cookie', cookie);
  const codes = (body: { items: { erpWarehouseCode: string }[] }): string[] =>
    body.items.map((item) => item.erpWarehouseCode);

  it('⛔ 로그인이 없으면 401 · 연계 메시지를 볼 권한이 없으면 403 이다', async () => {
    await request(app.getHttpServer()).get(PATH).expect(401);
    const denied = await list({}, cookies.none).expect(403);
    expect(denied.body.errors[0]).toMatchObject({ scope: 'screen', code: 'PERMISSION_DENIED' });
  });

  it('⭐ ERP 창고마다 한 줄이고 같은 코드의 MES 창고를 싣는다 — 없으면 null(「MES 창고 없음」)', async () => {
    const response = await list({}).expect(200);

    expect(response.body.items).toEqual([
      {
        erpWarehouseCode: PAIRED,
        erpWarehouseName: `${PAIRED} 창고`,
        erpActive: true,
        erpUpdatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        mesWarehouse: {
          warehouseId,
          plantId,
          plantCode: expect.any(String),
          plantName: expect.any(String),
          warehouseName: 'MES 이름',
          isActive: true,
        },
      },
      expect.objectContaining({ erpWarehouseCode: UNPAIRED, mesWarehouse: null }),
    ]);
    expect(response.body.page).toMatchObject({ page: 1, total: 2 });
  });

  it('⭐ ERP 에서 끈 창고는 includeInactive=true 일 때만 나온다 — MES 창고는 건드리지 않는다', async () => {
    const response = await list({ includeInactive: 'true' }).expect(200);

    expect(codes(response.body)).toEqual([PAIRED, UNPAIRED, STOPPED]);
    expect(response.body.items[2]).toMatchObject({ erpActive: false, mesWarehouse: null });
  });

  it('⭐ paired=false 는 MES 창고가 없는 것만 · paired=true 는 있는 것만 낸다', async () => {
    expect(codes((await list({ paired: 'false' }).expect(200)).body)).toEqual([UNPAIRED]);
    expect(codes((await list({ paired: 'true' }).expect(200)).body)).toEqual([PAIRED]);
  });

  it('⭐ plantId 는 짝 MES 창고의 공장이다', async () => {
    expect(codes((await list({ plantId: String(plantId) }).expect(200)).body)).toEqual([PAIRED]);
    expect(codes((await list({ plantId: '999999999' }).expect(200)).body)).toEqual([]);
  });

  it('⛔ 틀린 질의는 무시하지 않고 400 이다 — 걸러지지 않은 목록이 걸러진 것처럼 보인다', async () => {
    const response = await list({ paired: 'yes', includeInactive: '1', plantId: 'abc' }).expect(400);

    expect(response.body.errors.map((error: { field: string }) => error.field).sort()).toEqual([
      'includeInactive',
      'paired',
      'plantId',
    ]);
  });

  async function cleanup(): Promise<void> {
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.code_value.deleteMany({ where: { code: { startsWith: PREFIX }, code_group: { group_code: 'SL_TYPE' } } });
    const roles = { role_code: { startsWith: `${PREFIX}-` } };
    await prisma.user_role.deleteMany({ where: { role: roles } });
    await prisma.role_permission.deleteMany({ where: { role: roles } });
    await prisma.role.deleteMany({ where: roles });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
