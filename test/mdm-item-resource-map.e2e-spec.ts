/**
 * 품목–공정–설비–금형 매핑. 계획 확정의 설비·금형 자동 배정과 4M 추천이 읽는 기준정보다.
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

const LOGIN_ID = 'e2e-itemresmap-probe';
const NOPERM_ID = 'e2e-itemresmap-noperm';
const PASSWORD = '설비금형매핑-검사-비밀번호';
const PREFIX = 'IRMAP';
const ROLE = 'E2E_IRMAP';
const PATH = '/api/mdm/item-resource-maps';

function validator(operation: string, status = '200'): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('품목 설비·금형 매핑 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let itemId: number;
  let equipmentId: number;
  let moldA: number;
  let moldB: number;
  let otherPlantMold: number | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUsers();
    const plants = await prisma.plant.findMany({ take: 2, orderBy: { plant_id: 'asc' } });
    plantId = Number(plants[0].plant_id);
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '매핑검사품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id },
    });
    itemId = Number(item.item_id);
    const equipment = await prisma.equipment.create({
      data: { plant_id: plantId, equipment_code: `${PREFIX}-EQ`, equipment_name: '매핑검사사출기', equipment_type_code: 'PRESS', status_code: 'IN_SERVICE' },
    });
    equipmentId = Number(equipment.equipment_id);
    moldA = await makeMold(plantId, 'A');
    moldB = await makeMold(plantId, 'B');
    if (plants[1] !== undefined) otherPlantMold = await makeMold(Number(plants[1].plant_id), 'X');
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 등록하면 이름 칸까지 실어 돌려주고 목록에 기본이 먼저 온다', async () => {
    const plain = await post({ equipmentId, moldId: moldB, priorityNo: 10 }).expect(201);
    expect(validator('POST /mdm/item-resource-maps', '201')(plain.body)).toBe(true);
    const preferred = await post({ equipmentId, moldId: moldA, isDefault: true, priorityNo: 50 }).expect(201);
    expect(preferred.body).toMatchObject({ equipmentCode: `${PREFIX}-EQ`, moldCode: `${PREFIX}-MOLD-A`, isDefault: true });

    const list = await request(app.getHttpServer()).get(PATH).query({ itemId }).set('Cookie', cookie).expect(200);
    expect(validator('GET /mdm/item-resource-maps')(list.body)).toBe(true);
    expect(list.body.items.map((row: { moldId: number }) => row.moldId)).toEqual([moldA, moldB]);
  });

  it('⭐ 새 기본을 세우면 같은 품목·공정의 앞 기본이 내려간다', async () => {
    const before = await listOf();
    const plain = before.find((row) => row.moldId === moldB);
    const response = await request(app.getHttpServer())
      .put(`${PATH}/${plain?.itemResourceMapId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', await etagOf(plain?.itemResourceMapId ?? 0))
      .send({ isDefault: true })
      .expect(200);
    expect(response.body.isDefault).toBe(true);

    const after = await listOf();
    expect(after.filter((row) => row.isDefault).map((row) => row.moldId)).toEqual([moldB]);
  });

  it('⛔ 설비·금형이 둘 다 없으면 400 REQUIRED, 다른 공장 금형은 400 INVALID, 같은 조합은 400 UNIQUE_VIOLATION', async () => {
    const empty = await post({}).expect(400);
    expect(empty.body.errors[0]).toMatchObject({ field: 'equipmentId', code: 'REQUIRED' });

    const duplicate = await post({ equipmentId, moldId: moldA }).expect(400);
    expect(duplicate.body.errors[0]).toMatchObject({ code: 'UNIQUE_VIOLATION' });

    if (otherPlantMold === null) return;
    const cross = await post({ moldId: otherPlantMold }).expect(400);
    expect(cross.body.errors[0]).toMatchObject({ field: 'moldId', code: 'INVALID' });
  });

  it('⭐ 사용 중지하면 기본 목록에서 빠지고, 낡은 If-Match 는 409 다', async () => {
    const target = (await listOf()).find((row) => row.moldId === moldA);
    const etag = await etagOf(target?.itemResourceMapId ?? 0);
    await request(app.getHttpServer())
      .put(`${PATH}/${target?.itemResourceMapId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', etag)
      .send({ isActive: false })
      .expect(200);
    expect((await listOf()).map((row) => row.moldId)).toEqual([moldB]);

    await request(app.getHttpServer())
      .put(`${PATH}/${target?.itemResourceMapId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', etag)
      .send({ priorityNo: 1 })
      .expect(409);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post(PATH)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .send({ plantId, itemId, moldId: moldA })
      .expect(403);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function post(extra: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(PATH)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ plantId, itemId, ...extra });
  }

  async function listOf(): Promise<{ itemResourceMapId: number; moldId: number; isDefault: boolean }[]> {
    const list = await request(app.getHttpServer()).get(PATH).query({ itemId }).set('Cookie', cookie).expect(200);
    return list.body.items;
  }

  /** 목록은 ETag 를 안 내린다 — 행의 version_no 를 바로 읽는다. */
  async function etagOf(id: number): Promise<string> {
    const row = await prisma.item_resource_map.findUniqueOrThrow({ where: { item_resource_map_id: id } });
    return String(row.version_no);
  }

  async function makeMold(inPlant: number, suffix: string): Promise<number> {
    const mold = await prisma.mold.create({
      data: { plant_id: inPlant, mold_code: `${PREFIX}-MOLD-${suffix}`, mold_name: `매핑검사금형${suffix}`, status_code: 'IN_SERVICE', tool_type_code: 'MOLD' },
    });
    return Number(mold.mold_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '매핑검사', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const other = await prisma.app_user.create({ data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '매핑검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-06-05' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    await prisma.item_resource_map.deleteMany({ where: { item: { item_code: { startsWith: PREFIX } } } });
    await prisma.mold.deleteMany({ where: { mold_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
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
