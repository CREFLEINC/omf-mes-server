/**
 * 추적 시스템(flowtrack) 연동의 운영 정책 — `AUTO_ROUTING_PROCESS`(공정 코드) · `BACKFLUSH_WAREHOUSE` · `AUTO_ISSUE_SOURCE_WAREHOUSE`(창고 코드).
 *
 * 범위는 공장만, 값은 다른 기준정보의 코드다. 글자라 FK 가 없어 저장할 때 서버가 그 행을 본다.
 * 설정 화면은 없다 — 현장 값은 초기 데이터가 넣는다(사용자 결정 2026-11-16).
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

const PREFIX = `E2E_TSP_${randomUUID().slice(0, 8)}`;
const PATH = '/api/app/operation-policies';
const TODAY = '2026-11-16';
const ROUTING = 'AUTO_ROUTING_PROCESS';
const BACKFLUSH = 'BACKFLUSH_WAREHOUSE';
const ISSUE_SOURCE = 'AUTO_ISSUE_SOURCE_WAREHOUSE';

describe('추적 시스템 연동 운영 정책 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let plantId: bigint;
  let otherPlantId: bigint;
  const processIds: bigint[] = [];
  const warehouseIds: bigint[] = [];
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];

  const post = (body: object) =>
    request(app.getHttpServer()).post(PATH).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send(body);
  const put = async (id: bigint, body: object) => {
    const detail = await request(app.getHttpServer()).get(`${PATH}/${id}`).set('Cookie', cookie).expect(200);
    return request(app.getHttpServer())
      .put(`${PATH}/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', detail.headers.etag as string)
      .send(body);
  };
  const valueTextRejected = (body: { errors: unknown[] }) =>
    expect(body.errors).toEqual([expect.objectContaining({ field: 'valueText', code: 'INVALID' })]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unitId = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    const makePlant = async (suffix: string) =>
      (
        await prisma.plant.create({
          data: {
            plant_code: `${PREFIX}_${suffix}`,
            plant_name: `${PREFIX} ${suffix}`,
            legal_entity_id: base.legal_entity_id,
            business_unit_id: unitId,
            timezone_code: 'Asia/Ho_Chi_Minh',
          },
        })
      ).plant_id;
    plantId = await makePlant('P1');
    otherPlantId = await makePlant('P2');

    for (const [suffix, active] of [['ASSY', true], ['OLD', false]] as const) {
      const row = await prisma.process.create({
        data: { process_code: `${PREFIX}_${suffix}`, process_name: suffix, process_type_code: 'ASSEMBLY', is_active: active },
      });
      processIds.push(row.process_id);
    }
    for (const [suffix, plant, active] of [
      ['WH', plantId, true],
      ['OFF', plantId, false],
      ['WH2', otherPlantId, true],
    ] as const) {
      const row = await prisma.warehouse.create({
        data: {
          plant_id: plant,
          business_unit_id: unitId,
          warehouse_code: `${PREFIX}_${suffix}`,
          warehouse_name: suffix,
          warehouse_type_code: 'MATERIAL',
          management_level_code: 'WAREHOUSE',
          is_active: active,
        },
      });
      warehouseIds.push(row.warehouse_id);
    }

    const user = await prisma.app_user.create({
      data: { login_id: PREFIX, user_name: PREFIX, status_code: 'EMPLOYED' },
    });
    userIds.push(user.app_user_id);
    const role = await prisma.role.create({ data: { role_code: PREFIX, role_name: '연동 정책 시험' } });
    roleIds.push(role.role_id);
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-05-01' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
  });

  afterAll(async () => {
    await prisma.operation_policy.deleteMany({ where: { plant_id: { in: [plantId, otherPlantId] } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_id: { in: warehouseIds } } });
    await prisma.process.deleteMany({ where: { process_id: { in: processIds } } });
    await prisma.plant.deleteMany({ where: { plant_id: { in: [plantId, otherPlantId] } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await app.close();
  });

  it('공장 범위로 공정·창고 코드를 저장하고 공장 범위로 읽힌다 — 공장 범위가 아니면 400', async () => {
    await post({ policyCode: ROUTING, plantId: Number(plantId), valueText: `${PREFIX}_ASSY`, effectiveFrom: TODAY }).expect(201);
    await post({ policyCode: BACKFLUSH, plantId: Number(plantId), valueText: `${PREFIX}_WH`, effectiveFrom: TODAY }).expect(201);

    for (const [code, value] of [[ROUTING, `${PREFIX}_ASSY`], [BACKFLUSH, `${PREFIX}_WH`]]) {
      const read = await request(app.getHttpServer())
        .get(`${PATH}/effective`)
        .query({ policyCode: code, plantId: Number(plantId), on: TODAY })
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body).toMatchObject({ resolved: true, valueText: value, matchedScopeCode: 'PLANT' });
    }

    const noPlant = await post({ policyCode: BACKFLUSH, valueText: `${PREFIX}_WH`, effectiveFrom: TODAY }).expect(400);
    expect(noPlant.body.errors[0]).toMatchObject({ field: 'plantId', code: 'REQUIRED' });
    const withProcess = await post({
      policyCode: ROUTING,
      plantId: Number(plantId),
      processId: Number(processIds[0]),
      valueText: `${PREFIX}_ASSY`,
      effectiveFrom: TODAY,
    }).expect(400);
    expect(withProcess.body.errors[0]).toMatchObject({ field: 'processId', code: 'INVALID' });
  });

  it('없는 공정 · 쓰지 않는 공정이면 400', async () => {
    for (const value of [`${PREFIX}_NONE`, `${PREFIX}_OLD`]) {
      const response = await post({ policyCode: ROUTING, plantId: Number(plantId), valueText: value, effectiveFrom: '2026-11-17' }).expect(400);
      valueTextRejected(response.body);
    }
  });

  it('다른 공장 창고 · 없는 창고 · 쓰지 않는 창고면 400 — 자재 출발 창고도 같다', async () => {
    for (const code of [BACKFLUSH, ISSUE_SOURCE]) {
      for (const value of [`${PREFIX}_WH2`, `${PREFIX}_NONE`, `${PREFIX}_OFF`]) {
        const response = await post({ policyCode: code, plantId: Number(plantId), valueText: value, effectiveFrom: '2026-11-17' }).expect(400);
        valueTextRejected(response.body);
      }
    }
    await post({ policyCode: ISSUE_SOURCE, plantId: Number(plantId), valueText: `${PREFIX}_WH`, effectiveFrom: '2026-11-17' }).expect(201);
  });

  it('고칠 때도 같은 검사 — 창고는 저장된 정책의 공장으로 본다', async () => {
    const on = new Date('2026-11-18T00:00:00Z');
    const routing = await prisma.operation_policy.create({
      data: { policy_code: ROUTING, plant_id: plantId, value_text: `${PREFIX}_ASSY`, effective_from: on },
    });
    const backflush = await prisma.operation_policy.create({
      data: { policy_code: BACKFLUSH, plant_id: plantId, value_text: `${PREFIX}_WH`, effective_from: on },
    });

    const oldProcess = await put(routing.operation_policy_id, { valueText: `${PREFIX}_OLD`, effectiveFrom: '2026-11-18' });
    expect(oldProcess.status).toBe(400);
    valueTextRejected(oldProcess.body);
    const otherPlant = await put(backflush.operation_policy_id, { valueText: `${PREFIX}_WH2`, effectiveFrom: '2026-11-18' });
    expect(otherPlant.status).toBe(400);
    valueTextRejected(otherPlant.body);
    expect((await put(backflush.operation_policy_id, { valueText: `${PREFIX}_WH`, effectiveFrom: '2026-11-19' })).status).toBe(200);
  });
});
