/**
 * 점검항목 부여 — 설비와 설비그룹 두 층.
 *
 * 공유계약 `B-17` 「가장 가까운 것이 이긴다」의 해석이 이 검사의 뼈대다. 설비에 붙은
 * 것이 있으면 그것, 없으면 소속 그룹의 것, 그것도 없으면 상위 그룹, 끝까지 없으면 NONE.
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

const LOGIN_ID = 'e2e-mdmasg-probe';
const NOPERM_ID = 'e2e-mdmasg-noperm';
const PASSWORD = '점검부여-검사-비밀번호';
const PREFIX = 'MDMASG';
const ROLE = 'E2E_MDMASG';

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

/** 계약 `EquipmentInspectionItemAssignmentsResponse` 의 검사용 형태. */
interface EquipmentAssignmentsBody {
  assigned: { itemCode: string }[];
  effective: { itemCode: string; cycleTypeCode: string }[];
  resolvedFromLevelCode: string;
  resolvedFromGroupId: number | null;
}

describe('점검항목 부여 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let parentGroupId: number;
  let groupId: number;
  let equipmentId: number;
  let itemA: number;
  let itemB: number;
  let retiredItem: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '부여검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '부여검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-05-12' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    plantId = Number((await prisma.plant.findFirstOrThrow()).plant_id);
    parentGroupId = await createGroup(`${PREFIX}-PARENT`, null);
    groupId = await createGroup(`${PREFIX}-CHILD`, parentGroupId);
    equipmentId = await createEquipment(`${PREFIX}-EQ`, groupId);
    itemA = await createItem(`${PREFIX}-I1`, 1);
    itemB = await createItem(`${PREFIX}-I2`, 2);
    retiredItem = await createItem(`${PREFIX}-I3`, 3, false);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── 그룹 ────────────────────────────────────────────────────────────────

  it('⭐ 그룹 부여를 통째로 저장하고 계약 스키마를 만족한다', async () => {
    const saved = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${groupId}/inspection-items`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await groupEtag(groupId))
      .send({
        items: [
          { equipmentInspectionItemId: itemB, cycleTypeCode: 'WEEK', cycleInterval: 2 },
          {
            equipmentInspectionItemId: itemA,
            cycleTypeCode: 'DAY',
            cycleInterval: 1,
            cycleBaseDate: '2026-08-01',
          },
        ],
      })
      .expect(200);

    const validate = validator('GET /mdm/equipment-groups/{equipmentGroupId}/inspection-items');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // 항목 마스터의 sequenceNo 로 정렬한다 — 보낸 차례가 아니다.
    expect(saved.body.items.map((i: { itemCode: string }) => i.itemCode)).toEqual([
      `${PREFIX}-I1`,
      `${PREFIX}-I2`,
    ]);
    expect(saved.body.items[0].cycleBaseDate).toBe('2026-08-01');
    expect(saved.body.items[1].cycleBaseDate).toBeNull();
    // 나머지 칸은 점검항목 마스터에서 온다.
    expect(saved.body.items[0].judgmentMethodCode).toBe('VISUAL');
  });

  it('⛔ 사용 중지된 점검항목은 새로 부여할 수 없다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${groupId}/inspection-items`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await groupEtag(groupId))
      .send({
        items: [
          { equipmentInspectionItemId: retiredItem, cycleTypeCode: 'DAY', cycleInterval: 1 },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'items[0].equipmentInspectionItemId',
      code: 'INVALID',
    });
  });

  it('⛔ 같은 점검항목을 두 줄 보내면 몇 번째인지 짚는다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${groupId}/inspection-items`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await groupEtag(groupId))
      .send({
        items: [
          { equipmentInspectionItemId: itemA, cycleTypeCode: 'DAY', cycleInterval: 1 },
          { equipmentInspectionItemId: itemA, cycleTypeCode: 'WEEK', cycleInterval: 1 },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'items[1].equipmentInspectionItemId',
      code: 'UNIQUE_VIOLATION',
    });
  });

  it('⛔ 마스터에 없는 주기 단위는 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${groupId}/inspection-items`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await groupEtag(groupId))
      .send({
        items: [{ equipmentInspectionItemId: itemA, cycleTypeCode: '없는주기', cycleInterval: 1 }],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'items[0].cycleTypeCode',
      code: 'INVALID',
    });
  });

  it('⛔ 주기 간격 0 은 계약 검증이 거른다 — minimum 1', async () => {
    await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${groupId}/inspection-items`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await groupEtag(groupId))
      .send({ items: [{ equipmentInspectionItemId: itemA, cycleTypeCode: 'DAY', cycleInterval: 0 }] })
      .expect(400);
  });

  // ── 설비 — 해석 규칙 (B-17) ─────────────────────────────────────────────

  it('⭐ 설비에 부여가 없으면 소속 그룹의 것을 따른다', async () => {
    await putGroup(groupId, [{ equipmentInspectionItemId: itemA, cycleTypeCode: 'DAY', cycleInterval: 1 }]);
    await putEquipment([]);

    const response = await request(app.getHttpServer())
      .get(`/api/mdm/equipments/${equipmentId}/inspection-items`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/equipments/{equipmentId}/inspection-items');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.assigned).toEqual([]);
    expect(response.body.effective).toHaveLength(1);
    expect(response.body.resolvedFromLevelCode).toBe('EQUIPMENT_GROUP');
    expect(response.body.resolvedFromGroupId).toBe(groupId);
  });

  it('⭐ 설비에 부여가 있으면 그것이 이긴다 — 가장 가까운 것', async () => {
    await putGroup(groupId, [{ equipmentInspectionItemId: itemA, cycleTypeCode: 'DAY', cycleInterval: 1 }]);
    const saved = await putEquipment([
      { equipmentInspectionItemId: itemB, cycleTypeCode: 'MONTH', cycleInterval: 3 },
    ]);

    expect(saved.body.resolvedFromLevelCode).toBe('EQUIPMENT');
    expect(saved.body.resolvedFromGroupId).toBeNull();
    expect(saved.body.effective).toEqual(saved.body.assigned);
    expect(saved.body.effective[0].itemCode).toBe(`${PREFIX}-I2`);
  });

  it('⭐ 소속 그룹이 비면 상위 그룹까지 올라간다', async () => {
    await putGroup(parentGroupId, [
      { equipmentInspectionItemId: itemB, cycleTypeCode: 'YEAR', cycleInterval: 1 },
    ]);
    await putGroup(groupId, []);
    await putEquipment([]);

    const response = await request(app.getHttpServer())
      .get(`/api/mdm/equipments/${equipmentId}/inspection-items`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.resolvedFromLevelCode).toBe('EQUIPMENT_GROUP');
    // 소속 그룹이 아니라 «상위» 그룹에서 왔다.
    expect(response.body.resolvedFromGroupId).toBe(parentGroupId);
    expect(response.body.effective[0].cycleTypeCode).toBe('YEAR');
  });

  it('⛔ 어디에도 없으면 NONE 이다 — 화면이 입력을 열지 않는다', async () => {
    await putGroup(parentGroupId, []);
    await putGroup(groupId, []);
    await putEquipment([]);

    const response = await request(app.getHttpServer())
      .get(`/api/mdm/equipments/${equipmentId}/inspection-items`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.resolvedFromLevelCode).toBe('NONE');
    expect(response.body.effective).toEqual([]);
    expect(response.body.resolvedFromGroupId).toBeNull();
  });

  it('⭐ 빈 목록을 보내면 직접 부여가 사라지고 그룹의 것을 따른다 — 계약이 적었다', async () => {
    await putGroup(groupId, [{ equipmentInspectionItemId: itemA, cycleTypeCode: 'DAY', cycleInterval: 1 }]);
    await putEquipment([
      { equipmentInspectionItemId: itemB, cycleTypeCode: 'MONTH', cycleInterval: 1 },
    ]);

    const cleared = await putEquipment([]);
    expect(cleared.body.assigned).toEqual([]);
    expect(cleared.body.resolvedFromLevelCode).toBe('EQUIPMENT_GROUP');
    expect(cleared.body.effective[0].itemCode).toBe(`${PREFIX}-I1`);
  });

  // ── 공통 성질 ───────────────────────────────────────────────────────────

  it('⛔ 낡은 If-Match 는 409 이고, 거절된 저장은 아무것도 바꾸지 않는다', async () => {
    const stale = await groupEtag(groupId);
    await putGroup(groupId, [{ equipmentInspectionItemId: itemA, cycleTypeCode: 'DAY', cycleInterval: 1 }]);

    const before = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups/${groupId}/inspection-items`)
      .set('Cookie', cookie)
      .expect(200);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${groupId}/inspection-items`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', stale)
      .send({ items: [] })
      .expect(409);
    expect(rejected.body.conflictCause).toBe('user');

    const after = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups/${groupId}/inspection-items`)
      .set('Cookie', cookie)
      .expect(200);
    expect(after.body.items).toEqual(before.body.items);
    expect(after.headers.etag).toBe(before.headers.etag);
  });

  it('⛔ 권한이 없으면 두 층의 저장이 모두 403 이다', async () => {
    await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${groupId}/inspection-items`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await groupEtag(groupId))
      .send({ items: [] })
      .expect(403);

    await request(app.getHttpServer())
      .put(`/api/mdm/equipments/${equipmentId}/inspection-items`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await equipmentEtag())
      .send({ items: [] })
      .expect(403);
  });

  it('⛔ 없는 설비·그룹은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/equipments/999999999/inspection-items')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/mdm/equipment-groups/999999999/inspection-items')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function groupEtag(id: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups/${id}/inspection-items`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function equipmentEtag(): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/equipments/${equipmentId}/inspection-items`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function putGroup(id: number, items: unknown[]): Promise<void> {
    await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${id}/inspection-items`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await groupEtag(id))
      .send({ items })
      .expect(200);
  }

  async function putEquipment(items: unknown[]): Promise<{ body: EquipmentAssignmentsBody }> {
    return request(app.getHttpServer())
      .put(`/api/mdm/equipments/${equipmentId}/inspection-items`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await equipmentEtag())
      .send({ items })
      .expect(200);
  }

  async function createGroup(code: string, parent: number | null): Promise<number> {
    const created = await prisma.production_line.create({
      data: {
        plant_id: plantId,
        line_code: code,
        line_name: code,
        line_type_code: 'LINE',
        ...(parent === null ? {} : { parent_line_id: parent }),
      },
    });
    return Number(created.production_line_id);
  }

  async function createEquipment(code: string, inGroup: number): Promise<number> {
    const created = await prisma.equipment.create({
      data: {
        plant_id: plantId,
        equipment_code: code,
        equipment_name: code,
        equipment_type_code: 'INJECTION_MOLDING',
        status_code: 'IN_SERVICE',
        production_line_id: inGroup,
      },
    });
    return Number(created.equipment_id);
  }

  async function createItem(code: string, sequenceNo: number, isActive = true): Promise<number> {
    const created = await prisma.equipment_inspection_item.create({
      data: {
        plant_id: plantId,
        inspection_item_code: code,
        inspection_item_name: code,
        inspection_type_code: 'DAILY',
        judgment_method_code: 'VISUAL',
        data_type_code: 'BOOLEAN',
        sequence_no: sequenceNo,
        is_active: isActive,
      },
    });
    return Number(created.equipment_inspection_item_id);
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
    const items = await prisma.equipment_inspection_item.findMany({
      where: { inspection_item_code: { startsWith: PREFIX } },
      select: { equipment_inspection_item_id: true },
    });
    const itemIds = items.map((i) => i.equipment_inspection_item_id);
    await prisma.equipment_group_inspection_item.deleteMany({
      where: { equipment_inspection_item_id: { in: itemIds } },
    });
    await prisma.equipment_inspection_item_assignment.deleteMany({
      where: { equipment_inspection_item_id: { in: itemIds } },
    });
    await prisma.equipment_inspection_item.deleteMany({
      where: { inspection_item_code: { startsWith: PREFIX } },
    });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({
      where: { line_code: { startsWith: PREFIX }, NOT: { parent_line_id: null } },
    });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
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
