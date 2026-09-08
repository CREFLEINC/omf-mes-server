/**
 * 불량 실적 목록·분포 (e2e) — I-20 PR ①b. `GET /quality/defect-records` · `…/distribution` 딱 둘.
 * ⛔ 등록 경로가 없다(계약 `x-internal-note`) — 픽스처는 전부 prisma 직접 INSERT(0단계 선례:
 * I-19 §0 #5 의 `inspection_request`).
 *
 * ⭐ 물리 CHECK 실측(migration `20260826000000_data_model_v4:136-146`) — `ck_defect_source` 가
 * `production_result_id IS NOT NULL OR inspection_result_id IS NOT NULL OR
 * (source_type_code IS NOT NULL AND source_document_id IS NOT NULL)` 를 요구한다. 픽스처는
 * production_result·inspection_result 를 만들지 않고 전 행에 `source_type_code`+`source_document_id`
 * 를 채워 그 갈래로 통과시킨다 — work_order 픽스처는 통째로 필요 없다. lot·item 은 itemId 필터
 * (PR #355 리뷰 Major 2 M5)에만 최소로 심는다(`makeItemFilterFixtures`).
 * ⭐ `defect_qty CHECK (> 0)`(baseline) — 분모가 0 인 분포는 «매칭 0건»으로만 만들 수 있다
 * (양의 수량만 있는 행이 하나라도 잡히면 합계는 반드시 양수다) — 「대상이 0건이면 nodes 가 빈
 * 배열이다」 픽스처가 그래서 빈 기간이다.
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
// 부모 코드 직행 창(PR #355 리뷰 Major 1) — 다른 창과 안 겹친다.
const PARENT_DIRECT_FROM = '2026-09-28T00:00:00.000Z';
const PARENT_DIRECT_TO = '2026-09-28T01:00:00.000Z';
// itemId 필터 창(PR #355 리뷰 Major 2 M5) — 다른 창과 안 겹친다.
const ITEM_FILTER_FROM = '2026-09-28T02:00:00.000Z';
const ITEM_FILTER_TO = '2026-09-28T03:00:00.000Z';

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
    item: 0n, // itemId 필터(M5) 전용 품목
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
    await makeParentDirectFixtures();
    await makeItemFilterFixtures();
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
    it('⭐ 분포 — 기간 없이 부르면 400 REQUIRED(PR #355 리뷰 Major 2 M6 — 목록만이 아니라 분포도 잠긴다)', async () => {
      const response = await get(DISTRIBUTION).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'detectedFrom', code: 'REQUIRED' });
    });

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

    it('⭐ 분포 — 부모 코드에 직접 달린 행이 있어도 그 코드의 노드는 하나다(PR #355 리뷰 Major 1)', async () => {
      const response = await get(`${DISTRIBUTION}?groupBy=defectCode&detectedFrom=${PARENT_DIRECT_FROM}&detectedTo=${PARENT_DIRECT_TO}`).expect(200);
      const parentNodes = response.body.nodes.filter((n: { defectCodeId: number }) => n.defectCodeId === Number(ids.parent1));

      // 부모 101(외관) 직행 qty 5 + 자식 102(스크래치) qty 10 — 롤업이 직행 행을 빠뜨리면 15 대신 10 이 나온다.
      expect(parentNodes).toHaveLength(1); // 롤업(합산)과 잎(직행)으로 갈라진 둘이 아니라 하나
      expect(parentNodes[0]).toMatchObject({ recordCount: 2, defectQty: 15 });
      expect(parentNodes[0]).not.toHaveProperty('parentDefectCodeId');
      // 노드는 정확히 둘 — 부모 롤업(직행 5 를 포함한 15) + 자식(스크래치, 10). 잎 노드가 안 생긴다.
      expect(response.body.nodes).toHaveLength(2);
      const childNode = response.body.nodes.find((n: { defectCodeId: number }) => n.defectCodeId === Number(ids.childA1));
      expect(childNode).toMatchObject({ parentDefectCodeId: Number(ids.parent1), recordCount: 1, defectQty: 10 });
      expect(parentNodes[0].share).toBeCloseTo(100); // 부모 롤업 총량(15) = 이 창의 totalQty(15)
      expect(childNode.share).toBeCloseTo((10 / 15) * 100);
      expect(validator('GET /quality/defect-records/distribution')(response.body)).toBe(true);
    });

    it('⭐ 분포 — 대상이 0건이면 nodes 가 빈 배열이다', async () => {
      // #11 이름 정정(PR #355 리뷰 Major 2 M3) — 이 픽스처는 「share 가 0 이 아니라 없다」 분기를
      // 잠그지 못한다. defect_qty CHECK(>0) 상 grouped 가 비면 totalQty===0 분기 자체가 도달
      // 불가라(shareOf 주석 참조), 실제로 잠그는 것은 「0건이면 빈 배열」뿐이다.
      const response = await get(`${DISTRIBUTION}?detectedFrom=${EMPTY_FROM}&detectedTo=${EMPTY_TO}`).expect(200);

      expect(response.body.nodes).toEqual([]);
      expect(validator('GET /quality/defect-records/distribution')(response.body)).toBe(true);
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

    it('⭐ 분포 — groupBy=detectionProcess 가 발생 축과 «다른» 결과다(PR #355 리뷰 Major 2 M4)', async () => {
      const byOccurrence = await get(`${DISTRIBUTION}?${distPeriod}&groupBy=occurrenceProcess`).expect(200);
      const byDetection = await get(`${DISTRIBUTION}?${distPeriod}&groupBy=detectionProcess`).expect(200);

      expect(byOccurrence.body.nodes).toHaveLength(4);
      // detectionAxisAlt 행(스크래치, 검출=processB) 이 스크래치@processB(검출도 processB) 행과
      // 검출 축에서 합쳐져 3 노드가 된다 — 발생 축 그대로였다면 여기도 4 였을 것이다.
      expect(byDetection.body.nodes).toHaveLength(3);
      expect(byDetection.body.nodes).not.toEqual(byOccurrence.body.nodes);
      const merged = byDetection.body.nodes.find((n: { defectCodeId: number }) => n.defectCodeId === Number(ids.childA1));
      expect(merged).toMatchObject({ recordCount: 2, defectQty: 16 });
    });

    it('분포 — itemId 로 거른다(안 걸리는 행이 실제로 빠진다, PR #355 리뷰 Major 2 M5)', async () => {
      const itemPeriod = `detectedFrom=${ITEM_FILTER_FROM}&detectedTo=${ITEM_FILTER_TO}`;
      const filtered = await get(`${DISTRIBUTION}?${itemPeriod}&itemId=${ids.item}`).expect(200);
      const unfiltered = await get(`${DISTRIBUTION}?${itemPeriod}`).expect(200);

      const sumQty = (nodes: Array<{ defectQty: number }>) => nodes.reduce((sum, n) => sum + n.defectQty, 0);
      expect(sumQty(filtered.body.nodes)).toBe(7); // lot(품목 연결) 행만
      expect(sumQty(unfiltered.body.nodes)).toBe(16); // lot 미연결 행(9)도 포함 — 안 걸리는 행이 실제로 빠진다
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
    const insert = (defectCodeId: bigint, occurrenceProcessId: bigint, detectedAt: string, qty: number, detectionProcessId: bigint = occurrenceProcessId) =>
      prisma.defect_record.create({
        data: {
          defect_code_id: defectCodeId,
          occurrence_process_id: occurrenceProcessId,
          detection_process_id: detectionProcessId,
          source_type_code: 'FIELD',
          source_document_id: 1,
          defect_qty: qty,
          uom_id: uom.uom_id,
          detected_at: new Date(detectedAt),
        },
      });

    // 스크래치 2행(processA·processB 각 1) · 찍힘 1행 · 외경초과 1행. 합계 16+4+8=28.
    // ⭐ 첫 행만 검출 공정을 processB 로 다르게 심는다(PR #355 리뷰 Major 2 M4) — 발생==검출이면
    // groupBy=detectionProcess 가 발생 축과 같은 결과를 내 축을 못 가른다.
    await insert(ids.childA1, ids.processA, '2026-09-25T01:00:00.000Z', 10, ids.processB);
    await insert(ids.childA1, ids.processB, '2026-09-25T02:00:00.000Z', 6);
    await insert(ids.childA2, ids.processA, '2026-09-25T03:00:00.000Z', 4);
    await insert(ids.childB1, ids.processA, '2026-09-25T04:00:00.000Z', 8);
  }

  /** PR #355 리뷰 Major 1 — 부모 코드(외관)에 «직접» 달린 행 + 그 자식(스크래치)의 행. */
  async function makeParentDirectFixtures(): Promise<void> {
    const uom = await prisma.uom.findFirstOrThrow();
    const insert = (defectCodeId: bigint, detectedAt: string, qty: number) =>
      prisma.defect_record.create({
        data: {
          defect_code_id: defectCodeId,
          occurrence_process_id: ids.processA,
          detection_process_id: ids.processA,
          source_type_code: 'FIELD',
          source_document_id: 1,
          defect_qty: qty,
          uom_id: uom.uom_id,
          detected_at: new Date(detectedAt),
        },
      });

    await insert(ids.parent1, '2026-09-28T00:10:00.000Z', 5); // 부모(외관) 직행
    await insert(ids.childA1, '2026-09-28T00:20:00.000Z', 10); // 자식(스크래치)
  }

  /** PR #355 리뷰 Major 2 M5 — lot(품목) 연결 행 하나 + 미연결 행 하나(itemId 필터 반증용). */
  async function makeItemFilterFixtures(): Promise<void> {
    const uom = await prisma.uom.findFirstOrThrow();
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: `${PREFIX} 불량실적법인`, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: `${PREFIX} 불량실적공장`, timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: `${PREFIX} 불량실적품목`, item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item = item.item_id;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: item.item_id,
        lot_type_code: 'PRODUCT',
        plant_id: plant.plant_id,
        initial_qty: 100,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });

    const insert = (lotId: bigint | undefined, detectedAt: string, qty: number) =>
      prisma.defect_record.create({
        data: {
          defect_code_id: ids.childA1,
          occurrence_process_id: ids.processA,
          detection_process_id: ids.processA,
          source_type_code: 'FIELD',
          source_document_id: 1,
          lot_id: lotId,
          defect_qty: qty,
          uom_id: uom.uom_id,
          detected_at: new Date(detectedAt),
        },
      });

    await insert(lot.lot_id, '2026-09-28T02:10:00.000Z', 7); // lot(품목) 연결 — itemId 로 걸린다
    await insert(undefined, '2026-09-28T02:20:00.000Z', 9); // lot 미연결 — itemId 필터에 안 걸린다
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
    // itemId 필터 픽스처(M5) — defect_record 는 위에서 이미 지워졌으니 FK 역순으로 lot→item→plant→legal_entity.
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
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
