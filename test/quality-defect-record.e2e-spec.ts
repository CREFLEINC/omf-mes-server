/**
 * 불량 실적 목록·분포 (e2e) — I-20 PR ①b. `GET /quality/defect-records` · `…/distribution` 딱 둘.
 * ⛔ 등록 경로가 없다(계약 `x-internal-note`) — 픽스처는 전부 prisma 직접 INSERT(0단계 선례:
 * I-19 §0 #5 의 `inspection_request`).
 *
 * ⭐ 물리 CHECK 실측(migration `20260826000000_data_model_v4:136-146`) — `ck_defect_source` 가
 * `production_result_id IS NOT NULL OR inspection_result_id IS NOT NULL OR
 * (source_type_code IS NOT NULL AND source_document_id IS NOT NULL)` 를 요구한다. 픽스처는
 * production_result·inspection_result 를 만들지 않고 전 행에 `source_type_code`+`source_document_id`
 * 를 채워 그 갈래로 통과시킨다 — work_order·lot·item 픽스처가 통째로 필요 없어진다.
 * ⭐ `defect_qty CHECK (> 0)`(baseline) — 분모가 0 인 분포는 «매칭 0건»으로만 만들 수 있다
 * (양의 수량만 있는 행이 하나라도 잡히면 합계는 반드시 양수다) — #11 의 픽스처가 그래서 빈 기간이다.
 *
 * 두 창을 쓴다: 목록 창(09-21)과 분포 창(09-25)을 겹치지 않게 둬 서로의 집계가 섞이지 않는다.
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

const PREFIX = 'I20DR';
const LOGIN_ID = 'e2e-i20dr-probe';
const PASSWORD = 'PR-불량실적-비밀번호';
const RECORDS = '/api/quality/defect-records';
const DISTRIBUTION = `${RECORDS}/distribution`;

// 목록 창 — [LIST_FROM, LIST_TO). LIST_TO 와 «같은 시각»의 행(L4)은 빠져야 한다(#2).
const LIST_FROM = '2026-09-21T00:00:00.000Z';
const LIST_TO = '2026-09-22T00:00:00.000Z';
// 분포 창 — 목록 창과 안 겹친다.
const DIST_FROM = '2026-09-25T00:00:00.000Z';
const DIST_TO = '2026-09-27T00:00:00.000Z';
// 매칭 0건 창(#11) — 어느 픽스처도 여기 안 심는다.
const EMPTY_FROM = '2026-09-29T00:00:00.000Z';
const EMPTY_TO = '2026-09-30T00:00:00.000Z';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('불량 실적 목록·분포 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = {
    processA: 0n,
    processB: 0n,
    parent1: 0n, // 외관
    childA1: 0n, // 스크래치 — processA·processB 둘에 매핑(duplicateRisk=true 축)
    childA2: 0n, // 찍힘 — 매핑 0(duplicateRisk=false 축)
    parent2: 0n, // 치수
    childB1: 0n, // 외경초과
  };
  const listRowIds: Record<string, number> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeListFixtures();
    await makeDistributionFixtures();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const get = (url: string) => request(app.getHttpServer()).get(url).set('Cookie', cookie);
  const listPeriod = `detectedFrom=${LIST_FROM}&detectedTo=${LIST_TO}`;
  const distPeriod = `detectedFrom=${DIST_FROM}&detectedTo=${DIST_TO}`;

  describe('목록 — `GET /quality/defect-records`', () => {
    it('⭐ 목록 — 기간 없이 부르면 400 REQUIRED', async () => {
      const response = await get(RECORDS).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'detectedFrom', code: 'REQUIRED' });
    });

    it('⭐ 목록 — detectedTo 와 «같은 시각»의 행은 빠진다', async () => {
      const response = await get(`${RECORDS}?${listPeriod}`).expect(200);
      const returnedIds = response.body.items.map((item: { defectRecordId: number }) => item.defectRecordId);

      expect(returnedIds).not.toContain(listRowIds.boundary);
      expect(returnedIds).toContain(listRowIds.axisOcc);
    });

    it('목록 — sourceCode 로 거른다(안 걸리는 행이 실제로 빠진다)', async () => {
      const response = await get(`${RECORDS}?${listPeriod}&sourceCode=REPAIR`).expect(200);
      const returnedIds = response.body.items.map((item: { defectRecordId: number }) => item.defectRecordId);

      expect(returnedIds).toEqual([listRowIds.repair]);
      expect(returnedIds).not.toContain(listRowIds.axisOcc); // FIELD 원천 — 안 걸리는 행이 실제로 빠진다
    });

    it('목록 — 발생 공정과 검출 공정이 «다른 축»이다(각각 다른 결과)', async () => {
      // axisOcc: occ=A·det=B / axisDet: occ=B·det=A — 두 축을 섞으면 같은 결과가 나온다.
      const byOccurrence = await get(`${RECORDS}?${listPeriod}&occurrenceProcessId=${ids.processA}`).expect(200);
      const byDetection = await get(`${RECORDS}?${listPeriod}&detectionProcessId=${ids.processA}`).expect(200);
      const occIds = byOccurrence.body.items.map((item: { defectRecordId: number }) => item.defectRecordId);
      const detIds = byDetection.body.items.map((item: { defectRecordId: number }) => item.defectRecordId);

      expect(occIds).toContain(listRowIds.axisOcc);
      expect(occIds).not.toContain(listRowIds.axisDet);
      expect(detIds).toContain(listRowIds.axisDet);
      expect(detIds).not.toContain(listRowIds.axisOcc);
    });

    it('목록 — workOrderId 가 null 인 클레임 행도 나온다', async () => {
      const response = await get(`${RECORDS}?${listPeriod}`).expect(200);
      const claim = response.body.items.find((item: { defectRecordId: number }) => item.defectRecordId === listRowIds.claim);

      expect(claim).toBeDefined();
      expect(claim).toMatchObject({ workOrderId: null, sourceCode: 'CLAIM' });
      expect(validator('GET /quality/defect-records')(response.body)).toBe(true);
    });

    it('⭐ 목록 — 기본 정렬이 detected_at DESC 다', async () => {
      const response = await get(`${RECORDS}?${listPeriod}`).expect(200);
      const returnedIds = response.body.items.map((item: { defectRecordId: number }) => item.defectRecordId);

      // 통째로 단언(R-19) — 같은 시각 tie(sortTieLate·sortTieEarly)는 defect_record_id DESC 로 깨진다.
      expect(returnedIds).toEqual([
        listRowIds.sortTieLate,
        listRowIds.sortTieEarly,
        listRowIds.repair,
        listRowIds.claim,
        listRowIds.axisDet,
        listRowIds.axisOcc,
      ]);
    });

    it('목록 — sourceCode 는 물리 source_type_code 를 읽는다', async () => {
      const response = await get(`${RECORDS}?${listPeriod}&sourceCode=REPAIR`).expect(200);

      expect(response.body.items[0]).toMatchObject({ defectRecordId: listRowIds.repair, sourceCode: 'REPAIR' });
    });
  });

  describe('분포 — `GET /quality/defect-records/distribution`', () => {
    it('⭐ 분포 — groupBy 기본이 occurrenceProcess 다', async () => {
      const omitted = await get(`${DISTRIBUTION}?${distPeriod}`).expect(200);
      const explicit = await get(`${DISTRIBUTION}?${distPeriod}&groupBy=occurrenceProcess`).expect(200);

      expect(omitted.body.groupBy).toBe('occurrenceProcess');
      expect(omitted.body.nodes).toEqual(explicit.body.nodes);
      // ⭐ 반증 — defectCode 축이었다면 부모 롤업(2행)이 섞여 노드 수가 5가 됐을 것이다.
      expect(omitted.body.nodes).toHaveLength(4);
      expect(validator('GET /quality/defect-records/distribution')(omitted.body)).toBe(true);
    });

    it('분포 — enum 밖 groupBy 는 400 INVALID', async () => {
      // ⛔ 계약이 enum 3값을 이미 선언했다 — ajv 계약 가드가 서비스보다 먼저 막는다(R-19 · 중복 구현 안 함).
      const response = await get(`${DISTRIBUTION}?${distPeriod}&groupBy=bogus`).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'groupBy', code: 'INVALID' });
    });

    it('⭐ 분포 — 2계층이다(parentDefectCodeId 가 실린다)', async () => {
      const response = await get(`${DISTRIBUTION}?${distPeriod}&groupBy=defectCode`).expect(200);
      const byCode = (id: bigint) => response.body.nodes.find((n: { defectCodeId: number }) => n.defectCodeId === Number(id));
      const parent1 = byCode(ids.parent1);
      const childA1 = byCode(ids.childA1);

      expect(response.body.nodes).toHaveLength(5); // 부모 2(외관·치수) + 자식 3(스크래치·찍힘·외경초과)
      expect(parent1).not.toHaveProperty('parentDefectCodeId'); // 부모 자신은 «위»가 없다
      expect(parent1).toMatchObject({ recordCount: 3, defectQty: 20 }); // 스크래치(2·16) + 찍힘(1·4)
      expect(childA1).toMatchObject({ parentDefectCodeId: Number(ids.parent1), recordCount: 2, defectQty: 16 });
      // ⭐ 반증 — defectCode 축은 언제나 false(공정 축이 아니다).
      expect(childA1.duplicateRisk).toBe(false);
      expect(validator('GET /quality/defect-records/distribution')(response.body)).toBe(true);
    });

    it('⭐ 분포 — 대상이 0건이면 share 키가 «없다»(0 이 아니다)', async () => {
      const response = await get(`${DISTRIBUTION}?detectedFrom=${EMPTY_FROM}&detectedTo=${EMPTY_TO}`).expect(200);

      expect(response.body.nodes).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain('"share"');
    });

    it('분포 — duplicateRisk 가 공정 축에서만 true 다', async () => {
      const response = await get(`${DISTRIBUTION}?${distPeriod}&groupBy=occurrenceProcess`).expect(200);
      const childA1Nodes = response.body.nodes.filter((n: { defectCodeId: number }) => n.defectCodeId === Number(ids.childA1));
      const childA2Node = response.body.nodes.find((n: { defectCodeId: number }) => n.defectCodeId === Number(ids.childA2));

      // 스크래치는 processA·processB 둘에 매핑돼(defect_code_process) 두 노드 다 true.
      expect(childA1Nodes).toHaveLength(2);
      expect(childA1Nodes.every((n: { duplicateRisk: boolean }) => n.duplicateRisk === true)).toBe(true);
      // 찍힘은 매핑이 없다 — false.
      expect(childA2Node.duplicateRisk).toBe(false);
    });
  });

  async function makeMasters(): Promise<void> {
    const processA = await prisma.process.create({ data: { process_code: `${PREFIX}-PR-A`, process_name: `${PREFIX} 사출공정`, process_type_code: 'MOLDING' } });
    const processB = await prisma.process.create({ data: { process_code: `${PREFIX}-PR-B`, process_name: `${PREFIX} 포장공정`, process_type_code: 'PACKAGING' } });
    ids.processA = processA.process_id;
    ids.processB = processB.process_id;

    const codeOf = async (suffix: string, name: string, parentId: bigint | null) =>
      prisma.defect_code.create({ data: { defect_code: `${PREFIX}-DC-${suffix}`, defect_name: name, parent_defect_code_id: parentId } });
    const parent1 = await codeOf('P1', `${PREFIX} 외관`, null);
    ids.parent1 = parent1.defect_code_id;
    ids.childA1 = (await codeOf('A1', `${PREFIX} 스크래치`, parent1.defect_code_id)).defect_code_id;
    ids.childA2 = (await codeOf('A2', `${PREFIX} 찍힘`, parent1.defect_code_id)).defect_code_id;
    const parent2 = await codeOf('P2', `${PREFIX} 치수`, null);
    ids.parent2 = parent2.defect_code_id;
    ids.childB1 = (await codeOf('B1', `${PREFIX} 외경초과`, parent2.defect_code_id)).defect_code_id;

    // «스크래치»만 두 공정에 매인다(결정 12 N:M) — duplicateRisk 축.
    await prisma.defect_code_process.create({ data: { defect_code_id: ids.childA1, process_id: ids.processA } });
    await prisma.defect_code_process.create({ data: { defect_code_id: ids.childA1, process_id: ids.processB } });
  }

  async function makeListFixtures(): Promise<void> {
    const uom = await prisma.uom.findFirstOrThrow();

    const insert = async (
      key: string,
      overrides: { defectCodeId: bigint; occurrenceProcessId: bigint; detectionProcessId: bigint; sourceCode: string; detectedAt: string; qty: number },
    ) => {
      const row = await prisma.defect_record.create({
        data: {
          defect_code_id: overrides.defectCodeId,
          occurrence_process_id: overrides.occurrenceProcessId,
          detection_process_id: overrides.detectionProcessId,
          source_type_code: overrides.sourceCode,
          source_document_id: 1,
          defect_qty: overrides.qty,
          uom_id: uom.uom_id,
          detected_at: new Date(overrides.detectedAt),
        },
      });
      listRowIds[key] = Number(row.defect_record_id);
    };

    await insert('axisOcc', { defectCodeId: ids.childA1, occurrenceProcessId: ids.processA, detectionProcessId: ids.processB, sourceCode: 'FIELD', detectedAt: '2026-09-21T01:00:00.000Z', qty: 10 });
    await insert('axisDet', { defectCodeId: ids.childA2, occurrenceProcessId: ids.processB, detectionProcessId: ids.processA, sourceCode: 'PQC', detectedAt: '2026-09-21T02:00:00.000Z', qty: 5 });
    await insert('claim', { defectCodeId: ids.childA1, occurrenceProcessId: ids.processA, detectionProcessId: ids.processA, sourceCode: 'CLAIM', detectedAt: '2026-09-21T03:00:00.000Z', qty: 3 });
    await insert('boundary', { defectCodeId: ids.childA1, occurrenceProcessId: ids.processA, detectionProcessId: ids.processA, sourceCode: 'FIELD', detectedAt: LIST_TO, qty: 1 }); // 창 밖(같은 시각)
    await insert('repair', { defectCodeId: ids.childA1, occurrenceProcessId: ids.processA, detectionProcessId: ids.processA, sourceCode: 'REPAIR', detectedAt: '2026-09-21T05:00:00.000Z', qty: 2 });
    await insert('sortTieEarly', { defectCodeId: ids.childA1, occurrenceProcessId: ids.processA, detectionProcessId: ids.processA, sourceCode: 'FIELD', detectedAt: '2026-09-21T06:00:00.000Z', qty: 1 });
    await insert('sortTieLate', { defectCodeId: ids.childA1, occurrenceProcessId: ids.processA, detectionProcessId: ids.processA, sourceCode: 'FIELD', detectedAt: '2026-09-21T06:00:00.000Z', qty: 1 });
  }

  async function makeDistributionFixtures(): Promise<void> {
    const uom = await prisma.uom.findFirstOrThrow();
    const insert = (defectCodeId: bigint, processId: bigint, detectedAt: string, qty: number) =>
      prisma.defect_record.create({
        data: {
          defect_code_id: defectCodeId,
          occurrence_process_id: processId,
          detection_process_id: processId,
          source_type_code: 'FIELD',
          source_document_id: 1,
          defect_qty: qty,
          uom_id: uom.uom_id,
          detected_at: new Date(detectedAt),
        },
      });

    // 스크래치 2행(processA·processB 각 1) · 찍힘 1행 · 외경초과 1행. 합계 16+4+8=28.
    await insert(ids.childA1, ids.processA, '2026-09-25T01:00:00.000Z', 10);
    await insert(ids.childA1, ids.processB, '2026-09-25T02:00:00.000Z', 6);
    await insert(ids.childA2, ids.processA, '2026-09-25T03:00:00.000Z', 4);
    await insert(ids.childB1, ids.processA, '2026-09-25T04:00:00.000Z', 8);
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '불량실적조회', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });

    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** FK 역순으로 지운다. `beforeAll`·`afterAll` 둘 다 부른다(자가 치유 · §8-2). */
  async function cleanup(): Promise<void> {
    const codeScope = { defect_code: { startsWith: PREFIX } };
    await prisma.defect_record.deleteMany({ where: { defect_code: codeScope } });
    await prisma.defect_code_process.deleteMany({ where: { defect_code: codeScope } });
    await prisma.defect_code.deleteMany({ where: { defect_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});
