/**
 * 예비품 마스터.
 *
 * 예비품이 «공장 단위»가 된 것이 이번 마이그레이션이고, 설비 매핑도 그 안에서만 성립한다 —
 * 그 성질이 이 검사의 뼈대다.
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
import { SPARE_PART_REFERRERS } from '../src/mdm/spare-part/spare-part.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-mdmspare-probe';
const NOPERM_ID = 'e2e-mdmspare-noperm';
const PASSWORD = '예비품-마스터-검사-비밀번호';
const PREFIX = 'MDMSPARE';
const ROLE = 'E2E_MDMSPARE';

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

describe('예비품 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let otherPlantId: number | null;
  let equipmentIds: number[];
  let outsiderEquipmentId: number | null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '예비품검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '예비품검사용' } });
    for (const permission of ['W-06-08', 'W-05-06']) {
      await prisma.role_permission.create({
        data: { role_id: role.role_id, permission_code: permission },
      });
    }
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    const plants = await prisma.plant.findMany({ take: 2, orderBy: { plant_id: 'asc' } });
    plantId = Number(plants[0].plant_id);
    otherPlantId = plants[1] === undefined ? null : Number(plants[1].plant_id);
    equipmentIds = [
      await createEquipment(`${PREFIX}-EQ1`, plantId),
      await createEquipment(`${PREFIX}-EQ2`, plantId),
    ];
    outsiderEquipmentId =
      otherPlantId === null ? null : await createEquipment(`${PREFIX}-EQ3`, otherPlantId);
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
      WHERE c.contype = 'f' AND tn.nspname = 'mdm' AND t.relname = 'spare_part'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(SPARE_PART_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/spare-parts?plantId=${plantId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/spare-parts');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/spare-parts')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-X`))
      .expect(403);
  });

  it('⭐ 등록하고 상세가 계약 스키마·ETag·매핑 대수를 준다', async () => {
    const { id, etag } = await create(`${PREFIX}-A`);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/spare-parts/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/spare-parts/{sparePartId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    expect(detail.body.mappedEquipmentCount).toBe(0);
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⭐ 같은 코드를 다른 공장이 쓸 수 있다 — 유일 범위가 (공장, 코드)다', async () => {
    if (otherPlantId === null) return;
    await create(`${PREFIX}-SHARED`);

    await request(app.getHttpServer())
      .post('/api/mdm/spare-parts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-SHARED`), plantId: otherPlantId })
      .expect(201);

    expect(
      await prisma.spare_part.count({ where: { spare_part_code: `${PREFIX}-SHARED` } }),
    ).toBe(2);
  });

  // ── 설비 매핑 ───────────────────────────────────────────────────────────

  it('⭐ 설비 매핑을 통째로 저장하고 코드·명을 함께 낸다', async () => {
    const { id } = await create(`${PREFIX}-MAP`);

    const saved = await putMappings(id, equipmentIds);
    const validate = validator('GET /mdm/spare-parts/{sparePartId}/equipments');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(saved.body.items).toHaveLength(2);
    expect(saved.body.items[0].equipmentCode).toBe(`${PREFIX}-EQ1`);

    // 매핑이 붙으면 상세의 대수가 오르고 코드가 잠긴다.
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/spare-parts/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.mappedEquipmentCount).toBe(2);
    expect(detail.body.editability).toMatchObject({ codeEditable: false, reason: 'REFERENCED' });
  });

  it('⭐ 빠진 설비는 지워진다', async () => {
    const { id } = await create(`${PREFIX}-MAP2`);
    await putMappings(id, equipmentIds);

    const shrunk = await putMappings(id, [equipmentIds[1]]);
    expect(shrunk.body.items).toHaveLength(1);
    expect(shrunk.body.items[0].equipmentId).toBe(equipmentIds[1]);
  });

  it('⛔ 같은 설비를 두 번 보내면 몇 번째인지 짚는다', async () => {
    const { id } = await create(`${PREFIX}-MAP3`);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/spare-parts/${id}/equipments`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await mappingEtag(id))
      .send({ equipmentIds: [equipmentIds[0], equipmentIds[0]] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'equipmentIds[1]',
      code: 'UNIQUE_VIOLATION',
    });
  });

  it('⛔ 다른 공장의 설비는 매핑할 수 없다 — 예비품이 공장 단위다', async () => {
    if (outsiderEquipmentId === null) return;
    const { id } = await create(`${PREFIX}-MAP4`);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/spare-parts/${id}/equipments`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await mappingEtag(id))
      .send({ equipmentIds: [outsiderEquipmentId] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'equipmentIds[0]', code: 'INVALID' });
  });

  it('⭐ equipmentId 로 「이 설비에 쓰는 예비품」만 거른다', async () => {
    const mapped = await create(`${PREFIX}-USED`);
    await create(`${PREFIX}-UNUSED`);
    await putMappings(mapped.id, [equipmentIds[0]]);

    const response = await request(app.getHttpServer())
      .get(`/api/mdm/spare-parts?plantId=${plantId}&equipmentId=${equipmentIds[0]}`)
      .set('Cookie', cookie)
      .expect(200);

    const codes = response.body.items.map((s: { sparePartCode: string }) => s.sparePartCode);
    expect(codes).toContain(`${PREFIX}-USED`);
    expect(codes).not.toContain(`${PREFIX}-UNUSED`);
  });

  // ── 공통 성질 ───────────────────────────────────────────────────────────

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await create(`${PREFIX}-V`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/spare-parts/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ sparePartCode: `${PREFIX}-V`, sparePartName: '고친 이름' })
      .expect(200);
    expect(updated.body.sparePartName).toBe('고친 이름');

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/spare-parts/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ sparePartName: '뒤늦게' })
      .expect(409);
    expect(stale.body.errors[0].code).toBe('STALE_VERSION');
  });

  it('중지·재개가 돌고, 중지된 것은 기본 목록에서 빠진다', async () => {
    const { id, etag } = await create(`${PREFIX}-D`);

    const off = await request(app.getHttpServer())
      .post(`/api/mdm/spare-parts/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    expect(off.body.isActive).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/spare-parts?q=${PREFIX}-D`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.items.map((s: { sparePartId: number }) => s.sparePartId)).not.toContain(id);

    const on = await request(app.getHttpServer())
      .post(`/api/mdm/spare-parts/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', off.headers.etag)
      .expect(200);
    expect(on.body.isActive).toBe(true);
  });

  it('⛔ 없는 예비품은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/spare-parts/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function body(sparePartCode: string, extra: Record<string, unknown> = {}): object {
    return { plantId, sparePartCode, sparePartName: sparePartCode, ...extra };
  }

  async function mappingEtag(id: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/spare-parts/${id}/equipments`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function putMappings(
    id: number,
    ids: number[],
  ): Promise<{ body: { items: { equipmentId: number; equipmentCode: string }[] } }> {
    const response = await request(app.getHttpServer())
      .put(`/api/mdm/spare-parts/${id}/equipments`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await mappingEtag(id))
      .send({ equipmentIds: ids })
      .expect(200);
    return { body: response.body };
  }

  async function create(sparePartCode: string): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/spare-parts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(sparePartCode))
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/spare-parts/${created.body.sparePartId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { id: created.body.sparePartId, etag: detail.headers.etag };
  }

  async function createEquipment(code: string, inPlant: number): Promise<number> {
    const created = await prisma.equipment.create({
      data: {
        plant_id: inPlant,
        equipment_code: code,
        equipment_name: code,
        equipment_type_code: 'INJECTION_MOLDING',
        status_code: 'IN_SERVICE',
      },
    });
    return Number(created.equipment_id);
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
    const parts = await prisma.spare_part.findMany({
      where: { spare_part_code: { startsWith: PREFIX } },
      select: { spare_part_id: true },
    });
    await prisma.spare_part_equipment.deleteMany({
      where: { spare_part_id: { in: parts.map((p) => p.spare_part_id) } },
    });
    await prisma.spare_part.deleteMany({ where: { spare_part_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
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
