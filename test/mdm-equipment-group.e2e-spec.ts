/**
 * 설비 그룹 마스터.
 *
 * ⛔ 저장처가 `mdm.production_line` 이다 — 계약의 `x-source-column` 다섯이 전부 그쪽을
 * 가리킨다. 그 성질을 검사가 직접 확인한다(같은 행이 두 자원으로 보인다).
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
import { EQUIPMENT_GROUP_REFERRERS } from '../src/mdm/equipment/equipment-group.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-mdmeqgrp-probe';
const NOPERM_ID = 'e2e-mdmeqgrp-noperm';
const PASSWORD = '설비그룹-검사-비밀번호';
const PREFIX = 'MDMEQGRP';
const ROLE = 'E2E_MDMEQGRP';

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

describe('설비 그룹 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let otherPlantId: number | null;
  let locationId: number;
  let otherPlantLocationId: number | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '설비그룹검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '설비그룹검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-05-12' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    const plants = await prisma.plant.findMany({ take: 2, orderBy: { plant_id: 'asc' } });
    plantId = Number(plants[0].plant_id);
    otherPlantId = plants[1] === undefined ? null : Number(plants[1].plant_id);
    locationId = await makeLocation(plantId, 'A');
    if (otherPlantId !== null) otherPlantLocationId = await makeLocation(otherPlantId, 'B');
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
      WHERE c.contype = 'f' AND tn.nspname = 'mdm' AND t.relname = 'production_line'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(EQUIPMENT_GROUP_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
  });

  it('⭐ 저장처가 production_line 이다 — 같은 행이 생산라인 목록에도 보인다', async () => {
    const { id } = await create(`${PREFIX}-SAME`);

    // 계약이 x-source-column 으로 지목한 그 표에 실제로 들어갔는가.
    const row = await prisma.production_line.findUniqueOrThrow({
      where: { production_line_id: id },
    });
    expect(row.line_code).toBe(`${PREFIX}-SAME`);

    const lines = await request(app.getHttpServer())
      .get(`/api/mdm/production-lines?q=${PREFIX}-SAME`)
      .set('Cookie', cookie)
      .expect(200);
    expect(
      lines.body.items.map((l: { productionLineId: number }) => l.productionLineId),
    ).toContain(id);
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups?plantId=${plantId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/equipment-groups');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/equipment-groups')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-X`))
      .expect(403);
  });

  it('⭐ 등록하고 상세가 계약 스키마·ETag·소속 대수를 준다', async () => {
    const { id, etag } = await create(`${PREFIX}-A`);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/equipment-groups/{equipmentGroupId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    expect(detail.body.memberEquipmentCount).toBe(0);
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⭐ 설비가 붙으면 소속 대수가 오르고 코드가 잠긴다', async () => {
    const { id } = await create(`${PREFIX}-MEM`);
    await prisma.equipment.create({
      data: {
        plant_id: plantId,
        equipment_code: `${PREFIX}-EQ`,
        equipment_name: `${PREFIX}-EQ`,
        // 실재하는 코드 값을 쓴다 — 픽스처가 없는 값을 가르치지 않게 한다.
        equipment_type_code: 'INJECTION_MOLDING',
        status_code: 'IN_SERVICE',
        production_line_id: id,
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    // 「사용 중지 확인 문구가 이 값을 쓴다」(계약).
    expect(detail.body.memberEquipmentCount).toBe(1);
    expect(detail.body.editability).toMatchObject({ codeEditable: false, reason: 'REFERENCED' });
  });

  it('⛔ 마스터에 없는 그룹 유형은 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/equipment-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-BAD`), groupTypeCode: '없는유형' })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'groupTypeCode', code: 'INVALID' });
  });

  it('⛔ 자기 자신·순환·다른 공장을 상위 그룹으로 둘 수 없다', async () => {
    const a = await create(`${PREFIX}-CY-A`);
    const b = await create(`${PREFIX}-CY-B`, { parentGroupId: a.id });

    // 자기 자신
    await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${a.id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', (await detailOf(a.id)).etag)
      .send({ ...updateBody(`${PREFIX}-CY-A`), parentGroupId: a.id })
      .expect(400);

    // 순환 A→B→A
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${a.id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', (await detailOf(a.id)).etag)
      .send({ ...updateBody(`${PREFIX}-CY-A`), parentGroupId: b.id })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'parentGroupId', code: 'INVALID' });

    if (otherPlantId === null) return;
    const outsider = await create(`${PREFIX}-OUT`, {}, otherPlantId);
    await request(app.getHttpServer())
      .post('/api/mdm/equipment-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-CROSS`), parentGroupId: outsider.id })
      .expect(400);
  });

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await create(`${PREFIX}-V`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...updateBody(`${PREFIX}-V`), groupName: '고친 이름' })
      .expect(200);

    expect(updated.body.groupName).toBe('고친 이름');
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody(`${PREFIX}-V`))
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('중지·재개가 돌고, 중지된 것은 기본 목록에서 빠진다', async () => {
    const { id, etag } = await create(`${PREFIX}-D`);

    const off = await request(app.getHttpServer())
      .post(`/api/mdm/equipment-groups/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    expect(off.body.isActive).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups?q=${PREFIX}-D`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.items.map((g: { equipmentGroupId: number }) => g.equipmentGroupId)).not.toContain(id);

    const on = await request(app.getHttpServer())
      .post(`/api/mdm/equipment-groups/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', off.headers.etag)
      .expect(200);
    expect(on.body.isActive).toBe(true);
  });

  it('⭐ 라인 기본 위치 셋을 등록·조회하고, 생산라인 목록에도 싣는다', async () => {
    const locations = { defaultWipLocationId: locationId, defaultFgLocationId: locationId, defaultScrapLocationId: null };
    const { id } = await create(`${PREFIX}-LOC`, locations);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.equipmentGroup).toMatchObject(locations);
    expect(validator('GET /mdm/equipment-groups/{equipmentGroupId}')(detail.body)).toBe(true);

    const lines = await request(app.getHttpServer())
      .get(`/api/mdm/production-lines?q=${PREFIX}-LOC`)
      .set('Cookie', cookie)
      .expect(200);
    expect(lines.body.items.find((line: { productionLineId: number }) => line.productionLineId === id)).toMatchObject(locations);
  });

  it('⭐ 수정에서 기본 위치를 바꾸고 null 로 비운다 — 생략하면 그대로 둔다', async () => {
    const { id, etag } = await create(`${PREFIX}-LOCU`, { defaultWipLocationId: locationId });

    const cleared = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...updateBody(`${PREFIX}-LOCU`), defaultWipLocationId: null, defaultScrapLocationId: locationId })
      .expect(200);
    expect(cleared.body).toMatchObject({ defaultWipLocationId: null, defaultFgLocationId: null, defaultScrapLocationId: locationId });

    const kept = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', cleared.headers.etag)
      .send({ ...updateBody(`${PREFIX}-LOCU`), groupName: '이름만' })
      .expect(200);
    expect(kept.body).toMatchObject({ groupName: '이름만', defaultScrapLocationId: locationId });
  });

  it('⛔ 자재창고 위치는 기본 위치로 둘 수 없다 — 400 INVALID', async () => {
    const materialLocationId = await makeLocation(plantId, 'M', 'MATERIAL');
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/equipment-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-LOCM`, { defaultWipLocationId: materialLocationId }))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'defaultWipLocationId', code: 'INVALID' });
  });

  it('⛔ 없는 위치·다른 공장 위치는 400 INVALID 다', async () => {
    const missing = await request(app.getHttpServer())
      .post('/api/mdm/equipment-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-LOCX`, { defaultWipLocationId: 999999999 }))
      .expect(400);
    expect(missing.body.errors[0]).toMatchObject({ field: 'defaultWipLocationId', code: 'INVALID' });

    if (otherPlantLocationId === null) return;
    const cross = await request(app.getHttpServer())
      .post('/api/mdm/equipment-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-LOCY`, { defaultScrapLocationId: otherPlantLocationId }))
      .expect(400);
    expect(cross.body.errors[0]).toMatchObject({ field: 'defaultScrapLocationId', code: 'INVALID' });
  });

  it('⛔ 없는 그룹은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/equipment-groups/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function updateBody(groupCode: string, extra: Record<string, unknown> = {}): object {
    return { groupCode, groupName: groupCode, groupTypeCode: 'LINE', ...extra };
  }

  function body(groupCode: string, extra: Record<string, unknown> = {}): object {
    return { plantId, ...updateBody(groupCode, extra) };
  }

  async function detailOf(id: number): Promise<{ etag: string }> {
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return { etag: detail.headers.etag };
  }

  async function create(
    groupCode: string,
    extra: Record<string, unknown> = {},
    inPlant: number = plantId,
  ): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/equipment-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(groupCode, extra), plantId: inPlant })
      .expect(201);
    return { id: created.body.equipmentGroupId, ...(await detailOf(created.body.equipmentGroupId)) };
  }

  async function makeLocation(inPlant: number, suffix: string, warehouseTypeCode = 'GENERAL'): Promise<number> {
    const unit = await prisma.business_unit.findFirstOrThrow();
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: inPlant,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH${suffix}`,
        warehouse_name: `설비그룹검사창고${suffix}`,
        warehouse_type_code: warehouseTypeCode,
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC${suffix}`,
        location_name: `설비그룹검사위치${suffix}`,
        location_type_code: 'BIN',
      },
    });
    return Number(location.location_id);
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
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    // 자식 → 부모 순으로 지운다. parent_line_id 가 FK 다.
    await prisma.production_line.deleteMany({
      where: { line_code: { startsWith: PREFIX }, NOT: { parent_line_id: null } },
    });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
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
