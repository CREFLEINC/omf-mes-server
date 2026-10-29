/**
 * 단말 창고(W-CO-06 · omf-all-around#190 · 장부 P-136) — 같은 공장의 사용 중인 창고만, 비울 수 있다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2EHOTW${randomUUID().slice(0, 6)}`;
const PATH = '/api/mdm/terminals';

describe('단말 창고 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const ids: Record<string, bigint> = {};
  const roleIds: bigint[] = [];
  const userIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    for (const key of ['plant1', 'plant2']) {
      ids[key] = (
        await prisma.plant.create({
          data: { plant_code: `${PREFIX}-${key}`, plant_name: `${PREFIX} ${key}`, legal_entity_id: base.legal_entity_id, business_unit_id: unit.business_unit_id, timezone_code: 'Asia/Ho_Chi_Minh' },
        })
      ).plant_id;
    }
    for (const [key, plant, active] of [['whA', ids.plant1, true], ['whOff', ids.plant1, false], ['whOther', ids.plant2, true]] as const) {
      ids[key] = (
        await prisma.warehouse.create({
          data: {
            plant_id: plant,
            business_unit_id: unit.business_unit_id,
            warehouse_code: `${PREFIX}-${key}`,
            warehouse_name: `${PREFIX} ${key}`,
            warehouse_type_code: 'MATERIAL',
            management_level_code: 'WAREHOUSE',
            is_active: active,
          },
        })
      ).warehouse_id;
    }
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}_A`, user_name: `${PREFIX} A`, status_code: 'EMPLOYED' } });
    userIds.push(user.app_user_id);
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_R`, role_name: '단말 창고 시험' } });
    roleIds.push(role.role_id);
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-CO-06' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
  });

  afterAll(async () => {
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plant_id: { in: [ids.plant1, ids.plant2] } } });
    await app.close();
  });

  it('US5-1 같은 공장 창고로 등록하면 응답·목록에 warehouseId·warehouseName 이 실린다', async () => {
    const created = await create('M1', { warehouseId: Number(ids.whA) }).expect(201);
    expect(created.body).toMatchObject({ warehouseId: Number(ids.whA), warehouseName: `${PREFIX} whA` });

    const list = await request(app.getHttpServer()).get(PATH).query({ plantId: Number(ids.plant1) }).set('Cookie', cookie).expect(200);
    const row = list.body.items.find((t: { terminalId: number }) => t.terminalId === created.body.terminalId);
    expect(row).toMatchObject({ warehouseId: Number(ids.whA), warehouseName: `${PREFIX} whA` });
  });

  it('US5-1 창고 없이 등록하면 null 이고, 수정으로 지정했다가 비울 수 있다', async () => {
    const created = await create('M3', {}).expect(201);
    expect(created.body).toMatchObject({ warehouseId: null, warehouseName: null });

    const set = await update(created.body.terminalId, '1', { warehouseId: Number(ids.whA) }).expect(200);
    expect(set.body).toMatchObject({ warehouseId: Number(ids.whA) });
    const cleared = await update(created.body.terminalId, set.headers.etag as string, { warehouseId: null }).expect(200);
    expect(cleared.body).toMatchObject({ warehouseId: null, warehouseName: null });
  });

  it('US5-2 다른 공장 창고는 400 PLANT_MISMATCH, 사용 중지 창고는 400 INVALID', async () => {
    const other = await create('BAD1', { warehouseId: Number(ids.whOther) }).expect(400);
    expect(other.body.errors[0]).toMatchObject({ field: 'warehouseId', code: 'PLANT_MISMATCH' });
    const inactive = await create('BAD2', { warehouseId: Number(ids.whOff) }).expect(400);
    expect(inactive.body.errors[0]).toMatchObject({ field: 'warehouseId', code: 'INVALID' });

    const created = await create('M4', {}).expect(201);
    const moved = await update(created.body.terminalId, '1', { warehouseId: Number(ids.whOther) }).expect(400);
    expect(moved.body.errors[0]).toMatchObject({ field: 'warehouseId', code: 'PLANT_MISMATCH' });
  });

  function create(suffix: string, extra: object) {
    return request(app.getHttpServer())
      .post(PATH)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ terminalCode: `${PREFIX}-${suffix}`, plantId: Number(ids.plant1), terminalTypeCode: 'MOBILE', statusCode: 'RUNNING', ...extra });
  }

  function update(terminalId: number, version: string, extra: object) {
    return request(app.getHttpServer())
      .put(`${PATH}/${terminalId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', version)
      .send({ plantId: Number(ids.plant1), terminalTypeCode: 'MOBILE', statusCode: 'RUNNING', ...extra });
  }
});
