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
/** 쓰기 전용 계정 둘(PR ③). ⛔ `repair_execution.created_by` 가 이 계정을 물고 있어 계정 정리는
 *  수리 건을 지운 «뒤»여야 한다 — 그래서 조회 계정과 함께 `cleanup()` 이 한 자리에서 지운다. */
const POST_LOGIN_ID = 'e2e-re-post';
const POST_ROLE = 'E2E_RE_POST';
const NO_PERM_LOGIN_ID = 'e2e-re-post-np';
const NO_PERM_ROLE = 'E2E_RE_POST_NP';
// ⭐ 시각 픽스처는 «과거»로 고정한다 — 실행 날짜와 같아질 수 있는 값을 쓰면 「오늘만 잡히고
//    내일이면 초록」인 그물이 된다(PR #440 리뷰 Minor-2).
const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-01T01:00:00.000Z';
const T2 = '2026-09-01T03:00:00.000Z';
const RETURNED_AT = '2026-09-01T05:00:00.000Z';
/** 쓰기 전용 — 조회 픽스처의 세 시각과 «다른 날짜»이고 투입·반출 둘이 서로 다르다(PR ③). */
const STARTED_AT = '2026-09-02T04:05:06.000Z';
const RETURN_AT = '2026-09-02T07:08:09.000Z';
/** `mdm.worker` 에 실재해야 한다 — 없는 사번은 400 `INVALID` 갈래다(§5 ①). */
const WORKER_NO = `${PREFIX}-W1`;
/** 반출자 — 투입자와 «다른» 사번이라야 `worker_no` 무변경을 지켜볼 수 있다(B17). */
const OTHER_WORKER_NO = `${PREFIX}-W2`;

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
  /** 쓰기 전용 — 투입이 담는 참조 넷을 **서로 다른 표**에서 뽑아 값 단언이 출처를 가르게 한다. */
  let writeUomId: number;
  let repairProcessId: number;
  let terminalId: number;
  let terminalToken: string;
  /** 불량 기록을 «건마다» 새로 만든다 — 열린 건 판정(§5 ⑤)이 시험끼리 얽히지 않게 한다. */
  let makeDefectRecord: (lotId?: bigint | null) => Promise<number>;

  /**
   * ⭐ 응답의 int64 다섯(`defectRecordId`·`repairProcessId`·`uomId`·`terminalId`·
   * `repairExecutionId`)을 **서로 다른 값**으로 둔다 — 표마다 시퀀스가 독립이라 우연히 겹칠 수
   * 있고, 겹치면 뒤바뀜 변이가 «값까지 같아» 안 잡힌다(§7-1 ⓑ). 겹치면 버림 행을 하나 더
   * 만들어 값을 민다 — 버려진 행은 접두어 정리가 지운다.
   */
  const distinctIds = new Set<number>();
  async function distinct(make: (seq: number) => Promise<number>): Promise<number> {
    for (let seq = 0; ; seq += 1) {
      const id = await make(seq);
      if (!distinctIds.has(id)) {
        distinctIds.add(id);
        return id;
      }
    }
  }
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

  /**
   * `POST /production/repair-executions` + `…:return` — I-25 PR ③.
   *
   * ⭐ 쓰기가 만드는 수리 건은 **실제 쓰기**로 만들고 조회·DB 로 되읽는다 — 픽스처로 위조하면
   *    쓰기가 실제로 무엇을 채우는지를 못 본다.
   * ⭐ 계약이 403 을 선언한 것은 **투입 하나뿐**이라 이 describe 전용 세션 둘을 세운다
   *    (조회 전용 `cookie` 를 고치지 않는다). ⛔ `:return` 에는 403 단언을 더하지 않는다 —
   *    계약 미선언이라 가드가 통과시켜 **반증 불가**다(§6-3).
   */
  describe('POST /production/repair-executions · :return', () => {
    /** ⭐ `M-02-02` 하나 + 토큰 발급용 `M-CO-01` — **`M-02-01` 이 없다**(B18 ⓑ 의 전제). */
    const POST_PERMISSIONS = ['M-02-02', 'M-CO-01'];

    let postCookie: string[];
    let noPermCookie: string[];
    let createdDefectId: number;
    let created: request.Response;

    interface CallOptions {
      key?: string;
      cookie?: string[];
      workerNo?: string | null;
      token?: string;
    }

    function post(payload: object, options: CallOptions = {}) {
      const call = request(app.getHttpServer())
        .post(REPAIRS)
        .set('Cookie', options.cookie ?? postCookie)
        .set('Idempotency-Key', options.key ?? randomUUID());
      if (options.workerNo !== null) call.set('X-Worker-No', options.workerNo ?? WORKER_NO);
      if (options.token !== undefined) call.set('Authorization', `Bearer ${options.token}`);
      return call.send(payload);
    }

    function close(repairExecutionId: number, payload: object, options: CallOptions = {}) {
      const call = request(app.getHttpServer())
        .post(`${REPAIRS}/${repairExecutionId}:return`)
        .set('Cookie', options.cookie ?? postCookie)
        .set('Idempotency-Key', options.key ?? randomUUID());
      if (options.workerNo !== null) call.set('X-Worker-No', options.workerNo ?? WORKER_NO);
      return call.send(payload);
    }

    /** 수량을 **소수**로 둔다 — 계약이 `type: number` 라 정수만 쓰면 Decimal→number 가 안 보인다. */
    function createBody(defectRecordId: number, overrides: Record<string, unknown> = {}) {
      return {
        defectRecordId,
        repairProcessId,
        startedAt: STARTED_AT,
        repairQty: 40.5,
        uomId: writeUomId,
        ...overrides,
      };
    }

    function returnBody(overrides: Record<string, unknown> = {}) {
      return { returnedAt: RETURN_AT, repairResultCode: 'SUCCEEDED', ...overrides };
    }

    /** 열린 수리 건 하나를 «자기 불량 기록»으로 연다 — 시험끼리 열린 건을 공유하지 않는다. */
    async function openOne(): Promise<{ defectRecordId: number; repairExecutionId: number }> {
      const defectRecordId = await makeDefectRecord();
      const response = await post(createBody(defectRecordId)).expect(201);
      return { defectRecordId, repairExecutionId: response.body.repairExecutionId as number };
    }

    beforeAll(async () => {
      postCookie = await login(POST_LOGIN_ID, POST_ROLE, POST_PERMISSIONS);
      noPermCookie = await login(NO_PERM_LOGIN_ID, NO_PERM_ROLE, []);
      // 단말 토큰은 발급 API 로 받는다 — 서명 코드를 복제하지 않는다(`work-session` e2e 선례).
      const issued = await request(app.getHttpServer())
        .post(`/api/mdm/terminals/${terminalId}:issue-token`)
        .set('Cookie', postCookie)
        .set('Idempotency-Key', randomUUID())
        .expect(201);
      terminalToken = issued.body.token as string;
      // PK 는 서버가 준다 — 앞의 넷과 겹치면 «다른 불량으로 다시 투입»해 값을 민다.
      for (;;) {
        createdDefectId = await distinct(() => makeDefectRecord());
        const response = await post(createBody(createdDefectId));
        const repairExecutionId = response.body.repairExecutionId as number;
        if (!distinctIds.has(repairExecutionId)) {
          distinctIds.add(repairExecutionId);
          created = response;
          break;
        }
      }
    });

    it('⭐ 픽스처의 id 가 서로 다르다 — 값 단언이 «출처»를 가를 수 있게 하는 전제', () => {
      // 하나라도 같으면 뒤바뀜 변이가 값까지 같아 안 잡힌다(§7-1 ⓑ · PR ① 리뷰).
      const ids = [
        createdDefectId,
        repairProcessId,
        writeUomId,
        terminalId,
        created.body.repairExecutionId as number,
      ];
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('⭐ B8 투입 201 — 응답 «전 칸»을 값까지 통째로 못박는다(널 4칸은 키 자체가 없다)', async () => {
      expect(created.status).toBe(201);
      const validate = validator('POST /production/repair-executions', 201);
      expect(validate(created.body)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);

      // ⛔ `toBe(undefined)` 는 널과 못 가른다(I-18 R-3) — 키 자체의 부재를 본다.
      expect('returnedAt' in created.body).toBe(false);
      expect('repairResultCode' in created.body).toBe(false);
      expect('reintroducedLotId' in created.body).toBe(false);
      // 토큰 없이 보냈다 — 「없음」은 400 이 아니라 「키 없음」이다(§5 ④).
      expect('terminalId' in created.body).toBe(false);
      // ⭐ 키 집합만으로는 「있어야 할 칸이 «어느 물리 칸에서» 왔나」를 못 본다 — 계약이 int64
      //    로만 선언해 ajv 도 못 본다(PR ① 리뷰) ⇒ 값까지 못박는다.
      expect(created.body).toEqual({
        repairExecutionId: expect.any(Number),
        defectRecordId: createdDefectId,
        repairProcessId,
        startedAt: STARTED_AT,
        repairQty: 40.5,
        uomId: writeUomId,
        workerNo: WORKER_NO,
      });
    });

    it('⭐ B9 같은 불량에 열린 건이 있으면 409 OPEN_SESSION_EXISTS', async () => {
      const conflict = await post(createBody(createdDefectId)).expect(409);
      expect(conflict.body).toMatchObject({ code: 'OPEN_SESSION_EXISTS', conflictCause: 'user' });
    });

    it('⭐ B10 반출된 불량에는 «다시 투입»이 201 이다', async () => {
      const opened = await openOne();
      await close(opened.repairExecutionId, returnBody()).expect(200);
      // `returned_at: null` 조건을 빼면 여기서 409 가 나온다 — 이 단언이 없으면 아무도 못 본다.
      const again = await post(createBody(opened.defectRecordId, { startedAt: RETURN_AT })).expect(201);
      expect(again.body.defectRecordId).toBe(opened.defectRecordId);
      expect(again.body.repairExecutionId).not.toBe(opened.repairExecutionId);
    });

    it('⭐ B11 repairQty 0 은 400 RANGE · 없는 참조 셋은 «전수» 400 INVALID(500 이 새는 자리)', async () => {
      const defectRecordId = await makeDefectRecord();
      const zero = await post(createBody(defectRecordId, { repairQty: 0 })).expect(400);
      expect(zero.body.errors).toContainEqual(
        expect.objectContaining({ field: 'repairQty', code: 'RANGE' }),
      );

      const badDefect = await post(createBody(999999999)).expect(400);
      expect(badDefect.body.errors).toContainEqual(
        expect.objectContaining({ field: 'defectRecordId', code: 'INVALID' }),
      );
      const badUom = await post(createBody(defectRecordId, { uomId: 999999999 })).expect(400);
      expect(badUom.body.errors).toContainEqual(
        expect.objectContaining({ field: 'uomId', code: 'INVALID' }),
      );
      const badProcess = await post(createBody(defectRecordId, { repairProcessId: 999999999 })).expect(400);
      expect(badProcess.body.errors).toContainEqual(
        expect.objectContaining({ field: 'repairProcessId', code: 'INVALID' }),
      );

      // ⭐ 위 셋만으로는 **반증이 안 된다** — 검사를 지워도 공용 그물(`prisma-error.ts` 의
      //    `P2003`)이 `repair_execution_<컬럼>_fkey` 에서 같은 필드·같은 코드의 400 을 만든다
      //    (#440 Minor-1 의 「500 이 샌다」는 이 표에서는 사실이 아니다 · 실측).
      //    가르는 것은 **한 번에 몇 개를 짚느냐**다: 서비스는 셋을 모아 던지고 FK 는 하나뿐이다.
      const allBad = await post(
        createBody(999999999, { uomId: 999999998, repairProcessId: 999999997 }),
      ).expect(400);
      expect(allBad.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'defectRecordId', code: 'INVALID' }),
          expect.objectContaining({ field: 'uomId', code: 'INVALID' }),
          expect.objectContaining({ field: 'repairProcessId', code: 'INVALID' }),
        ]),
      );

      // 넷 다 INSERT 앞에서 걸렸다 — 행이 하나도 안 생겼다.
      expect(
        await prisma.repair_execution.count({ where: { defect_record_id: BigInt(defectRecordId) } }),
      ).toBe(0);
    });

    it('⭐ B12 단말 토큰을 실으면 terminalId 가 그 단말 · 틀린 토큰은 400 INVALID', async () => {
      const withToken = await post(createBody(await makeDefectRecord()), { token: terminalToken }).expect(201);
      expect(withToken.body.terminalId).toBe(terminalId);
      // 토큰 없이 부른 B8 은 키 자체가 없다 — 「없음」과 「틀림」이 다르다.
      expect('terminalId' in created.body).toBe(false);

      const bad = await post(createBody(await makeDefectRecord()), { token: 'not-a-real-token' }).expect(400);
      expect(bad.body.errors).toContainEqual(
        expect.objectContaining({ field: 'Authorization', code: 'INVALID' }),
      );
    });

    it('⭐ B13 :return 은 200(201 이 아니다) · 왕복이 닫히는 것을 «조회로» 확인한다', async () => {
      const opened = await openOne();
      const before = await request(app.getHttpServer())
        .get(`${REPAIRS}?defectRecordId=${opened.defectRecordId}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(before.body.items.map((item: { repairExecutionId: number }) => item.repairExecutionId)).toEqual([
        opened.repairExecutionId,
      ]);

      const returned = await close(opened.repairExecutionId, returnBody());
      // `@HttpCode(OK)` 를 빼면 201 이 나온다.
      expect(returned.status).toBe(200);
      const validate = validator('POST /production/repair-executions/{repairExecutionId}:return', 200);
      expect(validate(returned.body)).toBe(true);
      expect(returned.body).toEqual({
        repairExecutionId: opened.repairExecutionId,
        defectRecordId: opened.defectRecordId,
        repairProcessId,
        startedAt: STARTED_AT,
        returnedAt: RETURN_AT,
        repairQty: 40.5,
        uomId: writeUomId,
        repairResultCode: 'SUCCEEDED',
        workerNo: WORKER_NO,
      });

      const open = await request(app.getHttpServer())
        .get(`${REPAIRS}?defectRecordId=${opened.defectRecordId}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(open.body.items).toEqual([]);
      const closed = await request(app.getHttpServer())
        .get(`${REPAIRS}?defectRecordId=${opened.defectRecordId}&open=false`)
        .set('Cookie', cookie)
        .expect(200);
      expect(closed.body.items.map((item: { repairExecutionId: number }) => item.repairExecutionId)).toEqual([
        opened.repairExecutionId,
      ]);
    });

    it('⭐ B14 returnedAt 이 startedAt 보다 앞서면 400 RANGE · «같은 시각»이면 200(경계 포함)', async () => {
      const opened = await openOne();
      const earlier = await close(
        opened.repairExecutionId,
        returnBody({ returnedAt: '2026-09-02T04:05:05.000Z' }),
      ).expect(400);
      expect(earlier.body.errors).toContainEqual(
        expect.objectContaining({ field: 'returnedAt', code: 'RANGE' }),
      );
      // CHECK `ck_repair_execution_period` 가 `>=` 라 같은 시각은 통과한다 — `<` 를 `<=` 로
      // 바꾸면 이 단언이 RED 다.
      const boundary = await close(opened.repairExecutionId, returnBody({ returnedAt: STARTED_AT })).expect(200);
      expect(boundary.body.returnedAt).toBe(STARTED_AT);
    });

    it('⭐ B15 같은 키 재전송은 200 재생(returned_at 이 첫 값 그대로) · 다른 키는 409 INVALID_STATE', async () => {
      const opened = await openOne();
      const key = randomUUID();
      const first = await close(opened.repairExecutionId, returnBody(), { key }).expect(200);
      const replay = await close(opened.repairExecutionId, returnBody(), { key }).expect(200);
      expect(replay.body).toEqual(first.body);
      const row = await prisma.repair_execution.findUniqueOrThrow({
        where: { repair_execution_id: BigInt(opened.repairExecutionId) },
      });
      expect(row.returned_at?.toISOString()).toBe(RETURN_AT);

      // 같은 키 · 다른 본문은 지문이 갈려 409 `DUPLICATE_KEY` 다(계열 봉투의 `code`).
      const duplicate = await close(
        opened.repairExecutionId,
        returnBody({ repairResultCode: 'FAILED' }),
        { key },
      ).expect(409);
      expect(duplicate.body).toMatchObject({ code: 'DUPLICATE_KEY', conflictCause: 'user' });

      // ⭐ 다른 키로 두 번째 반출 — 계약이 409 를 선언했다(선례의 400 `STATE_LOCKED` 와 갈린다).
      const conflict = await close(
        opened.repairExecutionId,
        returnBody({ returnedAt: '2026-09-02T09:09:09.000Z' }),
      ).expect(409);
      expect(conflict.body).toMatchObject({ code: 'INVALID_STATE', conflictCause: 'user' });
    });

    it('B16 없는 id 에 :return 하면 404 다(400 이 아니다)', async () => {
      await close(999999999, returnBody()).expect(404);
    });

    it('⭐ B17 :return 이 worker_no 를 덮지 않는다 — 그 칸은 「투입한 사람」이다', async () => {
      const opened = await openOne();
      const returned = await close(opened.repairExecutionId, returnBody(), {
        workerNo: OTHER_WORKER_NO,
      }).expect(200);
      expect(returned.body.workerNo).toBe(WORKER_NO);
      const row = await prisma.repair_execution.findUniqueOrThrow({
        where: { repair_execution_id: BigInt(opened.repairExecutionId) },
      });
      expect(row.worker_no).toBe(WORKER_NO);
    });

    it('X-Worker-No 가 없으면 400 REQUIRED · 없는 사번이면 400 INVALID(투입·반출 둘 다)', async () => {
      const defectRecordId = await makeDefectRecord();
      const absent = await post(createBody(defectRecordId), { workerNo: null }).expect(400);
      expect(absent.body.errors).toContainEqual(
        expect.objectContaining({ field: 'X-Worker-No', code: 'REQUIRED' }),
      );
      const unknown = await post(createBody(defectRecordId), { workerNo: `${PREFIX}-NOPE` }).expect(400);
      expect(unknown.body.errors).toContainEqual(
        expect.objectContaining({ field: 'X-Worker-No', code: 'INVALID' }),
      );

      const opened = await openOne();
      const onReturn = await close(opened.repairExecutionId, returnBody(), { workerNo: null }).expect(400);
      expect(onReturn.body.errors).toContainEqual(
        expect.objectContaining({ field: 'X-Worker-No', code: 'REQUIRED' }),
      );
    });

    it('⭐ 같은 Idempotency-Key 재전송이 수리 건을 두 벌 만들지 않는다(행 수를 센다)', async () => {
      const defectRecordId = await makeDefectRecord();
      const key = randomUUID();
      const first = await post(createBody(defectRecordId), { key }).expect(201);
      // 멱등을 지우면 둘째 요청이 열린 건 판정에 걸려 409 다 — 201 재생이 그물이다.
      const again = await post(createBody(defectRecordId), { key }).expect(201);
      expect(again.body).toEqual(first.body);
      expect(
        await prisma.repair_execution.count({ where: { defect_record_id: BigInt(defectRecordId) } }),
      ).toBe(1);

      const duplicate = await post(createBody(defectRecordId, { repairQty: 1.5 }), { key }).expect(409);
      expect(duplicate.body).toMatchObject({ code: 'DUPLICATE_KEY', conflictCause: 'user' });
    });

    it('⭐ B18 403 — 권한 표의 «값»을 양쪽에서 지켜본다(R-9 · 아홉 번째 자리)', async () => {
      // ⓐ 권한 0건 계정은 403 이다 — 요구 자체가 없어지면 201 이 나와 RED.
      await post(createBody(await makeDefectRecord()), { cookie: noPermCookie }).expect(403);

      // ⓑ ⭐ 성공하는 계정은 `M-02-01` 을 **갖고 있지 않다** — 그래서
      //    `derived-permissions.ts:235` 를 `['M-02-01']` 로 바꾸는 «값» 변이가 아래 201 을
      //    403 으로 뒤집는다. ⓐ 만으로는 그 변이가 전 테스트 초록이다.
      const granted = await prisma.role_permission.findMany({
        where: { role: { role_code: POST_ROLE } },
        select: { permission_code: true },
      });
      expect(granted.map((row) => row.permission_code).sort()).toEqual(['M-02-02', 'M-CO-01']);
      await post(createBody(await makeDefectRecord())).expect(201);
    });
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
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '수리실행검사사업부',
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
    // 쓰기가 담는 단위는 **조회 픽스처와 다른 행**이다 — `uomId` 가 다른 칸에서 와도 값이 갈린다.
    writeUomId = await distinct(
      async (seq) =>
        Number(
          (
            await prisma.uom.create({
              data: { uom_code: `${PREFIX}-UOM${seq}`, uom_name: '수리실행검사단위', decimal_scale: 3 },
            })
          ).uom_id,
        ),
    );
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
    // 수리 공정은 **발생 공정과 다른 행**이다 — `repairProcessId` 뒤바뀜을 값이 잡는다(§7-1 ⓑ).
    repairProcessId = await distinct(
      async (seq) =>
        Number(
          (
            await prisma.process.create({
              data: {
                process_code: `${PREFIX}-RP${seq}`,
                process_name: '수리공정',
                process_type_code: 'MOLDING',
              },
            })
          ).process_id,
        ),
    );
    const defectCode = await prisma.defect_code.create({
      data: { defect_code: `${PREFIX}-DC`, defect_name: '수리실행검사불량' },
    });
    terminalId = await distinct(
      async (seq) =>
        Number(
          (
            await prisma.terminal.create({
              data: {
                terminal_code: `${PREFIX}-T${seq}`,
                plant_id: plant.plant_id,
                terminal_type_code: 'POP',
                status_code: 'RUNNING',
              },
            })
          ).terminal_id,
        ),
    );
    await prisma.worker.createMany({
      data: [WORKER_NO, OTHER_WORKER_NO].map((worker_no) => ({
        worker_no,
        worker_name: '수리실행검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      })),
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
    const defectRecord = async (lotId: bigint | null = null) => {
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
    // 쓰기 시험이 자기 불량 기록을 그때그때 만든다 — 열린 건이 하나뿐이라는 전제를 시험끼리
    // 공유하지 않는다(§5 ⑤ 의 409 가 앞 시험의 잔재로 터지면 그물이 아니라 사고다).
    makeDefectRecord = async (lotId: bigint | null = lotX.lot_id) =>
      Number((await defectRecord(lotId)).defect_record_id);

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
    await prisma.uom.deleteMany({ where: { uom_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    // 계정은 «맨 뒤»다 — `repair_execution.created_by` 가 쓰기 계정을 물고 있다.
    for (const loginId of [LOGIN_ID, POST_LOGIN_ID, NO_PERM_LOGIN_ID]) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!user) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    for (const roleCode of [POST_ROLE, NO_PERM_ROLE]) {
      await prisma.role_permission.deleteMany({ where: { role: { role_code: roleCode } } });
      await prisma.role.deleteMany({ where: { role_code: roleCode } });
    }
  }
});
