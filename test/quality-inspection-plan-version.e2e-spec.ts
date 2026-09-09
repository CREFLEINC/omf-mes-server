/**
 * 검사기준 버전과 검사 항목.
 *
 * ⭐ 항목 전체 치환이 「행 교체」가 아니다 — `inspection_measurement` 가 NOT NULL FK 로
 * 참조하므로 지우고 다시 넣으면 측정 기록이 무너진다(계약).
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
import { REVISION_STATUS } from '../src/planning/revision-status';
import { PLAN_VERSION_REFERRERS } from '../src/quality/inspection-plan/inspection-plan-version.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-iver-probe';
const NOPERM_ID = 'e2e-iver-noperm';
const PASSWORD = '검사버전-검사-비밀번호';
const PREFIX = 'E2E_IVER';
const ROLE = 'E2E_IVER_ROLE';

function validator(operation: string, status = '200'): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

interface Item {
  inspectionItemSpecId: number;
  sequenceNo: number;
  inspectionItemName: string;
}

describe('검사기준 버전 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let planCounter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '버전검사', status_code: 'EMPLOYED' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '버전검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-02' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();
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
      WHERE c.contype = 'f' AND tn.nspname = 'quality' AND t.relname = 'inspection_plan_version'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(PLAN_VERSION_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
  });

  it('등록·목록·상세가 계약 스키마를 만족하고 상세가 ETag 를 준다', async () => {
    const planId = await createPlan();
    const versionId = await createVersion(planId);

    const list = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plan-versions?inspectionPlanId=${planId}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /quality/inspection-plan-versions');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plan-versions/${versionId}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator(
      'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}',
    );
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.headers.etag).toBe('1');
    expect(detail.body.inspectionPlanVersion.planVersion).toBe(1);
    expect(detail.body.inspectionPlanVersion.statusCode).toBe(REVISION_STATUS.DRAFT);
  });

  it('⭐⭐ 샘플 비율이 백분율이다 — 30 을 그대로 받는다', async () => {
    const planId = await createPlan();
    const versionId = await createVersion(planId, { samplingRatio: 30 });

    const detail = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plan-versions/${versionId}`)
      .set('Cookie', cookie)
      .expect(200);
    // ⛔ 선행 마이그레이션 전에는 CHECK(0~1)가 이 저장을 막았다.
    expect(detail.body.inspectionPlanVersion.samplingRatio).toBe(30);

    // 100 을 넘으면 DB CHECK 가 막는다 — 계약도 maximum 100 이라 가드가 먼저 거른다.
    const tooBig = await request(app.getHttpServer())
      .post('/api/quality/inspection-plan-versions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...versionBody(await createPlan()), samplingRatio: 101 })
      .expect(400);
    expect(tooBig.body.errors[0].code).toBe('RANGE');
  });

  it('⛔ 기준에 버전이 이미 있으면 등록이 400 이다 — 신규 버전은 다른 경로다', async () => {
    const planId = await createPlan();
    await createVersion(planId);

    const rejected = await request(app.getHttpServer())
      .post('/api/quality/inspection-plan-versions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(versionBody(planId))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'inspectionPlanId',
      code: 'UNIQUE_VIOLATION',
    });
  });

  // ── 검사 항목 ───────────────────────────────────────────────────────────

  it('⭐ 항목을 통째로 저장하고 순서대로 낸다', async () => {
    const versionId = await createVersion(await createPlan());

    const saved = await putItems(versionId, [item(versionId, 1, 'A'), item(versionId, 2, 'B')]);
    const validate = validator(
      'PUT /quality/inspection-plan-versions/{inspectionPlanVersionId}/items',
    );
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(saved.body.items.map((i: Item) => i.inspectionItemName)).toEqual(['A', 'B']);
  });

  it('⭐⭐ 순서를 맞바꿔도 «같은 행»이 남는다 — 측정 기록이 매달려 있다', async () => {
    const versionId = await createVersion(await createPlan());
    const before = (await putItems(versionId, [item(versionId, 1, 'A'), item(versionId, 2, 'B')]))
      .body.items;

    const swapped = await putItems(versionId, [
      { ...item(versionId, 1, 'B'), inspectionItemSpecId: before[1].inspectionItemSpecId },
      { ...item(versionId, 2, 'A'), inspectionItemSpecId: before[0].inspectionItemSpecId },
    ]);

    expect(swapped.body.items.map((i: Item) => i.inspectionItemName)).toEqual(['B', 'A']);
    expect(swapped.body.items.map((i: Item) => i.inspectionItemSpecId).sort()).toEqual(
      before.map((i: Item) => i.inspectionItemSpecId).sort(),
    );
  });

  it('⛔ 수집 채널이 연결된 검사 항목은 치환에서 뺄 수 없다', async () => {
    const versionId = await createVersion(await createPlan());
    const saved = await putItems(versionId, [item(versionId, 1, 'CHANNEL')]);
    const plant = await prisma.plant.findFirstOrThrow();
    const equipment = await prisma.equipment.create({
      data: {
        plant_id: plant.plant_id,
        equipment_code: `${PREFIX}-CHANNEL-EQ`,
        equipment_name: '수집 채널 참조 설비',
        equipment_type_code: 'MACHINE',
        status_code: 'IN_SERVICE',
      },
    });
    await prisma.collection_channel.create({
      data: {
        equipment_id: equipment.equipment_id,
        channel_key: `${PREFIX}-CHANNEL`,
        inspection_item_id: saved.body.items[0].inspectionItemSpecId,
      },
    });

    const rejected = await putItemsRaw(versionId, []);
    expect(rejected.status).toBe(400);
    expect(rejected.body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
  });

  it('⛔ 같은 순서·상한<하한·남의 버전 항목은 400 이다', async () => {
    const versionId = await createVersion(await createPlan());

    const duplicated = await putItemsRaw(versionId, [
      item(versionId, 1, 'A'),
      item(versionId, 1, 'B'),
    ]);
    expect(duplicated.status).toBe(400);
    expect(duplicated.body.errors[0]).toMatchObject({
      field: 'items[1].sequenceNo',
      code: 'UNIQUE_VIOLATION',
    });

    const badLimits = await putItemsRaw(versionId, [
      { ...item(versionId, 1, 'A'), lowerLimit: 10, upperLimit: 5 },
    ]);
    expect(badLimits.status).toBe(400);
    expect(badLimits.body.errors[0]).toMatchObject({
      field: 'items[0].upperLimit',
      code: 'PAIR',
    });

    const foreign = await putItemsRaw(versionId, [
      { ...item(versionId, 1, 'A'), inspectionItemSpecId: 999999999 },
    ]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.errors[0]).toMatchObject({
      field: 'items[0].inspectionItemSpecId',
      code: 'INVALID',
    });
  });

  // ── 상태 전이 ───────────────────────────────────────────────────────────

  it('⛔ 항목이 없으면 확정이 400 LINE_REQUIRED 다', async () => {
    const versionId = await createVersion(await createPlan());

    const rejected = await request(app.getHttpServer())
      .post(`/api/quality/inspection-plan-versions/${versionId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(400);
    expect(rejected.body.errors[0].code).toBe('LINE_REQUIRED');
  });

  it('⭐ 확정 뒤에는 수정도 항목 저장도 400 STATE_LOCKED 다', async () => {
    const planId = await createPlan();
    const versionId = await createVersion(planId);
    await putItems(versionId, [item(versionId, 1, 'A')]);
    const confirmed = await confirm(versionId);
    // 계약 문자열로 고정한다 — 상수와 대조하면 상수가 틀려도 통과한다.
    expect(confirmed.body.statusCode).toBe('CONFIRMED');

    const update = await request(app.getHttpServer())
      .put(`/api/quality/inspection-plan-versions/${versionId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '2')
      .send(versionBody(planId))
      .expect(400);
    expect(update.body.errors[0].code).toBe('STATE_LOCKED');

    const items = await putItemsRaw(versionId, [item(versionId, 1, 'A')]);
    expect(items.status).toBe(400);
    expect(items.body.errors[0].code).toBe('STATE_LOCKED');
  });

  it('⭐⭐ 신규 버전이 설정과 항목을 함께 복제한다', async () => {
    const planId = await createPlan();
    const versionId = await createVersion(planId, { samplingRatio: 25, acceptanceNumber: 3 });
    const before = (
      await putItems(versionId, [item(versionId, 1, 'A'), item(versionId, 2, 'B')])
    ).body.items;
    await confirm(versionId);

    const created = await request(app.getHttpServer())
      .post(`/api/quality/inspection-plan-versions/${versionId}:new-revision`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(201);
    const validate = validator(
      'POST /quality/inspection-plan-versions/{inspectionPlanVersionId}:new-revision',
      '201',
    );
    expect(validate(created.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(created.body.planVersion).toBe(2);
    expect(created.body.statusCode).toBe(REVISION_STATUS.DRAFT);
    // 샘플링·판정 설정을 물려받는다.
    expect(created.body.samplingRatio).toBe(25);
    expect(created.body.acceptanceNumber).toBe(3);

    const items = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plan-versions/${created.body.inspectionPlanVersionId}/items`)
      .set('Cookie', cookie)
      .expect(200);
    expect(items.body.items).toHaveLength(2);
    // ⛔ 새 행이다 — 원본 항목 id 를 그대로 쓰면 두 버전이 한 행을 공유한다.
    expect(items.body.items.map((i: Item) => i.inspectionItemSpecId)).not.toEqual(
      before.map((i: Item) => i.inspectionItemSpecId),
    );
  });

  it('⭐ 폐기는 확정에서만 되고 되돌아오지 않는다', async () => {
    const versionId = await createVersion(await createPlan());
    await putItems(versionId, [item(versionId, 1, 'A')]);

    const tooEarly = await request(app.getHttpServer())
      .post(`/api/quality/inspection-plan-versions/${versionId}:obsolete`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(400);
    expect(tooEarly.body.errors[0].code).toBe('STATE_LOCKED');

    await confirm(versionId);
    const obsoleted = await request(app.getHttpServer())
      .post(`/api/quality/inspection-plan-versions/${versionId}:obsolete`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    expect(obsoleted.body.statusCode).toBe(REVISION_STATUS.OBSOLETE);

    for (const action of ['confirm', 'new-revision']) {
      await request(app.getHttpServer())
        .post(`/api/quality/inspection-plan-versions/${versionId}:${action}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .expect(400);
    }
  });

  it('⛔ 어휘 밖 샘플링·주기 코드는 400 이다', async () => {
    const planId = await createPlan();

    const rejected = await request(app.getHttpServer())
      .post('/api/quality/inspection-plan-versions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...versionBody(planId), samplingMethodCode: '없는방식' })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'samplingMethodCode',
      code: 'INVALID',
    });
  });

  it('⛔ 권한이 없으면 쓰기가 403 이고, 없는 버전은 404 다', async () => {
    const planId = await createPlan();

    await request(app.getHttpServer())
      .post('/api/quality/inspection-plan-versions')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(versionBody(planId))
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/quality/inspection-plan-versions/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/quality/inspection-plan-versions/999999999/items')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function versionBody(inspectionPlanId: number): Record<string, unknown> {
    return {
      inspectionPlanId,
      effectiveFrom: '2026-01-01',
      samplingMethodCode: 'SAMPLE_BY_LOT',
      inspectionFrequencyCode: 'PRODUCTION_LOT',
    };
  }

  function item(versionId: number, sequenceNo: number, name: string): Record<string, unknown> {
    return {
      inspectionPlanVersionId: versionId,
      sequenceNo,
      inspectionItemCode: `${PREFIX}-${name}`,
      inspectionItemName: name,
      dataTypeCode: 'NUMERIC',
      measurementCount: 1,
      requiredFlag: true,
      automaticJudgment: true,
    };
  }

  async function createPlan(): Promise<number> {
    planCounter += 1;
    const created = await prisma.inspection_plan.create({
      data: {
        inspection_plan_code: `${PREFIX}-P${planCounter}`,
        inspection_plan_name: `검사기준${planCounter}`,
        inspection_type_code: 'IQC',
      },
    });
    return Number(created.inspection_plan_id);
  }

  async function createVersion(
    inspectionPlanId: number,
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/quality/inspection-plan-versions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...versionBody(inspectionPlanId), ...extra })
      .expect(201);
    const validate = validator('POST /quality/inspection-plan-versions', '201');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body.inspectionPlanVersionId;
  }

  async function confirm(versionId: number): Promise<{ body: { statusCode: string } }> {
    const response = await request(app.getHttpServer())
      .post(`/api/quality/inspection-plan-versions/${versionId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    return { body: response.body };
  }

  async function putItems(
    versionId: number,
    items: Record<string, unknown>[],
  ): Promise<{ body: { items: Item[] } }> {
    const response = await putItemsRaw(versionId, items);
    expect(response.status).toBe(200);
    return { body: response.body as { items: Item[] } };
  }

  async function putItemsRaw(
    versionId: number,
    items: Record<string, unknown>[],
  ): Promise<{ status: number; body: { items: Item[]; errors: { code: string }[] } }> {
    const response = await request(app.getHttpServer())
      .put(`/api/quality/inspection-plan-versions/${versionId}/items`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ items });
    return { status: response.status, body: response.body };
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
    planCounter = 0;
    await prisma.collection_channel.deleteMany({
      where: { channel_key: { startsWith: PREFIX } },
    });
    await prisma.equipment.deleteMany({
      where: { equipment_code: { startsWith: PREFIX } },
    });
    const plans = await prisma.inspection_plan.findMany({
      where: { inspection_plan_code: { startsWith: PREFIX } },
      select: { inspection_plan_id: true },
    });
    const versions = await prisma.inspection_plan_version.findMany({
      where: { inspection_plan_id: { in: plans.map((row) => row.inspection_plan_id) } },
      select: { inspection_plan_version_id: true },
    });
    const versionIds = versions.map((row) => row.inspection_plan_version_id);
    await prisma.inspection_item_spec.deleteMany({
      where: { inspection_plan_version_id: { in: versionIds } },
    });
    await prisma.inspection_plan_version.deleteMany({
      where: { inspection_plan_version_id: { in: versionIds } },
    });
    await prisma.inspection_plan.deleteMany({
      where: { inspection_plan_code: { startsWith: PREFIX } },
    });

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
