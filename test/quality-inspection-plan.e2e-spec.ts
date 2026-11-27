/**
 * 검사기준 헤더.
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
import { INSPECTION_PLAN_REFERRERS } from '../src/quality/inspection-plan/inspection-plan.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-iplan-probe';
const NOPERM_ID = 'e2e-iplan-noperm';
const PASSWORD = '검사기준-검사-비밀번호';
const PREFIX = 'E2E_IPLAN';
const ROLE = 'E2E_IPLAN_ROLE';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const status = method === 'POST' && !path.includes(':') ? '201' : '200';
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('검사기준 헤더 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let userId = 0;
  let itemId = 0;
  let processId = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '검사기준검사', status_code: 'EMPLOYED' },
    });
    userId = Number(user.app_user_id);
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '검사기준검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-02' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();

    const uom = await prisma.uom.findFirstOrThrow({ select: { uom_id: true } });
    itemId = Number(
      (
        await prisma.item.create({
          data: {
            item_code: `${PREFIX}-I`,
            item_name: '검사품목',
            item_type_code: 'FINISHED',
            base_uom_id: uom.uom_id,
            lot_controlled: true,
          },
        })
      ).item_id,
    );
    processId = Number(
      (
        await prisma.process.create({
          data: {
            process_code: `${PREFIX}-PR`,
            process_name: '검사공정',
            process_type_code: 'ASSEMBLY',
          },
        })
      ).process_id,
    );
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
      WHERE c.contype = 'f' AND tn.nspname = 'quality' AND t.relname = 'inspection_plan'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(INSPECTION_PLAN_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
  });

  it('목록·상세가 계약 스키마를 만족하고 상세가 ETag 를 준다', async () => {
    const id = await create('P1');

    const list = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plans?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /quality/inspection-plans');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plans/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /quality/inspection-plans/{inspectionPlanId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.headers.etag).toBe('1');
    // 승인 기능은 없앴다 — 승인자·승인 시각을 싣지 않는다.
    expect(detail.body.inspectionPlan).not.toHaveProperty('approvedBy');
    expect(detail.body.inspectionPlan).not.toHaveProperty('approvedAt');
  });

  it('⭐ 버전이 붙으면 코드가 잠긴다', async () => {
    const id = await create('P2');
    await addVersion(id, REVISION_STATUS.DRAFT);

    const detail = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plans/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.editability).toMatchObject({ reason: 'REFERENCED', referenceCount: 1 });
  });

  it('⛔ 어휘 밖 검사유형·없는 대상·중복 코드는 400 이다', async () => {
    const badType = await request(app.getHttpServer())
      .post('/api/quality/inspection-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        inspectionPlanCode: `${PREFIX}-BAD`,
        inspectionPlanName: '어휘 밖',
        // ⚠ 설비 점검의 값(DAILY)을 넣어 본다 — 같은 이름 다른 그룹이다.
        inspectionTypeCode: 'DAILY',
      })
      .expect(400);
    expect(badType.body.errors[0]).toMatchObject({
      field: 'inspectionTypeCode',
      code: 'INVALID',
    });

    const badItem = await request(app.getHttpServer())
      .post('/api/quality/inspection-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        inspectionPlanCode: `${PREFIX}-BADI`,
        inspectionPlanName: '없는 품목',
        inspectionTypeCode: 'IQC',
        itemId: 999999999,
      })
      .expect(400);
    expect(badItem.body.errors[0]).toMatchObject({ field: 'itemId', code: 'INVALID' });

    await create('DUP');
    const duplicated = await request(app.getHttpServer())
      .post('/api/quality/inspection-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        inspectionPlanCode: `${PREFIX}-DUP`,
        inspectionPlanName: '중복',
        inspectionTypeCode: 'IQC',
      })
      .expect(400);
    expect(duplicated.body.errors[0]).toMatchObject({
      field: 'inspectionPlanCode',
      code: 'UNIQUE_VIOLATION',
    });
  });

  it('⭐ 적용 대상 셋과 검사유형 필터가 오간다', async () => {
    const id = await create('P7');

    const saved = await request(app.getHttpServer())
      .put(`/api/quality/inspection-plans/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({
        inspectionPlanCode: `${PREFIX}-P7`,
        inspectionPlanName: '고친 이름',
        inspectionTypeCode: 'PQC',
        itemId,
        processId,
        nameKo: '한국어',
        nameVi: 'Tieng Viet',
        pqcSkipAllowed: true,
      })
      .expect(200);
    // PQC 기준은 공정에 붙지 않는다 — 보낸 공정은 비워 저장한다(사용자 결정 2026-11-04).
    expect(saved.body).toMatchObject({
      itemId,
      processId: null,
      inspectionTypeCode: 'PQC',
      pqcSkipAllowed: true,
      nameKo: '한국어',
    });

    const filtered = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plans?q=${PREFIX}&inspectionTypeCode=PQC`)
      .set('Cookie', cookie)
      .expect(200);
    expect(
      filtered.body.items.map((p: { inspectionPlanId: number }) => p.inspectionPlanId),
    ).toEqual([id]);

    const byItem = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plans?itemId=${itemId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byItem.body.items).toHaveLength(1);
  });

  describe('공장으로 거른다 — 기준의 공장은 품목의 공장(BOM)이다(클라이언트 요청 2026-11-27)', () => {
    const Q = `${PREFIX}-PL-`;
    let plantA = 0;
    let plantB = 0;

    beforeAll(async () => {
      const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
      const uom = await prisma.uom.findFirstOrThrow({ select: { uom_id: true } });
      const plant = async (suffix: string): Promise<number> =>
        Number(
          (
            await prisma.plant.create({
              data: {
                plant_code: `${PREFIX}_${suffix}`,
                plant_name: `${PREFIX} ${suffix}`,
                legal_entity_id: base.legal_entity_id,
                timezone_code: 'Asia/Ho_Chi_Minh',
              },
            })
          ).plant_id,
        );
      plantA = await plant('A');
      plantB = await plant('B');
      const item: Record<string, bigint> = {};
      for (const name of ['PA', 'PB', 'BOTH', 'NONE']) {
        item[name] = (
          await prisma.item.create({
            data: { item_code: `${Q}${name}`, item_name: name, item_type_code: 'FINISHED', base_uom_id: uom.uom_id },
          })
        ).item_id;
      }
      // BOTH 는 두 공장 BOM 의 구성품이다.
      for (const [parent, plantId] of [['PA', plantA], ['PB', plantB]] as const) {
        await prisma.bom.create({
          data: {
            parent_item_id: item[parent],
            bom_code: `${Q}BOM`,
            bom_version: 1,
            status_code: 'CONFIRMED',
            effective_from: new Date('2026-01-01'),
            base_qty: 1,
            base_uom_id: uom.uom_id,
            plant_id: plantId,
            bom_component: {
              create: [{ component_item_id: item.BOTH, required_qty: 1, uom_id: uom.uom_id, sequence_no: 1 }],
            },
          },
        });
      }
      for (const name of ['PA', 'PB', 'BOTH', 'NONE', 'COMMON']) {
        await prisma.inspection_plan.create({
          data: {
            inspection_plan_code: `${Q}${name}`,
            inspection_plan_name: name,
            inspection_type_code: name === 'PA' ? 'IQC' : 'OQC',
            item_id: name === 'COMMON' ? null : item[name],
          },
        });
      }
    });

    const listed = async (query: string): Promise<string[]> =>
      (
        await request(app.getHttpServer())
          .get(`/api/quality/inspection-plans?q=${Q}&size=50&${query}`)
          .set('Cookie', cookie)
          .expect(200)
      ).body.items
        .map((p: { inspectionPlanCode: string }) => p.inspectionPlanCode.slice(Q.length))
        .sort();

    it('⭐ plantId 는 품목이 모품목·구성품으로 든 BOM 의 공장으로 거른다 — 두 공장 BOM 에 든 품목의 기준은 두 공장에서 나온다', async () => {
      expect(await listed(`plantId=${plantA}`)).toEqual(['BOTH', 'COMMON', 'NONE', 'PA']);
      expect(await listed(`plantId=${plantB}`)).toEqual(['BOTH', 'COMMON', 'NONE', 'PB']);
    });

    it('⭐ 공장을 모르는 품목의 기준과 품목이 빈 기준은 어느 plantId 로도 나온다', async () => {
      expect(await listed('plantId=999999999')).toEqual(['COMMON', 'NONE']);
      expect(await listed('')).toHaveLength(5);
    });

    it('⭐ q·inspectionTypeCode 와 함께 쓰고 page.total 도 걸러진 건수다', async () => {
      expect(await listed(`plantId=${plantA}&inspectionTypeCode=IQC`)).toEqual(['PA']);
      expect(await listed(`plantId=${plantB}&inspectionTypeCode=IQC`)).toEqual([]);
      const paged = await request(app.getHttpServer())
        .get(`/api/quality/inspection-plans?q=${Q}&plantId=${plantA}&size=2`)
        .set('Cookie', cookie)
        .expect(200);
      expect(paged.body.items).toHaveLength(2);
      expect(paged.body.page.total).toBe(4);
    });
  });

  it('사용 중지·다시 사용이 목록 기본값을 가른다', async () => {
    const id = await create('P8');

    await request(app.getHttpServer())
      .post(`/api/quality/inspection-plans/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(200);

    const defaults = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plans?q=${PREFIX}-P8`)
      .set('Cookie', cookie)
      .expect(200);
    expect(defaults.body.items).toHaveLength(0);

    await request(app.getHttpServer())
      .post(`/api/quality/inspection-plans/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '2')
      .expect(200);
  });

  it('⛔ 권한이 없으면 쓰기가 403 이고, 없는 검사기준은 404 다', async () => {
    await request(app.getHttpServer())
      .post('/api/quality/inspection-plans')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({
        inspectionPlanCode: `${PREFIX}-X`,
        inspectionPlanName: '막힘',
        inspectionTypeCode: 'IQC',
      })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/quality/inspection-plans/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⭐⭐ 기준 수정이 검사 수준을 함께 저장하고, 본 수준 판이 다르면 기본 정보까지 되돌린다(omf-all-around#357)', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/quality/inspection-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ inspectionPlanCode: `${PREFIX}-L1`, inspectionPlanName: 'L1', inspectionTypeCode: 'IQC', itemId })
      .expect(201);
    const id = Number(create.body.inspectionPlanId);
    const body = (name: string) => ({ inspectionPlanCode: `${PREFIX}-L1`, inspectionPlanName: name, inspectionTypeCode: 'IQC', itemId });

    await put(id, { ...body('L1-a'), inspectionLevelCode: 'NORMAL', inspectionLevelReason: ' 첫 지정 ', inspectionLevelVersionNo: null }, 200);
    const level = await prisma.item_inspection_level.findUniqueOrThrow({ where: { item_id: itemId } });
    expect(level.inspection_level_code).toBe('NORMAL');
    const histories = await prisma.item_inspection_level_history.findMany({ where: { item_id: itemId } });
    expect(histories).toEqual([
      expect.objectContaining({ from_level_code: null, to_level_code: 'NORMAL', change_type_code: 'MANUAL', reason: '첫 지정', changed_by: BigInt(userId) }),
    ]);

    // 창을 연 뒤 다른 저장이 수준을 바꿨다 — 기준명도 저장되지 않는다(한 트랜잭션).
    const conflict = await put(id, { ...body('L1-b'), inspectionLevelCode: 'TIGHTENED', inspectionLevelVersionNo: level.version_no + 1 }, 409);
    expect(conflict.body).toMatchObject({ conflictCause: 'user' });
    const after = await prisma.inspection_plan.findUniqueOrThrow({ where: { inspection_plan_id: id } });
    expect(after.inspection_plan_name).toBe('L1-a');
    expect((await prisma.item_inspection_level.findUniqueOrThrow({ where: { item_id: itemId } })).inspection_level_code).toBe('NORMAL');
    expect(await prisma.item_inspection_level_history.count({ where: { item_id: itemId } })).toBe(1);
  });

  it('⛔ IQC 가 아닌 기준에 수준을 실으면 400 inspectionLevelCode, IQC 대상이 아닌 품목의 수준 지정은 400 itemId(omf-all-around#357)', async () => {
    const id = await create('L2');
    const rejected = await put(id, { inspectionPlanCode: `${PREFIX}-L2`, inspectionPlanName: 'L2-x', inspectionTypeCode: 'OQC', inspectionLevelCode: 'NORMAL' }, 400);
    expect(rejected.body.errors).toEqual([expect.objectContaining({ field: 'inspectionLevelCode', code: 'INVALID' })]);
    expect((await prisma.inspection_plan.findUniqueOrThrow({ where: { inspection_plan_id: id } })).inspection_plan_name).toBe('L2');

    const uom = await prisma.uom.findFirstOrThrow({ select: { uom_id: true } });
    const outsider = await prisma.item.create({
      data: { item_code: `${PREFIX}-J`, item_name: 'IQC 밖 품목', item_type_code: 'FINISHED', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    const level = await request(app.getHttpServer())
      .post('/api/quality/item-inspection-levels')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ itemId: Number(outsider.item_id), inspectionLevelCode: 'NORMAL' })
      .expect(400);
    expect(level.body.errors).toEqual([expect.objectContaining({ field: 'itemId', code: 'INVALID' })]);

    // 검사 수준 쓰기는 검사 기준 관리(W-06-02) 권한이다 — 없으면 403.
    await request(app.getHttpServer())
      .post('/api/quality/item-inspection-levels')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ itemId, inspectionLevelCode: 'NORMAL' })
      .expect(403);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /** 기준 수정 — 상세의 ETag 로 잠근다. */
  async function put(id: number, body: object, status: number): Promise<request.Response> {
    const detail = await request(app.getHttpServer())
      .get(`/api/quality/inspection-plans/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return request(app.getHttpServer())
      .put(`/api/quality/inspection-plans/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', String(detail.headers.etag))
      .send(body)
      .expect(status);
  }

  async function create(suffix: string): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/quality/inspection-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      // ⚠ IQC 가 아니다 — 품목 칸이 빈 IQC 기준은 저장할 때 전용 기준 없는 «모든» 품목의 IQC 대상을 바꿔(사용자 결정 2026-11-04)
      //    같은 워커 DB 를 쓰는 다른 스위트의 품목까지 건드린다. 이 도우미는 헤더 CRUD 만 본다.
      .send({
        inspectionPlanCode: `${PREFIX}-${suffix}`,
        inspectionPlanName: suffix,
        inspectionTypeCode: 'OQC',
      })
      .expect(201);
    const validate = validator('POST /quality/inspection-plans');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body.inspectionPlanId;
  }

  /** 버전 API 는 다음 PR 이다 — 참조와 확정 상태를 세우려면 DB 로 넣는다. */
  async function addVersion(inspectionPlanId: number, statusCode: string): Promise<void> {
    await prisma.inspection_plan_version.create({
      data: {
        inspection_plan_id: inspectionPlanId,
        plan_version: 1,
        effective_from: new Date('2026-01-01'),
        sampling_method_code: 'FULL_INSPECTION',
        inspection_frequency_code: 'PRODUCTION_LOT',
        status_code: statusCode,
      },
    });
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
    const plans = await prisma.inspection_plan.findMany({
      where: { inspection_plan_code: { startsWith: PREFIX } },
      select: { inspection_plan_id: true },
    });
    await prisma.inspection_plan_version.deleteMany({
      where: { inspection_plan_id: { in: plans.map((row) => row.inspection_plan_id) } },
    });
    await prisma.inspection_plan.deleteMany({
      where: { inspection_plan_code: { startsWith: PREFIX } },
    });
    const items = { item: { item_code: { startsWith: PREFIX } } };
    await prisma.item_inspection_level_history.deleteMany({ where: items });
    await prisma.item_inspection_level.deleteMany({ where: items });
    const boms = { item: { item_code: { startsWith: PREFIX } } };
    await prisma.bom_component.deleteMany({ where: { bom: boms } });
    await prisma.bom.deleteMany({ where: boms });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });

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
