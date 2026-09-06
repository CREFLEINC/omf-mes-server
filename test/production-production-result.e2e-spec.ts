/**
 * 생산 실적 조회 — 목록 `GET /production/production-results` · 단건 `GET …/{id}` +
 * LOT 생명주기 변경이력 `GET /trace/lot-lifecycle-events`(I-7 PR ①) +
 * 등록 `POST /production/production-results` + LOT 배분 + L1(PR ②) +
 * 정정 `POST …/{id}:correct` · 상신 `POST …/{id}:request-approval`(PR ③).
 *
 * ⭐ 조회가 보는 실적은 **직접 INSERT** 한다 — 등록 경로를 태우면 조회 단언이 등록 구현에
 *   매달린다. 등록 갈래만 API 로 만든다.
 *   `production-work-order.e2e-spec.ts` 의 사다리를 그대로 베꼈고 그 파일은 손대지 않는다.
 * ⭐ 실적 2건 중 하나는 `shift_id` 를 비운다 — D1(NOT NULL 해제)이 실제로 먹었는지,
 *   그리고 뷰가 그때 키를 생략하는지를 같은 행으로 본다.
 * ⛔ 계약이 이 셋에 403 도 ETag 도 선언하지 않았다 — 권한 없는 사용자를 세우지 않고,
 *   `:close` 만 `W-02-05` 를 요구해 그 하나를 역할에 담는다.
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
import { seedRoute } from './approval-request.fixture';

const LOGIN_ID = 'e2e-pr-probe';
const NOPERM_ID = 'e2e-pr-noperm';
const APPROVER_ID = 'e2e-pr-approver';
const PASSWORD = 'PR-생산실적-비밀번호';
const PREFIX = 'PRE2E';
const ROLE = 'E2E_PRODUCTION_RESULT';
const APPROVER_ROLE = 'E2E_PRODUCTION_RESULT_APPROVER';
/**
 * 403 을 선언한 것은 `:close`(`W-02-05`)와 실적 등록(POP 화면 넷 중 하나면 된다)뿐이다 —
 * 조회 셋은 미선언이라 가드가 아예 안 본다(`permission.guard.ts:37-41`).
 */
const PERMISSIONS = ['W-02-05', 'P-02-04'];
/** 결재함 상세 GET 과 `:approve`/`:reject` 가 같은 한 벌을 쓴다(`derived-permissions.ts:17·143`). */
const APPROVER_PERMISSIONS = ['W-03-09'];
/** 승인 다형 축 — 서버가 채우는 값 그대로다(계약 x-internal-note). */
const CORRECT_APPROVAL_TYPE = 'PRODUCTION_RESULT_CORRECT';
const LOT_SOURCE = 'WORK_ORDER';
const RESULTS = '/api/production/production-results';
const EVENTS = '/api/trace/lot-lifecycle-events';
const WORK_ORDERS = '/api/production/work-orders';
const APPROVAL_REQUESTS = '/api/app/approval-requests';
const OCCURRED_EARLY = '2026-09-06T01:00:00.000Z';
const OCCURRED_LATE = '2026-09-06T05:00:00.000Z';

