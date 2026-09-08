/**
 * 처분 결정 목록·상세·이 부적합의 결정 (e2e) — I-21 PR ②a″·②b. `GET /quality/disposition-decisions` ·
 * `…/{dispositionDecisionId}` · `…/nonconformances/{nonconformanceId}/disposition-decisions`(+`summary`)
 * 셋이다. 후보(③)·특채(⑤)·쓰기(⑥⑦)는 다른 PR 몫이라 이 파일은 그 셋만 본다 — 뒤 PR 들이 이
 * 파일에 `describe` 를 더한다(회귀 `quality-` 규약).
 *
 * 등록·판정 저장 오퍼레이션이 아직 없어(⑥⑦) 픽스처는 전부 prisma 직접 INSERT 다(0단계 선례).
 * `disposition-decision`(D1~D3·tie·boundary)은 전부 ncA 하나에 달아 필터·정렬·페이지 단언을
 * 「이 부적합의 판정 6건」한 세트로 겹치지 않게 잠근다(§8-1 변형).
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

const PREFIX = 'I21DA';
const LOGIN_ID = 'e2e-i21da-probe';
const PASSWORD = 'PR-처분결정조회-비밀번호';
const DECISIONS = '/api/quality/disposition-decisions';

// ncA 의 판정 6건 — decided_at 축. WINDOW_TO 와 «같은 시각»(boundary)은 기간 필터에서 빠진다.
const T1 = '2026-09-01T01:00:00.000Z'; // D1 — SCRAP
const T2 = '2026-09-01T02:00:00.000Z'; // D2 — REWORK
const T3 = '2026-09-01T03:00:00.000Z'; // D3 — NORMAL
const TIE = '2026-09-01T04:00:00.000Z'; // tieA·tieB — 동률
const WINDOW_FROM = '2026-09-01T00:00:00.000Z';
const WINDOW_TO = '2026-09-01T05:00:00.000Z'; // boundary 도 이 시각 — 반열림 검증

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

describe('처분 결정 목록·상세 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let userId = 0n;

  const ids = {
    plant: 0n,
    item1: 0n,
    item2: 0n,
    uom: 0n,
    uom2: 0n,
    warehouse1: 0n,
    warehouse2: 0n,
    location1: 0n,
    lotA: 0n,
    lotB: 0n,
    lotM1: 0n,
    lotM2: 0n,
    lotN1: 0n,
    lotN2: 0n,
  };
  const ncIds: Record<string, bigint> = {};
  const decisionIds: Record<string, number> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUser();
    await makeMasters();
    await makeFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const get = (url: string) => request(app.getHttpServer()).get(url).set('Cookie', cookie);
  const ncAScope = () => `nonconformanceId=${ncIds.ncA}`;
  // 정렬(decided_at DESC, id DESC) — boundary(T5)>tieB(T4·id큼)>tieA(T4·id작음)>D3>D2>D1>atFrom(WINDOW_FROM).
  // ⭐⭐ 리뷰 Major-3 — atFrom 이 «시작 경계와 같은 시각»이다. 끝 경계(boundary)만 있으면
  // `decidedFrom >=` 를 `>` 로 바꿔도 e2e 가 초록이었다(WINDOW_FROM 시각 행이 그때는 없었다).
  const ncAOrder = ['boundary', 'tieB', 'tieA', 'D3', 'D2', 'D1', 'atFrom'];

  describe('목록 — 필터 전수', () => {
    it('dispositionTypeCode=SCRAP 이 D2·D3·REWORK 계열을 뺀다', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}&dispositionTypeCode=SCRAP`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).toEqual([decisionIds.D1]);
    });

    it('nonconformanceId 필터 — ncB(D4)를 뺀다', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).not.toContain(decisionIds.D4);
      expect(returned).toContain(decisionIds.D1);
    });

    it('itemId 필터 — item2(D4)만 집고 item1(ncA)을 뺀다', async () => {
      const response = await get(`${DECISIONS}?itemId=${ids.item2}`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).toEqual([decisionIds.D4]);
    });

    it('lotId 필터 — EXISTS 로 정확히 그 LOT 이 걸린 판정만 집는다(lotB 는 D4 뿐)', async () => {
      const response = await get(`${DECISIONS}?lotId=${ids.lotB}`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).toEqual([decisionIds.D4]);
    });

    it('warehouseId 필터 — WH1(lotA 잔액)이 D1 을 집고, 다른 창고(lotB)의 D4 는 안 걸린다', async () => {
      // ⛔ ncAScope 를 안 준다 — D4(lotB·WH2)가 애초에 안 걸려야(EXISTS) 하는 것을 보이려면
      // ncA 로 미리 좁히지 않은 채로 걸러야 한다(안 걸리는 행이 실제로 「필터가」 뺀 것이다).
      const response = await get(`${DECISIONS}?warehouseId=${ids.warehouse1}`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).toContain(decisionIds.D1);
      expect(returned).not.toContain(decisionIds.D4);
      expect(returned).not.toContain(decisionIds.D5); // ncMulti 는 잔액을 안 만들었다 — EXISTS 가 빈다
    });

    it('⭐ reinstatable=true 가 [D3] 뿐이다(SCRAP·REWORK 계열은 빠진다)', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}&reinstatable=true`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).toEqual([decisionIds.D3]);
    });

    it('reinstatable=false — D3 을 빼고 나머지(D1 포함)는 남는다(안 걸리는 행)', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}&reinstatable=false`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).not.toContain(decisionIds.D3);
      expect(returned).toContain(decisionIds.D1);
    });

    it('⭐⭐ followUpPending=true 가 [D1] 뿐이다 — D2·D3(및 REWORK 계열)이 안 든다(R-3 ⓓ)', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}&followUpPending=true`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).toEqual([decisionIds.D1]);
    });

    it('followUpPending=false — D1 을 빼고 D2·D3 은 남는다', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}&followUpPending=false`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).not.toContain(decisionIds.D1);
      expect(returned).toContain(decisionIds.D2);
      expect(returned).toContain(decisionIds.D3);
    });

    it('⭐⭐ D1 의 followUpQty=30·PARTIAL — CANCELLED 20 EA·다른 문서유형 20 EA 는 «안» 더해진다(R-3 ⓑ · 리뷰 Major-2)', async () => {
      // 이 단언이 30 을 지킨다는 것 자체가 두 조건을 함께 잠근다 — CANCELLED(상태 축 · I-20 ①c 형)
      // «와» D1-OTHER-DOC(판별자 축 · 리뷰 Major-2). `source_document_type_code` 조건을 지우면
      // 50 이 된다(같은 id·다른 문서 유형인 그 출고까지 합산되므로).
      const response = await get(`${DECISIONS}?${ncAScope()}&dispositionTypeCode=SCRAP`).expect(200);

      expect(response.body.items[0]).toMatchObject({ followUpQty: 30, followUpStatusCode: 'PARTIAL' });
    });

    it('⭐⭐ 「한계와 같은 값」 — SCRAP 이고 postedQty=decisionQty(25=25)이면 COMPLETED·followUpPending=false', async () => {
      const scope = `nonconformanceId=${ncIds.ncScrapDone}`;
      const detail = await get(`${DECISIONS}?${scope}`).expect(200);
      expect(detail.body.items[0]).toMatchObject({ followUpQty: 25, followUpStatusCode: 'COMPLETED' });

      // ⭐ 이 경계가 없으면 SQL 의 `<` 를 지우거나(타입만 검사) `<=` 로 바꿔도(완료분을 여전히
      // 「대기」로 본다) 그물 밖이다 — D1(PARTIAL) 하나로는 두 변이 다 초록이다.
      const pending = await get(`${DECISIONS}?${scope}&followUpPending=true`).expect(200);
      expect(pending.body.items).toEqual([]);
      const done = await get(`${DECISIONS}?${scope}&followUpPending=false`).expect(200);
      expect(done.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId)).toEqual([decisionIds.DscrapDone]);
    });

    it('⭐⭐ 리뷰 Major-1 — SCRAP 이고 출고가 «0행»이어도 followUpPending=true 목록에서 안 사라진다', async () => {
      const scope = `nonconformanceId=${ncIds.ncScrapNone}`;
      // `coalesce(sum(...), 0)` 을 지우면 `sum()` 이 NULL 이 되어 두 갈래 «모두»에서 이 행이
      // 증발한다(3값 논리 · W-04-10 진입 목록이 통째로 빈다) — 무필터 목록의 `?? 0` 매퍼는
      // 이 사고를 못 잡는다(뷰 단계에서만 가려진다). 질의 단계에서 직접 잠근다.
      const pending = await get(`${DECISIONS}?${scope}&followUpPending=true`).expect(200);
      expect(pending.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId)).toEqual([decisionIds.DscrapNone]);
      const done = await get(`${DECISIONS}?${scope}&followUpPending=false`).expect(200);
      expect(done.body.items).toEqual([]);

      const detail = await get(`${DECISIONS}?${scope}`).expect(200);
      expect(detail.body.items[0]).toMatchObject({ followUpQty: 0, followUpStatusCode: 'NOT_STARTED' });
    });

    it('D2·D3 의 followUpQty=0·NOT_STARTED(원천 0 을 「모른다」로 접지 않는다)', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}`).expect(200);
      const d2 = response.body.items.find((i: { dispositionDecisionId: number }) => i.dispositionDecisionId === decisionIds.D2);
      const d3 = response.body.items.find((i: { dispositionDecisionId: number }) => i.dispositionDecisionId === decisionIds.D3);

      expect(d2).toMatchObject({ followUpQty: 0, followUpStatusCode: 'NOT_STARTED' });
      expect(d3).toMatchObject({ followUpQty: 0, followUpStatusCode: 'NOT_STARTED' });
    });
  });

  describe('목록 — 기간(갈래 B)·정렬·페이지', () => {
    it('⭐ decidedFrom 만 오면 400 PAIR', async () => {
      const response = await get(`${DECISIONS}?decidedFrom=${T1}`).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'decidedTo', code: 'PAIR' });
    });

    it('⭐ decidedTo 만 오면 400 PAIR', async () => {
      const response = await get(`${DECISIONS}?decidedTo=${T1}`).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'decidedTo', code: 'PAIR' });
    });

    it('⭐ 둘 다 없으면 통과한다(이력 모드가 아니다)', async () => {
      await get(`${DECISIONS}?${ncAScope()}`).expect(200);
    });

    it('⭐ WINDOW_TO 와 «같은 시각»의 boundary 는 빠진다(반열림 끝 경계)', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}&decidedFrom=${WINDOW_FROM}&decidedTo=${WINDOW_TO}`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).not.toContain(decisionIds.boundary);
      expect(returned).toContain(decisionIds.D1);
    });

    it('⭐⭐ 리뷰 Major-3 — WINDOW_FROM 과 «같은 시각»의 atFrom 은 «든다»(반열림 시작 경계는 포함)', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}&decidedFrom=${WINDOW_FROM}&decidedTo=${WINDOW_TO}`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      // `>=` 를 `>` 로 바꾸면 이 행이 빠진다 — boundary(끝 경계) 단언만으로는 못 잡는다.
      expect(returned).toContain(decisionIds.atFrom);
    });

    it('⭐⭐ 기본 정렬 — decided_at DESC, 동률은 disposition_decision_id DESC(통째 단언)', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).toEqual(ncAOrder.map((key) => decisionIds[key]));
    });

    it('⭐ page=1&size=2 와 page=2&size=2 가 겹치지 않는다', async () => {
      const page1 = await get(`${DECISIONS}?${ncAScope()}&page=1&size=2`).expect(200);
      const page2 = await get(`${DECISIONS}?${ncAScope()}&page=2&size=2`).expect(200);
      const idsOf = (body: { items: { dispositionDecisionId: number }[] }) => body.items.map((i) => i.dispositionDecisionId);

      expect(idsOf(page1.body)).toEqual(ncAOrder.slice(0, 2).map((key) => decisionIds[key]));
      expect(idsOf(page2.body)).toEqual(ncAOrder.slice(2, 4).map((key) => decisionIds[key]));
      expect(page1.body.page).toEqual({ page: 1, size: 2, total: ncAOrder.length });
    });

    it('응답이 계약 스키마를 통과한다(ajv)', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}`).expect(200);
      expect(validator('GET /quality/disposition-decisions')(response.body)).toBe(true);
    });
  });

  describe('상세', () => {
    it('200 · «우리가 낸» ETag 가 없다(계약 미선언 — setEtag 를 안 쓴다)', async () => {
      const response = await get(`${DECISIONS}/${decisionIds.D1}`).expect(200);
      // ⛔ Express 가 모든 JSON 응답에 약한 해시 ETag(`W/"…"`)를 자동으로 붙인다 — 그것과
      // `setEtag()`(공유계약 A-4 · 순정수 문자열)가 다르다는 것만 잠근다(선례 `app-role.e2e-
      // spec.ts:150` 의 `toBe('1')` 형과 반대 방향). 여기서 숫자 문자열이 나오면 누군가
      // `setEtag()` 를 붙였다는 뜻이다 — 계약이 이 오퍼레이션에 ETag 를 선언하지 않았다(§1-1).
      expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
      expect(response.body).toMatchObject({ dispositionDecisionId: decisionIds.D1, lotId: Number(ids.lotA) });
      expect(validator('GET /quality/disposition-decisions/{dispositionDecisionId}')(response.body)).toBe(true);
    });

    it('없는 id → 404', async () => {
      await get(`${DECISIONS}/9999999`).expect(404);
    });

    it('⭐ N5 형(LOT 2건) 판정은 lotId·lotNo 키를 생략한다(첫 LOT 을 조용히 고르지 않는다)', async () => {
      const response = await get(`${DECISIONS}/${decisionIds.D5}`).expect(200);

      expect(response.body).not.toHaveProperty('lotId');
      expect(response.body).not.toHaveProperty('lotNo');
    });

    it('⭐⭐ R-13 — 조인 칸(itemCode·itemName·nonconformanceNo·decidedByName)이 실제로 채워진다', async () => {
      const response = await get(`${DECISIONS}/${decisionIds.D1}`).expect(200);

      expect(response.body).toMatchObject({
        itemCode: `${PREFIX}-IT1`,
        itemName: `${PREFIX} 품목1`,
        nonconformanceNo: `${PREFIX}-NC-ncA`,
        decidedByName: '처분결정조회',
      });
      expect(response.body).not.toHaveProperty('approvalRequestId'); // 오늘 언제나 NULL — 키 생략(§1-3)
    });
  });

  /**
   * 처분 판정 대상 목록(I-21 PR ③) — `GET /quality/disposition-candidates`. §4-1(R-4) 반영본.
   * ⭐ 계약이 «다른 파일»(`shipment-04제품출하.json`)이라 ajv 검증기도 따로 둔다.
   * ⭐ 1순위 픽스처(§0 지시) — `is_defect=false` 창고에만 잔액이 있는 LOT(모집단에서 빠진다) ·
   * 불량창고가 «둘」인 LOT(행이 남고 하나가 실린다) · PRODUCT 갈래(RETURN 전용 칸이 null) ·
   * `q`·정렬 동률·기간 경계.
   */
  describe('후보 목록 — GET /quality/disposition-candidates', () => {
    const CANDIDATES = '/api/quality/disposition-candidates';
    let plantId = 0n;
    let businessUnitId = 0n;
    let legalEntityId = 0n;
    const wh: Record<string, bigint> = {};
    const loc: Record<string, bigint> = {};
    const item: Record<string, bigint> = {};
    const cand: Record<string, bigint> = {};
    let workerId = 0n;

    const T_OLD = '2020-01-15T00:00:00.000Z';
    const T_RETURN = '2026-08-01T00:00:00.000Z';
    const T_PRODUCT = '2026-08-02T00:00:00.000Z';
    const T_OTHER = '2026-08-03T00:00:00.000Z';
    const T_TIE = '2026-08-10T00:00:00.000Z';

    function candidateValidator(status = 200): ValidateFunction {
      const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8')) as object;
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      addFormats(ajv);
      for (const f of ['int64', 'int32', 'double', 'float']) ajv.addFormat(f, true);
      ajv.addSchema(contract, 'https://omf-mes.invalid/shipment-contract');
      const pointer = `/paths/~1quality~1disposition-candidates/get/responses/${status}/content/application~1json/schema`;
      return ajv.compile({ $ref: `https://omf-mes.invalid/shipment-contract#${pointer}` });
    }

    beforeAll(async () => {
      plantId = (await prisma.plant.findFirstOrThrow({ where: { plant_code: `${PREFIX}-P` } })).plant_id;
      businessUnitId = (await prisma.business_unit.findFirstOrThrow({ where: { business_unit_code: `${PREFIX}-BU` } })).business_unit_id;
      legalEntityId = (await prisma.legal_entity.findFirstOrThrow({ where: { legal_entity_code: `${PREFIX}-LE` } })).legal_entity_id;

      await cleanupCandidates(); // 자가 치유 — 이전 실패 실행의 잔여물을 지운다.
      const worker = await prisma.worker.create({
        data: { worker_no: `${PREFIX}-WKC`, worker_name: '후보목록검사원', business_unit_id: businessUnitId, plant_id: plantId, status_code: 'EMPLOYED' },
      });
      workerId = worker.worker_id;

      await makeCandidateMasters();
      await makeCandidateFixtures();
    });

    afterAll(async () => cleanupCandidates());

    const get = (url: string) => request(app.getHttpServer()).get(url).set('Cookie', cookie);
    const lotIdsOf = (body: { items: { lotId: number }[] }): number[] => body.items.map((i) => i.lotId);

    it('#1 원천 둘(RETURN·PRODUCT)이 한 목록으로 나온다', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c}`).expect(200);
      const rows = lotIdsOf(response.body);

      expect(rows).toContain(Number(cand.rtn));
      expect(rows).toContain(Number(cand.prod));
      const rtn = response.body.items.find((i: { lotId: number }) => i.lotId === Number(cand.rtn));
      const prod = response.body.items.find((i: { lotId: number }) => i.lotId === Number(cand.prod));
      expect(rtn).toMatchObject({ sourceCode: 'RETURN' });
      expect(prod).toMatchObject({ sourceCode: 'PRODUCT' });
    });

    it('#2 ⭐ 불량창고(120)·완제품창고(80)에 걸친 LOT 이 나오고 quantity 는 불량창고 잔액만이다', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.split}`).expect(200);

      expect(response.body.items).toEqual([expect.objectContaining({ lotId: Number(cand.split), warehouseId: Number(wh.d1), quantity: 120 })]);
    });

    it('#3 불량창고 잔액이 0(on_hand_qty=0)인 LOT 은 안 나온다', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c}`).expect(200);

      expect(lotIdsOf(response.body)).not.toContain(Number(cand.zero));
    });

    it('#3-a 잔액이 «완제품창고에만» 있는 LOT 은 전체 목록에서 빠진다', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c}`).expect(200);

      expect(lotIdsOf(response.body)).not.toContain(Number(cand.goodOnly));
    });

    it('#3-b ⭐ 불량창고가 0행이면 잔액 전건으로 «접지 않는다» — lotId 로 좁혀도 목록이 빈다', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.goodOnly}`).expect(200);

      expect(response.body).toMatchObject({ items: [], page: { total: 0 } });
    });

    it('#4 두 원천에 다 걸리는 LOT 은 «한 행»이고 RETURN 이 이긴다(inspectionResultId 는 null)', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.both}`).expect(200);

      expect(response.body.items).toEqual([expect.objectContaining({ lotId: Number(cand.both), sourceCode: 'RETURN', inspectionResultId: null })]);
    });

    it('#5 sourceCode=PRODUCT 가 RETURN(rtn)을 빼고 PRODUCT(prod)를 남긴다', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c}&sourceCode=PRODUCT`).expect(200);
      const rows = lotIdsOf(response.body);

      expect(rows).toContain(Number(cand.prod));
      expect(rows).not.toContain(Number(cand.rtn));
    });

    it('#6 withoutNonconformanceOnly=true — 열린 부적합이 있는 rtn 을 빼고 없는 prod 를 남긴다', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c}&withoutNonconformanceOnly=true`).expect(200);
      const rows = lotIdsOf(response.body);

      expect(rows).not.toContain(Number(cand.rtn));
      expect(rows).toContain(Number(cand.prod));
      // ⭐ count(where) 가 rows 와 «같은» 필터를 봐야 한다 — count 만 필터를 놓치면 items 는 줄어도
      // page.total 은 그대로라 이 단언이 없으면 그 어긋남이 안 잡힌다.
      expect(response.body.page.total).toBe(rows.length);
    });

    it('#7 withoutNonconformanceOnly=true 인데 «종결된» 부적합만 있는 LOT 은 남는다', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c}&withoutNonconformanceOnly=true`).expect(200);

      expect(lotIdsOf(response.body)).toContain(Number(cand.ncClosed));
    });

    it('#8 receivedTo 와 «같은 날»의 행이 나온다(양끝 포함)', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.rtn}&receivedTo=2026-08-01`).expect(200);

      expect(lotIdsOf(response.body)).toContain(Number(cand.rtn));
    });

    it('#9 receivedFrom 이 하루 뒤면 안 나온다', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.rtn}&receivedFrom=2026-08-02`).expect(200);

      expect(lotIdsOf(response.body)).not.toContain(Number(cand.rtn));
    });

    it('#9-a ⭐⭐ 기간 필터를 넣어도 PRODUCT 갈래가 살아남는다(R-18 — receivedAt 공통 칸)', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.prod}&receivedFrom=2026-08-02&receivedTo=2026-08-02`).expect(200);

      expect(lotIdsOf(response.body)).toContain(Number(cand.prod));
    });

    it('#10 기간을 아예 안 줘도 200 이고 오래된 건이 나온다', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.old}`).expect(200);

      expect(lotIdsOf(response.body)).toContain(Number(cand.old));
    });

    it('#11 q — LOT 번호·입고번호·품목코드·품목명 네 칸을 본다', async () => {
      const byLotNo = await get(`${CANDIDATES}?q=${PREFIX}-LOT-C-RTN`).expect(200);
      const byReceiptNo = await get(`${CANDIDATES}?q=${PREFIX}-GR-C-RTN`).expect(200);
      const byItemCode = await get(`${CANDIDATES}?q=${PREFIX}-ITC`).expect(200);
      const byItemName = await get(`${CANDIDATES}?q=${PREFIX}후보품목`).expect(200);

      for (const response of [byLotNo, byReceiptNo, byItemCode, byItemName]) {
        expect(lotIdsOf(response.body)).toContain(Number(cand.rtn));
      }
    });

    it('#12 ⭐ PRODUCT 갈래는 goodsReceiptId·receiptNo·partnerName 을 «null» 로 싣는다(키 생략이 아니다)', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.prod}`).expect(200);

      expect(response.body.items[0]).toMatchObject({ goodsReceiptId: null, receiptNo: null, partnerName: null });
      expect(response.body.items[0]).toHaveProperty('goodsReceiptId');
    });

    it('#13 RETURN 갈래의 partnerName 은 원 출하 거래처다', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.rtn}`).expect(200);

      expect(response.body.items[0]).toMatchObject({ partnerName: `${PREFIX} 원출하거래처`, sourceCode: 'RETURN' });
    });

    it('#14 이미 부적합이 있는 대상은 nonconformanceId·No·StatusCode 를 함께 싣는다', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.rtn}`).expect(200);

      expect(response.body.items[0]).toMatchObject({
        nonconformanceId: Number(cand.ncOfRtn),
        nonconformanceNo: `${PREFIX}-NC-CAND-RTN`,
        nonconformanceStatusCode: 'PENDING_DECISION',
      });
    });

    it('#15 ⭐ 정렬 — received_at DESC · ⛔ NULLS LAST 없음 · 2차 키 lot_id DESC(동률)', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c}`).expect(200);
      const rows = lotIdsOf(response.body);

      // 주 정렬 — PRODUCT(T_PRODUCT, 나중)가 RETURN(T_RETURN, 먼저)보다 앞선다.
      expect(rows.indexOf(Number(cand.prod))).toBeLessThan(rows.indexOf(Number(cand.rtn)));

      const tieResponse = await get(`${CANDIDATES}?itemId=${item.tie}`).expect(200);
      expect(lotIdsOf(tieResponse.body)).toEqual([Number(cand.tieB), Number(cand.tieA)]); // 같은 시각 — id 큰 쪽이 먼저
    });

    it('#15-a page·size 기본값(1/50) — 서버가 채운다(계약 default · useDefaults 없음)', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c}`).expect(200);

      expect(response.body.page).toMatchObject({ page: 1, size: 50 });
    });

    it('itemId 필터 — 다른 품목(item2)을 뺀다', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c2}`).expect(200);

      expect(lotIdsOf(response.body)).toEqual([Number(cand.item2)]);
    });

    it('warehouseId 필터 — 불량창고1(rtn)을 집고 불량창고2 전용(wh2Only)은 뺀다', async () => {
      const response = await get(`${CANDIDATES}?warehouseId=${wh.d1}&itemId=${item.c}`).expect(200);
      const rows = lotIdsOf(response.body);

      expect(rows).toContain(Number(cand.rtn));
      expect(rows).not.toContain(Number(cand.wh2Only));
    });

    it('⭐ 불량창고가 «둘」인 LOT 은 더 큰 창고(90) 하나만 싣는다 — 행을 없애지 않는다', async () => {
      const response = await get(`${CANDIDATES}?lotId=${cand.twoDefect}`).expect(200);

      expect(response.body.items).toEqual([expect.objectContaining({ lotId: Number(cand.twoDefect), warehouseId: Number(wh.d2), quantity: 90 })]);
    });

    it('응답이 계약 스키마(shipment-04제품출하.json)를 통과한다(ajv)', async () => {
      const response = await get(`${CANDIDATES}?itemId=${item.c}`).expect(200);
      expect(candidateValidator()(response.body)).toBe(true);
    });

    async function newCandidateLot(suffix: string, itemId: bigint): Promise<bigint> {
      const lot = await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT-C-${suffix}`,
          item_id: itemId,
          lot_type_code: 'PRODUCT',
          plant_id: plantId,
          initial_qty: 100,
          uom_id: ids.uom,
          source_type_code: 'INBOUND_RECEIPT_LINE',
          source_id: 1,
          status_code: 'DEFECTIVE',
        },
      });
      return lot.lot_id;
    }

    async function newCandidateBalance(warehouseId: bigint, itemId: bigint, lotId: bigint, onHandQty: number, receivedAt: string): Promise<void> {
      await prisma.inventory_balance.create({
        data: {
          legal_entity_id: legalEntityId,
          business_unit_id: businessUnitId,
          plant_id: plantId,
          warehouse_id: warehouseId,
          location_id: loc[warehouseId === wh.d1 ? 'd1' : warehouseId === wh.d2 ? 'd2' : 'g'],
          item_id: itemId,
          lot_id: lotId,
          quality_status_code: 'DEFECTIVE',
          inventory_status_code: 'AVAILABLE',
          ownership_type_code: 'OWNED',
          on_hand_qty: onHandQty,
          uom_id: ids.uom,
          last_transaction_at: new Date(receivedAt),
        },
      });
    }

    /** RETURN 갈래 입고 한 줄. `allocationId` 를 주면 원 출하 거래처 역추적(§4-1)이 켜진다. */
    async function newReturnReceipt(suffix: string, itemId: bigint, lotId: bigint, warehouseId: bigint, allocationId?: bigint): Promise<string> {
      const receipt = await prisma.goods_receipt.create({
        data: {
          goods_receipt_no: `${PREFIX}-GR-C-${suffix}`,
          receipt_type_code: 'RETURN',
          plant_id: plantId,
          warehouse_id: warehouseId,
          receipt_datetime: new Date(T_RETURN),
          status_code: 'REGISTERED',
        },
      });
      await prisma.goods_receipt_line.create({
        data: {
          goods_receipt_id: receipt.goods_receipt_id,
          line_no: 1,
          item_id: itemId,
          lot_id: lotId,
          receipt_qty: 10,
          uom_id: ids.uom,
          quality_status_code: 'DEFECTIVE',
          inventory_status_code: 'AVAILABLE',
          destination_location_id: loc[warehouseId === wh.d1 ? 'd1' : warehouseId === wh.d2 ? 'd2' : 'g'],
          original_shipment_lot_allocation_id: allocationId,
        },
      });
      return receipt.goods_receipt_no;
    }

    /** PRODUCT 갈래 — OQC 확정 불합격 한 건. */
    async function newOqcReject(suffix: string, itemId: bigint, lotId: bigint): Promise<bigint> {
      const req = await prisma.inspection_request.create({
        data: {
          inspection_request_no: `${PREFIX}-IRQ-C-${suffix}`,
          inspection_type_code: 'OQC',
          target_type_code: 'LOT',
          target_id: lotId,
          item_id: itemId,
          lot_id: lotId,
          target_qty: 10,
          uom_id: ids.uom,
          status_code: 'COMPLETED',
          requested_at: new Date(T_PRODUCT),
        },
      });
      const result = await prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-IRS-C-${suffix}`,
          inspection_request_id: req.inspection_request_id,
          inspected_qty: 10,
          rejected_qty: 10,
          uom_id: ids.uom,
          inspector_id: workerId,
          inspected_at: new Date(T_PRODUCT),
          status_code: 'CONFIRMED',
          overall_judgment_code: 'REJECTED',
          idempotency_key: `${PREFIX}-IRS-C-${suffix}-KEY`,
        },
      });
      return result.inspection_result_id;
    }

    async function newNonconformance(suffix: string, itemId: bigint, lotId: bigint, closed: boolean): Promise<bigint> {
      const nc = await prisma.nonconformance.create({
        data: {
          nonconformance_no: `${PREFIX}-NC-CAND-${suffix}`,
          item_id: itemId,
          severity_code: 'MINOR',
          description: `${PREFIX} 후보목록 부적합 ${suffix}`,
          status_code: closed ? 'DECIDED' : 'PENDING_DECISION',
          opened_at: new Date(T_RETURN),
          closed_at: closed ? new Date(T_PRODUCT) : null,
        },
      });
      await prisma.nonconformance_lot.create({
        data: { nonconformance_id: nc.nonconformance_id, lot_id: lotId, affected_qty: 10, uom_id: ids.uom, quality_status_before_code: 'DEFECTIVE', quality_status_after_code: 'DEFECTIVE' },
      });
      return nc.nonconformance_id;
    }

    async function makeCandidateMasters(): Promise<void> {
      const whD1 = await prisma.warehouse.create({
        data: { plant_id: plantId, business_unit_id: businessUnitId, warehouse_code: `${PREFIX}-WHD1`, warehouse_name: `${PREFIX} 불량창고1`, warehouse_type_code: 'FINISHED', management_level_code: 'LOCATION', is_defect: true },
      });
      wh.d1 = whD1.warehouse_id;
      loc.d1 = (await prisma.location.create({ data: { warehouse_id: whD1.warehouse_id, location_code: `${PREFIX}-LOCD1`, location_name: `${PREFIX} 위치D1`, location_type_code: 'BIN' } })).location_id;

      const whD2 = await prisma.warehouse.create({
        data: { plant_id: plantId, business_unit_id: businessUnitId, warehouse_code: `${PREFIX}-WHD2`, warehouse_name: `${PREFIX} 불량창고2`, warehouse_type_code: 'FINISHED', management_level_code: 'LOCATION', is_defect: true },
      });
      wh.d2 = whD2.warehouse_id;
      loc.d2 = (await prisma.location.create({ data: { warehouse_id: whD2.warehouse_id, location_code: `${PREFIX}-LOCD2`, location_name: `${PREFIX} 위치D2`, location_type_code: 'BIN' } })).location_id;

      // ⭐ is_defect=false — 「불량창고를 가리는 칸이 0개」였던 초판을 R-4 로 뒤집는 자리(§0 #4).
      const whG = await prisma.warehouse.create({
        data: { plant_id: plantId, business_unit_id: businessUnitId, warehouse_code: `${PREFIX}-WHG`, warehouse_name: `${PREFIX} 완제품창고`, warehouse_type_code: 'FINISHED', management_level_code: 'LOCATION', is_defect: false },
      });
      wh.g = whG.warehouse_id;
      loc.g = (await prisma.location.create({ data: { warehouse_id: whG.warehouse_id, location_code: `${PREFIX}-LOCG`, location_name: `${PREFIX} 위치G`, location_type_code: 'BIN' } })).location_id;

      item.c = (await prisma.item.create({ data: { item_code: `${PREFIX}-ITC`, item_name: `${PREFIX}후보품목`, item_type_code: 'FINISHED_GOODS', base_uom_id: ids.uom, lot_controlled: true } })).item_id;
      item.c2 = (await prisma.item.create({ data: { item_code: `${PREFIX}-ITC2`, item_name: `${PREFIX} 후보품목2`, item_type_code: 'FINISHED_GOODS', base_uom_id: ids.uom, lot_controlled: true } })).item_id;
      item.tie = (await prisma.item.create({ data: { item_code: `${PREFIX}-ITCT`, item_name: `${PREFIX} 후보품목동률`, item_type_code: 'FINISHED_GOODS', base_uom_id: ids.uom, lot_controlled: true } })).item_id;

      const customer = await prisma.partner.create({ data: { partner_code: `${PREFIX}-PTC`, partner_name: `${PREFIX} 원출하거래처` } });
      const shipmentRequest = await prisma.shipment_request.create({
        data: { shipment_request_no: `${PREFIX}-SRQ-C`, customer_id: customer.partner_id, ship_to_partner_id: customer.partner_id, requested_ship_date: new Date('2026-07-01'), status_code: 'CONFIRMED' },
      });
      const requestLine = await prisma.shipment_request_line.create({
        data: { shipment_request_id: shipmentRequest.shipment_request_id, line_no: 1, item_id: item.c, requested_qty: 10, uom_id: ids.uom },
      });
      const shipment = await prisma.shipment.create({ data: { shipment_no: `${PREFIX}-SHP-C`, shipment_request_id: shipmentRequest.shipment_request_id, warehouse_id: whD1.warehouse_id, status_code: 'SHIPPED' } });
      const shipmentLine = await prisma.shipment_line.create({
        data: { shipment_id: shipment.shipment_id, line_no: 1, shipment_request_line_id: requestLine.shipment_request_line_id, item_id: item.c, shipped_qty: 10, uom_id: ids.uom },
      });
      cand.allocation = (
        await prisma.shipment_lot_allocation.create({ data: { shipment_line_id: shipmentLine.shipment_line_id, lot_id: await newCandidateLot('ALLOC-SRC', item.c), allocated_qty: 10, uom_id: ids.uom } })
      ).shipment_lot_allocation_id;
    }

    async function makeCandidateFixtures(): Promise<void> {
      cand.rtn = await newCandidateLot('RTN', item.c);
      await newReturnReceipt('RTN', item.c, cand.rtn, wh.d1, cand.allocation);
      await newCandidateBalance(wh.d1, item.c, cand.rtn, 100, T_RETURN);
      cand.ncOfRtn = await newNonconformance('RTN', item.c, cand.rtn, false);

      cand.prod = await newCandidateLot('PROD', item.c);
      await newOqcReject('PROD', item.c, cand.prod);
      await newCandidateBalance(wh.d1, item.c, cand.prod, 80, T_PRODUCT);

      cand.both = await newCandidateLot('BOTH', item.c);
      await newReturnReceipt('BOTH', item.c, cand.both, wh.d1);
      await newOqcReject('BOTH', item.c, cand.both);
      await newCandidateBalance(wh.d1, item.c, cand.both, 60, T_OTHER);

      cand.split = await newCandidateLot('SPLIT', item.c);
      await newReturnReceipt('SPLIT', item.c, cand.split, wh.d1);
      await newCandidateBalance(wh.d1, item.c, cand.split, 120, T_OTHER);
      await newCandidateBalance(wh.g, item.c, cand.split, 80, T_OTHER);

      cand.zero = await newCandidateLot('ZERO', item.c);
      await newReturnReceipt('ZERO', item.c, cand.zero, wh.d1);
      await newCandidateBalance(wh.d1, item.c, cand.zero, 0, T_OTHER);

      cand.goodOnly = await newCandidateLot('GOODONLY', item.c);
      await newReturnReceipt('GOODONLY', item.c, cand.goodOnly, wh.g);
      await newCandidateBalance(wh.g, item.c, cand.goodOnly, 50, T_OTHER);

      cand.twoDefect = await newCandidateLot('TWODEFECT', item.c);
      await newReturnReceipt('TWODEFECT', item.c, cand.twoDefect, wh.d1);
      await newCandidateBalance(wh.d1, item.c, cand.twoDefect, 50, T_OTHER);
      await newCandidateBalance(wh.d2, item.c, cand.twoDefect, 90, T_OTHER);

      cand.ncClosed = await newCandidateLot('NCCLOSED', item.c);
      await newReturnReceipt('NCCLOSED', item.c, cand.ncClosed, wh.d1);
      await newCandidateBalance(wh.d1, item.c, cand.ncClosed, 30, T_OTHER);
      await newNonconformance('NCCLOSED', item.c, cand.ncClosed, true);

      cand.old = await newCandidateLot('OLD', item.c);
      await newReturnReceipt('OLD', item.c, cand.old, wh.d1);
      await newCandidateBalance(wh.d1, item.c, cand.old, 15, T_OLD);

      cand.wh2Only = await newCandidateLot('WH2ONLY', item.c);
      await newReturnReceipt('WH2ONLY', item.c, cand.wh2Only, wh.d2);
      await newCandidateBalance(wh.d2, item.c, cand.wh2Only, 40, T_OTHER);

      cand.item2 = await newCandidateLot('ITEM2', item.c2);
      await newReturnReceipt('ITEM2', item.c2, cand.item2, wh.d1);
      await newCandidateBalance(wh.d1, item.c2, cand.item2, 20, T_OTHER);

      cand.tieA = await newCandidateLot('TIEA', item.tie);
      await newReturnReceipt('TIEA', item.tie, cand.tieA, wh.d1);
      await newCandidateBalance(wh.d1, item.tie, cand.tieA, 10, T_TIE);
      cand.tieB = await newCandidateLot('TIEB', item.tie); // id 가 tieA 보다 크다 — 동률이면 이 쪽이 먼저(DESC)
      await newReturnReceipt('TIEB', item.tie, cand.tieB, wh.d1);
      await newCandidateBalance(wh.d1, item.tie, cand.tieB, 10, T_TIE);
    }

    /** 자가 치유 — FK 역순(§8-1 정리 사슬 + 후보 목록이 더한 shipment 사슬·worker). */
    async function cleanupCandidates(): Promise<void> {
      // ⭐ `goods_receipt_line` 이 `shipment_lot_allocation` 을 참조한다(`fk_goods_receipt_line_orig_shipment`)
      // — shipment 사슬보다 «먼저» 지운다(§8-1 정리 사슬의 형제 함정).
      await prisma.nonconformance_lot.deleteMany({ where: { nonconformance: { nonconformance_no: { startsWith: `${PREFIX}-NC-CAND-` } } } });
      await prisma.nonconformance.deleteMany({ where: { nonconformance_no: { startsWith: `${PREFIX}-NC-CAND-` } } });
      await prisma.inventory_balance.deleteMany({ where: { lot: { lot_no: { startsWith: `${PREFIX}-LOT-C-` } } } });
      await prisma.goods_receipt_line.deleteMany({ where: { goods_receipt: { goods_receipt_no: { startsWith: `${PREFIX}-GR-C-` } } } });
      await prisma.goods_receipt.deleteMany({ where: { goods_receipt_no: { startsWith: `${PREFIX}-GR-C-` } } });
      await prisma.shipment_lot_allocation.deleteMany({ where: { shipment_line: { shipment: { shipment_no: `${PREFIX}-SHP-C` } } } });
      await prisma.shipment_line.deleteMany({ where: { shipment: { shipment_no: `${PREFIX}-SHP-C` } } });
      await prisma.shipment.deleteMany({ where: { shipment_no: `${PREFIX}-SHP-C` } });
      await prisma.shipment_request_line.deleteMany({ where: { shipment_request: { shipment_request_no: `${PREFIX}-SRQ-C` } } });
      await prisma.shipment_request.deleteMany({ where: { shipment_request_no: `${PREFIX}-SRQ-C` } });
      await prisma.partner.deleteMany({ where: { partner_code: `${PREFIX}-PTC` } });
      await prisma.inspection_result.deleteMany({ where: { inspection_result_no: { startsWith: `${PREFIX}-IRS-C-` } } });
      await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: `${PREFIX}-IRQ-C-` } } });
      await prisma.lot.deleteMany({ where: { lot_no: { startsWith: `${PREFIX}-LOT-C-` } } });
      await prisma.worker.deleteMany({ where: { worker_no: `${PREFIX}-WKC` } });
      await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-ITC` } } });
      await prisma.location.deleteMany({ where: { location_code: { startsWith: `${PREFIX}-LOCD` } } });
      await prisma.location.deleteMany({ where: { location_code: `${PREFIX}-LOCG` } });
      await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: `${PREFIX}-WHD` } } });
      await prisma.warehouse.deleteMany({ where: { warehouse_code: `${PREFIX}-WHG` } });
    }
  });

  describe('이 부적합의 결정 (②b · +summary)', () => {
    const url = (nonconformanceId: bigint | number) => `/api/quality/nonconformances/${nonconformanceId}/disposition-decisions`;

    it('⭐ 질의 칸이 0인데 page 가 {1, total, total}로 전건이다(51번째가 조용히 안 사라진다)', async () => {
      const response = await get(url(ncIds.ncSummary)).expect(200);

      expect(response.body.items).toHaveLength(2);
      expect(response.body.page).toEqual({ page: 1, size: 2, total: 2 });
    });

    it('summary.remainingQty = 대상(100) − 결정(25+35) = 40(서버 계산)', async () => {
      const response = await get(url(ncIds.ncSummary)).expect(200);

      expect(response.body.summary).toMatchObject({ affectedQtyTotal: 100, decidedQtyTotal: 60, remainingQty: 40 });
    });

    it('summary.uomId 가 부적합(대상 LOT)의 단위다', async () => {
      const response = await get(url(ncIds.ncSummary)).expect(200);

      expect(response.body.summary.uomId).toBe(Number(ids.uom));
    });

    it('⛔ 응답에 ETag 헤더가 없다(계약 미선언)', async () => {
      const response = await get(url(ncIds.ncSummary)).expect(200);

      // Express 가 자동으로 붙이는 약한 해시(W/"…")와, `setEtag()`(공유계약 A-4·순정수 문자열)가
      // 다르다는 것만 잠근다(상세 시험과 같은 방향).
      expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
    });

    it('정렬 — decided_at DESC(Dsummary2 가 먼저)', async () => {
      const response = await get(url(ncIds.ncSummary)).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).toEqual([decisionIds.Dsummary2, decisionIds.Dsummary1]);
    });

    it('⭐ 정렬 2차 키 — decided_at 동률이면 disposition_decision_id DESC(통째 단언)', async () => {
      const response = await get(url(ncIds.ncSummaryTie)).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).toEqual([decisionIds.DsummaryTieHi, decisionIds.DsummaryTieLo]);
    });

    it('⭐⭐ 리뷰 Major-1 — 대상 «합»이 다중 LOT 전건(0.1+0.2=0.3)이고 uomId 는 «첫» LOT 의 단위다', async () => {
      // 두 LOT 의 uom_id 가 다르다(ids.uom·ids.uom2) — 「lots[0] 만 합한다」·「마지막 LOT 의 uom
      // 을 고른다」변이 둘을 이 한 시험이 잡는다. affected_qty=0.1+0.2 는 Number() 로 먼저 더치면
      // 0.30000000000000004 가 새는 고전적 부동소수 함정이라 R-25 의 «대상» 쪽도 함께 잠근다.
      const response = await get(url(ncIds.ncMultiUom)).expect(200);

      expect(response.body.summary).toEqual({ affectedQtyTotal: 0.3, decidedQtyTotal: 0, remainingQty: 0.3, uomId: Number(ids.uom) });
    });

    it('⭐ Minor-5 — 결정이 0건이면 잔량은 대상 전량이다(「0건→잔량 0」으로 접지 않는다)', async () => {
      const response = await get(url(ncIds.ncMultiUom)).expect(200);

      expect(response.body.items).toEqual([]);
      expect(response.body.summary.remainingQty).toBe(0.3);
    });

    it('⭐⭐ 없는 nonconformanceId 는 404 가 «아니다» — 빈 목록 + summary 전 칸 0(계약 미선언 · 같은 계약 파일 형제 선례) // 결정 — 통보 후보(번호는 통합자가 준다)', async () => {
      // `GET …/{inspectionResultId}/measurements` 가 같은 계약 파일 안에서 이미 「빈 목록+total 0,
      // 404 아니다」로 판정해 뒀다(quality-inspection-summary.e2e-spec.ts:318) — 자식 컬렉션 GET 은
      // 부모 존재를 따로 확인하지 않는다. ⚠ 저장소 전체가 이 규범 하나로 갈린 것은 «아니다» —
      // 계약 미선언인데도 404 를 내는 자식 컬렉션도 실재한다(예: goods-issues/{id}/lines). 이
      // 오퍼레이션은 «같은 계약 파일·같은 축(계약 선언 유무)»을 근거로 골랐다.
      // summary.uomId=0 도 같은 결정의 연장이다 — required·널불가 정수에 실을 값이 없어
      // 강제된 값이고(도출이 아니다), 노출 반경은 0(①b 상세가 이미 404 를 낸다).
      const response = await get(url(999999999)).expect(200);

      expect(response.body).toEqual({
        items: [],
        page: { page: 1, size: 0, total: 0 },
        summary: { affectedQtyTotal: 0, decidedQtyTotal: 0, remainingQty: 0, uomId: 0 },
      });
      expect(validator('GET /quality/nonconformances/{nonconformanceId}/disposition-decisions')(response.body)).toBe(true);
    });

    it('응답이 계약 스키마를 통과한다(ajv)', async () => {
      const response = await get(url(ncIds.ncSummary)).expect(200);
      expect(validator('GET /quality/nonconformances/{nonconformanceId}/disposition-decisions')(response.body)).toBe(true);
    });

    it('⭐ Nit-2 — 행에 followUpPending·reinstatable 이 없다(ajv strict:false 라 못 잡는 자리를 직접 잠근다)', async () => {
      // `DispositionDecision.properties` 에 두 이름이 0건이다(질의 파라미터로만 있다 · disposition-rollup.ts 머리 주석).
      const response = await get(url(ncIds.ncSummary)).expect(200);

      expect(response.body.items[0]).not.toHaveProperty('followUpPending');
      expect(response.body.items[0]).not.toHaveProperty('reinstatable');
    });
  });

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: `${PREFIX} 처분목록법인`, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: `${PREFIX} 처분목록사업부` },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: `${PREFIX} 처분목록공장`, timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.plant = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    // ⭐ 리뷰 Major-1 — 대상(affected) 쪽 다중 LOT 축을 잠그려면 «단위가 다른» 두 번째 uom 이 필요하다.
    const uom2 = await prisma.uom.create({ data: { uom_code: `${PREFIX}-UOM2`, uom_name: `${PREFIX} 보조단위`, decimal_scale: 6 } });
    ids.uom2 = uom2.uom_id;

    const item1 = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT1`, item_name: `${PREFIX} 품목1`, item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item1 = item1.item_id;
    const item2 = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT2`, item_name: `${PREFIX} 품목2`, item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item2 = item2.item_id;

    const wh1 = await prisma.warehouse.create({
      data: { plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH1`, warehouse_name: `${PREFIX} 창고1`, warehouse_type_code: 'FINISHED', management_level_code: 'LOCATION' },
    });
    ids.warehouse1 = wh1.warehouse_id;
    const loc1 = await prisma.location.create({
      data: { warehouse_id: wh1.warehouse_id, location_code: `${PREFIX}-LOC1`, location_name: `${PREFIX} 위치1`, location_type_code: 'BIN' },
    });
    ids.location1 = loc1.location_id;
    const wh2 = await prisma.warehouse.create({
      data: { plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH2`, warehouse_name: `${PREFIX} 창고2`, warehouse_type_code: 'FINISHED', management_level_code: 'LOCATION' },
    });
    ids.warehouse2 = wh2.warehouse_id;
    const loc2 = await prisma.location.create({
      data: { warehouse_id: wh2.warehouse_id, location_code: `${PREFIX}-LOC2`, location_name: `${PREFIX} 위치2`, location_type_code: 'BIN' },
    });

    ids.lotA = await newLot('A', item1.item_id, plant.plant_id);
    ids.lotB = await newLot('B', item2.item_id, plant.plant_id);
    ids.lotM1 = await newLot('M1', item1.item_id, plant.plant_id);
    ids.lotM2 = await newLot('M2', item1.item_id, plant.plant_id);
    ids.lotN1 = await newLot('N1', item1.item_id, plant.plant_id);
    ids.lotN2 = await newLot('N2', item1.item_id, plant.plant_id);

    await newBalance(entity.legal_entity_id, unit.business_unit_id, plant.plant_id, wh1.warehouse_id, loc1.location_id, item1.item_id, ids.lotA, uom.uom_id, 100);
    await newBalance(entity.legal_entity_id, unit.business_unit_id, plant.plant_id, wh2.warehouse_id, loc2.location_id, item2.item_id, ids.lotB, uom.uom_id, 50);
  }

  async function newLot(suffix: string, itemId: bigint, plantId: bigint): Promise<bigint> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${suffix}`,
        item_id: itemId,
        lot_type_code: 'PRODUCT',
        plant_id: plantId,
        initial_qty: 100,
        uom_id: ids.uom,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'DEFECTIVE',
      },
    });
    return lot.lot_id;
  }

  async function newBalance(
    legalEntityId: bigint,
    businessUnitId: bigint,
    plantId: bigint,
    warehouseId: bigint,
    locationId: bigint,
    itemId: bigint,
    lotId: bigint,
    uomId: bigint,
    onHandQty: number,
  ): Promise<void> {
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: legalEntityId,
        business_unit_id: businessUnitId,
        plant_id: plantId,
        warehouse_id: warehouseId,
        location_id: locationId,
        item_id: itemId,
        lot_id: lotId,
        quality_status_code: 'DEFECTIVE',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: onHandQty,
        uom_id: uomId,
      },
    });
  }

  async function makeNonconformance(key: string, itemId: bigint, lotIds: bigint[], affectedQtyEach = 10): Promise<bigint> {
    const nc = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-${key}`,
        item_id: itemId,
        severity_code: 'MINOR',
        description: `${PREFIX} 부적합 ${key}`,
        status_code: 'PENDING_DECISION',
        opened_at: new Date(WINDOW_FROM),
      },
    });
    await prisma.nonconformance_lot.createMany({
      data: lotIds.map((lotId) => ({
        nonconformance_id: nc.nonconformance_id,
        lot_id: lotId,
        affected_qty: affectedQtyEach,
        uom_id: ids.uom,
        quality_status_before_code: 'DEFECTIVE',
        quality_status_after_code: 'DEFECTIVE',
      })),
    });
    ncIds[key] = nc.nonconformance_id;
    return nc.nonconformance_id;
  }

  async function makeDecision(key: string, nonconformanceId: bigint, dispositionTypeCode: string, decisionQty: number, decidedAt: string): Promise<number> {
    const decision = await prisma.disposition_decision.create({
      data: {
        nonconformance_id: nonconformanceId,
        disposition_type_code: dispositionTypeCode,
        decision_qty: decisionQty,
        uom_id: ids.uom,
        reason: `${PREFIX} 판정 사유`,
        decided_by: userId,
        decided_at: new Date(decidedAt),
      },
    });
    const id = Number(decision.disposition_decision_id);
    decisionIds[key] = id;
    return id;
  }

  /**
   * 출고 — `source_document_type_code='DISPOSITION_DECISION'`(§0 #3 롤업의 원천). ⭐⭐ 리뷰
   * Major-2 — `sourceDocumentTypeCode` 를 다르게 주면 「같은 id·다른 문서 유형」 픽스처가 된다.
   */
  async function makeGoodsIssue(key: string, decisionId: number, statusCode: string, issueQty: number, sourceDocumentTypeCode = 'DISPOSITION_DECISION'): Promise<void> {
    const issue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-GI-${key}`,
        issue_type_code: 'SCRAP',
        source_document_type_code: sourceDocumentTypeCode,
        source_document_id: BigInt(decisionId),
        source_warehouse_id: ids.warehouse1,
        issued_at: new Date(T1),
        status_code: statusCode,
      },
    });
    await prisma.goods_issue_line.create({
      data: {
        goods_issue_id: issue.goods_issue_id,
        line_no: 1,
        item_id: ids.item1,
        lot_id: ids.lotA,
        issue_qty: issueQty,
        uom_id: ids.uom,
        source_location_id: ids.location1,
      },
    });
  }

  async function makeFixtures(): Promise<void> {
    const ncA = await makeNonconformance('ncA', ids.item1, [ids.lotA]);
    const ncB = await makeNonconformance('ncB', ids.item2, [ids.lotB]);
    const ncMulti = await makeNonconformance('ncMulti', ids.item1, [ids.lotM1, ids.lotM2]);

    await makeDecision('D1', ncA, 'SCRAP', 50, T1);
    await makeDecision('D2', ncA, 'REWORK', 60, T2);
    await makeDecision('D3', ncA, 'NORMAL', 40, T3);
    await makeDecision('tieA', ncA, 'REWORK', 5, TIE);
    await makeDecision('tieB', ncA, 'REWORK', 5, TIE); // TIE 와 같은 시각 · id 는 tieA 보다 크다
    await makeDecision('boundary', ncA, 'REWORK', 1, WINDOW_TO); // 반열림 «끝» 경계 — 기간 필터에서 빠진다
    await makeDecision('atFrom', ncA, 'REWORK', 1, WINDOW_FROM); // ⭐⭐ 리뷰 Major-3 — 반열림 «시작» 경계 — 든다

    // ⭐ R-3 ⓑ — POSTED 30 + CANCELLED 20. followUpQty 는 30 이어야 한다(50 이면 필터가 샌다).
    await makeGoodsIssue('D1-POSTED', decisionIds.D1, 'POSTED', 30);
    await makeGoodsIssue('D1-CANCELLED', decisionIds.D1, 'CANCELLED', 20);
    // ⭐⭐ 리뷰 Major-2 — 같은 `source_document_id`(D1) · 다른 `source_document_type_code`.
    // `goods_issue.source_document_id` 는 FK·CHECK 가 없어 다른 문서 유형과 번호가 겹치는 것이
    // 정상이다(실측) — 판별자 조건을 지워도 이 행이 안 섞이면 걸린다.
    await makeGoodsIssue('D1-OTHER-DOC', decisionIds.D1, 'POSTED', 20, 'WORK_ORDER');

    await makeDecision('D4', ncB, 'REWORK', 20, '2025-01-01T00:00:00.000Z'); // 다른 품목·LOT·기간 밖
    await makeDecision('D5', ncMulti, 'REWORK', 15, T1); // 상세 — lotId/lotNo 키 생략(LOT 2건)

    // ⭐⭐ R-19 — 「SCRAP 이지만 완료」 한 건. D1 하나만으로는 SQL 의 `<` 를 지우거나 `<=` 로
    // 바꿔도(followUpPending 이 「타입만」으로 좁혀져도) e2e 가 초록이다 — 「한계와 같은 값」
    // (postedQty == decisionQty)이 «따로» 있어야 그 변이가 잡힌다.
    const ncScrapDone = await makeNonconformance('ncScrapDone', ids.item1, [ids.lotA]);
    await makeDecision('DscrapDone', ncScrapDone, 'SCRAP', 25, T1);
    await makeGoodsIssue('DscrapDone-POSTED', decisionIds.DscrapDone, 'POSTED', 25);

    // ⭐⭐ 리뷰 Major-1 — 「SCRAP 이고 출고가 «0행»」 한 건. 여태 SCRAP 픽스처(D1·DscrapDone)가
    // 전부 출고를 가져서 `fu.posted_qty` 의 `coalesce(sum(...), 0)` 이 실제로 안 걸렸다 —
    // 0행이면 `sum()` 이 NULL 이 되고 3값 논리로 `followUpPending` 두 갈래 «모두»에서 행이
    // 증발한다(coalesce 를 지워도 이 픽스처 없이는 e2e 가 초록이었다).
    const ncScrapNone = await makeNonconformance('ncScrapNone', ids.item1, [ids.lotA]);
    await makeDecision('DscrapNone', ncScrapNone, 'SCRAP', 40, T1);

    // ②b — 「이 부적합의 결정」(전건 + summary). affectedQtyTotal=100(lotA 하나) · 결정 25+35=60
    // → remainingQty=40. uomId 는 nonconformance_lot.uom_id(= ids.uom)로 고정된다.
    const ncSummary = await makeNonconformance('ncSummary', ids.item1, [ids.lotA], 100);
    await makeDecision('Dsummary1', ncSummary, 'REWORK', 25, T1);
    await makeDecision('Dsummary2', ncSummary, 'SCRAP', 35, T2);

    // ②b 정렬 2차 키 — decided_at 동률(TIE) 둘. 별도 부적합으로 떼어 summary 산식(위)과 섞이지 않게 한다.
    const ncSummaryTie = await makeNonconformance('ncSummaryTie', ids.item1, [ids.lotA], 10);
    await makeDecision('DsummaryTieLo', ncSummaryTie, 'REWORK', 1, TIE);
    await makeDecision('DsummaryTieHi', ncSummaryTie, 'REWORK', 1, TIE); // TIE 와 같은 시각 · id 는 Lo 보다 크다

    // ⭐⭐ 리뷰 Major-1 — 대상(affected) 합의 다중 LOT 축 + uom 선택 축 + R-25 소수 함정(대상 쪽)을
    // «한 픽스처»로 잠근다. `makeNonconformance` 는 LOT 마다 같은 uom·수량만 지원해 직접 심는다.
    // 두 LOT 의 uom_id 를 다르게(ids.uom·ids.uom2) 두어 「lots[0] 만 합한다」·「마지막 LOT 의 uom
    // 을 고른다」변이를 잡고, affected_qty 를 0.1+0.2 로 심는다 — 0.1+0.2=0.30000000000000004 가
    // «보이는» 고전적 부동소수 함정이다(0.15+0.15 는 JS 에서 우연히 정확해 못 잡는다). 결정을
    // «0건» 붙여 「결정 0건이면 잔량 = 대상 전량」(Minor-5)도 같은 픽스처로 잠근다.
    const ncMultiUom = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-ncMultiUom`,
        item_id: ids.item1,
        severity_code: 'MINOR',
        description: `${PREFIX} 부적합 ncMultiUom`,
        status_code: 'PENDING_DECISION',
        opened_at: new Date(WINDOW_FROM),
      },
    });
    await prisma.nonconformance_lot.createMany({
      data: [
        { nonconformance_id: ncMultiUom.nonconformance_id, lot_id: ids.lotN1, affected_qty: 0.1, uom_id: ids.uom, quality_status_before_code: 'DEFECTIVE', quality_status_after_code: 'DEFECTIVE' },
        { nonconformance_id: ncMultiUom.nonconformance_id, lot_id: ids.lotN2, affected_qty: 0.2, uom_id: ids.uom2, quality_status_before_code: 'DEFECTIVE', quality_status_after_code: 'DEFECTIVE' },
      ],
    });
    ncIds.ncMultiUom = ncMultiUom.nonconformance_id;
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '처분결정조회', status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });

    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** FK 역순으로 지운다. `beforeAll`·`afterAll` 둘 다 부른다(자가 치유). */
  async function cleanup(): Promise<void> {
    await prisma.goods_issue_line.deleteMany({ where: { goods_issue: { goods_issue_no: { startsWith: `${PREFIX}-GI-` } } } });
    await prisma.goods_issue.deleteMany({ where: { goods_issue_no: { startsWith: `${PREFIX}-GI-` } } });
    await prisma.disposition_decision.deleteMany({ where: { nonconformance: { nonconformance_no: { startsWith: `${PREFIX}-NC-` } } } });
    await prisma.nonconformance_lot.deleteMany({ where: { nonconformance: { nonconformance_no: { startsWith: `${PREFIX}-NC-` } } } });
    await prisma.nonconformance.deleteMany({ where: { nonconformance_no: { startsWith: `${PREFIX}-NC-` } } });
    await prisma.uom.deleteMany({ where: { uom_code: `${PREFIX}-UOM2` } }); // Major-1 픽스처(ncMultiUom)의 두 번째 uom — nonconformance_lot 을 먼저 지운 뒤라야 지워진다.
    await prisma.inventory_balance.deleteMany({ where: { lot: { lot_no: { startsWith: `${PREFIX}-LOT-` } } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: `${PREFIX}-LOT-` } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: `${PREFIX}-LOC` } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: `${PREFIX}-WH` } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-IT` } } });
    await prisma.plant.deleteMany({ where: { plant_code: `${PREFIX}-P` } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: `${PREFIX}-BU` } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: `${PREFIX}-LE` } });

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});
