/**
 * 처분 결정 목록·상세 (e2e) — I-21 PR ②a″. `GET /quality/disposition-decisions` ·
 * `…/{dispositionDecisionId}` 딱 둘이다. 후보(③)·특채(⑤)·쓰기(⑥⑦)는 다른 PR 몫이라 이
 * 파일은 그 둘만 본다 — 뒤 PR 들이 이 파일에 `describe` 를 더한다(회귀 `quality-` 규약).
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
    item1: 0n,
    item2: 0n,
    uom: 0n,
    warehouse1: 0n,
    warehouse2: 0n,
    location1: 0n,
    lotA: 0n,
    lotB: 0n,
    lotM1: 0n,
    lotM2: 0n,
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
  // 정렬(decided_at DESC, id DESC) — boundary(T5) > tieB(T4·id 큼) > tieA(T4·id 작음) > D3 > D2 > D1.
  const ncAOrder = ['boundary', 'tieB', 'tieA', 'D3', 'D2', 'D1'];

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

    it('⭐ D1 의 followUpQty=30·PARTIAL — CANCELLED 20 EA 는 «안» 더해진다(R-3 ⓑ · I-20 ①c 형)', async () => {
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

    it('⭐ WINDOW_TO 와 «같은 시각»의 boundary 는 빠진다(반열림)', async () => {
      const response = await get(`${DECISIONS}?${ncAScope()}&decidedFrom=${WINDOW_FROM}&decidedTo=${WINDOW_TO}`).expect(200);
      const returned = response.body.items.map((i: { dispositionDecisionId: number }) => i.dispositionDecisionId);

      expect(returned).not.toContain(decisionIds.boundary);
      expect(returned).toContain(decisionIds.D1);
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
      expect(page1.body.page).toEqual({ page: 1, size: 2, total: 6 });
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
      expect(response.headers.etag).not.toMatch(/^\d+$/);
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
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;

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

  async function makeNonconformance(key: string, itemId: bigint, lotIds: bigint[]): Promise<bigint> {
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
        affected_qty: 10,
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

  /** 폐기 출고 — `source_document_type_code='DISPOSITION_DECISION'`(§0 #3 롤업의 원천). */
  async function makeGoodsIssue(key: string, decisionId: number, statusCode: string, issueQty: number): Promise<void> {
    const issue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-GI-${key}`,
        issue_type_code: 'SCRAP',
        source_document_type_code: 'DISPOSITION_DECISION',
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
    await makeDecision('boundary', ncA, 'REWORK', 1, WINDOW_TO); // 반열림 경계 — 기간 필터에서 빠진다

    // ⭐ R-3 ⓑ — POSTED 30 + CANCELLED 20. followUpQty 는 30 이어야 한다(50 이면 필터가 샌다).
    await makeGoodsIssue('D1-POSTED', decisionIds.D1, 'POSTED', 30);
    await makeGoodsIssue('D1-CANCELLED', decisionIds.D1, 'CANCELLED', 20);

    await makeDecision('D4', ncB, 'REWORK', 20, '2025-01-01T00:00:00.000Z'); // 다른 품목·LOT·기간 밖
    await makeDecision('D5', ncMulti, 'REWORK', 15, T1); // 상세 — lotId/lotNo 키 생략(LOT 2건)

    // ⭐⭐ R-19 — 「SCRAP 이지만 완료」 한 건. D1 하나만으로는 SQL 의 `<` 를 지우거나 `<=` 로
    // 바꿔도(followUpPending 이 「타입만」으로 좁혀져도) e2e 가 초록이다 — 「한계와 같은 값」
    // (postedQty == decisionQty)이 «따로» 있어야 그 변이가 잡힌다.
    const ncScrapDone = await makeNonconformance('ncScrapDone', ids.item1, [ids.lotA]);
    await makeDecision('DscrapDone', ncScrapDone, 'SCRAP', 25, T1);
    await makeGoodsIssue('DscrapDone-POSTED', decisionIds.DscrapDone, 'POSTED', 25);
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