function validator(file: string, operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, `../contracts/${file}`), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('생산 실적 조회 · LOT 생명주기 이력 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let workOrderId: number;
  let otherWorkOrderId: number;
  let closableWorkOrderId: number;
  /** `shift_id` 를 비운 실적 — D1 실증 대상이다. */
  let shiftlessResultId: number;
  let shiftedResultId: number;
  let emptySlotId: bigint;
  /** 등록 대상 — `IN_PROGRESS` + 선발행 슬롯 셋(대기 2 · 폐번 1). */
  let recordingWorkOrderId: number;
  let waitingSlotId: bigint;
  let secondSlotId: bigint;
  let voidedSlotId: bigint;
  let noPermCookie: string[];
  /** 정정 대상 넷 — 상신(A) · B급 정정(B) · A급 정정(C) · 자유 사유 코드(D). */
  let correctingWorkOrderId: number;
  let resultAId: number;
  let resultBId: number;
  let resultCId: number;
  let resultDId: number;
  /** 정정 앞뒤로 `withProgress` 를 읽는 W/O — 실적 1건(양품 40)만 붙는다. */
  let progressWorkOrderId: number;
  /** 정정이 `:close` 3분류를 바꾸는 것을 보는 W/O — 지시 100 · 실적 100. */
  let correctClosableWorkOrderId: number;
  let closingResultId: number;
  /** ①에서 만든 정정본 — 「정정본도 상신할 수 있다」가 이 id 를 쓴다. */
  let correctionOfBId: number;
  let approverCookie: string[];
  let approverUserId: bigint;
  let correctRouteId: bigint;
  const ids = { plant: 0n, uom: 0n, item: 0n, worker: 0n, shift: 0n };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
    // ⭐ 개발 DB `approval_route` 는 0행이다 — 안 심으면 상신이 늘 400 `ROUTE_NOT_FOUND` 다.
    correctRouteId = await seedRoute(prisma, CORRECT_APPROVAL_TYPE, [approverUserId]);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록 — 기간을 비워도 400 이 아니다', async () => {
    // ⛔ 감사 조회가 아니다 — 계약이 `occurredFrom`·`occurredTo` 를 required 로 안 적었다.
    const response = await request(app.getHttpServer()).get(RESULTS).set('Cookie', cookie).expect(200);

    expect(Array.isArray(response.body.items)).toBe(true);
    expect(response.body.page).toMatchObject({ page: 1, size: 50 });
    expect(typeof response.body.page.total).toBe('number');
  });

  it('목록 — `workOrderId` 로 좁혀진다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${RESULTS}?workOrderId=${workOrderId}`)
      .set('Cookie', cookie)
      .expect(200);

    // 이 W/O 의 2건만 온다 — 다른 W/O 의 1건은 빠진다.
    expect(response.body.page.total).toBe(2);
    expect(response.body.items.map((item: { workOrderId: number }) => item.workOrderId)).not.toContain(otherWorkOrderId);
    // 정렬 고정 `occurred_at DESC` — 늦게 일어난 것이 앞이다.
    expect(response.body.items.map((item: { productionResultId: number }) => item.productionResultId)).toEqual([
      shiftedResultId,
      shiftlessResultId,
    ]);
    // ⭐ D1 — `shift_id` 가 빈 행이 «저장돼» 있고 뷰가 그때 키를 생략한다.
    expect(Object.keys(response.body.items[1])).not.toContain('shiftId');
    expect(response.body.items[0]).toMatchObject({ shiftId: Number(ids.shift), goodQty: 40, defectQty: 0 });
    expect(validator('production-02생산실행.json', 'GET /production/production-results')(response.body)).toBe(true);
  });

  it('목록 — `occurredTo` 정각은 안 잡힌다(반열림 · L-3)', async () => {
    // 끝 경계를 LATE 정각으로 보내면 EARLY 만 온다 — 「그날까지」를 익일 00:00 으로 보내는 관행에서 경계 1건이 이중 계수되지 않는다.
    const response = await request(app.getHttpServer())
      .get(`${RESULTS}?workOrderId=${workOrderId}&occurredFrom=${OCCURRED_EARLY}&occurredTo=${OCCURRED_LATE}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items.map((item: { productionResultId: number }) => item.productionResultId)).toEqual([
      shiftlessResultId,
    ]);
  });

  it('단건 — 없는 id 는 404 다', async () => {
    await request(app.getHttpServer()).get(`${RESULTS}/999999999`).set('Cookie', cookie).expect(404);
  });

  it('단건 — 200 에 ETag 가 «없다»', async () => {
    const response = await request(app.getHttpServer())
      .get(`${RESULTS}/${shiftlessResultId}`)
      .set('Cookie', cookie)
      .expect(200);

    // 계약이 I-7 7건 중 어디에도 ETag 를 선언하지 않았다 — `setEtag` 를 부르지 않는다.
    // ⚠ Express 가 모든 JSON 응답에 붙이는 «약한» 내용 해시는 남는다 — 그것은 전송 계층의
    //    것이고 우리가 싣는 낙관적 잠금 토큰(W/O 상세의 `'1'` 같은 숫자)이 아니다.
    expect(response.headers.etag).toMatch(/^W\/"/);
    expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
    expect(response.body).toMatchObject({
      productionResultId: shiftlessResultId,
      workOrderId,
      resultSequence: 1,
      goodQty: 30,
      statusCode: 'CONFIRMED',
      resultSourceCode: 'MANUAL',
    });
    expect(
      validator('production-02생산실행.json', 'GET /production/production-results/{productionResultId}')(response.body),
    ).toBe(true);
  });

  it('이벤트 — 기간을 비우면 400 `REQUIRED` 다(가드)', async () => {
    const rejected = await request(app.getHttpServer()).get(EVENTS).set('Cookie', cookie).expect(400);

    // ⌜감사 조회는 기간을 강제한다(공유계약 L-3)⌝ — 계약 검증 가드가 낸다. 코드로 다시 안 막는다.
    expect(rejected.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'occurredFrom', code: 'REQUIRED' })]),
    );
  });

  it('이벤트 — 실적이 없으면 빈 배열이고 `page` 키가 없다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${EVENTS}?occurredFrom=2020-01-01T00:00:00.000Z&occurredTo=2020-01-02T00:00:00.000Z`)
      .set('Cookie', cookie)
      .expect(200);

    // 응답이 `{ items }` 하나다 — 쪽 나눔이 없고 기간이 유일한 상한이다.
    expect(response.body).toEqual({ items: [] });
    expect(Object.keys(response.body)).not.toContain('page');
  });

  it('이벤트 — 마감한 W/O 의 L2 가 `WORK_ORDER_CLOSING` 으로 보인다', async () => {
    await request(app.getHttpServer())
      .post(`/api/production/work-orders/${closableWorkOrderId}:close`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({})
      .expect(200);

    const response = await request(app.getHttpServer())
      .get(`${EVENTS}?occurredFrom=2026-09-01T00:00:00.000Z&occurredTo=2026-12-31T00:00:00.000Z&transitionCode=L2`)
      .set('Cookie', cookie)
      .expect(200);

    const events = response.body.items.filter((item: { lotId: number }) => item.lotId === Number(emptySlotId));
    expect(events).toHaveLength(1);
    // 계약 enum 이 전이별 값을 못박았다 — L2 는 `WORK_ORDER_CLOSING`(R-2).
    expect(events[0]).toMatchObject({
      lotId: Number(emptySlotId),
      lotNo: `${PREFIX}-LOT-2`,
      fromLifecycleStatusCode: 'WAITING',
      toLifecycleStatusCode: 'VOIDED',
      transitionCode: 'L2',
      sourceDocumentTypeCode: 'WORK_ORDER_CLOSING',
      sourceDocumentId: closableWorkOrderId,
    });
    expect(validator('logistics-01자재창고.json', 'GET /trace/lot-lifecycle-events')(response.body)).toBe(true);
  });

  describe('등록 POST (PR ②)', () => {
    const RECORDED_AT = '2026-09-06T03:00:00.000Z';

    interface RegisterOptions {
      key?: string;
      cookie?: string[];
      workerNo?: string;
      ifMatch?: string;
    }

    function register(payload: object, options: RegisterOptions = {}) {
      const call = request(app.getHttpServer())
        .post(RESULTS)
        .set('Cookie', options.cookie ?? cookie)
        .set('Idempotency-Key', options.key ?? randomUUID())
        // 귀속 사번은 계약이 required 로 못박은 유일한 작업자 원천이다(§4-3).
        .set('X-Worker-No', options.workerNo ?? `${PREFIX}-WK`);
      if (options.ifMatch !== undefined) call.set('If-Match', options.ifMatch);
      return call.send(payload);
    }

    const resultBody = (overrides: object = {}) => ({
      workOrderId: recordingWorkOrderId,
      uomId: Number(ids.uom),
      resultSourceCode: 'MANUAL',
      occurredAt: RECORDED_AT,
      goodQty: 10,
      ...overrides,
    });

    it('등록 — 201 이고 ETag 헤더가 없다', async () => {
      const response = await register(resultBody()).expect(201);

      expect(response.body).toMatchObject({
        workOrderId: recordingWorkOrderId,
        resultSequence: 1,
        // 생략한 넷은 0 으로 «저장»되고, required 14 라 0 도 값으로 실린다.
        goodQty: 10,
        defectQty: 0,
        holdQty: 0,
        scrapQty: 0,
        reworkQty: 0,
        statusCode: 'CONFIRMED',
        workerId: Number(ids.worker),
      });
      // 등재된 규칙 `PR-{YYMMDD}-{SEQ4}` 그대로 — 접두어를 지어내지 않는다.
      expect(response.body.productionResultNo).toMatch(/^PR-\d{6}-\d{4}$/);
      // 요청에 칸이 없는 둘은 키가 아예 없다(D1 · 단말 토큰 부재).
      expect(Object.keys(response.body)).not.toContain('shiftId');
      expect(Object.keys(response.body)).not.toContain('terminalId');
      // 계약이 201 에 ETag 를 선언하지 않았다 — Express 의 약한 내용 해시만 남는다.
      expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
      expect(validator('production-02생산실행.json', 'POST /production/production-results', 201)(response.body)).toBe(
        true,
      );
    });

    it('등록 — 슬롯이 `WAITING`→`ACTIVE` 로 옮고 `lot_lifecycle_history` 에 L1 이 찍힌다', async () => {
      // 배분 합계는 양품수량을 못 넘는다(DB-C18) — 30 을 배분하려면 양품이 30 이상이어야 한다.
      const response = await register(
        resultBody({ goodQty: 30, lotAllocations: [{ lotId: Number(waitingSlotId), allocatedQty: 30 }] }),
      ).expect(201);

      const slot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: waitingSlotId } });
      expect(slot.lifecycle_status_code).toBe('ACTIVE');
      const history = await prisma.lot_lifecycle_history.findMany({ where: { lot_id: waitingSlotId } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        from_lifecycle_status_code: 'WAITING',
        to_lifecycle_status_code: 'ACTIVE',
        transition_code: 'L1',
        // 계약 enum 이 전이별 값을 못박았다 — L1 은 `PRODUCTION_RESULT`(§1-4 ⓑ).
        source_document_type_code: 'PRODUCTION_RESULT',
        source_document_id: BigInt(response.body.productionResultId),
        // 전이 시각은 단말이 보낸 «사건» 시각이다 — 서버 수신 시각이 아니다.
        changed_at: new Date(RECORDED_AT),
      });
      const allocations = await prisma.production_result_lot_allocation.findMany({ where: { lot_id: waitingSlotId } });
      expect(allocations).toHaveLength(1);
      expect(Number(allocations[0].allocated_qty)).toBe(30);
    });

    it('등록 — 같은 슬롯에 두 번째 실적은 이력을 두 번 안 찍는다', async () => {
      await register(
        resultBody({
          occurredAt: '2026-09-06T04:00:00.000Z',
          lotAllocations: [{ lotId: Number(waitingSlotId), allocatedQty: 5 }],
        }),
      ).expect(201);

      // 이미 `ACTIVE` 인 슬롯은 코어가 `skippedLotIds` 로 건너뛴다 — 배분만 늘고 이력은 그대로다.
      expect(await prisma.lot_lifecycle_history.count({ where: { lot_id: waitingSlotId } })).toBe(1);
      expect(await prisma.production_result_lot_allocation.count({ where: { lot_id: waitingSlotId } })).toBe(2);
    });

    it('등록 — 같은 멱등키 재전송이 행을 두 벌 만들지 않는다', async () => {
      const key = randomUUID();

      const first = await register(resultBody({ goodQty: 4 }), { key }).expect(201);
      const again = await register(resultBody({ goodQty: 4 }), { key }).expect(201);

      expect(again.body.productionResultId).toBe(first.body.productionResultId);
      // 헤더 값을 도메인 표에 그대로 담는다 — 멱등 기록이 만료된 뒤의 재전송을 이 UNIQUE 가 막는다(§4-4).
      expect(await prisma.production_result.count({ where: { idempotency_key: key } })).toBe(1);
    });

    it('등록 — If-Match 는 온 요청만 대조한다 — 낡으면 409, 없으면 통과다', async () => {
      // 실적은 `work_order` 를 UPDATE 하지 않으므로 W/O 의 `version_no` 는 1 그대로다.
      const stale = await register(resultBody({ goodQty: 6 }), { ifMatch: '99' }).expect(409);

      expect(stale.body).toMatchObject({ conflictCause: 'user', code: 'VERSION_CONFLICT' });
      expect(
        validator('production-02생산실행.json', 'POST /production/production-results', 409)(stale.body),
      ).toBe(true);
      // 토큰이 없으면 대조를 건너뛴다 — 오프라인 큐는 토큰을 싣지 않는다(C-9).
      await register(resultBody({ goodQty: 6 })).expect(201);
    });

    it('등록 — 배분한 슬롯 LOT 의 `versionNo` 가 +1 된다(R-15)', async () => {
      const before = await prisma.lot.findUniqueOrThrow({ where: { lot_id: secondSlotId } });

      await register(resultBody({ lotAllocations: [{ lotId: Number(secondSlotId), allocatedQty: 7 }] })).expect(201);

      // `moveWithin` 이 응답에 실리는 칸을 바꾸므로 ETag 도 올린다 — `:complete`·`PUT` 이 같은 토큰을 쓴다.
      const after = await prisma.lot.findUniqueOrThrow({ where: { lot_id: secondSlotId } });
      expect(after.version_no).toBe(before.version_no + 1);
    });

    it('등록 — 실패하면 배분·이력이 하나도 안 남는다', async () => {
      const before = await prisma.production_result.count({
        where: { work_order_id: BigInt(recordingWorkOrderId) },
      });

      const rejected = await register(
        resultBody({
          lotAllocations: [
            { lotId: Number(secondSlotId), allocatedQty: 3 },
            { lotId: Number(voidedSlotId), allocatedQty: 3 },
          ],
        }),
      ).expect(400);

      expect(rejected.body.errors[0]).toMatchObject({ field: 'lotAllocations', code: 'STATE_LOCKED' });
      // 채번은 트랜잭션 «밖»이라 결번은 남는다 — 허용한다(I-2 R-2). 행은 하나도 안 는다.
      expect(await prisma.production_result.count({ where: { work_order_id: BigInt(recordingWorkOrderId) } })).toBe(
        before,
      );
      expect(await prisma.production_result_lot_allocation.count({ where: { lot_id: voidedSlotId } })).toBe(0);
      expect(await prisma.lot_lifecycle_history.count({ where: { lot_id: voidedSlotId } })).toBe(0);
    });

    it('등록 — 권한 없으면 403 이다', async () => {
      // 계약이 403 을 선언한 자리라 가드가 본다 — POP 화면 넷 중 하나도 없는 계정이다.
      await register(resultBody(), { cookie: noPermCookie }).expect(403);
    });

    it('이벤트 — 방금 찍힌 L1 이 `GET /trace/lot-lifecycle-events` 로 보인다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${EVENTS}?occurredFrom=2026-09-01T00:00:00.000Z&occurredTo=2026-12-31T00:00:00.000Z&transitionCode=L1`)
        .set('Cookie', cookie)
        .expect(200);

      const events = response.body.items.filter((item: { lotId: number }) => item.lotId === Number(waitingSlotId));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        lotNo: `${PREFIX}-LOT-R1`,
        fromLifecycleStatusCode: 'WAITING',
        toLifecycleStatusCode: 'ACTIVE',
        transitionCode: 'L1',
        sourceDocumentTypeCode: 'PRODUCTION_RESULT',
      });
      expect(validator('logistics-01자재창고.json', 'GET /trace/lot-lifecycle-events')(response.body)).toBe(true);
    });
  });

  describe('정정 · 상신 (PR ③)', () => {
    const correct = (productionResultId: number, payload: object, options: { cookie?: string[] } = {}) =>
      request(app.getHttpServer())
        .post(`${RESULTS}/${productionResultId}:correct`)
        .set('Cookie', options.cookie ?? cookie)
        .set('Idempotency-Key', randomUUID())
        .send(payload);

    const submit = (productionResultId: number, reason: string) =>
      request(app.getHttpServer())
        .post(`${RESULTS}/${productionResultId}:request-approval`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reason });

    /** 결재함 상세의 ETag 는 `:approve`·`:reject` 가 함께 쓰는 토큰이다. */
    async function decide(action: 'approve' | 'reject', approvalRequestId: number, comment: string): Promise<void> {
      const detail = await request(app.getHttpServer())
        .get(`${APPROVAL_REQUESTS}/${approvalRequestId}`)
        .set('Cookie', approverCookie)
        .expect(200);
      await request(app.getHttpServer())
        .post(`${APPROVAL_REQUESTS}/${approvalRequestId}:${action}`)
        .set('Cookie', approverCookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', detail.headers.etag as string)
        .send({ comment })
        .expect(200);
    }

    const goodQtyOf = async (workOrderId: number): Promise<number> => {
      const response = await request(app.getHttpServer())
        .get(`${WORK_ORDERS}/${workOrderId}`)
        .set('Cookie', cookie)
        .expect(200);
      return response.body.progress.goodQty as number;
    };

    it('정정 — 사유만 바꾸면 201 이고 승인 없이 통과한다', async () => {
      const response = await correct(resultBId, { reasonCode: 'MISCOUNT', note: '집계 오기' }).expect(201);

      correctionOfBId = response.body.productionResultId;
      // B급(다섯 수량이 원본과 같다)이라 승인 흔적이 0건이어도 통과한다.
      expect(response.body).toMatchObject({
        correctsProductionResultId: resultBId,
        workOrderId: correctingWorkOrderId,
        // 사건 칸 열 승계 — 다섯 수량도 원본 그대로다.
        goodQty: 20,
        defectQty: 0,
        statusCode: 'CONFIRMED',
        // ⚠ 계약이 이름을 달리 적었다 — 본문 `note` 가 물리 `remarks` 로 간다.
        remarks: '집계 오기',
      });
      expect(response.body.productionResultNo).toMatch(/^PR-\d{6}-\d{4}$/);
      // 계약 201 에 ETag 를 안 선언했다 — 원본을 고치지 않으니 새 토큰을 낼 자리도 없다.
      expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
      expect(
        validator('production-02생산실행.json', 'POST /production/production-results/{productionResultId}:correct', 201)(
          response.body,
        ),
      ).toBe(true);
      // ⛔ 원본은 그대로다 — 배분도 하나 안 생긴다.
      const original = await prisma.production_result.findUniqueOrThrow({
        where: { production_result_id: BigInt(resultBId) },
      });
      expect(original.version_no).toBe(1);
      expect(
        await prisma.production_result_lot_allocation.count({
          where: { production_result_id: BigInt(correctionOfBId) },
        }),
      ).toBe(0);
    });

    it('정정 — 사유 코드는 아무 문자열이나 통과한다(그룹 0값 · 대조 안 걺 · R-20)', async () => {
      // `PRODUCTION_RESULT_CORRECT_REASON` 그룹은 값이 0건이라 대조를 걸면 모든 값이 400 이 된다.
      const response = await correct(resultDId, { reasonCode: '아무-값이나-통과-2026' }).expect(201);

      expect(response.body).toMatchObject({ correctsProductionResultId: resultDId, goodQty: 5 });
      const row = await prisma.production_result.findUniqueOrThrow({
        where: { production_result_id: BigInt(response.body.productionResultId) },
      });
      expect(row.correct_reason_code).toBe('아무-값이나-통과-2026');
      // 공백만은 여전히 막는다 — required 를 「있기만 하면」으로 풀지 않는다.
      await correct(resultDId, { reasonCode: '   ' }).expect(400);
    });

    it('정정 — 수량을 바꾸면 400 이고, 상신·승인 뒤 같은 요청이 201 이 된다', async () => {
      const payload = { reasonCode: 'MISCOUNT', goodQty: 50 };

      const rejected = await correct(resultCId, payload).expect(400);

      // ⭐ 코어 `assertApproved` 는 ⌜요청 0건이면 통과⌝ 라 이 자리를 열어 준다 — 도메인 게이트가 막는다.
      expect(rejected.body.errors[0]).toMatchObject({ code: 'APPROVAL_REQUIRED' });

      const submitted = await submit(resultCId, '집계에서 양품 20 EA 누락').expect(202);
      // 승인 «전»에는 진행 중이라 코드가 갈린다.
      const pending = await correct(resultCId, payload).expect(400);
      expect(pending.body.errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });

      await decide('approve', submitted.body.approvalRequestId, '수량 확인함');
      const accepted = await correct(resultCId, payload).expect(201);

      expect(accepted.body).toMatchObject({ correctsProductionResultId: resultCId, goodQty: 50, defectQty: 0 });
    });

    it('정정 — 정정본이 목록에 원본과 «둘 다» 보인다', async () => {
      const response = await request(app.getHttpServer())
        .get(`${RESULTS}?workOrderId=${correctingWorkOrderId}`)
        .set('Cookie', cookie)
        .expect(200);

      const listed = response.body.items.map((item: { productionResultId: number }) => item.productionResultId);
      // ⛔ 목록은 잎만 세지 «않는다» — 정정은 이력이라 원본도 남는다(누계만 잎을 센다).
      expect(listed).toContain(resultBId);
      expect(listed).toContain(correctionOfBId);
      const correction = response.body.items.find(
        (item: { productionResultId: number }) => item.productionResultId === correctionOfBId,
      );
      expect(correction).toMatchObject({ correctsProductionResultId: resultBId });
      // 원본은 그 칸이 비어 키가 없다.
      const original = response.body.items.find(
        (item: { productionResultId: number }) => item.productionResultId === resultBId,
      );
      expect(Object.keys(original)).not.toContain('correctsProductionResultId');
    });

    it('정정 — 정정 뒤 `withProgress` 의 `goodQty` 가 정정 후 값이다(두 배가 아니다)', async () => {
      expect(await goodQtyOf(progressWorkOrderId)).toBe(40);

      const only = await prisma.production_result.findFirstOrThrow({
        where: { work_order_id: BigInt(progressWorkOrderId) },
        select: { production_result_id: true },
      });
      await correct(Number(only.production_result_id), { reasonCode: 'MISCOUNT', note: '사유만' }).expect(201);

      // 정정본이 «대체값»이라 원본이 합에서 빠진다 — 그냥 더하면 80 이다.
      expect(await goodQtyOf(progressWorkOrderId)).toBe(40);
    });

    it('정정 — 정정 뒤 `:close` 3분류가 정정 후 값으로 갈린다', async () => {
      const payload = { reasonCode: 'MISCOUNT', goodQty: 60 };
      const submitted = await submit(closingResultId, '실측 60 EA 로 정정').expect(202);
      await decide('approve', submitted.body.approvalRequestId, '실측 확인함');
      await correct(closingResultId, payload).expect(201);

      const close = (body: object) =>
        request(app.getHttpServer())
          .post(`${WORK_ORDERS}/${correctClosableWorkOrderId}:close`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', randomUUID())
          .set('If-Match', '1')
          .send(body);

      // 100 + 60 을 더하면 «초과»(사유만 요구)다 — 잔량 처분을 묻는 것이 미달 판정의 증거다.
      const rejected = await close({}).expect(400);
      expect(rejected.body.errors[0]).toMatchObject({
        field: 'remainderDispositionCode',
        code: 'REMAINDER_DISPOSITION_REQUIRED',
      });

      await close({ remainderDispositionCode: 'WRITE_OFF', reasonCode: 'MATERIAL_SHORTAGE' }).expect(200);

      const queued = await prisma.integration_message.findFirstOrThrow({
        where: { target_type_code: 'WORK_ORDER', target_id: BigInt(correctClosableWorkOrderId) },
      });
      // ERP 로 나가는 값도 정정 후 값이다 — 조회·마감·송신이 한 정의를 쓴다.
      expect((queued.payload as { header: { goodQty: number; completionJudgmentCode: string } }).header).toMatchObject({
        goodQty: 60,
        completionJudgmentCode: 'UNDER',
      });
    });

    it('상신 — 결재선을 심으면 202 이고 `approvalRequestId` 가 온다', async () => {
      const response = await submit(resultAId, '교대 종료 후 집계에서 양품 누락 확인').expect(202);

      expect(typeof response.body.approvalRequestId).toBe('number');
      expect(
        validator(
          'production-02생산실행.json',
          'POST /production/production-results/{productionResultId}:request-approval',
          202,
        )(response.body),
      ).toBe(true);
      const row = await prisma.approval_request.findUniqueOrThrow({
        where: { approval_request_id: BigInt(response.body.approvalRequestId) },
      });
      // 서버가 다형 축 두 칸을 채운다 — 화면은 등급도 유형도 보내지 않는다.
      expect(row).toMatchObject({
        approval_type_code: CORRECT_APPROVAL_TYPE,
        target_type_code: 'PRODUCTION_RESULT',
        target_id: BigInt(resultAId),
        status_code: 'PENDING',
      });
      // ⛔ 원본은 그대로다 — 상신이 `version_no` 를 안 올린다.
      const original = await prisma.production_result.findUniqueOrThrow({
        where: { production_result_id: BigInt(resultAId) },
      });
      expect(original.version_no).toBe(1);
    });

    it('상신 — 진행 중 요청이 있으면 400 이다', async () => {
      const rejected = await submit(resultAId, '두 번째 상신').expect(400);

      // 한 실적에 살아 있는 요청은 하나다 — 코어 `assertNoOpenRequest` 가 던지는 그대로 흘린다.
      expect(rejected.body.errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });
    });

    it('상신 — 반려 뒤 다시 상신하면 새 요청이 선다', async () => {
      const open = await prisma.approval_request.findFirstOrThrow({
        where: { approval_type_code: CORRECT_APPROVAL_TYPE, target_id: BigInt(resultAId), status_code: 'PENDING' },
      });

      await decide('reject', Number(open.approval_request_id), '근거 자료가 없다');
      const again = await submit(resultAId, '근거 붙여 다시 올린다').expect(202);

      // 반려는 진행 중이 아니다(J-6) — 옛 요청을 되살리지 않고 «새» 행이 선다.
      expect(again.body.approvalRequestId).not.toBe(Number(open.approval_request_id));
      expect(
        await prisma.approval_request.count({
          where: { approval_type_code: CORRECT_APPROVAL_TYPE, target_id: BigInt(resultAId) },
        }),
      ).toBe(2);
    });

    it('상신 — 정정본도 상신할 수 있다(R-10)', async () => {
      // 다형 축(`targetId`)이라 「원본인지 정정본인지」를 볼 근거가 없고 계약이 안 막았다.
      const response = await submit(correctionOfBId, '정정본을 다시 고친다').expect(202);

      expect(typeof response.body.approvalRequestId).toBe('number');
    });

    it('상신 — 결재선이 없으면 400 `ROUTE_NOT_FOUND` 다', async () => {
      await prisma.approval_route.update({ where: { approval_route_id: correctRouteId }, data: { is_active: false } });
      try {
        const rejected = await submit(resultDId, '결재선이 없는 상태').expect(400);

        // 상신할 곳이 없는 요청을 만들지 않는다 — 코어 `selectRoute` 가 던진다.
        expect(rejected.body.errors[0]).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
      } finally {
        await prisma.approval_route.update({ where: { approval_route_id: correctRouteId }, data: { is_active: true } });
      }
    });

    it('상신 — 활성 결재선 둘은 물리가 막아 `ROUTE_AMBIGUOUS` 가 안 난다(R-8 정정)', async () => {
      // ⚠ I-7.md R-8 은 ⌜`approval_route` 에 유일 제약이 없어 실제로 나는 갈래⌝ 라 적었는데
      //   I-1 A6 이 `uq_approval_route_active(approval_type_code, COALESCE(business_unit_id,0))
      //   WHERE is_active` 를 이미 깔았다. 상신자가 `businessUnitId=null` 이라 `selectRoute` 는
      //   공통본만 보고, 활성 공통본은 이 인덱스가 한 벌로 묶는다 ⇒ 이 도메인에서 그 갈래는 «도달 불가»다.
      await expect(seedRoute(prisma, CORRECT_APPROVAL_TYPE, [approverUserId])).rejects.toThrow();

      // 결재선은 여전히 한 벌이라 상신이 그대로 선다 — 코드는 그대로 두고(코어 소관) 사실만 못박는다.
      const response = await submit(resultDId, '결재선은 한 벌뿐이다').expect(202);
      expect(typeof response.body.approvalRequestId).toBe('number');
    });

    it('상신 — 없는 실적이면 404 이고 AP 번호가 안 나간다', async () => {
      const before = await approvalCounter();

      await request(app.getHttpServer())
        .post(`${RESULTS}/999999999:request-approval`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: '없는 실적' })
        .expect(404);

      // 존재 확인이 채번보다 «앞»이라 결번이 안 생긴다(I-5 R-12).
      expect(await approvalCounter()).toEqual(before);
    });

    /** `APPROVAL_REQUEST` 채번 카운터의 현재값 — 결번 여부를 이 숫자로 본다. */
    async function approvalCounter(): Promise<bigint> {
      const counter = await prisma.numbering_counter.findFirst({
        where: { numbering_rule: { document_type_code: 'APPROVAL_REQUEST' } },
        orderBy: { numbering_counter_id: 'desc' },
        select: { last_value: true },
      });
      return counter?.last_value ?? 0n;
    }
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '생산실적검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '생산실적검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '생산실적검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    ids.plant = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;

    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '생산실적검사품목',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    ids.item = item.item_id;
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    const operation = await prisma.routing_operation.create({
      data: {
        routing_id: routing.routing_id,
        operation_seq: 10,
        process_id: process.process_id,
        operation_name: '사출',
      },
    });
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: item.item_id,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 1,
        base_uom_id: uom.uom_id,
      },
    });
    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-WK`,
        worker_name: '생산실적검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });
    ids.worker = worker.worker_id;
    const shift = await prisma.shift.create({
      data: {
        plant_id: plant.plant_id,
        shift_code: `${PREFIX}-SH`,
        shift_name: '주간',
        start_time: new Date('1970-01-01T08:00:00.000Z'),
        end_time: new Date('1970-01-01T17:00:00.000Z'),
      },
    });
    ids.shift = shift.shift_id;

    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'CONFIRMED',
      },
    });
    const plan = await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id,
        plan_no: `${PREFIX}-PP`,
        plan_date: new Date('2026-09-06T00:00:00.000Z'),
        planned_qty: 100,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });

    const workOrder = async (suffix: string, statusCode: string) =>
      prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-${suffix}`,
          production_plan_id: plan.production_plan_id,
          routing_operation_id: operation.routing_operation_id,
          item_id: item.item_id,
          order_qty: 100,
          uom_id: uom.uom_id,
          status_code: statusCode,
        },
      });

    const main = await workOrder('WO', 'PLANNED');
    workOrderId = Number(main.work_order_id);
    const other = await workOrder('WO2', 'PLANNED');
    otherWorkOrderId = Number(other.work_order_id);
    /**
     * 마감 대상 — `IN_PROGRESS` 로 바로 심는다(`:release` 를 안 태운다. 이 스위트가 보는
     * 것은 마감이 찍는 L2 의 «값»이라 배포 경로를 재현할 이유가 없다). 누적 양품이
     * 지시 수량과 같아 정상 마감이고 본문이 비어도 통과한다.
     */
    const closable = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOC`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'IN_PROGRESS',
        released_at: new Date('2026-09-06T00:30:00.000Z'),
      },
    });
    closableWorkOrderId = Number(closable.work_order_id);

    // 선발행 슬롯 2건 — 첫째에만 실적이 붙어 마감이 «둘째만» 폐번한다(L2 한 줄).
    const slots = [];
    for (const seq of [1, 2]) {
      slots.push(
        await prisma.lot.create({
          data: {
            lot_no: `${PREFIX}-LOT-${seq}`,
            item_id: item.item_id,
            lot_type_code: 'PRODUCT',
            plant_id: plant.plant_id,
            initial_qty: 50,
            uom_id: uom.uom_id,
            source_type_code: LOT_SOURCE,
            source_id: closable.work_order_id,
            status_code: 'NORMAL',
            lifecycle_status_code: 'WAITING',
            work_order_lot_seq: seq,
          },
        }),
      );
    }
    emptySlotId = slots[1].lot_id;

    const result = async (
      suffix: string,
      workOrderIdValue: bigint,
      goodQty: number,
      occurredAt: string,
      shiftId: bigint | null,
      resultSequence = 1,
    ) =>
      prisma.production_result.create({
        data: {
          production_result_no: `${PREFIX}-${suffix}`,
          work_order_id: workOrderIdValue,
          // `uq_production_result_seq(work_order_id, result_sequence)` — 같은 W/O 안에서 겹치면 안 된다.
          result_sequence: resultSequence,
          good_qty: goodQty,
          uom_id: uom.uom_id,
          result_source_code: 'MANUAL',
          occurred_at: new Date(occurredAt),
          worker_id: worker.worker_id,
          shift_id: shiftId,
          // 값 목록이 없는 칸이다(`x-no-code-key`) — 이미 데이터에 있는 값을 그대로 쓴다(§2-3).
          status_code: 'CONFIRMED',
          idempotency_key: `${PREFIX}-${randomUUID()}`,
        },
      });

    // ⭐ D1 — `shift_id` 없이 저장된다. 마이그 전이라면 이 INSERT 자체가 깨진다.
    shiftlessResultId = Number((await result('PRD1', main.work_order_id, 30, OCCURRED_EARLY, null)).production_result_id);
    shiftedResultId = Number((await result('PRD2', main.work_order_id, 40, OCCURRED_LATE, shift.shift_id, 2)).production_result_id);
    await result('PRD3', other.work_order_id, 50, OCCURRED_LATE, null);

    // 등록 대상 W/O — 배포된 상태로 바로 심는다(`:release` 를 안 태운다. 이 스위트가 보는 것은
    // 「실적이 슬롯을 어떻게 옮기는가」라 배포 경로를 재현할 이유가 없다).
    const recording = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOR`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'IN_PROGRESS',
        released_at: new Date('2026-09-06T00:30:00.000Z'),
      },
    });
    recordingWorkOrderId = Number(recording.work_order_id);

    const recordingSlot = async (seq: number, lifecycleStatusCode: string) =>
      prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT-R${seq}`,
          item_id: item.item_id,
          lot_type_code: 'PRODUCT',
          plant_id: plant.plant_id,
          initial_qty: 50,
          uom_id: uom.uom_id,
          source_type_code: LOT_SOURCE,
          source_id: recording.work_order_id,
          status_code: 'NORMAL',
          lifecycle_status_code: lifecycleStatusCode,
          work_order_lot_seq: seq,
        },
      });
    waitingSlotId = (await recordingSlot(1, 'WAITING')).lot_id;
    secondSlotId = (await recordingSlot(2, 'WAITING')).lot_id;
    // 폐번 슬롯 — 배분에 섞이면 400 이고 아무것도 안 남아야 한다.
    voidedSlotId = (await recordingSlot(3, 'VOIDED')).lot_id;

    // 정정 대상 W/O — 실적 넷을 직접 심는다(정정이 «원본을 어떻게 다루는가»가 관심이라
    // 등록 경로를 태우지 않는다). 지시 200 이라 정정 뒤에도 초과가 나지 않는다.
    const correcting = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOX`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 200,
        uom_id: uom.uom_id,
        status_code: 'IN_PROGRESS',
        released_at: new Date('2026-09-06T00:30:00.000Z'),
      },
    });
    correctingWorkOrderId = Number(correcting.work_order_id);
    resultAId = Number((await result('PRX1', correcting.work_order_id, 10, OCCURRED_EARLY, null, 1)).production_result_id);
    resultBId = Number((await result('PRX2', correcting.work_order_id, 20, OCCURRED_EARLY, null, 2)).production_result_id);
    resultCId = Number((await result('PRX3', correcting.work_order_id, 30, OCCURRED_EARLY, null, 3)).production_result_id);
    resultDId = Number((await result('PRX4', correcting.work_order_id, 5, OCCURRED_EARLY, null, 4)).production_result_id);

    // 진척 대상 — 실적 1건(40)뿐이라 「정정 뒤 80 이 되는가」가 한눈에 갈린다.
    const progressing = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOG`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'IN_PROGRESS',
        released_at: new Date('2026-09-06T00:30:00.000Z'),
      },
    });
    progressWorkOrderId = Number(progressing.work_order_id);
    await result('PRG1', progressing.work_order_id, 40, OCCURRED_EARLY, null, 1);

    // 마감 대상 — 정정 전이면 정상(100/100), 정정 뒤면 미달(60/100)이다.
    const correctClosable = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOZ`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'IN_PROGRESS',
        released_at: new Date('2026-09-06T00:30:00.000Z'),
      },
    });
    correctClosableWorkOrderId = Number(correctClosable.work_order_id);
    closingResultId = Number(
      (await result('PRZ1', correctClosable.work_order_id, 100, OCCURRED_EARLY, null, 1)).production_result_id,
    );

    // 마감이 정상 판정이 되도록 누적 양품 = 지시 수량. 이 실적은 슬롯에 안 붙는다.
    const closableResult = await result('PRDC', closable.work_order_id, 100, OCCURRED_EARLY, null);
    await prisma.production_result_lot_allocation.create({
      data: {
        production_result_id: closableResult.production_result_id,
        lot_id: slots[0].lot_id,
        allocated_qty: 100,
        uom_id: uom.uom_id,
      },
    });
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '생산실적검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // 권한 0건 계정 — 등록만 403 을 선언하므로 이 계정으로 그 갈래를 본다(역할을 안 붙인다).
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '생산실적권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // 결재자 — 결재선의 유일한 단계다. A급 정정을 실제로 «승인»해 게이트가 열리는 것을 본다.
    const approver = await prisma.app_user.create({
      data: { login_id: APPROVER_ID, user_name: '생산실적결재자', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: approver.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    approverUserId = approver.app_user_id;
    // ⚠ 역할을 «먼저» 붙이고 로그인한다 — 세션이 그때의 권한을 담는다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '생산실적검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const approverRole = await prisma.role.create({
      data: { role_code: APPROVER_ROLE, role_name: '생산실적결재용' },
    });
    await prisma.role_permission.createMany({
      data: APPROVER_PERMISSIONS.map((permission_code) => ({ role_id: approverRole.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: approverUserId, role_id: approverRole.role_id } });

    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
    approverCookie = await login(APPROVER_ID);
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

  /** 만든 행을 FK 역순으로 지운다(§10-1 그대로 · 자기참조 FK 는 한 `deleteMany` 로 통과한다). */
  async function cleanup(): Promise<void> {
    const plantScope = { plant: { plant_code: { startsWith: PREFIX } } };
    const orderScope = { work_order_no: { startsWith: PREFIX } };
    const queued = await prisma.work_order.findMany({ where: orderScope, select: { work_order_id: true } });
    await prisma.integration_message.deleteMany({
      where: { target_type_code: 'WORK_ORDER', target_id: { in: queued.map((row) => row.work_order_id) } },
    });
    // 승인 축 — FK 역순(step → request → route_step → route). 결재자 계정보다 «먼저» 지운다.
    const requests = await prisma.approval_request.findMany({
      where: { approval_type_code: CORRECT_APPROVAL_TYPE },
      select: { approval_request_id: true },
    });
    await prisma.approval_step.deleteMany({
      where: { approval_request_id: { in: requests.map((row) => row.approval_request_id) } },
    });
    await prisma.approval_request.deleteMany({ where: { approval_type_code: CORRECT_APPROVAL_TYPE } });
    await prisma.approval_route_step.deleteMany({
      where: { approval_route: { approval_type_code: CORRECT_APPROVAL_TYPE } },
    });
    await prisma.approval_route.deleteMany({ where: { approval_type_code: CORRECT_APPROVAL_TYPE } });
    await prisma.lot_lifecycle_history.deleteMany({ where: { lot: plantScope } });
    await prisma.production_result_lot_allocation.deleteMany({
      where: { production_result: { work_order: orderScope } },
    });
    await prisma.production_result.deleteMany({ where: { work_order: orderScope } });
    await prisma.lot.deleteMany({ where: plantScope });
    await prisma.work_order.deleteMany({ where: orderScope });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.shift.deleteMany({ where: { shift_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    for (const loginId of [LOGIN_ID, NOPERM_ID, APPROVER_ID]) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!user) continue;
      // 멱등 기록도 지운다 — 남으면 다음 회차의 같은 키 재전송이 옛 응답을 되돌려 준다.
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    for (const roleCode of [ROLE, APPROVER_ROLE]) {
      const role = await prisma.role.findUnique({ where: { role_code: roleCode } });
      if (!role) continue;
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
