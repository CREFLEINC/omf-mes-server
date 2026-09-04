/**
 * 설비 점검항목 마스터.
 *
 * 계약이 요구한 칸 다섯이 물리에 없어 앞선 커밋이 세웠다. 그 위에 계약이 못박은 조건부
 * 필수(「측정값이면 단위·상하한이 필수」)가 얹힌다 — 그것이 이 검사의 뼈대다.
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

const LOGIN_ID = 'e2e-mdmeqinsp-probe';
const NOPERM_ID = 'e2e-mdmeqinsp-noperm';
const PASSWORD = '설비점검항목-검사-비밀번호';
const PREFIX = 'MDMEQINSP';
const ROLE = 'E2E_MDMEQINSP';

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

describe('설비 점검항목 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let otherPlantId: number | null;
  let uomId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '점검항목검사', status_code: 'EMPLOYED' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '점검항목검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-05-12' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    const plants = await prisma.plant.findMany({ take: 2, orderBy: { plant_id: 'asc' } });
    plantId = Number(plants[0].plant_id);
    otherPlantId = plants[1] === undefined ? null : Number(plants[1].plant_id);
    uomId = Number((await prisma.uom.findFirstOrThrow()).uom_id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-inspection-items?plantId=${plantId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/equipment-inspection-items');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/equipment-inspection-items')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(visual(`${PREFIX}-X`))
      .expect(403);
  });

  it('⭐ 육안 항목을 등록하고 상세가 계약 스키마와 ETag 를 준다', async () => {
    const { id, etag } = await create(visual(`${PREFIX}-A`));

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-inspection-items/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/equipment-inspection-items/{equipmentInspectionItemId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    expect(detail.body.assignmentCount).toBe(0);
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⛔ 측정값 판정이면 단위·상하한이 필수다 — 계약이 못박았다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/equipment-inspection-items')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...visual(`${PREFIX}-M1`), judgmentMethodCode: 'MEASUREMENT' })
      .expect(400);

    // 셋을 한꺼번에 낸다 — 화면이 하나씩 고치며 왕복하지 않게 한다.
    expect(rejected.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'lowerLimit',
      'uomId',
      'upperLimit',
    ]);
    expect(rejected.body.errors[0].code).toBe('REQUIRED');
  });

  it('⭐ 측정값 항목은 셋을 갖추면 통과한다', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/equipment-inspection-items')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        ...visual(`${PREFIX}-M2`),
        judgmentMethodCode: 'MEASUREMENT',
        uomId,
        lowerLimit: 1,
        upperLimit: 10,
      })
      .expect(201);

    expect(created.body.judgmentMethodCode).toBe('MEASUREMENT');
    expect(created.body.lowerLimit).toBe(1);

    // 계약이 안 받는 data_type_code 를 서버가 판정 방식에서 도출한다.
    const row = await prisma.equipment_inspection_item.findUniqueOrThrow({
      where: { equipment_inspection_item_id: created.body.equipmentInspectionItemId },
    });
    expect(row.data_type_code).toBe('NUMERIC');
  });

  it('⛔ 상한이 하한보다 작으면 400 — ck_equipment_inspection_limits', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/equipment-inspection-items')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        ...visual(`${PREFIX}-M3`),
        judgmentMethodCode: 'MEASUREMENT',
        uomId,
        lowerLimit: 10,
        upperLimit: 1,
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'upperLimit', code: 'PAIR' });
  });

  it('⛔ 마스터에 없는 점검 유형은 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/equipment-inspection-items')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...visual(`${PREFIX}-BAD`), inspectionTypeCode: '없는유형' })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'inspectionTypeCode',
      code: 'INVALID',
    });
  });

  it('⭐ 부여된 곳이 있으면 코드가 잠긴다 — 설비와 그룹을 함께 센다', async () => {
    const { id } = await create(visual(`${PREFIX}-REF`));
    // 설비 그룹의 저장처는 mdm.production_line 이다(#122).
    const group = await prisma.production_line.create({
      data: {
        plant_id: plantId,
        line_code: `${PREFIX}-G`,
        line_name: `${PREFIX}-G`,
        line_type_code: 'LINE',
      },
    });
    await prisma.equipment_group_inspection_item.create({
      data: {
        production_line_id: group.production_line_id,
        equipment_inspection_item_id: id,
        cycle_type_code: 'DAY',
        cycle_interval: 1,
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-inspection-items/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.assignmentCount).toBe(1);
    expect(detail.body.editability).toMatchObject({ codeEditable: false, reason: 'REFERENCED' });
  });

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await create(visual(`${PREFIX}-V`));

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-inspection-items/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...updateBody(`${PREFIX}-V`), itemName: '고친 이름', sequenceNo: 7 })
      .expect(200);

    expect(updated.body.itemName).toBe('고친 이름');
    expect(updated.body.sequenceNo).toBe(7);
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-inspection-items/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody(`${PREFIX}-V`))
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⭐ 같은 코드를 다른 공장이 쓸 수 있다 — 유일 범위가 (공장, 코드)다', async () => {
    if (otherPlantId === null) return;
    await create(visual(`${PREFIX}-SHARED`));

    await request(app.getHttpServer())
      .post('/api/mdm/equipment-inspection-items')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...visual(`${PREFIX}-SHARED`), plantId: otherPlantId })
      .expect(201);

    expect(
      await prisma.equipment_inspection_item.count({
        where: { inspection_item_code: `${PREFIX}-SHARED` },
      }),
    ).toBe(2);
  });

  it('⛔ 없는 점검항목은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/equipment-inspection-items/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function visual(itemCode: string): Record<string, unknown> {
    return {
      plantId,
      itemCode,
      itemName: itemCode,
      inspectionTypeCode: 'DAILY',
      judgmentMethodCode: 'VISUAL',
      requiredFlag: true,
      sequenceNo: 1,
    };
  }

  function updateBody(itemCode: string): Record<string, unknown> {
    const { plantId: _plantId, ...rest } = visual(itemCode);
    return { ...rest, isActive: true };
  }

  async function create(body: Record<string, unknown>): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/equipment-inspection-items')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body)
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-inspection-items/${created.body.equipmentInspectionItemId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { id: created.body.equipmentInspectionItemId, etag: detail.headers.etag };
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
    const ids = items.map((i) => i.equipment_inspection_item_id);
    await prisma.equipment_group_inspection_item.deleteMany({
      where: { equipment_inspection_item_id: { in: ids } },
    });
    await prisma.equipment_inspection_item_assignment.deleteMany({
      where: { equipment_inspection_item_id: { in: ids } },
    });
    await prisma.equipment_inspection_item.deleteMany({
      where: { inspection_item_code: { startsWith: PREFIX } },
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
