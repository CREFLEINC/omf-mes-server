/**
 * 부서 생산 창고(피처 003 · omf-all-around#66).
 *
 * 부서마다 생산 창고를 연결한다 — 자재별 지정은 없다. 활성 창고만 받고 창고 유형으로 거르지 않는다.
 * 연결을 빼면 그 창고가 출발지인 이 부서의 활성 요청 수를 알린다(요청은 그대로 진행).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_DPW_${randomUUID().slice(0, 8)}`;
const CONTRACT_PATH = '/mdm/departments/{departmentId}/production-warehouses';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');

function validator(method: string, status: number): ValidateFunction {
  const pointer = `/paths/${CONTRACT_PATH.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('부서 생산 창고 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let deniedCookie: string;
  let departmentId: bigint;
  let plantId: bigint;
  const warehouses: Record<string, bigint> = {};
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];

  const path = (id: bigint | number = departmentId) => `/api/mdm/departments/${id}/production-warehouses`;
  const put = (warehouseIds: bigint[], query = '', session = cookie) =>
    request(app.getHttpServer())
      .put(`${path()}${query}`)
      .set('Cookie', session)
      .set('Idempotency-Key', randomUUID())
      .send({ warehouseIds: warehouseIds.map(Number) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unitId = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    plantId = (
      await prisma.plant.create({
        data: {
          plant_code: PREFIX,
          plant_name: `${PREFIX} 공장`,
          legal_entity_id: base.legal_entity_id,
          business_unit_id: unitId,
          timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })
    ).plant_id;
    const type = await prisma.code_value.findFirstOrThrow({
      where: { code_group: { group_code: 'WAREHOUSE_TYPE' } },
      orderBy: { display_order: 'asc' },
    });
    const warehouse = async (key: string, extra: { is_active?: boolean; is_defect?: boolean; is_external?: boolean } = {}) => {
      warehouses[key] = (
        await prisma.warehouse.create({
          data: {
            plant_id: plantId,
            business_unit_id: unitId,
            warehouse_code: `${PREFIX}-${key}`,
            warehouse_name: `생산 창고 ${key}`,
            warehouse_type_code: type.code,
            management_level_code: 'WAREHOUSE',
            ...extra,
          },
        })
      ).warehouse_id;
    };
    await warehouse('A');
    await warehouse('B');
    await warehouse('OFF', { is_active: false });
    await warehouse('DEFECT', { is_defect: true });
    await warehouse('EXT', { is_external: true });

    departmentId = (
      await prisma.department.create({ data: { department_code: `${PREFIX}-D`, department_name: '생산 창고 시험 부서' } })
    ).department_id;

    const admin = await makeUser('ADMIN', 'W-06-06');
    const denied = await makeUser('DENIED', 'W-06-07');
    const jwt = app.get(JwtService);
    const sign = (id: bigint) => `${SESSION_COOKIE}=${jwt.sign({ sub: Number(id), typ: 'session' })}`;
    cookie = sign(admin);
    deniedCookie = sign(denied);
  });

  afterAll(async () => {
    await prisma.department_production_warehouse.deleteMany({ where: { department_id: departmentId } });
    await prisma.department.deleteMany({ where: { department_id: departmentId } });
    await prisma.warehouse.deleteMany({ where: { warehouse_id: { in: Object.values(warehouses) } } });
    await prisma.plant.deleteMany({ where: { plant_id: plantId } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await app.close();
  });

  async function makeUser(suffix: string, permission: string): Promise<bigint> {
    const user = await prisma.app_user.create({
      data: { login_id: `${PREFIX}_${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED' },
    });
    userIds.push(user.app_user_id);
    const role = await prisma.role.create({
      data: { role_code: `${PREFIX}_${suffix}`, role_name: `생산 창고 시험 ${suffix}` },
    });
    roleIds.push(role.role_id);
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return user.app_user_id;
  }

  const linked = async () =>
    (await prisma.department_production_warehouse.findMany({ where: { department_id: departmentId } }))
      .map((row) => row.warehouse_id)
      .sort((a, b) => Number(a - b));

  it('US8-1 연결이 없으면 빈 목록이고, PUT 으로 연결한 창고가 GET 에 그대로 돌아온다', async () => {
    const empty = await request(app.getHttpServer()).get(path()).set('Cookie', cookie).expect(200);
    expect(empty.body).toEqual({ items: [] });

    const saved = await put([warehouses.B, warehouses.A, warehouses.A]).expect(200);
    expect(validator('put', 200)(saved.body)).toBe(true);
    expect(saved.body.removed).toEqual([]);
    expect(saved.body.items.map((item: { warehouseCode: string }) => item.warehouseCode)).toEqual([
      `${PREFIX}-A`,
      `${PREFIX}-B`,
    ]);

    const read = await request(app.getHttpServer()).get(path()).set('Cookie', cookie).expect(200);
    expect(validator('get', 200)(read.body)).toBe(true);
    expect(read.body.items).toEqual([
      { warehouseId: Number(warehouses.A), warehouseCode: `${PREFIX}-A`, warehouseName: '생산 창고 A', plantId: Number(plantId) },
      { warehouseId: Number(warehouses.B), warehouseCode: `${PREFIX}-B`, warehouseName: '생산 창고 B', plantId: Number(plantId) },
    ]);

    // 부서 목록 「생산 창고」 열 — 목록 행이 연결 수를 싣는다.
    const departments = await request(app.getHttpServer())
      .get('/api/mdm/departments')
      .query({ q: `${PREFIX}-D` })
      .set('Cookie', cookie)
      .expect(200);
    expect(departments.body.items).toEqual([
      expect.objectContaining({ departmentId: Number(departmentId), productionWarehouseCount: 2 }),
    ]);
  });

  it('US8-1 쓰지 않는 창고·없는 창고는 400 이고 아무것도 바꾸지 않는다', async () => {
    const before = await linked();
    for (const ids of [[warehouses.A, warehouses.OFF], [warehouses.A, BigInt(9_000_000_000)]]) {
      const response = await put(ids).expect(400);
      expect(response.body.errors[0]).toMatchObject({ scope: 'field', field: 'warehouseIds', code: 'INVALID' });
    }
    expect(await linked()).toEqual(before);
  });

  it('US8-1 창고 유형으로 거르지 않는다 — 불량·외부 창고도 연결된다(시안 검토 9)', async () => {
    const saved = await put([warehouses.A, warehouses.DEFECT, warehouses.EXT]).expect(200);
    expect(saved.body.items).toHaveLength(3);
    expect(saved.body.removed).toEqual([{ warehouseId: Number(warehouses.B), activeRequestCount: 0 }]);
    expect(await linked()).toEqual([warehouses.A, warehouses.DEFECT, warehouses.EXT].sort((a, b) => Number(a - b)));
  });

  it('US8-2 dryRun=true 는 뺄 창고와 요청 수를 내고 저장하지 않는다', async () => {
    const before = await linked();
    const preview = await put([warehouses.A], '?dryRun=true').expect(200);
    expect(validator('put', 200)(preview.body)).toBe(true);
    expect(preview.body.items.map((item: { warehouseId: number }) => item.warehouseId)).toEqual([Number(warehouses.A)]);
    expect(preview.body.removed).toEqual(
      [warehouses.DEFECT, warehouses.EXT]
        .sort((a, b) => Number(a - b))
        .map((id) => ({ warehouseId: Number(id), activeRequestCount: 0 })),
    );
    expect(await linked()).toEqual(before);

    // 빈 배열은 연결을 모두 뺀다.
    const cleared = await put([]).expect(200);
    expect(cleared.body.items).toEqual([]);
    expect(await linked()).toEqual([]);
  });

  // S5(배포 때 대기 요청 생성) 뒤 활성화 — 출발 창고가 있는 요청은 그때 처음 생긴다(tasks T008).
  it.todo('US8-2 뺄 창고가 출발지인 이 부서의 대기·배포 요청 수를 내고, 저장해도 요청은 그대로다');
  it.todo('US8-3 연결을 바꿔도 이미 만든 요청의 sourceWarehouseId 는 그대로다');

  it('W-06-06 이 없으면 조회·저장 모두 403, 없는 부서는 404', async () => {
    await request(app.getHttpServer()).get(path()).set('Cookie', deniedCookie).expect(403);
    await put([warehouses.A], '', deniedCookie).expect(403);
    await request(app.getHttpServer()).get(path(9_000_000_000)).set('Cookie', cookie).expect(404);
  });
});
