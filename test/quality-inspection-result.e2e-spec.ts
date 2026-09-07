/**
 * 검사 의뢰·결과 (e2e) — I-19. PR ②a(의뢰 조회 2건) + PR ②b(결과 조회 2건) + PR ③b(저장) + PR ③c(수정)
 * + **PR ④(`:confirm` — 이 슬라이스의 심장)**. 집계 3건·`/measurements` 는 PR ⑤ 가 이어 붙인다.
 * ⭐ 확정 갈래는 **전이가 «일어나야» 하는 픽스처**를 쓴다 — `lot_id` 가 실재하고 상태가 전이표의
 *   `from` 안에 있는 LOT + 열린 `lot_hold`. 그 위에서만 「안 옮겨졌다」가 반증 가능해진다.
 * ⭐ PR ③b 부터 **쓰기 경로가 행을 «만든다»** — 그전까지 `DRAFT` + 판정 없음 행은 픽스처가 prisma
 *   로 심은 것뿐이었다. 저장 갈래는 그 행을 `POST` 로 세우고 이어서 `GET` 으로 모양을 확인한다.
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
const NOPERM_ID = 'e2e-i19qa-noperm';
/** 계약이 403 을 선언한 셋 — 도출표(`derived-permissions.ts:250·251·280`)에 이미 있다. */
const ROLE = 'E2E_I19_QUALITY';
const PERMISSIONS = ['W-01-01', 'P-02-13', 'W-04-03'];
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
  let noPermCookie: string[];

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
    sessionWorker: 0n,
    process: 0n,
    businessUnit: 0n,
    itemSpecA: 0n,
    itemSpecB: 0n,
    routingOperation: 0n,
    c14PlanVersion: 0n,
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
  // ⭐ 리뷰 Major 2 픽스처 — uq_inspection_round 는 (의뢰,회차) 쌍만 닫을 뿐 「의뢰 하나 = 사슬
  // 하나」를 보장하지 않는다. prisma 직접 INSERT 로 그 갈래를 만든다(정상 쓰기 경로로는 못 만든다).
  let requestR6Id: number; // 뿌리가 둘인 의뢰(이상 데이터)
  let requestR7Id: number; // 교차-의뢰 자식 시나리오 — 뿌리
  let resultE1Id: number; // R6 뿌리1(정상 · round=1 · prev=NULL)
  let resultE2Id: number; // R6 뿌리2(이상 데이터 · round=2 인데도 prev=NULL)
  let resultF1Id: number; // R7 뿌리
  let resultF2Id: number; // R8(다른 의뢰) 소속인데 previous_result_id 로 F1 의 자식이 된다
  // ⭐ 리뷰 m-7 픽스처 — 분기 사슬(한 부모에 자식 둘)에서 BFS 깊이 순과 회차 순이 갈린다.
  let requestR9Id: number;
  let resultG1Id: number; // 뿌리(회차1)
  let resultGAId: number; // G1 자식(회차2)
  let resultGBId: number; // G1 자식(회차5) — GA 의 형제, 회차가 더 크다
  let resultGCId: number; // GA 의 자식(회차3) — GB 보다 늦게(더 깊게) 발견되지만 회차는 더 작다
  const INSPECTED_A1 = '2026-09-02T01:00:00.000Z';
  const INSPECTED_A2 = '2026-09-02T03:00:00.000Z';
  const INSPECTED_B1 = '2026-09-02T02:00:00.000Z';
  const INSPECTED_C1 = '2026-09-03T00:00:00.000Z';
  const INSPECTED_D1 = '2026-09-04T00:00:00.000Z';
  const INSPECTED_E = '2026-09-06T00:00:00.000Z';
  const INSPECTED_F1 = '2026-09-07T00:00:00.000Z';
  const INSPECTED_F2 = '2026-09-07T01:00:00.000Z';
  const INSPECTED_G = '2026-09-08T00:00:00.000Z';
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

  // ── 쓰기 공용 도구 (PR ③b 저장 · PR ③c 수정이 함께 쓴다) ──────────────────────
  /** ⛔ 조회 단언의 기간창(`SCOPE_FROM`~`SCOPE_TO`) 밖이다 — 쓰기가 그 건수를 흔들면 안 된다. */
  const INSPECTED_W = '2026-09-10T05:00:00.000Z';
  const WORKER_HEADER = `${PREFIX}-WK`;
  let writeSeq = 0;

  /**
   * 쓰기 단언마다 «자기 의뢰»를 하나씩 세운다. `uq_inspection_round(의뢰, 회차)` 가 「뿌리는
   * 의뢰당 하나」를 강제하므로(§5-1 「없으면 회차 1」) 한 의뢰를 나눠 쓰면 두 번째 저장이
   * 409 `DUPLICATE_KEY` 로 막힌다 — 그 자체가 옳은 동작이라 테스트가 의뢰를 나눈다.
   * 번호 접미어가 `W…` 인 것도 필요하다: `q=${PREFIX}-IR-1` 단언이 `IR-10` 을 함께 잡으면 안 된다.
   */
  async function newRequest(): Promise<number> {
    writeSeq += 1;
    const row = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-IR-W${writeSeq}`,
        inspection_type_code: 'PQC',
        inspection_plan_version_id: ids.inspectionPlanVersion,
        target_type_code: 'WORK_ORDER',
        target_id: ids.workOrder,
        item_id: ids.item2,
        work_order_id: ids.workOrder,
        target_qty: 100,
        uom_id: ids.uom,
        status_code: 'REQUESTED',
        requested_at: new Date(REQUESTED_R1),
      },
    });
    return Number(row.inspection_request_id);
  }

  function draftBody(inspectionRequestId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      inspectionRequestId,
      inspectedQty: 100,
      // ⭐ 합이 100 이 아니다 — 작성중에는 통과해야 한다(M-e ⓑ).
      acceptedQty: 0,
      rejectedQty: 0,
      heldQty: 0,
      uomId: Number(ids.uom),
      inspectedAt: INSPECTED_W,
      statusCode: 'DRAFT',
      ...overrides,
    };
  }

  function post(body: Record<string, unknown>, options: { session?: string[]; workerNo?: string; key?: string } = {}) {
    const call = request(app.getHttpServer())
      .post(RESULTS)
      .set('Cookie', options.session ?? cookie)
      .set('Idempotency-Key', options.key ?? randomUUID());
    if (options.workerNo !== undefined) call.set('X-Worker-No', options.workerNo);
    return call.send(body);
  }

  async function newDraft(inspectionRequestId: number, overrides: Record<string, unknown> = {}): Promise<number> {
    const created = await post(draftBody(inspectionRequestId, overrides), { workerNo: WORKER_HEADER }).expect(201);
    return created.body.inspectionResultId as number;
  }

  function put(inspectionResultId: number, body: Record<string, unknown>, version: number, session: string[] = cookie) {
    return request(app.getHttpServer())
      .put(`${RESULTS}/${inspectionResultId}`)
      .set('Cookie', session)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(version))
      .send(body);
  }

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
      expect(validator('GET /quality/inspection-results')(response.body)).toBe(true);
    });

    it('⛔ Major 3(리뷰) — `inspectedFrom`·`inspectedTo` 는 한 쌍이다. 한쪽만 오면 400 `PAIR`', async () => {
      const fromOnly = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectedFrom=${SCOPE_FROM}`)
        .set('Cookie', cookie)
        .expect(400);
      expect(fromOnly.body.errors[0]).toMatchObject({ field: 'inspectedTo', code: 'PAIR' });

      const toOnly = await request(app.getHttpServer()).get(`${RESULTS}?inspectedTo=${SCOPE_TO}`).set('Cookie', cookie).expect(400);
      expect(toOnly.body.errors[0]).toMatchObject({ field: 'inspectedTo', code: 'PAIR' });
    });

    it('⭐ `finalRoundOnly=false` 면 `items.length > page.total` 이다 — 사슬이 뿌리와 같은 페이지에 동거한다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectedFrom=${SCOPE_FROM}&inspectedTo=${SCOPE_TO}&finalRoundOnly=false`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page.total).toBe(2);
      expect(response.body.items.length).toBeGreaterThan(response.body.page.total);
      expect(validator('GET /quality/inspection-results')(response.body)).toBe(true);
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
      expect(validator('GET /quality/inspection-results')(response.body)).toBe(true);
    });

    it('⭐ Major 2(리뷰) — 뿌리가 둘인 의뢰가 사슬을 두 번 싣지 않는다(조용한 중복 방지)', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectionRequestId=${requestR6Id}`)
        .set('Cookie', cookie)
        .expect(200);

      // 뿌리(previous_result_id IS NULL)가 E1·E2 둘이라 page.total 도 2 다. 옛 코드는
      // inspection_request_id 로 묶어 두 뿌리가 같은 사슬 버킷을 공유했고, 그 버킷을 뿌리
      // 수만큼(2번) flatMap 해 items 가 [E1,E2,E1,E2] 로 중복됐다. 지금은 뿌리마다 독립
      // BFS 라 각자 자기 자신 1건짜리 사슬로 끝난다 — 중복이 없다.
      expect(response.body.page.total).toBe(2);
      expect(response.body.items.map((item: { inspectionResultId: number }) => item.inspectionResultId)).toEqual([
        resultE1Id,
        resultE2Id,
      ]);
    });

    it('⭐ Major 2(리뷰) — 교차-의뢰 자식이 previous_result_id 로 잡힌다(조용한 소실 방지)', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectionRequestId=${requestR7Id}`)
        .set('Cookie', cookie)
        .expect(200);

      // F2 는 자기 자신의 inspection_request_id 가 R8(다른 의뢰)이라 「inspection_request_id
      // IN (뿌리 의뢰들)」로 훑던 옛 코드에서는 통째로 사라졌다. previous_result_id 로 직접
      // 찾는 지금은 F1(R7 뿌리)의 자식으로 정상 노출된다 — F2 의 inspectionRequestId 필드
      // 자체는 여전히 R8(자기 소속)을 그대로 낸다(데이터를 지어내 R7로 바꾸지 않는다).
      expect(response.body.page.total).toBe(1); // 뿌리는 F1 하나(R7 스코프 기준)
      expect(response.body.items.map((item: { inspectionResultId: number }) => item.inspectionResultId)).toEqual([
        resultF1Id,
        resultF2Id,
      ]);
      expect(response.body.items[1].inspectionRequestId).not.toBe(requestR7Id); // F2 는 R8 소속 그대로
    });

    it('⭐ 리뷰 m-7 — 분기 사슬(한 부모에 자식 둘)도 회차 오름차순으로 나온다(BFS 깊이 순이 아니다)', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectionRequestId=${requestR9Id}`)
        .set('Cookie', cookie)
        .expect(200);

      // G1(1) 의 자식이 GA(2)·GB(5) 둘이고 GA 의 자식이 GC(3)다. BFS 는 깊이 순으로 담아
      // [G1,GA,GB,GC]=[1,2,5,3] 이 된다 — 최종 정렬이 없으면 이 단언이 실패한다.
      expect(response.body.items.map((item: { inspectionResultId: number }) => item.inspectionResultId)).toEqual([
        resultG1Id,
        resultGAId,
        resultGCId,
        resultGBId,
      ]);
      expect(response.body.items.map((item: { inspectionRound: number }) => item.inspectionRound)).toEqual([1, 2, 3, 5]);
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

    it('⭐ DRAFT 행 — `overall_judgment_code` 가 NULL 이면 `overallJudgmentCode` 키를 생략한다(선례 054 와 같은 모양 — 문의 085)', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?inspectionRequestId=${requestR3Id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({ inspectionResultId: resultC1Id, statusCode: 'DRAFT' });
      expect(response.body.items[0]).not.toHaveProperty('overallJudgmentCode');
      // ⛔ 전체 스키마 ajv 검증은 여기서도 못 통과한다 — 계약이 required 로 적은 칸이라 키
      // 생략도 ajv 상 위반이다(ⓐ 를 골라도 결과는 같다 — 스킵은 판정과 독립적인 불가피한
      // 결과다). 설계 미정 — 문의 085(054 와 같은 자리 · 묶어 답해 달라고 적는다).
    });
  });


  describe('저장 (PR ③b)', () => {
    it('`POST` `statusCode=DRAFT` 가 수량 합이 안 맞아도 201 이다 — 번호·회차·검사자를 서버가 채운다(M-e ⓑ)', async () => {
      const response = await post(draftBody(await newRequest()), { workerNo: WORKER_HEADER }).expect(201);

      expect(response.body).toMatchObject({
        statusCode: 'DRAFT',
        // ⭐ 본문이 못 보내는 세 칸 — §5-3 의 「서로 다른 축」이 각자 채운다.
        inspectionRound: 1,
        inspectorId: Number(ids.worker),
        versionNo: 1,
      });
      // 기간 키는 `inspectedAt` 의 UTC 날짜다 — 서버 수신 시각(오늘)이 아니다.
      expect(response.body.inspectionResultNo).toMatch(/^IRS-20260910-\d{4}$/);
    });

    it('⭐ 문의 085 — `POST`(DRAFT)로 «실제로 만든» 행이 `GET` 에서 `overallJudgmentCode` 키를 안 낸다', async () => {
      const inspectionResultId = await newDraft(await newRequest());

      const detail = await request(app.getHttpServer()).get(`${RESULTS}/${inspectionResultId}`).set('Cookie', cookie).expect(200);
      expect(detail.body).toMatchObject({ inspectionResultId, statusCode: 'DRAFT' });
      // 지금까지 이 모양은 픽스처가 prisma 로 심은 행에서만 봤다(선례 054 와 같은 판정). 쓰기
      // 경로가 세운 행도 같은 모양인지가 이 PR 의 몫이다 — 물리까지 함께 못 박는다.
      expect(detail.body).not.toHaveProperty('overallJudgmentCode');
      const row = await prisma.inspection_result.findUniqueOrThrow({
        where: { inspection_result_id: BigInt(inspectionResultId) },
        select: { overall_judgment_code: true, confirmed_at: true },
      });
      expect(row.overall_judgment_code).toBeNull();
      expect(row.confirmed_at).toBeNull();
    });

    it('`POST` `statusCode=CONFIRMED` 가 수량 합이 안 맞으면 400 `INVALID`', async () => {
      const response = await post(draftBody(await newRequest(), { statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED' }), {
        workerNo: WORKER_HEADER,
      }).expect(400);

      expect(response.body.errors).toContainEqual(expect.objectContaining({ field: 'inspectedQty', code: 'INVALID' }));
    });

    it('`POST` `statusCode=CONFIRMED` 에 `overallJudgmentCode` 가 없으면 400 `REQUIRED`', async () => {
      const response = await post(draftBody(await newRequest(), { statusCode: 'CONFIRMED', acceptedQty: 100 }), {
        workerNo: WORKER_HEADER,
      }).expect(400);

      expect(response.body.errors).toContainEqual(expect.objectContaining({ field: 'overallJudgmentCode', code: 'REQUIRED' }));
    });

    it('`POST` `statusCode=CONFIRMED` 가 201 이고 `confirmed_at` 이 함께 찬다', async () => {
      const response = await post(
        draftBody(await newRequest(), { statusCode: 'CONFIRMED', acceptedQty: 100, overallJudgmentCode: 'ACCEPTED' }),
        { workerNo: WORKER_HEADER },
      ).expect(201);

      expect(response.body).toMatchObject({ statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED' });
      expect(response.body.confirmedAt).toEqual(expect.any(String));
      // 확정 응답은 계약 `InspectionResult` 를 그대로 통과한다(판정 칸이 required 라 DRAFT 는 못 한다).
      expect(validator('POST /quality/inspection-results', 201)(response.body)).toBe(true);
      // ⚠ **이 0 은 「옳아서」가 아니라 「아직 안 붙여서」다.** PR ④(#316)는 `:confirm` 쪽에만
      //   부수효과를 세웠고, 계약은 확정 경로 둘의 부수효과가 같아야 한다고 적었다
      //   (`x-internal-note`). ⭐ **고치는 PR 은 이 단언을 뒤집는다** — LOT 상태·`lot_status_event`
      //   1행·보류 해제를 `:confirm` 갈래와 같은 모양으로 단언한다. 정본 §12-1 ⓑ.
      //   ⛔ 이 단언을 「전이가 없다」의 근거로 인용하지 마라 — 이 픽스처는 PQC·`lot_id=null`
      //   ·`rejectedQty=0` 이라 §3-3·§3-4 를 정확히 구현해도 0 이다(반증 불가).
      expect(await prisma.lot_status_event.count({ where: { lot: { plant: { plant_code: { startsWith: PREFIX } } } } })).toBe(0);
    });

    it('⭐ 기준 없는 의뢰(`inspectionPlanVersionId=null`)에 `measurements` 없이 201 이 난다', async () => {
      const response = await post(
        draftBody(requestR5Id, { statusCode: 'CONFIRMED', acceptedQty: 100, overallJudgmentCode: 'ACCEPTED', remarks: '자유 입력만으로 성립한다' }),
        { workerNo: WORKER_HEADER },
      ).expect(201);

      expect(response.body).toMatchObject({ inspectionRequestId: requestR5Id, remarks: '자유 입력만으로 성립한다' });
      expect(await prisma.inspection_measurement.count({ where: { inspection_result_id: BigInt(response.body.inspectionResultId) } })).toBe(0);
    });

    it('같은 `Idempotency-Key` 재전송이 한 건이다 — `inspection_result` 행이 늘지 않는다', async () => {
      const inspectionRequestId = await newRequest();
      const key = randomUUID();
      const body = draftBody(inspectionRequestId);
      const first = await post(body, { workerNo: WORKER_HEADER, key }).expect(201);
      const again = await post(body, { workerNo: WORKER_HEADER, key }).expect(201);

      expect(again.body.inspectionResultId).toBe(first.body.inspectionResultId);
      expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(inspectionRequestId) } })).toBe(1);
    });

    it('`previousResultId` 를 실으면 회차가 +1 이고 같은 의뢰에 매달린다', async () => {
      const inspectionRequestId = await newRequest();
      const root = await newDraft(inspectionRequestId);
      const response = await post(
        draftBody(inspectionRequestId, { previousResultId: root, reinspectionReasonCode: 'CUSTOMER_CLAIM' }),
        { workerNo: WORKER_HEADER },
      ).expect(201);

      expect(response.body).toMatchObject({ inspectionRequestId, inspectionRound: 2, previousResultId: root });
    });

    it('⛔ `previousResultId` 가 «다른 의뢰»의 행이면 400 `INVALID` — 쓰기 경로는 교차-의뢰 자식을 안 만든다', async () => {
      const response = await post(draftBody(await newRequest(), { previousResultId: resultA1Id }), { workerNo: WORKER_HEADER }).expect(400);

      expect(response.body.errors[0]).toMatchObject({ field: 'previousResultId', code: 'INVALID' });
    });

    it('없는 `inspectionRequestId` 는 400 `INVALID` 다(404 가 아니다 — 계약 미선언)', async () => {
      const response = await post(draftBody(999_999_999), { workerNo: WORKER_HEADER }).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'inspectionRequestId', code: 'INVALID' });
    });

    it('⭐ `X-Worker-No` 없이 계정 토큰만으로 201 이다 — 서버가 세션에서 검사자를 푼다(§5-5)', async () => {
      const response = await post(draftBody(await newRequest())).expect(201);

      // 헤더 갈래(`-WK`)가 아니라 계정 연결 갈래(`-WK2`)로 풀렸다.
      expect(response.body.inspectorId).toBe(Number(ids.sessionWorker));
      expect(response.body.inspectorId).not.toBe(Number(ids.worker));
    });

    it('⭐ 확정 행에 판정이 비면 물리 CHECK 가 둘째 그물로 막는다(`ck_inspection_result_judgment`)', async () => {
      // 서비스가 400 `REQUIRED` 로 먼저 막지만(위 단언), M-e ⓒ 가 NOT NULL 을 푼 뒤로 «DB 는»
      // 아무것도 못 막고 있었다. 이 PR 의 마이그가 그 자리를 닫았는지 물리로 직접 확인한다.
      const inspectionRequestId = await newRequest();
      await expect(
        prisma.inspection_result.create({
          data: {
            inspection_result_no: `${PREFIX}-IRS-CHECK`,
            inspection_request_id: BigInt(inspectionRequestId),
            inspection_round: 90,
            inspected_qty: 100,
            accepted_qty: 100,
            uom_id: ids.uom,
            overall_judgment_code: null,
            inspector_id: ids.worker,
            inspected_at: new Date(INSPECTED_W),
            status_code: 'CONFIRMED',
            idempotency_key: `${PREFIX}-IDEM-CHECK`,
          },
        }),
      ).rejects.toThrow(/ck_inspection_result_judgment/);
    });

    it('`measurements` 를 실으면 그 결과에 그대로 붙는다 — 치환·생략 갈래는 PR ③c 가 잇는다', async () => {
      const measurement = (specId: bigint, value: number) => ({
        inspectionItemSpecId: Number(specId),
        sampleNo: 1,
        numericValue: value,
        judgmentCode: 'ACCEPTED',
        measuredAt: INSPECTED_W,
      });
      const inspectionResultId = await newDraft(await newRequest(), {
        measurements: [measurement(ids.itemSpecA, 10), measurement(ids.itemSpecB, 20)],
      });

      const rows = await prisma.inspection_measurement.findMany({
        where: { inspection_result_id: BigInt(inspectionResultId) },
        orderBy: { inspection_item_spec_id: 'asc' },
        select: { inspection_item_spec_id: true, numeric_value: true, judgment_code: true },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => Number(row.numeric_value))).toEqual([10, 20]);
      // ⛔ 항목 판정은 종합 판정과 «그룹이 다르다» — 항목에는 「보류」가 없다(§1-5).
      expect(rows.map((row) => row.judgment_code)).toEqual(['ACCEPTED', 'ACCEPTED']);
    });

    it('⛔ 측정치 값 세 칸 중 둘 이상이 차면 400 `INVALID` — `ck_measurement_single_value` 를 앞당겨 잡는다', async () => {
      const response = await post(
        draftBody(await newRequest(), {
          measurements: [
            { inspectionItemSpecId: Number(ids.itemSpecA), sampleNo: 1, numericValue: 1, textValue: '가', judgmentCode: 'ACCEPTED', measuredAt: INSPECTED_W },
          ],
        }),
        { workerNo: WORKER_HEADER },
      ).expect(400);

      // 계약 스키마가 값 세 칸을 각각 «선택»으로만 적어 검증 가드를 통과한다 — 그대로 흘리면 500 이다.
      expect(response.body.errors[0]).toMatchObject({ field: 'measurements[0]', code: 'INVALID' });
    });

    it('⭐ #304 M-2 — 같은 의뢰에 뿌리를 둘 세우면 409 `DUPLICATE_KEY` 다(`uq_inspection_round`)', async () => {
      const inspectionRequestId = await newRequest();
      await newDraft(inspectionRequestId);
      // 두 번째 저장도 previousResultId 가 없어 회차 1 을 노린다 — (의뢰, 회차) UNIQUE 가 막는다.
      const response = await post(draftBody(inspectionRequestId), { workerNo: WORKER_HEADER }).expect(409);

      expect(response.body).toMatchObject({ code: 'DUPLICATE_KEY', conflictCause: 'user' });
      // 봉투가 `QualityConflictResponse` 다 — required(`code`·`message`)를 계약 스키마로 확인한다.
      expect(validator('POST /quality/inspection-results', 409)(response.body)).toBe(true);
      expect(response.body.errors).toBeUndefined();
    });

    it('⭐ #314 Major — 물리 하한이 400 이다(500 아니다): `inspectedQty` 0 · `acceptedQty` 음수 · `sampleNo` 0', async () => {
      const inspectionRequestId = await newRequest();
      // ⭐ 본길이다 — M-e ⓑ 가 연 「세 칸을 다 채우기 전 임시 저장」이 정확히 이 갈래다.
      const zero = await post(draftBody(inspectionRequestId, { inspectedQty: 0 }), { workerNo: WORKER_HEADER }).expect(400);
      expect(zero.body.errors).toContainEqual(expect.objectContaining({ field: 'inspectedQty', code: 'RANGE' }));

      // `app.qty_t` 도메인이 `VALUE >= 0` 이라 음수 세 칸도 같은 500 갈래였다.
      const negative = await post(draftBody(inspectionRequestId, { acceptedQty: -1 }), { workerNo: WORKER_HEADER }).expect(400);
      expect(negative.body.errors).toContainEqual(expect.objectContaining({ field: 'acceptedQty', code: 'RANGE' }));

      const sample = await post(
        draftBody(inspectionRequestId, {
          measurements: [{ inspectionItemSpecId: Number(ids.itemSpecA), sampleNo: 0, judgmentCode: 'ACCEPTED', measuredAt: INSPECTED_W }],
        }),
        { workerNo: WORKER_HEADER },
      ).expect(400);
      expect(sample.body.errors).toContainEqual(expect.objectContaining({ field: 'measurements[0].sampleNo', code: 'RANGE' }));

      // 셋 다 막혔으니 행이 하나도 안 섰다 — 500 이었다면 여기서도 0 이지만 응답이 5xx 였다.
      expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(inspectionRequestId) } })).toBe(0);
    });

    it('무권한 계정은 `POST` 에서 403 이다', async () => {
      await post(draftBody(await newRequest()), { session: noPermCookie, workerNo: WORKER_HEADER }).expect(403);
    });
  });

  describe('수정 (PR ③c)', () => {
    it('`PUT` 이 작성중 결과를 고친다 — 새 ETag 가 온다', async () => {
      const inspectionResultId = await newDraft(await newRequest());
      const response = await put(
        inspectionResultId,
        { inspectedQty: 100, acceptedQty: 90, rejectedQty: 10, heldQty: 0, overallJudgmentCode: 'HELD', inspectedAt: INSPECTED_W, remarks: '고침' },
        1,
      ).expect(200);

      expect(response.body).toMatchObject({
        inspectionResultId,
        acceptedQty: 90,
        rejectedQty: 10,
        overallJudgmentCode: 'HELD',
        remarks: '고침',
        versionNo: 2,
      });
      // ⚠ 계약이 `PUT` 200 에 ETag 를 «선언하지 않았는데» `runVersioned` 는 늘 낸다 — I-1 의
      //   `PUT …/steps` 와 같은 자리다. 「알려둘 것」으로 남기고 고치지 않는다(호환 완화).
      expect(response.headers.etag).toBe('2');
      // ⛔ `statusCode` 를 못 바꾼다 — 계약 `InspectionResultUpdate` 에 그 칸이 없다.
      expect(response.body.statusCode).toBe('DRAFT');
      expect(validator('PUT /quality/inspection-results/{inspectionResultId}')(response.body)).toBe(true);
    });

    it('보낸 칸만 바뀐다 — 생략한 칸은 저장된 값 그대로다(명시 null 로 «해제»하는 칸이 0 이다)', async () => {
      const inspectionResultId = await newDraft(await newRequest(), { remarks: '처음 비고' });
      const response = await put(inspectionResultId, { acceptedQty: 40 }, 1).expect(200);

      expect(response.body).toMatchObject({ acceptedQty: 40, remarks: '처음 비고', inspectedQty: 100 });
    });

    it('⭐ 확정된 결과를 `PUT` 하면 409 `INVALID_STATE` — 고치는 것이 아니라 재검이다(B-10)', async () => {
      const response = await put(resultA1Id, { remarks: '확정본을 고친다' }, 1).expect(409);

      // 봉투가 `ErrorResponse` 가 아니라 `QualityConflictResponse` 다. `code` 가 required 라 반드시 실린다.
      expect(response.body).toMatchObject({ code: 'INVALID_STATE', conflictCause: 'user' });
      expect(response.body.errors).toBeUndefined();
      expect(validator('PUT /quality/inspection-results/{inspectionResultId}', 409)(response.body)).toBe(true);
      // ⛔ `:confirm` 의 재확정(400 `STATE_LOCKED`)과 봉투가 «다르다» — 여기는 409 다.
      expect(await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(resultA1Id) }, select: { version_no: true } })).toEqual({ version_no: 1 });
    });

    it('⭐ `If-Match` 가 어긋나면 409 `VERSION_CONFLICT` + `currentVersion` — 상태 게이트보다 «먼저» 본다', async () => {
      const inspectionResultId = await newDraft(await newRequest());
      const response = await put(inspectionResultId, { remarks: '낡은 토큰' }, 99).expect(409);

      expect(response.body).toMatchObject({ code: 'VERSION_CONFLICT', conflictCause: 'user', currentVersion: '1' });
      expect(validator('PUT /quality/inspection-results/{inspectionResultId}', 409)(response.body)).toBe(true);

      // 확정본에 낡은 토큰을 보내면 «상태»가 아니라 «버전»이 먼저 걸린다(형제 `:release`·`:close` 선례).
      const confirmed = await put(resultA1Id, { remarks: '낡은 토큰 + 확정본' }, 99).expect(409);
      expect(confirmed.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: '1' });
    });

    it('⚠ 같은 키로 «다른» 본문을 보내면 409 인데 계약 required 인 `code` 가 빠진다(알려진 결손 · 공용 파일)', async () => {
      const inspectionResultId = await newDraft(await newRequest());
      const key = randomUUID();
      const send = (remarks: string) =>
        request(app.getHttpServer())
          .put(`${RESULTS}/${inspectionResultId}`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', key)
          .set('If-Match', '1')
          .send({ remarks });
      await send('첫 본문').expect(200);
      const response = await send('다른 본문').expect(409);

      expect(response.body).toMatchObject({ conflictCause: 'user' });
      expect(response.body.message).toEqual(expect.any(String));
      // ⚠ 실측 — `idempotency.service.ts:115` 가 공용 예외를 `code` 없이 던진다. `QualityConflictResponse.code`
      //   는 required 라 이 갈래«만» 계약 스키마를 통과하지 못한다. R-8 이 PR ① 에 배정했으나
      //   `ConflictExtra` 타입만 늘고 사용처가 안 섰다 — 공용 파일이라 이 PR 이 고치지 않는다.
      //   ⭐ 고치는 PR 은 아래 한 줄을 `code: 'DUPLICATE_KEY'` 단언으로 바꾼다. ⛔ 「계약 스키마
      //   불통과」를 초록으로 굳히지 않는다 — 살아 있는 응답에 ajv `toBe(false)` 를 걸면 결함이
      //   테스트로 고정된다(#314 리뷰). 부재만 특성화한다. 정본 §12-1 미완 ⓐ.
      expect(response.body.code).toBeUndefined();
    });

    it('⭐ `measurements` 를 실으면 치환이고 생략하면 손대지 않는다', async () => {
      const measurement = (specId: bigint, value: number) => ({
        inspectionItemSpecId: Number(specId),
        sampleNo: 1,
        numericValue: value,
        judgmentCode: 'ACCEPTED',
        measuredAt: INSPECTED_W,
      });
      const inspectionResultId = await newDraft(await newRequest(), {
        measurements: [measurement(ids.itemSpecA, 10), measurement(ids.itemSpecB, 20)],
      });
      const scope = { inspection_result_id: BigInt(inspectionResultId) };

      // 생략 — 손대지 않는다(빈 배열과 다르다).
      await put(inspectionResultId, { remarks: '측정치는 안 건드린다' }, 1).expect(200);
      expect(await prisma.inspection_measurement.count({ where: scope })).toBe(2);

      // 실으면 전건 치환이다 — 부분 병합이 아니다(§1-3).
      await put(inspectionResultId, { measurements: [measurement(ids.itemSpecA, 99)] }, 2).expect(200);
      const rows = await prisma.inspection_measurement.findMany({ where: scope, select: { inspection_item_spec_id: true, numeric_value: true } });
      expect(rows).toHaveLength(1);
      expect(rows[0].inspection_item_spec_id).toBe(ids.itemSpecA);
      expect(Number(rows[0].numeric_value)).toBe(99);

      // 빈 배열은 «전건 삭제»다 — 생략과 다르다. 설계 미정 — 문의 086(계약이 완전히 침묵한다).
      await put(inspectionResultId, { measurements: [] }, 3).expect(200);
      expect(await prisma.inspection_measurement.count({ where: scope })).toBe(0);
    });

    it('없는 `inspectionResultId` 는 404 다(계약 선언) · 값 목록 밖 판정은 400 `INVALID`', async () => {
      await put(999_999_999, { remarks: '없는 대상' }, 1).expect(404);

      const inspectionResultId = await newDraft(await newRequest());
      // ⛔ 공백 문자열도 「값 목록 밖」이라 걸린다 — `assertCodeValues` 가 빈 문자열을 값으로 본다.
      const blank = await put(inspectionResultId, { overallJudgmentCode: ' ' }, 1).expect(400);
      expect(blank.body.errors[0]).toMatchObject({ field: 'overallJudgmentCode', code: 'INVALID' });
    });

    it('⭐ #314 Major — `PUT` 도 같은 하한을 건다: `inspectedQty` 0·음수 · `heldQty` 음수 · `sampleNo` 0', async () => {
      const inspectionResultId = await newDraft(await newRequest());

      const zero = await put(inspectionResultId, { inspectedQty: 0 }, 1).expect(400);
      expect(zero.body.errors).toContainEqual(expect.objectContaining({ field: 'inspectedQty', code: 'RANGE' }));

      const mixed = await put(inspectionResultId, { inspectedQty: -5, heldQty: -1 }, 1).expect(400);
      expect(mixed.body.errors.map((item: { field: string }) => item.field)).toEqual(['inspectedQty', 'heldQty']);

      const sample = await put(
        inspectionResultId,
        { measurements: [{ inspectionItemSpecId: Number(ids.itemSpecA), sampleNo: 0, judgmentCode: 'ACCEPTED', measuredAt: INSPECTED_W }] },
        1,
      ).expect(400);
      expect(sample.body.errors).toContainEqual(expect.objectContaining({ field: 'measurements[0].sampleNo', code: 'RANGE' }));

      // 400 이 먼저 났으니 버전이 안 올랐다 — 화면의 If-Match 가 그대로 산다.
      const after = await request(app.getHttpServer()).get(`${RESULTS}/${inspectionResultId}`).set('Cookie', cookie).expect(200);
      expect(after.body.versionNo).toBe(1);
    });

    it('무권한 계정은 `PUT` 에서 403 이다', async () => {
      const inspectionResultId = await newDraft(await newRequest());
      await put(inspectionResultId, { remarks: '권한 없음' }, 1, noPermCookie).expect(403);
    });
  });

  // ── 확정(PR ④) 공용 도구 ────────────────────────────────────────────────────
  /** 입하 LOT 이 태어날 때 걸리는 보류(`lot-registry.service.ts:16`). 확정이 닫는 유일한 사유다. */
  const INCOMING_HOLD = 'INCOMING_INSPECTION_WAIT';
  const CONFIRM_RELEASE_REASON = 'INCOMING_INSPECTION_PASSED'; // 설계 미정 — 문의 087
  const HELD_AT = '2026-08-31T00:00:00.000Z';
  let confirmSeq = 0;

  /**
   * 확정 단언마다 «자기 LOT»을 세운다 — 전이가 서로를 흔들면 어느 단언이 무엇을 지키는지
   * 알 수 없다. `workOrderId` 를 주면 C14 대상인 **선발행 생산LOT**(`work_order_lot_seq` 보유)이다.
   */
  async function newLot(
    statusCode: string,
    options: { holds?: string[]; workOrderId?: bigint; seq?: number } = {},
  ): Promise<bigint> {
    confirmSeq += 1;
    const workOrderId = options.workOrderId;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-CF${confirmSeq}`,
        item_id: ids.item2,
        lot_type_code: workOrderId === undefined ? 'RAW_MATERIAL' : 'PRODUCTION',
        plant_id: ids.plant,
        initial_qty: 100,
        uom_id: ids.uom,
        source_type_code: workOrderId === undefined ? 'INBOUND_RECEIPT_LINE' : 'WORK_ORDER',
        source_id: workOrderId ?? ids.plant,
        status_code: statusCode,
        work_order_lot_seq: options.seq ?? null,
      },
    });
    for (const reason of options.holds ?? []) {
      // ⚠ `held_at` 은 «과거»여야 한다 — `ck_lot_hold_release`(`released_at >= held_at`)가
      //    해제 UPDATE 를 500 으로 튕긴다. 검사 시각(`INSPECTED_W`)은 미래 날짜라 못 쓴다.
      await prisma.lot_hold.create({
        data: { lot_id: lot.lot_id, reason_code: reason, status_code: 'HELD', held_at: new Date(HELD_AT) },
      });
    }
    return lot.lot_id;
  }

  async function newWorkOrder(): Promise<bigint> {
    confirmSeq += 1;
    const row = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO-CF${confirmSeq}`,
        routing_operation_id: ids.routingOperation,
        item_id: ids.item2,
        order_qty: 100,
        uom_id: ids.uom,
        status_code: 'IN_PROGRESS',
      },
    });
    return row.work_order_id;
  }

  /** ⛔ `${PREFIX}-IR-CF…` — `q=${PREFIX}-IR-1` 단언과 `itemId=item1` 건수를 안 건드린다. */
  async function newConfirmRequest(
    options: { lotId?: bigint; typeCode?: string; planVersionId?: bigint; workOrderId?: bigint } = {},
  ): Promise<number> {
    confirmSeq += 1;
    const row = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-IR-CF${confirmSeq}`,
        inspection_type_code: options.typeCode ?? 'IQC',
        inspection_plan_version_id: options.planVersionId ?? ids.inspectionPlanVersion,
        target_type_code: options.lotId === undefined ? 'WORK_ORDER' : 'LOT',
        target_id: options.lotId ?? options.workOrderId ?? ids.workOrder,
        item_id: ids.item2,
        lot_id: options.lotId ?? null,
        work_order_id: options.workOrderId ?? null,
        target_qty: 100,
        uom_id: ids.uom,
        status_code: 'REQUESTED',
        requested_at: new Date(REQUESTED_R1),
      },
    });
    return Number(row.inspection_request_id);
  }

  /** LOT 이 붙은 의뢰 + 그 위의 작성중 결과를 한 번에. 수량은 확정이 통과하는 모양으로 준다. */
  async function newConfirmable(
    lotStatus: string,
    holds: string[],
    quantities: Record<string, unknown> = { acceptedQty: 100 },
  ): Promise<{ inspectionRequestId: number; inspectionResultId: number; lotId: bigint }> {
    const lotId = await newLot(lotStatus, { holds });
    const inspectionRequestId = await newConfirmRequest({ lotId });
    return { inspectionRequestId, inspectionResultId: await newDraft(inspectionRequestId, quantities), lotId };
  }

  function confirm(
    inspectionResultId: number,
    body: Record<string, unknown>,
    version: number | null,
    options: { session?: string[]; key?: string } = {},
  ) {
    const call = request(app.getHttpServer())
      .post(`${RESULTS}/${inspectionResultId}:confirm`)
      .set('Cookie', options.session ?? cookie)
      .set('Idempotency-Key', options.key ?? randomUUID());
    if (version !== null) call.set('If-Match', String(version));
    return call.send(body);
  }

  const eventsOf = (lotId: bigint) => prisma.lot_status_event.findMany({ where: { lot_id: lotId } });
  const lotOfId = (lotId: bigint) =>
    prisma.lot.findUniqueOrThrow({ where: { lot_id: lotId }, select: { status_code: true, version_no: true } });
  const holdsOf = (lotId: bigint) => prisma.lot_hold.findMany({ where: { lot_id: lotId }, orderBy: { lot_hold_id: 'asc' } });

  describe('확정 (PR ④) — ⭐ 심장', () => {
    it('⭐ 합격이 LOT 을 `NORMAL` 로 옮기고 `C4` 이력 1행을 남기며 수입검사 보류 3칸을 채운다', async () => {
      const { inspectionRequestId, inspectionResultId, lotId } = await newConfirmable('INSPECTION_PENDING', [INCOMING_HOLD]);

      const response = await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 1).expect(200);

      expect(response.body).toMatchObject({
        inspectionResultId,
        statusCode: 'CONFIRMED',
        overallJudgmentCode: 'ACCEPTED',
        versionNo: 2,
      });
      expect(response.body.confirmedAt).toEqual(expect.any(String));
      expect(response.headers.etag).toBe('2');
      expect(validator('POST /quality/inspection-results/{inspectionResultId}:confirm')(response.body)).toBe(true);

      // ⓐ LOT 이 «실제로» 옮겨졌다 — 상태와 ETag 축이 함께 움직인다.
      expect(await lotOfId(lotId)).toEqual({ status_code: 'NORMAL', version_no: 2 });

      // ⓑ 이력이 «1행 늘고» 전이 코드는 계약이 이름 적은 값이다(지어낸 값이 아니다).
      const events = await eventsOf(lotId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        previous_status_code: 'INSPECTION_PENDING',
        new_status_code: 'NORMAL',
        transition_code: 'C4',
        source_document_type_code: 'INSPECTION_RESULT',
        source_document_id: BigInt(inspectionResultId),
      });
      // ⛔ 재고 차원 세 칸은 비운다 — 원장을 지나지 않는다(§9-1 #2).
      expect(events[0].quality_status_code).toBeNull();
      expect(events[0].location_id).toBeNull();

      // ⓒ 보류가 닫힌다 — `ck_lot_hold_release_reason` 이 사유를 강제한다.
      const holds = await holdsOf(lotId);
      expect(holds).toHaveLength(1);
      expect(holds[0].released_at).not.toBeNull();
      expect(holds[0].released_by).not.toBeNull();
      // ⭐ 설계 미정 — 문의 087. 시드 4값에 「1회차 합격」에 맞는 값이 0개다(RETEST_* 는 C7·C8 전용).
      expect(holds[0].release_reason_code).toBe(CONFIRM_RELEASE_REASON);

      // 의뢰가 완료로 간다 — 전이표 «밖»의 부수효과(§7-3 유일한 예외).
      const requestRow = await prisma.inspection_request.findUniqueOrThrow({
        where: { inspection_request_id: BigInt(inspectionRequestId) },
        select: { status_code: true },
      });
      expect(requestRow.status_code).toBe('COMPLETED');
    });

    it('⭐ ⓓ 불합격은 `DEFECTIVE`+`C6` 이고 보류를 «닫지 않는다» — `W-01-01` §5-1 「불합격 = Hold 유지 → 반품」', async () => {
      const { inspectionResultId, lotId } = await newConfirmable('INSPECTION_PENDING', [INCOMING_HOLD], { rejectedQty: 100 });

      await confirm(inspectionResultId, { overallJudgmentCode: 'REJECTED' }, 1).expect(200);

      expect(await lotOfId(lotId)).toEqual({ status_code: 'DEFECTIVE', version_no: 2 });
      expect((await eventsOf(lotId)).map((event) => event.transition_code)).toEqual(['C6']);
      const holds = await holdsOf(lotId);
      expect(holds[0].released_at).toBeNull();
      expect(holds[0].release_reason_code).toBeNull();
    });

    it('보류 판정은 `INSPECTION_PENDING`+`C5` 이고 역시 보류를 닫지 않는다', async () => {
      const { inspectionResultId, lotId } = await newConfirmable('NORMAL', [INCOMING_HOLD], { heldQty: 100 });

      await confirm(inspectionResultId, { overallJudgmentCode: 'HELD' }, 1).expect(200);

      expect(await lotOfId(lotId)).toEqual({ status_code: 'INSPECTION_PENDING', version_no: 2 });
      expect((await eventsOf(lotId)).map((event) => event.transition_code)).toEqual(['C5']);
      expect((await holdsOf(lotId))[0].released_at).toBeNull();
    });

    it('⭐ ⓔ R-11 — 다른 열린 보류가 남아 있으면 합격이어도 `NORMAL` 로 «안» 올린다', async () => {
      const { inspectionResultId, lotId } = await newConfirmable('INSPECTION_PENDING', [INCOMING_HOLD, 'FOREIGN_MATTER_SUSPECTED']);

      await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 1).expect(200);

      // 중복 보류가 허용된다(`W-03-02` §4-B) — 수입검사 보류만 닫고 올리면 의심자재 보류가
      // 열린 채 출고가 풀린다. 상태도 ETag 도 그대로다.
      expect(await lotOfId(lotId)).toEqual({ status_code: 'INSPECTION_PENDING', version_no: 1 });
      expect(await eventsOf(lotId)).toHaveLength(0);
      const holds = await holdsOf(lotId);
      expect(holds[0].released_at).not.toBeNull(); // 수입검사 보류는 닫혔다
      expect(holds[1].released_at).toBeNull(); // 의심자재 보류는 열려 있다
    });

    it('⭐ R-10 — `lot_id` 가 없는 의뢰는 전이 없이 확정만 한다(⛔ W/O 전체로 넓히지 않는다)', async () => {
      const workOrderId = await newWorkOrder();
      const slotA = await newLot('NORMAL', { workOrderId, seq: 1 });
      const slotB = await newLot('NORMAL', { workOrderId, seq: 2 });
      const inspectionRequestId = await newConfirmRequest({ typeCode: 'PQC', workOrderId });
      const inspectionResultId = await newDraft(inspectionRequestId, { acceptedQty: 100 });

      await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 1).expect(200);

      // 계획안 본문 §3-3 의 옛 규칙(「`targetTypeCode='WORK_ORDER'` 면 W/O 축」)대로 넓혔다면
      // 이 둘이 옮겨진다 — R-10 이 그 규칙을 뒤집었다.
      expect(await eventsOf(slotA)).toHaveLength(0);
      expect(await eventsOf(slotB)).toHaveLength(0);
      expect((await lotOfId(slotA)).status_code).toBe('NORMAL');
    });

    it('⭐ 계획안 §8-3 #39 뒤집힘 — `DEFECTIVE` LOT 의 재검 합격 확정이 400 `STATE_LOCKED` 다(R-1 의 필연 · 문의 088)', async () => {
      const { inspectionRequestId, inspectionResultId, lotId } = await newConfirmable('DEFECTIVE', []);

      const response = await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 1).expect(400);
      expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });

      // 트랜잭션이 통째로 되돌아간다 — 결과·의뢰·LOT 셋 다 그대로다(부분 확정이 없다).
      const [result, requestRow] = await Promise.all([
        prisma.inspection_result.findUniqueOrThrow({
          where: { inspection_result_id: BigInt(inspectionResultId) },
          select: { status_code: true, version_no: true, confirmed_at: true },
        }),
        prisma.inspection_request.findUniqueOrThrow({
          where: { inspection_request_id: BigInt(inspectionRequestId) },
          select: { status_code: true },
        }),
      ]);
      expect(result).toEqual({ status_code: 'DRAFT', version_no: 1, confirmed_at: null });
      expect(requestRow.status_code).toBe('REQUESTED');
      expect(await lotOfId(lotId)).toEqual({ status_code: 'DEFECTIVE', version_no: 1 });
    });

    it('이미 확정된 결과를 다시 `:confirm` 하면 400 `STATE_LOCKED` — `PUT`(409 `INVALID_STATE`)과 봉투가 다르다', async () => {
      const { inspectionResultId, lotId } = await newConfirmable('INSPECTION_PENDING', [INCOMING_HOLD]);
      await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 1).expect(200);

      const response = await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 2).expect(400);
      expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      expect(response.body.code).toBeUndefined(); // 409 봉투가 아니다
      // 두 번째 호출이 LOT 을 한 번 더 옮기지 않았다.
      expect(await eventsOf(lotId)).toHaveLength(1);
    });

    it('⭐ `If-Match` 가 어긋나면 409 `VERSION_CONFLICT` + `currentVersion`·`currentLotStatusCode` — 상태보다 «먼저» 본다', async () => {
      const { inspectionResultId } = await newConfirmable('INSPECTION_PENDING', [INCOMING_HOLD]);

      const response = await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 99).expect(409);

      expect(response.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        conflictCause: 'user',
        currentVersion: '1',
        // ⛔ 계약이 「message 자유 텍스트에서 파싱하지 않는다 — 이 구조화 칸이 정본」이라 못박았다.
        currentLotStatusCode: 'INSPECTION_PENDING',
      });
      expect(validator('POST /quality/inspection-results/{inspectionResultId}:confirm', 409)(response.body)).toBe(true);
    });

    it('`If-Match` 없이 부르면 400 이고, 없는 결과 id 는 404 다', async () => {
      const { inspectionResultId } = await newConfirmable('INSPECTION_PENDING', [INCOMING_HOLD]);

      await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, null).expect(400);
      await confirm(999_999_999, { overallJudgmentCode: 'ACCEPTED' }, 1).expect(404);
    });

    it('저장된 판정도 본문 판정도 없으면 400 `REQUIRED` · 값 목록 밖이면 400 `INVALID`', async () => {
      const { inspectionResultId } = await newConfirmable('INSPECTION_PENDING', [INCOMING_HOLD]);

      const missing = await confirm(inspectionResultId, {}, 1).expect(400);
      expect(missing.body.errors).toContainEqual(expect.objectContaining({ field: 'overallJudgmentCode', code: 'REQUIRED' }));

      const bogus = await confirm(inspectionResultId, { overallJudgmentCode: 'BOGUS' }, 1).expect(400);
      expect(bogus.body.errors[0]).toMatchObject({ field: 'overallJudgmentCode', code: 'INVALID' });
    });

    it('⭐ 조건부 CHECK 가 확정에서 «처음» 깨어난다 — 수량 합이 안 맞으면 400 `INVALID`(500 이 아니다)', async () => {
      // 작성중으로는 합이 0 ≠ 100 이어도 선다(M-e ⓑ). `:confirm` 이 상태를 CONFIRMED 로 올리는
      // 순간 `ck_inspection_result_qty` 가 발화하므로 서비스가 먼저 400 을 내야 한다.
      const lotId = await newLot('INSPECTION_PENDING', { holds: [INCOMING_HOLD] });
      const inspectionRequestId = await newConfirmRequest({ lotId });
      const inspectionResultId = await newDraft(inspectionRequestId, {});

      const response = await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 1).expect(400);
      expect(response.body.errors).toContainEqual(expect.objectContaining({ field: 'inspectedQty', code: 'INVALID' }));

      const result = await prisma.inspection_result.findUniqueOrThrow({
        where: { inspection_result_id: BigInt(inspectionResultId) },
        select: { status_code: true },
      });
      expect(result.status_code).toBe('DRAFT');
      expect(await eventsOf(lotId)).toHaveLength(0);
    });

    it('⭐ ⓕ C14 — PQC 불합격 수량이 `acceptance_number` 를 넘으면 같은 W/O 의 생산LOT 전체가 `INSPECTION_PENDING` 이 되고 `from` 밖 LOT 은 건너뛴다', async () => {
      const workOrderId = await newWorkOrder();
      const slot = await newLot('NORMAL', { workOrderId, seq: 1 });
      const scrapped = await newLot('SCRAPPED', { workOrderId, seq: 2 });
      const notASlot = await newLot('NORMAL', { workOrderId }); // 선발행 슬롯이 아니다(seq 없음)
      const inspectionRequestId = await newConfirmRequest({
        typeCode: 'PQC',
        workOrderId,
        planVersionId: ids.c14PlanVersion,
      });
      const inspectionResultId = await newDraft(inspectionRequestId, { acceptedQty: 80, rejectedQty: 20 });

      await confirm(inspectionResultId, { overallJudgmentCode: 'REJECTED' }, 1).expect(200);

      // 옮겨진 것 — 자기 자신으로 가는 전이가 아니라 NORMAL → INSPECTION_PENDING 이다.
      expect(await lotOfId(slot)).toEqual({ status_code: 'INSPECTION_PENDING', version_no: 2 });
      expect((await eventsOf(slot)).map((event) => event.transition_code)).toEqual(['C14']);
      // ⭐ 건너뛴 것 — `SCRAPPED` 하나가 섞였다고 PQC 확정 전체가 막히면 안 된다(R-7).
      expect(await lotOfId(scrapped)).toEqual({ status_code: 'SCRAPPED', version_no: 1 });
      expect(await eventsOf(scrapped)).toHaveLength(0);
      // 슬롯이 아닌 LOT 은 애초에 대상이 아니다.
      expect(await eventsOf(notASlot)).toHaveLength(0);
    });

    it('`acceptance_number` 가 null 이면 C14 판정을 «건너뛴다» — 0 으로 접지 않는다', async () => {
      const workOrderId = await newWorkOrder();
      const slot = await newLot('NORMAL', { workOrderId, seq: 1 });
      const inspectionRequestId = await newConfirmRequest({ typeCode: 'PQC', workOrderId });
      const inspectionResultId = await newDraft(inspectionRequestId, { acceptedQty: 80, rejectedQty: 20 });

      await confirm(inspectionResultId, { overallJudgmentCode: 'REJECTED' }, 1).expect(200);

      expect(await eventsOf(slot)).toHaveLength(0);
    });

    it('IQC 확정은 `acceptance_number` 가 있어도 C14 를 돌지 않는다', async () => {
      const workOrderId = await newWorkOrder();
      const slot = await newLot('NORMAL', { workOrderId, seq: 1 });
      const inspectionRequestId = await newConfirmRequest({ workOrderId, planVersionId: ids.c14PlanVersion });
      const inspectionResultId = await newDraft(inspectionRequestId, { acceptedQty: 80, rejectedQty: 20 });

      await confirm(inspectionResultId, { overallJudgmentCode: 'REJECTED' }, 1).expect(200);

      expect(await eventsOf(slot)).toHaveLength(0);
    });

    it('같은 `Idempotency-Key` 재전송이 «한 번만» 전이한다', async () => {
      const { inspectionResultId, lotId } = await newConfirmable('INSPECTION_PENDING', [INCOMING_HOLD]);
      const key = randomUUID();

      const first = await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 1, { key }).expect(200);
      const again = await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 1, { key }).expect(200);

      expect(again.body.versionNo).toBe(first.body.versionNo);
      expect(await eventsOf(lotId)).toHaveLength(1);
      expect((await lotOfId(lotId)).version_no).toBe(2);
    });

    it('무권한 계정은 `:confirm` 에서 403 이다', async () => {
      const { inspectionResultId } = await newConfirmable('INSPECTION_PENDING', [INCOMING_HOLD]);

      await confirm(inspectionResultId, { overallJudgmentCode: 'ACCEPTED' }, 1, { session: noPermCookie }).expect(403);
    });
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '검사의뢰검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const businessUnit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '검사의뢰검사사업부' },
    });
    ids.businessUnit = businessUnit.business_unit_id;
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
    ids.routingOperation = routingOperation.routing_operation_id;

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
    // 항목 규격 2 — PR ③ 의 `measurements` 치환 단언이 쓴다(교정 이력·자동 판정은 PR ⑤ 몫).
    const specOf = async (sequenceNo: number, code: string) =>
      prisma.inspection_item_spec.create({
        data: {
          inspection_plan_version_id: planVersion.inspection_plan_version_id,
          sequence_no: sequenceNo,
          inspection_item_code: code,
          inspection_item_name: `검사항목${sequenceNo}`,
          data_type_code: 'NUMERIC',
        },
      });
    // ⭐ C14 의 근거 필드 — `acceptance_number` 가 있는 두 번째 기준 버전(`W-06-02:106`).
    //    기준 버전 1(위)은 이 칸이 null 이라 「판정을 건너뛴다」 갈래의 근거가 된다.
    const c14Version = await prisma.inspection_plan_version.create({
      data: {
        inspection_plan_id: plan.inspection_plan_id,
        plan_version: 2,
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        sampling_method_code: 'SAMPLE_BY_LOT',
        inspection_frequency_code: 'EVERY_LOT',
        status_code: 'ACTIVE',
        acceptance_number: 5,
      },
    });
    ids.c14PlanVersion = c14Version.inspection_plan_version_id;
    ids.itemSpecA = (await specOf(10, `${PREFIX}-SPEC-A`)).inspection_item_spec_id;
    ids.itemSpecB = (await specOf(20, `${PREFIX}-SPEC-B`)).inspection_item_spec_id;

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
    // Major 2 픽스처용 — item1·lotA 스코프(위 「의뢰 조회」 단언들의 정확한 건수)를 안 건드리게
    // item2·workOrder(PQC 갈래·R4/R5 와 같은 축)를 재사용한다. 대상 자체는 이 테스트와 무관하다.
    const r6 = await requestOf('6', { inspectionTypeCode: 'PQC', targetTypeCode: 'WORK_ORDER', targetId: workOrder.work_order_id, itemId: item2.item_id, workOrderId: workOrder.work_order_id, statusCode: 'REQUESTED', requestedAt: REQUESTED_R1 });
    requestR6Id = Number(r6.inspection_request_id);
    const r7 = await requestOf('7', { inspectionTypeCode: 'PQC', targetTypeCode: 'WORK_ORDER', targetId: workOrder.work_order_id, itemId: item2.item_id, workOrderId: workOrder.work_order_id, statusCode: 'REQUESTED', requestedAt: REQUESTED_R1 });
    requestR7Id = Number(r7.inspection_request_id);
    const r8 = await requestOf('8', { inspectionTypeCode: 'PQC', targetTypeCode: 'WORK_ORDER', targetId: workOrder.work_order_id, itemId: item2.item_id, workOrderId: workOrder.work_order_id, statusCode: 'REQUESTED', requestedAt: REQUESTED_R1 });
    const r9 = await requestOf('9', { inspectionTypeCode: 'PQC', targetTypeCode: 'WORK_ORDER', targetId: workOrder.work_order_id, itemId: item2.item_id, workOrderId: workOrder.work_order_id, statusCode: 'REQUESTED', requestedAt: REQUESTED_R1 });
    requestR9Id = Number(r9.inspection_request_id);

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

    // ⭐ 리뷰 Major 2 — R6: 뿌리가 둘인 의뢰(이상 데이터). uq_inspection_round(의뢰,회차) 는
    // (의뢰,회차) 쌍만 닫아 round=1·round=2 가 «둘 다» previous_result_id=NULL 로 공존할 수
    // 있다 — 정상 쓰기 경로(§5-1 「없으면 회차 1」)로는 못 만들어 prisma 로 직접 심는다.
    const e1 = await resultOf('E1', { inspectionRequestId: r6.inspection_request_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED', inspectedAt: INSPECTED_E, acceptedQty: 100 });
    resultE1Id = Number(e1.inspection_result_id);
    const e2 = await resultOf('E2', { inspectionRequestId: r6.inspection_request_id, round: 2, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED', inspectedAt: INSPECTED_E, acceptedQty: 100 });
    resultE2Id = Number(e2.inspection_result_id);

    // ⭐ 리뷰 Major 2 — R7/R8: 교차-의뢰 자식. previous_result_id 를 같은 의뢰로 묶는 FK·CHECK
    // 가 0건이라 F2(의뢰 R8 소속)가 F1(의뢰 R7 소속)의 자식으로 물리적으로 설 수 있다.
    const f1 = await resultOf('F1', { inspectionRequestId: r7.inspection_request_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'REJECTED', inspectedAt: INSPECTED_F1, rejectedQty: 100 });
    resultF1Id = Number(f1.inspection_result_id);
    const f2 = await resultOf('F2', { inspectionRequestId: r8.inspection_request_id, previousResultId: f1.inspection_result_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED', inspectedAt: INSPECTED_F2, acceptedQty: 100 });
    resultF2Id = Number(f2.inspection_result_id);

    // ⭐ 리뷰 m-7 — R9: 분기 사슬(G1 의 자식이 GA·GB 둘). BFS 는 깊이 순으로 담아 GB(회차5·
    // 얕음)가 GC(회차3·GA 의 자식이라 더 깊음)보다 먼저 담긴다 — 최종 정렬(회차 오름차순)이
    // 없으면 [1,2,5,3] 으로 나간다.
    const g1 = await resultOf('G1', { inspectionRequestId: r9.inspection_request_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'REJECTED', inspectedAt: INSPECTED_G, rejectedQty: 100 });
    resultG1Id = Number(g1.inspection_result_id);
    const ga = await resultOf('GA', { inspectionRequestId: r9.inspection_request_id, round: 2, previousResultId: g1.inspection_result_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'REJECTED', inspectedAt: INSPECTED_G, rejectedQty: 100 });
    resultGAId = Number(ga.inspection_result_id);
    const gb = await resultOf('GB', { inspectionRequestId: r9.inspection_request_id, round: 5, previousResultId: g1.inspection_result_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED', inspectedAt: INSPECTED_G, acceptedQty: 100 });
    resultGBId = Number(gb.inspection_result_id);
    const gc = await resultOf('GC', { inspectionRequestId: r9.inspection_request_id, round: 3, previousResultId: ga.inspection_result_id, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED', inspectedAt: INSPECTED_G, acceptedQty: 100 });
    resultGCId = Number(gc.inspection_result_id);
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '검사의뢰검사', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const other = await prisma.app_user.create({ data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    // ⭐ §5-5 의 둘째 갈래 — 계정에 «연결된» 작업자. `X-Worker-No` 없이 온 관리웹 저장이 이 행으로
    //   풀린다. 헤더 갈래(`${PREFIX}-WK`)와 다른 행이라 어느 길로 풀렸는지 단언이 가른다.
    const sessionWorker = await prisma.worker.create({
      data: { worker_no: `${PREFIX}-WK2`, worker_name: '계정연결검사원', business_unit_id: ids.businessUnit, plant_id: ids.plant, app_user_id: user.app_user_id, status_code: 'EMPLOYED' },
    });
    ids.sessionWorker = sessionWorker.worker_id;
    // ⚠ 역할을 «먼저» 붙이고 로그인한다 — 세션이 그때의 권한을 담는다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '검사결과쓰기용' } });
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
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
    // ⚠ PR ③ 이 만든 행은 번호를 «채번»이 짓는다(`IRS-…`) — 접두어로는 안 잡히므로 의뢰를 거쳐 건다.
    const resultScope = {
      OR: [{ inspection_result_no: { startsWith: PREFIX } }, { inspection_request: { inspection_request_no: { startsWith: PREFIX } } }],
    };
    // `inspection_measurement` 는 `inspection_result`·`inspection_item_spec` 둘의 자식이다 — 맨 먼저.
    await prisma.inspection_measurement.deleteMany({ where: { inspection_result: resultScope } });
    // `inspection_result` 는 `inspection_request`·`worker` 둘을 참조한다 — 그 둘보다 먼저 지운다.
    // 회차 자식이 부모를 가리키므로 두 번 돈다(자식 먼저 · §8-2).
    await prisma.inspection_result.deleteMany({ where: { AND: [resultScope, { previous_result_id: { not: null } }] } });
    await prisma.inspection_result.deleteMany({ where: resultScope });
    await prisma.inspection_item_spec.deleteMany({ where: { inspection_item_code: { startsWith: PREFIX } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.inbound_receipt_line.deleteMany({ where: { inbound_receipt: { plant: { plant_code: { startsWith: PREFIX } } } } });
    await prisma.lot_status_event.deleteMany({ where: { lot: { plant: { plant_code: { startsWith: PREFIX } } } } });
    // 확정(PR ④) 픽스처가 처음 심는 표다 — LOT 보다 먼저 지워야 FK 가 안 막는다.
    await prisma.lot_hold.deleteMany({ where: { lot: { plant: { plant_code: { startsWith: PREFIX } } } } });
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

    for (const loginId of [LOGIN_ID, NOPERM_ID]) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!user) continue;
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
