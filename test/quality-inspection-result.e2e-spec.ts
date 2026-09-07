/**
 * 검사 의뢰·결과 (e2e) — I-19. PR ②a(의뢰 조회 2건) + PR ②b(**결과 조회 2건**).
 * `POST`·`PUT`·`:confirm`·집계 3건·`/measurements`는 PR ③④⑤ 가 같은 파일에 이어 붙인다.
 *
 * ⭐ `inspection_request` 는 **직접 INSERT** 한다 — 만드는 오퍼레이션이 계약에 0건이다
 *   (I-19.md §0 #5). 갈래 셋을 심는다 — IQC(`targetTypeCode='LOT'`)·PQC(`'WORK_ORDER'`) ·
 *   ⭐ **기준 없는 갈래**(`inspection_plan_version_id = null` · M-e ⓐ 가 그 칸의 NOT NULL 을
 *   풀어 이제 심을 수 있다).
 * ⭐ `inspection_result` 도 **직접 INSERT** 한다 — 확정을 만드는 `:confirm`·`POST`는 PR ③④
 *   몫이다. R1 에 재검 사슬(2회차) · R2 에 단일 회차 · R3 에 **DRAFT + 판정 없음**(M-e ⓒ가
 *   nullable 로 푼 그 갈래) · R4 에 PQC(W/O 축 `processId`)를 각각 심는다.
 * ⭐ 검사기준(`inspection_plan_version`)은 FK 를 채우는 최소 골격만 심는다 — 항목 규격 3·
 *   검교정 이력·단말은 이 PR 도 ③④⑤ 도 안 쓴다(PR ⑤가 이 `beforeAll` 을 확장한다).
 * ⛔ 계약이 조회 8건 어디에도 403 을 안 적었다 — 권한 없는 계정을 여기서 안 만든다
 *   (`permission.guard.ts:37-41`). 계정 하나는 로그인 세션만 검사한다.
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

const PREFIX = 'I19QA';
const LOGIN_ID = 'e2e-i19qa-probe';
const PASSWORD = 'PR-검사의뢰-비밀번호';
const REQUESTS = '/api/quality/inspection-requests';
const RESULTS = '/api/quality/inspection-results';

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

describe('검사 의뢰·결과 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = {
    plant: 0n,
    uom: 0n,
    item1: 0n,
    item2: 0n,
    inspectionPlanVersion: 0n,
    workOrder: 0n,
    partnerA: 0n,
    lotA: 0n,
    lotB: 0n,
    worker: 0n,
    process: 0n,
  };
  let requestR1Id: number;
  let requestR2Id: number;
  let requestR3Id: number;
  let requestR4Id: number;
  let requestR5Id: number;
  const REQUESTED_R1 = '2026-09-01T09:00:00.000Z';
  const REQUESTED_R2 = '2026-09-01T07:00:00.000Z';
  const REQUESTED_R3 = '2026-09-01T11:00:00.000Z';
  const REQUESTED_R4 = '2026-09-01T13:00:00.000Z';
  const REQUESTED_R5 = '2026-09-01T15:00:00.000Z';

  // 결과 조회(PR ②b) 픽스처 — R1 재검 사슬(2회차) · R2 단일 회차 · R3 DRAFT+판정없음 ·
  // R4 PQC(W/O 축 processId). 기간창(SCOPE_FROM~SCOPE_TO)은 A1·A2·B1 만 담고 C1·D1 은 뺀다.
  let resultA1Id: number; // R1 round1(뿌리) — CONFIRMED·REJECTED
  let resultA2Id: number; // R1 round2(자식) — CONFIRMED·ACCEPTED
  let resultB1Id: number; // R2 round1(뿌리·단일) — CONFIRMED·ACCEPTED
  let resultC1Id: number; // R3 round1 — ⭐ DRAFT + overall_judgment_code=NULL
  let resultD1Id: number; // R4 round1 — PQC·W/O 축 processId 실측용
  const INSPECTED_A1 = '2026-09-02T01:00:00.000Z';
  const INSPECTED_A2 = '2026-09-02T03:00:00.000Z';
  const INSPECTED_B1 = '2026-09-02T02:00:00.000Z';
  const INSPECTED_C1 = '2026-09-03T00:00:00.000Z';
  const INSPECTED_D1 = '2026-09-04T00:00:00.000Z';
  const SCOPE_FROM = '2026-09-02T00:00:00.000Z';
  const SCOPE_TO = '2026-09-02T23:59:59.000Z';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('의뢰 조회 (PR ②a)', () => {
    it('목록이 `page`·`size`·`total` 골격으로 온다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${REQUESTS}?itemId=${ids.item1}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page).toMatchObject({ page: 1, size: 50, total: 3 });
      expect(response.body.items).toHaveLength(3);
      // PQC 갈래(item2)는 item1 스코프 밖이다 — 필터가 실제로 좁히는지 함께 본다.
      expect(response.body.items.map((item: { inspectionRequestId: number }) => item.inspectionRequestId)).not.toContain(
        requestR4Id,
      );
      expect(validator('GET /quality/inspection-requests')(response.body)).toBe(true);
    });

    it('`pendingOnly=true` 는 `REQUESTED`·`IN_PROGRESS` 둘 다 담는다 — 상태 하나로는 못 고른다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${REQUESTS}?itemId=${ids.item1}&pendingOnly=true`)
        .set('Cookie', cookie)
        .expect(200);

      const returned = response.body.items.map((item: { inspectionRequestId: number }) => item.inspectionRequestId);
      expect(returned.sort()).toEqual([requestR1Id, requestR2Id].sort());
      expect(response.body.page.total).toBe(2);
    });

    it('⭐ #286 M-1 — `pendingOnly=true` 와 `statusCode` 를 AND 로 묶는다(`statusCode` 를 삼키지 않는다)', async () => {
      const response = await request(app.getHttpServer())
        .get(`${REQUESTS}?itemId=${ids.item1}&pendingOnly=true&statusCode=IN_PROGRESS`)
        .set('Cookie', cookie)
        .expect(200);

      // R1=REQUESTED·R2=IN_PROGRESS 둘 다 pendingOnly 대상이지만, statusCode 가 더 좁힌다.
      expect(response.body.items.map((item: { inspectionRequestId: number }) => item.inspectionRequestId)).toEqual([
        requestR2Id,
      ]);
      expect(response.body.page.total).toBe(1);
    });

    it('`pendingOnly` 기본값은 `false` 라 완료도 온다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${REQUESTS}?itemId=${ids.item1}`)
        .set('Cookie', cookie)
        .expect(200);

      const returned = response.body.items.map((item: { inspectionRequestId: number }) => item.inspectionRequestId);
      expect(returned).toContain(requestR3Id);
    });

    it('`supplierId` 가 `inbound_receipt_line.lot_id` 역방향 관계로 걸러진다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${REQUESTS}?supplierId=${ids.partnerA}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page.total).toBe(1);
      expect(response.body.items[0]).toMatchObject({ inspectionRequestId: requestR1Id, lotId: Number(ids.lotA) });
    });

    it('`q` 는 의뢰번호만 훑는다 — 품목명으로는 안 걸린다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${REQUESTS}?q=${PREFIX}-IR-1`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page.total).toBe(1);
      expect(response.body.items[0].inspectionRequestId).toBe(requestR1Id);

      const byItemName = await request(app.getHttpServer())
        .get(`${REQUESTS}?q=${encodeURIComponent('I19QA검사품목')}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(byItemName.body.page.total).toBe(0);
    });

    it('⭐ 기본 정렬이 의뢰 시각 오름차순이다(오래 기다린 것부터)', async () => {
      const response = await request(app.getHttpServer())
        .get(`${REQUESTS}?itemId=${ids.item1}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items.map((item: { inspectionRequestId: number }) => item.inspectionRequestId)).toEqual([
        requestR2Id,
        requestR1Id,
        requestR3Id,
      ]);
    });

    it('상세가 200 이고 없는 id 는 404 다 — ⭐ ETag 를 안 낸다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${REQUESTS}/${requestR1Id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body).toMatchObject({
        inspectionRequestId: requestR1Id,
        inspectionTypeCode: 'IQC',
        targetTypeCode: 'LOT',
        statusCode: 'REQUESTED',
      });
      expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
      expect(validator('GET /quality/inspection-requests/{inspectionRequestId}')(response.body)).toBe(true);

      await request(app.getHttpServer()).get(`${REQUESTS}/999999999`).set('Cookie', cookie).expect(404);
    });
  });

  describe('기준 없는 의뢰 (M-e ⓐ)', () => {
    it('⭐ 기준이 없으면 `inspectionPlanVersionId` 키가 «아예 없다» — 가짜 0 을 안 싣는다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${REQUESTS}/${requestR5Id}`)
        .set('Cookie', cookie)
        .expect(200);

      // ⛔ `Number(null) === 0` 이라 그냥 변환하면 「기준 0번」이 실린다. 계약이 `[integer,null]`
      // 이라 ajv 는 그 0 을 통과시킨다 — 키의 유무로만 잡을 수 있다(plan.md §5-7 널 금지).
      expect(response.body).not.toHaveProperty('inspectionPlanVersionId');
      expect(response.body).toMatchObject({ inspectionRequestId: requestR5Id, inspectionTypeCode: 'PQC' });
      expect(validator('GET /quality/inspection-requests/{inspectionRequestId}')(response.body)).toBe(true);

      // 기준이 있는 의뢰는 그대로 실린다 — 키를 통째로 지운 것이 아니다.
      const withPlan = await request(app.getHttpServer())
        .get(`${REQUESTS}/${requestR1Id}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(withPlan.body.inspectionPlanVersionId).toBe(Number(ids.inspectionPlanVersion));
    });
  });

  describe('결과 조회 (PR ②b)', () => {
    it('⛔ `inspectionRequestId` 도 기간도 없으면 400 `REQUIRED`', async () => {
      const response = await request(app.getHttpServer()).get(RESULTS).set('Cookie', cookie).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'inspectionRequestId', code: 'REQUIRED' });
    });

    it('`inspectionRequestId` 만 주면 기간 없이 200 이다(한 의뢰의 회차를 읽는 길) — 재검 사슬이 동거한다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectionRequestId=${requestR1Id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page.total).toBe(1); // 뿌리(회차1) 1건만 센다
      expect(response.body.items).toHaveLength(2); // 사슬 전체(회차1·2)가 같은 페이지에 있다
      expect(response.body.items.map((item: { inspectionResultId: number }) => item.inspectionResultId)).toEqual([
        resultA1Id,
        resultA2Id,
      ]);
      expect(validator('GET /quality/inspection-results')(response.body)).toBe(true);
    });

    it('기간만 주면 200 이다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectedFrom=${SCOPE_FROM}&inspectedTo=${SCOPE_TO}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page.total).toBe(2); // 기간 안 뿌리 — R1 의 A1 · R2 의 B1
    });

    it('⭐ `finalRoundOnly=false` 면 `items.length > page.total` 이다 — 사슬이 뿌리와 같은 페이지에 동거한다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectedFrom=${SCOPE_FROM}&inspectedTo=${SCOPE_TO}&finalRoundOnly=false`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page.total).toBe(2);
      expect(response.body.items.length).toBeGreaterThan(response.body.page.total);
    });

    it('⭐ R-12 — `finalRoundOnly` 를 생략해도 기본값 `false`(목록) 와 같다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectedFrom=${SCOPE_FROM}&inspectedTo=${SCOPE_TO}`)
        .set('Cookie', cookie)
        .expect(200);

      // 생략 ≡ finalRoundOnly=false — 집계 3건(PR ⑤)만 true 가 기본이다. false 로 구현하면
      // 여기서 items.length === page.total 이 되어 사슬이 잘려 나간다(계획 R-12).
      expect(response.body.items.length).toBeGreaterThan(response.body.page.total);
    });

    it('⭐ 사슬 안은 회차 오름차순이고 뿌리 사이는 `sort` 축이다(기본 `inspectedAt,desc`)', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectedFrom=${SCOPE_FROM}&inspectedTo=${SCOPE_TO}`)
        .set('Cookie', cookie)
        .expect(200);

      // 뿌리끼리는 inspectedAt desc — B1(02:00) 이 A1(01:00) 보다 먼저다.
      // A1 의 사슬 안에서는 시각(A2=03:00)이 아니라 회차 오름차순 — A1(1회차) 다음 A2(2회차).
      expect(response.body.items.map((item: { inspectionResultId: number }) => item.inspectionResultId)).toEqual([
        resultB1Id,
        resultA1Id,
        resultA2Id,
      ]);
    });

    it('`finalRoundOnly=true` 는 의뢰마다 최종 회차 1건만 낸다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectedFrom=${SCOPE_FROM}&inspectedTo=${SCOPE_TO}&finalRoundOnly=true`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page.total).toBe(2);
      expect(response.body.items.map((item: { inspectionResultId: number }) => item.inspectionResultId)).toEqual([
        resultA2Id, // R1 최종 회차(2)
        resultB1Id, // R2 최종 회차(1 — 단일)
      ]);
    });

    it('`sort` 가 허용 3키 밖이면 400 `INVALID`', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectionRequestId=${requestR1Id}&sort=bogus,asc`)
        .set('Cookie', cookie)
        .expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'sort', code: 'INVALID' });
    });

    it('결과 상세가 200 이고 없는 id 는 404 다 — ⭐ ETag 를 낸다(값이 `versionNo` 와 같다)', async () => {
      const response = await request(app.getHttpServer()).get(`${RESULTS}/${resultA1Id}`).set('Cookie', cookie).expect(200);

      expect(response.body).toMatchObject({ inspectionResultId: resultA1Id, statusCode: 'CONFIRMED', versionNo: 1 });
      expect(response.headers.etag).toBe('1');
      expect(validator('GET /quality/inspection-results/{inspectionResultId}')(response.body)).toBe(true);

      await request(app.getHttpServer()).get(`${RESULTS}/999999999`).set('Cookie', cookie).expect(404);
    });

    it('⭐ processId — W/O 축(ⓑ)이 기준 축(ⓐ)보다 먼저다(§2-3 · PQC)', async () => {
      const response = await request(app.getHttpServer()).get(`${RESULTS}/${resultD1Id}`).set('Cookie', cookie).expect(200);

      expect(response.body).toMatchObject({ processId: Number(ids.process), processName: '사출공정' });
      expect(validator('GET /quality/inspection-results/{inspectionResultId}')(response.body)).toBe(true);
    });

    it('⭐ DRAFT 행 — `overall_judgment_code` 가 NULL 이면 그 값을 그대로 낸다(계약이 required·string 으로만 닫아 못 그리는 자리 — 문의 069+16)', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectionRequestId=${requestR3Id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({ inspectionResultId: resultC1Id, statusCode: 'DRAFT' });
      expect(response.body.items[0]).toHaveProperty('overallJudgmentCode', null);
      // ⛔ 전체 스키마 ajv 검증은 여기서 부르지 않는다 — 계약 `InspectionResult.overallJudgmentCode`
      // 는 required·type:"string"(널을 형에 안 적음)이라 이 한 행만 ajv 가 못 통과시킨다. 그
      // 간극 자체가 이 테스트의 목적이다(설계 미정 — 문의 069+16, PR 본문에 근거를 적는다).
    });
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '검사의뢰검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const businessUnit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '검사의뢰검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '검사의뢰검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.plant = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;

    // item1 = IQC LOT 갈래(원자재) · item2 = PQC WORK_ORDER 갈래(제품) — q 검색이 서로
    // 걸치지 않도록 이름을 가른다.
    const item1 = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT1`, item_name: 'I19QA검사품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item1 = item1.item_id;
    const item2 = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT2`, item_name: 'I19QA생산품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item2 = item2.item_id;

    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    ids.process = process.process_id;
    const routing = await prisma.routing.create({
      data: { item_id: item2.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    const routingOperation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
    });
    const workOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`,
        routing_operation_id: routingOperation.routing_operation_id,
        item_id: item2.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'IN_PROGRESS',
      },
    });
    ids.workOrder = workOrder.work_order_id;

    // 검사기준 — FK 를 채우는 최소 골격. 항목 규격·검교정은 PR ⑤ 몫이다.
    const plan = await prisma.inspection_plan.create({
      data: { inspection_plan_code: `${PREFIX}-PLAN`, inspection_plan_name: '검사의뢰검사기준', inspection_type_code: 'IQC' },
    });
    const planVersion = await prisma.inspection_plan_version.create({
      data: {
        inspection_plan_id: plan.inspection_plan_id,
        plan_version: 1,
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        sampling_method_code: 'FULL',
        inspection_frequency_code: 'EVERY_LOT',
        status_code: 'ACTIVE',
      },
    });
    ids.inspectionPlanVersion = planVersion.inspection_plan_version_id;

    // 공급사 2 + 입하 라인 2 — `supplierId` 2단 조인(§4-1)이 실제 값으로 갈리는지 본다.
    const partnerA = await prisma.partner.create({ data: { partner_code: `${PREFIX}-SUP-A`, partner_name: '검사의뢰공급사A' } });
    ids.partnerA = partnerA.partner_id;
    const partnerB = await prisma.partner.create({ data: { partner_code: `${PREFIX}-SUP-B`, partner_name: '검사의뢰공급사B' } });

    const receiptOf = async (suffix: string, supplierId: bigint) =>
      prisma.inbound_receipt.create({
        data: { inbound_receipt_no: `${PREFIX}-IB${suffix}`, supplier_id: supplierId, plant_id: plant.plant_id, receipt_datetime: new Date('2026-08-31T00:00:00.000Z'), status_code: 'RECEIVED' },
      });
    const receiptA = await receiptOf('A', partnerA.partner_id);
    const receiptB = await receiptOf('B', partnerB.partner_id);

    const lineOf = async (suffix: string, receiptId: bigint) =>
      prisma.inbound_receipt_line.create({
        data: { inbound_receipt_id: receiptId, line_no: 1, item_id: item1.item_id, received_qty: 100, uom_id: uom.uom_id, inspection_required: true, status_code: 'RECEIVED' },
      });
    const lineA = await lineOf('A', receiptA.inbound_receipt_id);
    const lineB = await lineOf('B', receiptB.inbound_receipt_id);

    // ⭐ `lot.inbound_receipt_line[]` 역방향 관계 — `source_type_code`/`source_id` 다형
    // 참조가 아니라 이 FK 로 공급사를 2단 조인한다(§4-1 실측).
    const lotOf = async (suffix: string, lineId: bigint) => {
      const lot = await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT-${suffix}`,
          item_id: item1.item_id,
          lot_type_code: 'RAW_MATERIAL',
          plant_id: plant.plant_id,
          initial_qty: 100,
          uom_id: uom.uom_id,
          source_type_code: 'INBOUND_RECEIPT_LINE',
          source_id: lineId,
          status_code: 'INSPECTION_PENDING',
        },
      });
      await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: lineId }, data: { lot_id: lot.lot_id } });
      return lot;
    };
    const lotA = await lotOf('A', lineA.inbound_receipt_line_id);
    ids.lotA = lotA.lot_id;
    const lotB = await lotOf('B', lineB.inbound_receipt_line_id);
    ids.lotB = lotB.lot_id;

    const requestOf = async (
      suffix: string,
      overrides: { inspectionTypeCode: string; targetTypeCode: string; targetId: bigint; itemId: bigint; lotId?: bigint; workOrderId?: bigint; statusCode: string; requestedAt: string; planVersionId?: bigint | null },
    ) =>
      prisma.inspection_request.create({
        data: {
          inspection_request_no: `${PREFIX}-IR-${suffix}`,
          inspection_type_code: overrides.inspectionTypeCode,
          inspection_plan_version_id:
            overrides.planVersionId === undefined ? planVersion.inspection_plan_version_id : overrides.planVersionId,
          target_type_code: overrides.targetTypeCode,
          target_id: overrides.targetId,
          item_id: overrides.itemId,
          lot_id: overrides.lotId ?? null,
          work_order_id: overrides.workOrderId ?? null,
          target_qty: 100,
          uom_id: uom.uom_id,
          status_code: overrides.statusCode,
          requested_at: new Date(overrides.requestedAt),
        },
      });

    const r1 = await requestOf('1', { inspectionTypeCode: 'IQC', targetTypeCode: 'LOT', targetId: lotA.lot_id, itemId: item1.item_id, lotId: lotA.lot_id, statusCode: 'REQUESTED', requestedAt: REQUESTED_R1 });
    requestR1Id = Number(r1.inspection_request_id);
    const r2 = await requestOf('2', { inspectionTypeCode: 'IQC', targetTypeCode: 'LOT', targetId: lotB.lot_id, itemId: item1.item_id, lotId: lotB.lot_id, statusCode: 'IN_PROGRESS', requestedAt: REQUESTED_R2 });
    requestR2Id = Number(r2.inspection_request_id);
    const r3 = await requestOf('3', { inspectionTypeCode: 'IQC', targetTypeCode: 'LOT', targetId: item1.item_id, itemId: item1.item_id, statusCode: 'COMPLETED', requestedAt: REQUESTED_R3 });
    requestR3Id = Number(r3.inspection_request_id);
    // PQC 갈래 — 다른 품목(item2)이라 item1 로 좁히는 위 단언들과 안 섞인다.
    const r4 = await requestOf('4', { inspectionTypeCode: 'PQC', targetTypeCode: 'WORK_ORDER', targetId: workOrder.work_order_id, itemId: item2.item_id, workOrderId: workOrder.work_order_id, statusCode: 'REQUESTED', requestedAt: REQUESTED_R4 });
    requestR4Id = Number(r4.inspection_request_id);
    // ⭐ 기준 없는 갈래 — 검사 기준이 등록되지 않은 품목도 검사를 진행한다(✓확정 2026-07-15).
    // M-e ⓐ 전에는 물리가 NOT NULL 이라 이 행 자체를 심을 수 없었다.
    const r5 = await requestOf('5', { inspectionTypeCode: 'PQC', targetTypeCode: 'WORK_ORDER', targetId: workOrder.work_order_id, itemId: item2.item_id, workOrderId: workOrder.work_order_id, statusCode: 'REQUESTED', requestedAt: REQUESTED_R5, planVersionId: null });
    requestR5Id = Number(r5.inspection_request_id);

    // 결과(PR ②b) 픽스처 — 검사자 하나로 충분하다(주체 해석은 PR ③ 몫).
    const worker = await prisma.worker.create({
      data: { worker_no: `${PREFIX}-WK`, worker_name: '검사의뢰검사원', business_unit_id: businessUnit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
    });
    ids.worker = worker.worker_id;

    const resultOf = async (
      suffix: string,
      overrides: {
        inspectionRequestId: bigint;
        round?: number;
        previousResultId?: bigint;
        statusCode: string;
        overallJudgmentCode: string | null;
        inspectedAt: string;
        acceptedQty?: number;
        rejectedQty?: number;
        heldQty?: number;
      },
    ) =>
      prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-IRS-${suffix}`,
          inspection_request_id: overrides.inspectionRequestId,
          inspection_round: overrides.round ?? 1,
          previous_result_id: overrides.previousResultId ?? null,
          inspected_qty: 100,
          accepted_qty: overrides.acceptedQty ?? 0,
          rejected_qty: overrides.rejectedQty ?? 0,
          held_qty: overrides.heldQty ?? 0,
          uom_id: uom.uom_id,
          overall_judgment_code: overrides.overallJudgmentCode,
          inspector_id: worker.worker_id,
          inspected_at: new Date(overrides.inspectedAt),
          confirmed_at: overrides.statusCode === 'CONFIRMED' ? new Date(overrides.inspectedAt) : null,
          status_code: overrides.statusCode,
          idempotency_key: `${PREFIX}-IDEM-${suffix}`,
        },
      });

    // R1 — 재검 사슬(회차 2). 1회차 불합격(REJECTED) → 재검 2회차 합격(ACCEPTED).
    const a1 = await resultOf('A1', { inspectionRequestId: r1.inspection_request_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'REJECTED', inspectedAt: INSPECTED_A1, acceptedQty: 80, rejectedQty: 20 });
    resultA1Id = Number(a1.inspection_result_id);
    const a2 = await resultOf('A2', { inspectionRequestId: r1.inspection_request_id, round: 2, previousResultId: a1.inspection_result_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED', inspectedAt: INSPECTED_A2, acceptedQty: 100 });
    resultA2Id = Number(a2.inspection_result_id);

    // R2 — 단일 회차(사슬 없음).
    const b1 = await resultOf('B1', { inspectionRequestId: r2.inspection_request_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED', inspectedAt: INSPECTED_B1, acceptedQty: 100 });
    resultB1Id = Number(b1.inspection_result_id);

    // R3 — ⭐ DRAFT + overall_judgment_code=NULL(M-e ⓒ). CHECK 는 CONFIRMED 일 때만 걸어
    // 수량 합이 안 맞아도(전부 0) 통과한다.
    const c1 = await resultOf('C1', { inspectionRequestId: r3.inspection_request_id, statusCode: 'DRAFT', overallJudgmentCode: null, inspectedAt: INSPECTED_C1 });
    resultC1Id = Number(c1.inspection_result_id);

    // R4 — PQC(W/O 축). `processId` 판정 ⓑ(work_order.routing_operation.process)의 근거.
    const d1 = await resultOf('D1', { inspectionRequestId: r4.inspection_request_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED', inspectedAt: INSPECTED_D1, acceptedQty: 100 });
    resultD1Id = Number(d1.inspection_result_id);
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '검사의뢰검사', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    cookie = await login(LOGIN_ID);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** FK 역순으로 지운다. `beforeAll`·`afterAll` 둘 다 부른다(자가 치유). */
  async function cleanup(): Promise<void> {
    // `inspection_result` 는 `inspection_request`·`worker` 둘을 참조한다 — 그 둘보다 먼저 지운다.
    await prisma.inspection_result.deleteMany({ where: { inspection_result_no: { startsWith: PREFIX } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.inbound_receipt_line.deleteMany({ where: { inbound_receipt: { plant: { plant_code: { startsWith: PREFIX } } } } });
    await prisma.lot.deleteMany({ where: { plant: { plant_code: { startsWith: PREFIX } } } });
    await prisma.inbound_receipt.deleteMany({ where: { plant: { plant_code: { startsWith: PREFIX } } } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.inspection_plan_version.deleteMany({ where: { inspection_plan: { inspection_plan_code: { startsWith: PREFIX } } } });
    await prisma.inspection_plan.deleteMany({ where: { inspection_plan_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
