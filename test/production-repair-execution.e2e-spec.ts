/**
 * 수리 실행 — 목록 조회 1건(I-25 PR ①). 투입·반출(`POST` 둘, PR ③)은 이 파일에 뒤이어 더한다.
 *
 * ⭐ 조회가 보는 수리 실행은 **직접 INSERT** 한다 — 이 PR 에 `POST` 가 없다(PR ③ 몫).
 * ⭐ 구간형 — 상태 컬럼이 없다. `open` 은 `returned_at IS NULL` 의 여집합으로 푼다
 *    (I-25 §0 자리 3 ⓐ · `work-session-query.service.ts` 사본).
 * ⛔ 계약이 이 목록에 403 을 선언하지 않았다 — 권한 없는 계정을 세우지 않는다(§6-3).
 * ⛔ 상세 GET 이 계약에 없다 — 이 파일에서 만들지 않는다.
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

const LOGIN_ID = 'e2e-re-probe';
const PASSWORD = 'RE-수리실행-비밀번호';
const PREFIX = 'REE2E';
const REPAIRS = '/api/production/repair-executions';
const T0 = '2026-09-08T00:00:00.000Z';
const T1 = '2026-09-08T01:00:00.000Z';
const T2 = '2026-09-08T03:00:00.000Z';
const RETURNED_AT = '2026-09-08T05:00:00.000Z';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('수리 실행 목록 조회 1건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let defectMainId: number;
  let defectOtherLotId: number;
  let lotXId: number;
  /** re1·re2 동률(T1) · re3 다른 시각(T2) · re4 반출됨(open=false 대상) · re5 다른 LOT · re6 LOT 없음. */
  let re1Id: number;
  let re2Id: number;
  let re3Id: number;
  let re4Id: number;
  let re5Id: number;
  let re6Id: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    cookie = await login(LOGIN_ID, null, []);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록 200 + 응답 키 집합(계약 11칸 중 5칸만 참 — 널 허용 6칸은 「키 자체가 없다」)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${REPAIRS}?defectRecordId=${defectMainId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(validator('GET /production/repair-executions')(response.body)).toBe(true);
    const item = response.body.items.find((row: { repairExecutionId: number }) => row.repairExecutionId === re1Id);
    // ⛔ `toBe(undefined)` 는 널과 못 가른다(I-18 R-3) — `in` 연산자로 키 자체의 부재를 본다.
    expect('repairProcessId' in item).toBe(false);
    expect('returnedAt' in item).toBe(false);
    expect('repairResultCode' in item).toBe(false);
    expect('reintroducedLotId' in item).toBe(false);
    expect('terminalId' in item).toBe(false);
    expect('workerNo' in item).toBe(false);
    expect(Object.keys(item).sort()).toEqual([
      'defectRecordId',
      'repairExecutionId',
      'repairQty',
      'startedAt',
      'uomId',
    ]);
    // Decimal(repair_qty) 이 소수를 보존한 number 로 온다.
    expect(item.repairQty).toBe(40.5);
  });

  it('⭐ 정렬 — started_at desc + repair_execution_id desc(동률 두 행 포함 배열 통째)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${REPAIRS}?defectRecordId=${defectMainId}`)
      .set('Cookie', cookie)
      .expect(200);

    // re3(T2) 가 먼저, T1 동률(re1·re2)은 PK desc 로 re2 가 re1 보다 앞선다.
    expect(response.body.items.map((item: { repairExecutionId: number }) => item.repairExecutionId)).toEqual([
      re3Id,
      re2Id,
      re1Id,
    ]);
  });

  it('⭐ open 기본 true — 반출된 행(re4)이 안 나온다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${REPAIRS}?defectRecordId=${defectMainId}`)
      .set('Cookie', cookie)
      .expect(200);

    const ids = response.body.items.map((item: { repairExecutionId: number }) => item.repairExecutionId);
    expect(ids).not.toContain(re4Id);
    expect(new Set(ids)).toEqual(new Set([re1Id, re2Id, re3Id]));
  });

  it('⭐ open=false 는 여집합 — 반출된 행만 나온다(전체가 아니다)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${REPAIRS}?defectRecordId=${defectMainId}&open=false`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items.map((item: { repairExecutionId: number }) => item.repairExecutionId)).toEqual([
      re4Id,
    ]);
  });

  it('⭐ defectRecordId 필터 / lotId 필터(defect_record.lot_id 1홉) — 다른 LOT·LOT 없음 행이 안 섞인다', async () => {
    const byDefect = await request(app.getHttpServer())
      .get(`${REPAIRS}?defectRecordId=${defectOtherLotId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byDefect.body.items.map((item: { repairExecutionId: number }) => item.repairExecutionId)).toEqual([
      re5Id,
    ]);

    const byLot = await request(app.getHttpServer())
      .get(`${REPAIRS}?lotId=${lotXId}`)
      .set('Cookie', cookie)
      .expect(200);
    const lotIds = byLot.body.items.map((item: { repairExecutionId: number }) => item.repairExecutionId);
    expect(new Set(lotIds)).toEqual(new Set([re1Id, re2Id, re3Id]));
    // re5(다른 LOT)·re6(lot_id NULL) 은 안 섞인다.
    expect(lotIds).not.toContain(re5Id);
    expect(lotIds).not.toContain(re6Id);
  });

  it('목록이 startedFrom 이상 startedTo 미만 반개구간으로 걸러진다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${REPAIRS}?defectRecordId=${defectMainId}&startedFrom=${T1}&startedTo=${T2}`)
      .set('Cookie', cookie)
      .expect(200);

    // gte T1 — T1 행(re1·re2)은 포함. lt T2 — T2 정각의 re3 는 제외(반개구간 · L-3).
    const ids = response.body.items.map((item: { repairExecutionId: number }) => item.repairExecutionId);
    expect(new Set(ids)).toEqual(new Set([re1Id, re2Id]));
    expect(ids).not.toContain(re3Id);
  });

  it('page.total 이 필터 기준이고 page=1&size=1 이 1건만 낸다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${REPAIRS}?defectRecordId=${defectMainId}&page=1&size=1`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.page).toMatchObject({ page: 1, size: 1, total: 3 });
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].repairExecutionId).toBe(re3Id);
  });

  it('⭐ 인계 목록(A6)과 다른 결과 — 계약이 선언한 상한을 가드가 400 으로 막는다', async () => {
    const overSize = await request(app.getHttpServer())
      .get(`${REPAIRS}?size=201`)
      .set('Cookie', cookie)
      .expect(400);
    expect(overSize.body.errors).toBeDefined();

    const zeroPage = await request(app.getHttpServer())
      .get(`${REPAIRS}?page=0`)
      .set('Cookie', cookie)
      .expect(400);
    expect(zeroPage.body.errors).toBeDefined();
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '수리실행검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '수리실행검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '수리실행검사품목',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const defectCode = await prisma.defect_code.create({
      data: { defect_code: `${PREFIX}-DC`, defect_name: '수리실행검사불량' },
    });

    const lot = async (suffix: string) =>
      prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT-${suffix}`,
          item_id: item.item_id,
          lot_type_code: 'WIP',
          plant_id: plant.plant_id,
          initial_qty: 100,
          uom_id: uom.uom_id,
          source_type_code: 'WORK_ORDER',
          source_id: 1,
          status_code: 'NORMAL',
        },
      });
    const lotX = await lot('X');
    lotXId = Number(lotX.lot_id);
    const lotY = await lot('Y');

    let sourceDocumentSeq = 0;
    const defectRecord = async (lotId: bigint | null) => {
      sourceDocumentSeq += 1;
      return prisma.defect_record.create({
        data: {
          lot_id: lotId,
          defect_code_id: defectCode.defect_code_id,
          defect_qty: 1,
          uom_id: uom.uom_id,
          occurrence_process_id: process.process_id,
          detection_process_id: process.process_id,
          detected_at: new Date(T0),
          // `ck_defect_source` — production_result_id·inspection_result_id 가 둘 다 없으면
          // (source_type_code, source_document_id) 쌍이 있어야 한다. 이 조회 픽스처는 두 결과
          // 표를 세우지 않고 이 discriminator 로 최소 충족한다.
          source_type_code: 'MANUAL',
          source_document_id: sourceDocumentSeq,
        },
      });
    };
    const defectMain = await defectRecord(lotX.lot_id);
    defectMainId = Number(defectMain.defect_record_id);
    const defectOtherLot = await defectRecord(lotY.lot_id);
    defectOtherLotId = Number(defectOtherLot.defect_record_id);
    const defectNullLot = await defectRecord(null);

    const repairExecution = async (
      defectRecordId: bigint,
      startedAt: string,
      qty: number,
      returnedAt: string | null = null,
      repairResultCode: string | null = null,
    ) =>
      prisma.repair_execution.create({
        data: {
          defect_record_id: defectRecordId,
          started_at: new Date(startedAt),
          returned_at: returnedAt === null ? null : new Date(returnedAt),
          repair_qty: qty,
          uom_id: uom.uom_id,
          repair_result_code: repairResultCode,
        },
      });

    re1Id = Number((await repairExecution(defectMain.defect_record_id, T1, 40.5)).repair_execution_id);
    re2Id = Number((await repairExecution(defectMain.defect_record_id, T1, 12)).repair_execution_id);
    re3Id = Number((await repairExecution(defectMain.defect_record_id, T2, 8)).repair_execution_id);
    // 반출된 행 — open 기본값(true)이 제외하고 open=false 만 낸다.
    re4Id = Number(
      (await repairExecution(defectMain.defect_record_id, T0, 3, RETURNED_AT, 'SUCCEEDED')).repair_execution_id,
    );
    re5Id = Number((await repairExecution(defectOtherLot.defect_record_id, T1, 1)).repair_execution_id);
    re6Id = Number((await repairExecution(defectNullLot.defect_record_id, T1, 1)).repair_execution_id);
  }

  /** 역할 코드가 널이면 역할을 안 붙인다(조회 전용 세션). */
  async function login(loginId: string, roleCode: string | null, permissions: string[]): Promise<string[]> {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: '수리실행검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    if (roleCode !== null) {
      const role = await prisma.role.create({ data: { role_code: roleCode, role_name: '수리실행검사용' } });
      await prisma.role_permission.createMany({
        data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })),
      });
      await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    }
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 만든 행을 FK 역순으로 지운다(⛔ TRUNCATE 금지). */
  async function cleanup(): Promise<void> {
    const defectWhere = { defect_code: { defect_code: { startsWith: PREFIX } } };
    await prisma.repair_execution.deleteMany({ where: { defect_record: defectWhere } });
    await prisma.defect_record.deleteMany({ where: defectWhere });
    await prisma.defect_code.deleteMany({ where: { defect_code: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});
