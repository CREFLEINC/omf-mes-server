/**
 * 처분 판정 저장 (e2e) — I-21 PR ⑦(심장 B).
 * `POST /quality/nonconformances/{nonconformanceId}/disposition-decisions` 하나뿐이다.
 *
 * ⭐⭐ **저장소 유일한 「201 + If-Match 필수 + ETag」다.** 공용 `runVersioned` 는 성공 상태를
 * 200 으로 고정해 못 쓰고, 컨트롤러가 `runIdempotent(CREATED)` + `ifMatchVersion` + `setEtag`
 * 를 손으로 엮는다. ⛔ 그 셋째 인자는 **HTTP 상태가 아니다** — `master-write.ts:44` 가
 * `outcome.status` 를 버려 `idempotency_record.response_status` 에만 남는다 ⇒ HTTP 로는 영영
 * 관측되지 않으므로 **그 칸을 직접 단언**하는 시험이 있다(⑥ 이 찾은 M44).
 *
 * ⭐ **이 파일의 절반은 «갈래 순서»를 관측한다** — 한 요청이 두 규칙을 «동시에» 어기게 짜야
 * 순서가 보인다. 인접 쌍을 전수로 잠갔다(가드↔서비스 · 404↔400 · 400 안 셋 · 400↔409 ·
 * 409↔409 · 409↔400 · 400↔409).
 *
 * ⭐ 픽스처는 **부적합마다 자기 LOT** 을 쓴다(테스트 순서 의존 0). 성공 경로와 실패 경로
 * **둘 다** 다중 LOT 부적합을 태운다 — 「전건을 옮긴다」와 「전건이 되돌아간다」가 각각
 * 한 LOT 만 봐도 초록이 되는 것을 막는다(⑥ 리뷰 Major-2 가 그 자리였다).
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

const PREFIX = 'I21DW';
const LOGIN_ID = 'e2e-i21dw-probe';
const PASSWORD = 'PR-처분판정-비밀번호';
/**
 * ⭐⭐ **`W-03-10` «만»** 가진 계정으로 잰다(§8-3 #30-d · 통보 181). 도출표는 이 오퍼레이션에
 * `P-02-13`(POP · PQC) 하나를 주었고 그 계정으로 재면 `manual-permissions.ts` 4행을 지워도
 * 초록이라 **구멍이 안 잡힌다.**
 */
const PERMISSION = 'W-03-10';
/** ⛔ 권한 «0개»면 「아무 권한도 없다」와 「이 기능만 없다」를 못 가른다 — 조회 화면 하나를 준다. */
const NO_WRITE_PERMISSION = 'W-03-01';
const ROLE = 'E2E_I21_DISP_WRITE';
const ROLE_NO_WRITE = 'E2E_I21_DISP_WRITE_RO';

const decisionSchema = validator(201);

function validator(status: number): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object;
  const path = '/quality/nonconformances/{nonconformanceId}/disposition-decisions';
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/post/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('처분 판정 저장 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noWriteCookie: string[];
  let userId = 0n;

  const ids: Record<string, bigint> = {};
  const lotIds: Record<string, bigint> = {};
  /** 부적합 이름 → id. 갈래마다 «자기» 부적합을 쓴다. */
  const ncIds: Record<string, number> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUser();
    await makeMasters();
    await makeNonconformances();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const url = (nonconformanceId: number) => `/api/quality/nonconformances/${nonconformanceId}/disposition-decisions`;

  const post = (nonconformanceId: number, ifMatch: string | number, asCookie: string[] = cookie) =>
    request(app.getHttpServer())
      .post(url(nonconformanceId))
      .set('Cookie', asCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(ifMatch));

  /** 판정 본문 — 「고치고 싶은 칸만」 넘긴다. 기본 단위는 소수 6자리 단위다. */
  function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { dispositionTypeCode: 'SCRAP', decisionQty: 1, uomId: Number(ids.uom6), reason: `${PREFIX} 판정 사유`, ...overrides };
  }

  const eventsOf = (lotKey: string) => prisma.lot_status_event.findMany({ where: { lot_id: lotIds[lotKey] } });
  const decisionCount = (key: string) => prisma.disposition_decision.count({ where: { nonconformance_id: BigInt(ncIds[key]) } });

  // ─────────────────────────────── 본길 ───────────────────────────────

  it('⭐⭐ 201 + ETag = 부적합의 «새» version_no · 본문은 계약 스키마다', async () => {
    const response = await post(ncIds.main, 4)
      .send(body({ dispositionTypeCode: 'REWORK', decisionQty: 0.1 }))
      .expect(201);

    // ⭐ 판정 저장이 부적합의 판을 «올려야» 한다 — 안 올리면 그 토큰이 경합을 못 잡는다(계약 명시).
    expect(response.headers.etag).toBe('5');
    expect(response.body).toMatchObject({
      nonconformanceId: ncIds.main,
      dispositionTypeCode: 'REWORK',
      decisionQty: 0.1,
      uomId: Number(ids.uom6),
      reason: `${PREFIX} 판정 사유`,
      decidedBy: Number(userId),
      // 후속 전표가 0건이라 폐기 롤업이 0 이다(required 라 키를 생략하지 않는다).
      followUpStatusCode: 'NOT_STARTED',
      followUpQty: 0,
    });
    // ⛔ `versionNo` 는 본문에 안 싣는다(공유계약 A-4) — ETag 전용이다.
    expect(response.body).not.toHaveProperty('versionNo');
    // 대상 LOT 이 «둘»이라 `lotId`·`lotNo` 는 키를 생략한다(조용히 첫 LOT 을 고르지 않는다).
    expect(response.body).not.toHaveProperty('lotId');
    // 널을 못 받는 선택 칸(R-13) — 오늘 언제나 NULL 인 `approvalRequestId` 는 키 생략이다.
    expect(response.body).not.toHaveProperty('approvalRequestId');
    expect(response.body.nonconformanceNo).toBe(`${PREFIX}-NC-main`);
    expect(decisionSchema(response.body)).toBe(true);

    const row = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.main) } });
    expect(row).toMatchObject({ version_no: 5, status_code: 'PENDING_DECISION', closed_at: null, updated_by: userId });
    const decision = await prisma.disposition_decision.findFirstOrThrow({ where: { nonconformance_id: BigInt(ncIds.main) } });
    // 감사 칸은 계약 본문에 없거나(approval) 서버가 채운다 — DB 로만 볼 수 있어 여기서 잠근다.
    expect(decision.decided_by).toBe(userId);
    expect(decision.approval_request_id).toBeNull();
    expect(decision.decided_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('⭐⭐ 대상 LOT «전건»이 옮겨진다 — REWORK → INSPECTION_PENDING · 이력 transition_code C17', async () => {
    // ⭐ 두 LOT 의 출발이 «다르다»(NORMAL ↔ DEFECTIVE) — 첫 LOT 만 옮기는 변이도, 출발을
    //   상수로 고정하는 변이도 여기서 잡힌다.
    const before = await prisma.lot.findMany({ where: { lot_id: { in: [lotIds.R1, lotIds.R2] } }, orderBy: { lot_id: 'asc' } });
    await post(ncIds.rework, 2).send(body({ dispositionTypeCode: 'REWORK', decisionQty: 60 })).expect(201);

    const after = await prisma.lot.findMany({ where: { lot_id: { in: [lotIds.R1, lotIds.R2] } }, orderBy: { lot_id: 'asc' } });
    expect(after.map((lot) => lot.status_code)).toEqual(['INSPECTION_PENDING', 'INSPECTION_PENDING']);
    expect(after.map((lot) => lot.version_no)).toEqual(before.map((lot) => lot.version_no + 1));

    const decision = await prisma.disposition_decision.findFirstOrThrow({ where: { nonconformance_id: BigInt(ncIds.rework) } });
    for (const [key, previous] of [['R1', 'NORMAL'], ['R2', 'DEFECTIVE']] as const) {
      const events = await eventsOf(key);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        transition_code: 'C17',
        previous_status_code: previous,
        new_status_code: 'INSPECTION_PENDING',
        source_document_type_code: 'DISPOSITION_DECISION',
        source_document_id: decision.disposition_decision_id,
        reason: `${PREFIX} 판정 사유`,
        changed_by: userId,
      });
    }
  });

  it('⭐ SCRAP → SCRAPPED · C18', async () => {
    await post(ncIds.scrap, 3).send(body({ dispositionTypeCode: 'SCRAP', decisionQty: 100 })).expect(201);

    const after = await prisma.lot.findMany({ where: { lot_id: { in: [lotIds.S1, lotIds.S2] } } });
    expect(after.map((lot) => lot.status_code)).toEqual(['SCRAPPED', 'SCRAPPED']);
    expect((await eventsOf('S1'))[0]).toMatchObject({ transition_code: 'C18', new_status_code: 'SCRAPPED' });
  });

  it('⭐ NORMAL → NORMAL · C19 — 무변화여도 이력이 «한 행» 남는다', async () => {
    await post(ncIds.normal, 1).send(body({ dispositionTypeCode: 'NORMAL', decisionQty: 50 })).expect(201);

    const n1 = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotIds.N1 } });
    expect(n1.status_code).toBe('NORMAL');
    // ⛔ 「상태가 안 바뀌니 건너뛴다」로 접으면 여기가 0행이 된다 — 판정 이력이 통째로 사라진다.
    const events = await eventsOf('N1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ transition_code: 'C19', previous_status_code: 'NORMAL', new_status_code: 'NORMAL' });
    expect((await eventsOf('N2'))[0]).toMatchObject({ previous_status_code: 'DEFECTIVE', new_status_code: 'NORMAL' });
  });

  it('⭐⭐ 남은 수량과 «정확히» 같으면 201 이고 부적합이 DECIDED 로 닫힌다(소수 경계)', async () => {
    // ⭐ 대상 합이 0.1 + 0.2 다 — `Number()` 로 접어 더하면 0.30000000000000004 가 되어
    //   「남은 수량 0」이 영영 안 오고 부적합이 안 닫힌다(node 실측: 0.1+0.2 === 0.3 → false).
    //   위 본길이 이미 0.1 을 썼으므로 남은 것이 정확히 0.2 다.
    await post(ncIds.main, 5).send(body({ dispositionTypeCode: 'SCRAP', decisionQty: 0.2 })).expect(201);

    const row = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.main) } });
    expect(row.status_code).toBe('DECIDED');
    expect(row.closed_at).not.toBeNull();
    expect(row.version_no).toBe(6);
  });

  it('⭐⭐ 부분 처분 — 매 판정마다 옮기고 «마지막» 도착 상태가 남는다(REWORK 60 → SCRAP 40)', async () => {
    await post(ncIds.partial, 1).send(body({ dispositionTypeCode: 'REWORK', decisionQty: 60 })).expect(201);
    const middle = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.partial) } });
    // 남은 수량 40 > 0 이라 «아직» 안 닫힌다 — 부분 처분은 PENDING_DECISION 에 머문다.
    expect(middle).toMatchObject({ status_code: 'PENDING_DECISION', version_no: 2, closed_at: null });
    expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotIds.P1 } })).status_code).toBe('INSPECTION_PENDING');

    await post(ncIds.partial, 2).send(body({ dispositionTypeCode: 'SCRAP', decisionQty: 40 })).expect(201);

    // ⛔ 「첫 판정만 옮긴다」로 바꾸면 여기가 INSPECTION_PENDING 으로 남는다.
    const lots = await prisma.lot.findMany({ where: { lot_id: { in: [lotIds.P1, lotIds.P2] } } });
    expect(lots.map((lot) => lot.status_code)).toEqual(['SCRAPPED', 'SCRAPPED']);
    expect(await eventsOf('P1')).toHaveLength(2);
    const after = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.partial) } });
    expect(after).toMatchObject({ status_code: 'DECIDED', version_no: 3 });
    expect(await decisionCount('partial')).toBe(2);
  });

  it('⭐⭐ 같은 Idempotency-Key 재전송 — 행이 안 늘고 201 을 재생하며 기록의 상태가 201 이다', async () => {
    const key = randomUUID();
    const send = () =>
      request(app.getHttpServer())
        .post(url(ncIds.idem))
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .set('If-Match', '3')
        .send(body({ decisionQty: 5 }));

    const first = await send().expect(201);
    const replay = await send().expect(201);

    expect(replay.body.dispositionDecisionId).toBe(first.body.dispositionDecisionId);
    expect(await decisionCount('idem')).toBe(1);
    expect((await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.idem) } })).version_no).toBe(4);
    expect(await eventsOf('I1')).toHaveLength(1);
    // ⛔⛔ M44 — `runIdempotent` 의 셋째 인자는 HTTP 상태가 «아니다». 인자를 OK 로 바꿔도 첫
    //   요청도 재생도 201 그대로라(`@Post` 기본값) HTTP 로는 영영 안 보인다. 이 칸이 유일한 그물이다.
    const record = await prisma.idempotency_record.findUniqueOrThrow({ where: { idempotency_key: key } });
    expect(record.response_status).toBe(201);
  });

  it('⭐ 대상 LOT 이 «하나»면 응답이 lotId·lotNo 를 싣는다(둘이면 생략 — 접기 규칙)', async () => {
    const response = await post(ncIds.single, 1).send(body({ decisionQty: 3 })).expect(201);

    expect(response.body).toMatchObject({ lotId: Number(lotIds.G1), lotNo: `${PREFIX}-LOT-G1` });
    expect(decisionSchema(response.body)).toBe(true);
  });

  it('⭐ 일부 LOT 만 옮겨져도 201 이고 못 옮긴 LOT 은 그대로다(SCRAPPED 가 섞인 부적합)', async () => {
    const before = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotIds.X1 } });
    await post(ncIds.mixed, 1).send(body({ dispositionTypeCode: 'SCRAP', decisionQty: 10 })).expect(201);

    const x1 = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotIds.X1 } });
    expect(x1.version_no).toBe(before.version_no);
    expect(await eventsOf('X1')).toHaveLength(0);
    expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotIds.X2 } })).status_code).toBe('SCRAPPED');
    expect(await eventsOf('X2')).toHaveLength(1);
  });

  // ─────────────────────────────── 거부 갈래 ───────────────────────────────

  it('⭐ 없는 nonconformanceId → 404(계약이 «이» 오퍼레이션에 404 를 선언했다)', async () => {
    await post(99_999_999, 1).send(body()).expect(404);
  });

  it('⭐ uomId 가 부적합의 단위와 다르면 400 INVALID', async () => {
    const response = await post(ncIds.val, 1).send(body({ uomId: Number(ids.uom2) })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'uomId', code: 'INVALID' });
  });

  it('⭐⭐ reason — 「공백만」은 REQUIRED 이고 「빈 문자열」은 RANGE 다(두 갈래의 코드가 다르다)', async () => {
    const blank = await post(ncIds.val, 1).send(body({ reason: '   ' })).expect(400);
    const empty = await post(ncIds.val, 1).send(body({ reason: '' })).expect(400);

    // `minLength:1` 이 `" "` 를 통과시킨다 — 서비스가 REQUIRED 로 막는다(A-12).
    expect(blank.body.errors[0]).toMatchObject({ field: 'reason', code: 'REQUIRED' });
    expect(empty.body.errors[0]).toMatchObject({ code: 'RANGE' });
  });

  it('⭐ reason 의 앞뒤 공백을 «조용히» 다듬지 않는다(2단계 기준 4)', async () => {
    const response = await post(ncIds.trim, 1).send(body({ decisionQty: 2, reason: `  ${PREFIX} 여백  ` })).expect(201);

    expect(response.body.reason).toBe(`  ${PREFIX} 여백  `);
  });

  it('⭐⭐ decisionQty 스케일 — 소수 7자리는 400 RANGE 다(⛔ 조용한 반올림 금지)', async () => {
    const response = await post(ncIds.val, 1).send(body({ decisionQty: 0.9999995 })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'decisionQty', code: 'RANGE' });
  });

  it('⭐⭐ 스케일 한계는 «단위마다» 다르다 — 소수 2자리 단위에서 1.005 는 400, 1.05 는 201', async () => {
    // ⛔ 상수 6 으로 접는 변이가 여기서 잡힌다 — `mdm.uom.decimal_scale` 이 축이다(§9-1 #16).
    const rejected = await post(ncIds.scale, 1).send(body({ decisionQty: 1.005, uomId: Number(ids.uom2) })).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'decisionQty', code: 'RANGE' });

    await post(ncIds.scale, 1).send(body({ decisionQty: 1.05, uomId: Number(ids.uom2) })).expect(201);
  });

  it('⭐ decisionQty 정수 15자리는 400 RANGE 다(numeric(20,6) overflow 를 문 앞에서 막는다)', async () => {
    const response = await post(ncIds.val, 1).send(body({ decisionQty: 1e15 })).expect(400);

    // ⛔ 잔량 초과(409)보다 «앞»이다 — 담을 수 없는 값은 「많다」가 아니라 「틀렸다」이다.
    expect(response.body.errors[0]).toMatchObject({ field: 'decisionQty', code: 'RANGE' });
  });

  it('⭐ 계약 가드가 이미 막는 둘은 서비스가 다시 세지 않는다(R-15 — 회귀 잠금)', async () => {
    // `decisionQty` 의 `exclusiveMinimum: 0` 과 `dispositionTypeCode` 의 enum 이 그것이다.
    const zero = await post(ncIds.val, 1).send(body({ decisionQty: 0 })).expect(400);
    const unknown = await post(ncIds.val, 1).send(body({ dispositionTypeCode: 'SORTING' })).expect(400);

    expect(zero.body.errors[0]).toMatchObject({ code: 'RANGE' });
    expect(unknown.body.errors[0]).toMatchObject({ code: 'INVALID' });
  });

  it('⭐⭐ 잔량 초과 → 409 DISPOSITION_QTY_EXCEEDED + remainingQty · remainingQtyUomId', async () => {
    const response = await post(ncIds.exceed, 5).send(body({ decisionQty: 120.000001 })).expect(409);

    // ⛔ 화면이 `message` 자유문에서 파싱하지 않는다 — 구조화 칸이 정본이다(계약 명시).
    expect(response.body).toMatchObject({
      code: 'DISPOSITION_QTY_EXCEEDED',
      conflictCause: 'user',
      remainingQty: 120,
      remainingQtyUomId: Number(ids.uom6),
    });
    expect(await decisionCount('exceed')).toBe(0);
    // 「한계와 같은 값」은 통과한다 — `>` 이지 `>=` 가 아니다.
    await post(ncIds.exceed, 5).send(body({ decisionQty: 120 })).expect(201);
  });

  it('⭐ 잔량은 «이미 저장된 결정»을 뺀 값이다 — 두 번째 판정의 409 가 남은 만큼만 허용한다', async () => {
    await post(ncIds.remain, 1).send(body({ decisionQty: 30 })).expect(201);
    const response = await post(ncIds.remain, 2).send(body({ decisionQty: 71 })).expect(409);

    expect(response.body).toMatchObject({ code: 'DISPOSITION_QTY_EXCEEDED', remainingQty: 70 });
  });

  it('⭐ 이미 종결(DECIDED)된 부적합이면 409 INVALID_STATE 다', async () => {
    const response = await post(ncIds.decided, 2).send(body({ decisionQty: 1 })).expect(409);

    expect(response.body).toMatchObject({ code: 'INVALID_STATE', conflictCause: 'user' });
    expect(await decisionCount('decided')).toBe(0);
  });

  it('⭐ 대상 LOT 이 전부 SCRAPPED 라 한 건도 못 옮기면 400 STATE_LOCKED 다', async () => {
    const response = await post(ncIds.locked, 1).send(body({ decisionQty: 5 })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    // ⛔ 결정만 남고 LOT 이 안 바뀌면 다음 화면이 잘못된 대상을 집는다(B-8) — 함께 되돌아간다.
    expect(await decisionCount('locked')).toBe(0);
  });

  it('⭐ 의뢰를 안 거친(NOT_REQUESTED) 부적합 — 부분 판정은 201, «전량» 판정은 409 INVALID_STATE', async () => {
    // 전이표가 정본이다 — `nonconformance-decide` 의 `from` 이 `PENDING_DECISION` 하나다(§6-1).
    // 종결시킬 것이 없는 부분 판정은 그 전이를 안 타므로 통과한다.
    // ⚠ 첫 판정을 REWORK 로 둔다 — SCRAP 이면 LOT 이 SCRAPPED 로 굳어 둘째가 전이 0건(400)에
    //   먼저 걸려 이 자리를 못 본다(전이 검사가 종결 판정보다 앞이다).
    await post(ncIds.notreq, 1).send(body({ dispositionTypeCode: 'REWORK', decisionQty: 4 })).expect(201);
    const closing = await post(ncIds.notreq, 2).send(body({ decisionQty: 6 })).expect(409);

    expect(closing.body).toMatchObject({ code: 'INVALID_STATE' });
    const row = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.notreq) } });
    expect(row).toMatchObject({ status_code: 'NOT_REQUESTED', version_no: 2 });
  });

  it('⭐ If-Match 가 어긋나면 409 VERSION_CONFLICT + currentVersion', async () => {
    const response = await post(ncIds.roll, 999).send(body({ decisionQty: 10 })).expect(409);

    expect(response.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: '6', conflictCause: 'user' });
  });

  it('⭐ If-Match 를 안 보내면 400 REQUIRED 다(가드 · 계약이 «필수»로 선언했다)', async () => {
    const response = await request(app.getHttpServer())
      .post(url(ncIds.roll))
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send(body())
      .expect(400);

    expect(response.body.errors[0]).toMatchObject({ code: 'REQUIRED' });
  });

  it('⭐⭐ 권한 — `W-03-10` «만» 가진 계정이 201 을 받는다(도출표엔 P-02-13 하나뿐이다)', async () => {
    // ⛔ 이 스위트의 성공 시험 전부가 그 계정으로 돈다 — `manual-permissions.ts` 4행을 지우면
    //   전건이 403 이 된다. 여기서는 그것이 «의도»임을 이름으로 남긴다.
    await post(ncIds.perm, 1).send(body({ decisionQty: 1 })).expect(201);
  });

  it('⭐ 권한 없는 계정은 403 (↩ 게이트를 빼면 201 이 된다)', async () => {
    await post(ncIds.perm, 2, noWriteCookie).send(body({ decisionQty: 1 })).expect(403);
  });

  // ─────────────────────────── 갈래 «순서» — 인접 쌍 전수 ───────────────────────────

  it('⭐⭐ 순서 — 계약 검증 가드가 서비스보다 앞이다(decisionQty 0 + 없는 id → 400 RANGE)', async () => {
    const response = await post(99_999_999, 1).send(body({ decisionQty: 0 })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ code: 'RANGE' });
  });

  it('⭐⭐ 순서 — 존재 확인(404)이 본문 형식(400)보다 앞이다(없는 id + 단위 불일치 → 404)', async () => {
    await post(99_999_999, 1).send(body({ uomId: Number(ids.uom2) })).expect(404);
  });

  it('⭐⭐ 순서 — 단위 대조가 스케일보다 앞이다(단위 불일치 + 소수 7자리 → uomId INVALID)', async () => {
    const response = await post(ncIds.val, 1).send(body({ uomId: Number(ids.uom2), decisionQty: 0.9999995 })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'uomId', code: 'INVALID' });
  });

  it('⭐⭐ 순서 — 스케일이 사유 공백 검사보다 앞이다(소수 7자리 + 공백만 → decisionQty RANGE)', async () => {
    const response = await post(ncIds.val, 1).send(body({ decisionQty: 0.9999995, reason: '   ' })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'decisionQty', code: 'RANGE' });
  });

  it('⭐⭐ 순서 — 본문 형식(400)이 종결 판정(409)보다 앞이다(DECIDED + 단위 불일치 → 400)', async () => {
    const response = await post(ncIds.decided, 2).send(body({ uomId: Number(ids.uom2) })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'uomId', code: 'INVALID' });
  });

  it('⭐⭐ 순서 — 종결(INVALID_STATE)이 잔량 초과(DISPOSITION_QTY_EXCEEDED)보다 앞이다', async () => {
    const response = await post(ncIds.decided, 2).send(body({ decisionQty: 9999 })).expect(409);

    expect(response.body.code).toBe('INVALID_STATE');
  });

  it('⭐⭐ 순서 — 잔량 초과(409)가 전이 0건(400 STATE_LOCKED)보다 앞이다', async () => {
    // `locked` 는 대상이 전부 SCRAPPED 라 옮길 것이 «0건»이면서 동시에 수량을 넘긴 요청이다.
    const response = await post(ncIds.locked, 1).send(body({ decisionQty: 9999 })).expect(409);

    expect(response.body.code).toBe('DISPOSITION_QTY_EXCEEDED');
  });

  it('⭐⭐ 순서 — 전이 0건(400)이 판 번호 대조(409 VERSION_CONFLICT)보다 앞이다', async () => {
    const response = await post(ncIds.locked, 999).send(body({ decisionQty: 5 })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  // ─────────────────────────── 롤백 · 잠금 ───────────────────────────

  it('⭐⭐ 롤백 — 마지막 단계(판 번호)가 던지면 결정·전이·이력·멱등이 «전부» 안 남는다', async () => {
    // ⭐ 대상 LOT 이 «둘»이다 — 하나만 되돌리는 변이가 여기서 잡힌다(성공 경로에만 다중 LOT 을
    //   두면 그 자리가 그물 밖이다 · ⑥ 리뷰 Major-2).
    const before = await prisma.lot.findMany({ where: { lot_id: { in: [lotIds.B1, lotIds.B2] } }, orderBy: { lot_id: 'asc' } });
    await post(ncIds.roll, 999).send(body({ dispositionTypeCode: 'SCRAP', decisionQty: 120 })).expect(409);

    expect(await decisionCount('roll')).toBe(0);
    const after = await prisma.lot.findMany({ where: { lot_id: { in: [lotIds.B1, lotIds.B2] } }, orderBy: { lot_id: 'asc' } });
    expect(after.map((lot) => [lot.status_code, lot.version_no])).toEqual(before.map((lot) => [lot.status_code, lot.version_no]));
    expect(await eventsOf('B1')).toHaveLength(0);
    expect(await eventsOf('B2')).toHaveLength(0);
    expect((await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.roll) } })).version_no).toBe(6);
    // 멱등 기록도 함께 되돌아간다 — 같은 키가 「처리 중」으로 굳으면 재시도가 영영 막힌다.
    expect(await prisma.idempotency_record.count({ where: { app_user_id: userId, status: 'IN_PROGRESS' } })).toBe(0);
  });

  it('⭐⭐ 동시 두 요청이 잔량을 «나눠 갖지» 못한다 — 뒤쪽이 409 DISPOSITION_QTY_EXCEEDED', async () => {
    // ⛔ 잔량 재계수가 부적합 잠금 «밖»이면 둘 다 remaining=120 을 읽어 «둘 다» 저장된다.
    //   If-Match 만으로는 못 막는다 — 둘이 같은 토큰을 들고 온다(뒤쪽이 VERSION_CONFLICT 로
    //   갈리면 그것이 곧 「잠금이 없다」는 증거다). ⚠ 겹치지 않고 직렬로 돌면 잠금 없이도
    //   초록인 검사다(선례 주석 `app-role.e2e-spec.ts:356`).
    // ⚠ 대상 120 을 70 씩 두 번 집는다 — 「전량」이면 첫 판정이 부적합을 닫아 둘째가 종결
    //   판정(INVALID_STATE)에 먼저 걸려 잔량 자리를 못 본다.
    const send = () => post(ncIds.race, 1).send(body({ dispositionTypeCode: 'SCRAP', decisionQty: 70 }));
    const [a, b] = await Promise.all([send(), send()]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).body.code).toBe('DISPOSITION_QTY_EXCEEDED');
    expect(await decisionCount('race')).toBe(1);
  });

  // ─────────────────────────────── 픽스처 ───────────────────────────────

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: `${PREFIX} 법인`, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: `${PREFIX} 공장`, timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.plant = plant.plant_id;

    // ⭐ 소수 자릿수가 «다른» 단위 둘 — 스케일 축을 상수 6 으로 접는 변이가 이 둘로만 잡힌다.
    const uom6 = await prisma.uom.create({ data: { uom_code: `${PREFIX}-U6`, uom_name: `${PREFIX} 6자리`, decimal_scale: 6 } });
    const uom2 = await prisma.uom.create({ data: { uom_code: `${PREFIX}-U2`, uom_name: `${PREFIX} 2자리`, decimal_scale: 2 } });
    ids.uom6 = uom6.uom_id;
    ids.uom2 = uom2.uom_id;

    for (const [key, uomId] of [['item6', uom6.uom_id], ['item2', uom2.uom_id]] as const) {
      const item = await prisma.item.create({
        data: { item_code: `${PREFIX}-IT-${key}`, item_name: `${PREFIX} ${key}`, item_type_code: 'FINISHED_GOODS', base_uom_id: uomId, lot_controlled: true },
      });
      ids[key] = item.item_id;
    }

    // ⭐ 출발 상태가 서로 «다른» LOT 들 — 「전건을 옮긴다」와 「출발을 상수로 고정한다」가 갈린다.
    const plan: [string, string, 'item6' | 'item2'][] = [
      ['M1', 'NORMAL', 'item6'], ['M2', 'INSPECTION_PENDING', 'item6'],
      ['R1', 'NORMAL', 'item6'], ['R2', 'DEFECTIVE', 'item6'],
      ['S1', 'DEFECTIVE', 'item6'], ['S2', 'NORMAL', 'item6'],
      ['N1', 'NORMAL', 'item6'], ['N2', 'DEFECTIVE', 'item6'],
      ['P1', 'NORMAL', 'item6'], ['P2', 'DEFECTIVE', 'item6'],
      ['E1', 'DEFECTIVE', 'item6'], ['E2', 'NORMAL', 'item6'],
      ['D1', 'DEFECTIVE', 'item6'],
      ['K1', 'SCRAPPED', 'item6'], ['K2', 'SCRAPPED', 'item6'],
      ['X1', 'SCRAPPED', 'item6'], ['X2', 'NORMAL', 'item6'],
      ['C1', 'NORMAL', 'item2'],
      ['Q1', 'NORMAL', 'item6'],
      ['Z1', 'DEFECTIVE', 'item6'],
      ['I1', 'DEFECTIVE', 'item6'],
      ['B1', 'NORMAL', 'item6'], ['B2', 'DEFECTIVE', 'item6'],
      ['G1', 'NORMAL', 'item6'],
      ['V1', 'NORMAL', 'item6'], ['V2', 'DEFECTIVE', 'item6'],
      ['T1', 'NORMAL', 'item6'],
      ['W1', 'NORMAL', 'item6'],
      ['Y1', 'NORMAL', 'item6'], ['Y2', 'DEFECTIVE', 'item6'],
    ];
    for (const [suffix, statusCode, itemKey] of plan) {
      const lot = await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT-${suffix}`,
          item_id: ids[itemKey],
          lot_type_code: 'PRODUCT',
          plant_id: plant.plant_id,
          initial_qty: 1000,
          uom_id: itemKey === 'item2' ? uom2.uom_id : uom6.uom_id,
          source_type_code: 'INBOUND_RECEIPT_LINE',
          source_id: 1,
          status_code: statusCode,
        },
      });
      lotIds[suffix] = lot.lot_id;
    }
  }

  /** 갈래마다 «자기» 부적합을 쓴다 — 판 번호를 1 이 아닌 값으로도 벌려 상수 ETag 변이를 잡는다. */
  async function makeNonconformances(): Promise<void> {
    await makeNc('main', 'item6', 'uom6', [['M1', 0.1], ['M2', 0.2]], 'PENDING_DECISION', 4, null);
    await makeNc('rework', 'item6', 'uom6', [['R1', 60], ['R2', 100]], 'PENDING_DECISION', 2, null);
    await makeNc('scrap', 'item6', 'uom6', [['S1', 40], ['S2', 60]], 'PENDING_DECISION', 3, null);
    await makeNc('normal', 'item6', 'uom6', [['N1', 20], ['N2', 30]], 'PENDING_DECISION', 1, null);
    await makeNc('partial', 'item6', 'uom6', [['P1', 60], ['P2', 40]], 'PENDING_DECISION', 1, null);
    await makeNc('exceed', 'item6', 'uom6', [['E1', 70], ['E2', 50]], 'PENDING_DECISION', 5, null);
    await makeNc('remain', 'item6', 'uom6', [['Y1', 40], ['Y2', 60]], 'PENDING_DECISION', 1, null);
    await makeNc('decided', 'item6', 'uom6', [['D1', 10]], 'DECIDED', 2, new Date('2026-09-02T00:00:00.000Z'));
    await makeNc('locked', 'item6', 'uom6', [['K1', 5], ['K2', 5]], 'PENDING_DECISION', 1, null);
    await makeNc('mixed', 'item6', 'uom6', [['X1', 5], ['X2', 5]], 'PENDING_DECISION', 1, null);
    await makeNc('scale', 'item2', 'uom2', [['C1', 10]], 'PENDING_DECISION', 1, null);
    await makeNc('notreq', 'item6', 'uom6', [['Q1', 10]], 'NOT_REQUESTED', 1, null);
    await makeNc('race', 'item6', 'uom6', [['Z1', 120]], 'PENDING_DECISION', 1, null);
    await makeNc('idem', 'item6', 'uom6', [['I1', 30]], 'PENDING_DECISION', 3, null);
    await makeNc('roll', 'item6', 'uom6', [['B1', 50], ['B2', 70]], 'PENDING_DECISION', 6, null);
    await makeNc('single', 'item6', 'uom6', [['G1', 10]], 'PENDING_DECISION', 1, null);
    // 거부 갈래 전용 — 판 번호가 절대 안 오르므로 여러 시험이 같은 부적합을 재사용한다.
    await makeNc('val', 'item6', 'uom6', [['V1', 60], ['V2', 60]], 'PENDING_DECISION', 1, null);
    await makeNc('trim', 'item6', 'uom6', [['T1', 10]], 'PENDING_DECISION', 1, null);
    await makeNc('perm', 'item6', 'uom6', [['W1', 10]], 'PENDING_DECISION', 1, null);
  }

  async function makeNc(
    key: string,
    itemKey: 'item6' | 'item2',
    uomKey: 'uom6' | 'uom2',
    lots: [string, number][],
    statusCode: string,
    versionNo: number,
    closedAt: Date | null,
  ): Promise<void> {
    const nc = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-${key}`,
        item_id: ids[itemKey],
        severity_code: 'MAJOR',
        description: `${PREFIX} ${key}`,
        status_code: statusCode,
        opened_at: new Date('2026-09-01T00:00:00.000Z'),
        closed_at: closedAt,
        version_no: versionNo,
      },
    });
    for (const [suffix, qty] of lots) {
      await prisma.nonconformance_lot.create({
        data: {
          nonconformance_id: nc.nonconformance_id,
          lot_id: lotIds[suffix],
          affected_qty: qty,
          uom_id: ids[uomKey],
          quality_status_before_code: 'DEFECTIVE',
          quality_status_after_code: 'DEFECTIVE',
        },
      });
    }
    ncIds[key] = Number(nc.nonconformance_id);
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

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '처분판정자', status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '처분판정용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: PERMISSION } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);

    const readOnly = await prisma.app_user.create({ data: { login_id: `${LOGIN_ID}-ro`, user_name: '처분조회전용', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: readOnly.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const readOnlyRole = await prisma.role.create({ data: { role_code: ROLE_NO_WRITE, role_name: '처분조회전용' } });
    await prisma.role_permission.create({ data: { role_id: readOnlyRole.role_id, permission_code: NO_WRITE_PERMISSION } });
    await prisma.user_role.create({ data: { app_user_id: readOnly.app_user_id, role_id: readOnlyRole.role_id } });
    noWriteCookie = await login(`${LOGIN_ID}-ro`);
  }

  /** FK 역순으로 지운다. `beforeAll`·`afterAll` 둘 다 부른다(자가 치유). */
  async function cleanup(): Promise<void> {
    const item = { item: { item_code: { startsWith: `${PREFIX}-IT` } } };
    await prisma.disposition_decision.deleteMany({ where: { nonconformance: item } });
    await prisma.nonconformance_lot.deleteMany({ where: { nonconformance: item } });
    await prisma.nonconformance.deleteMany({ where: item });
    await prisma.lot_status_event.deleteMany({ where: { lot: { lot_no: { startsWith: `${PREFIX}-LOT-` } } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: `${PREFIX}-LOT-` } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-IT` } } });
    await prisma.uom.deleteMany({ where: { uom_code: { startsWith: `${PREFIX}-U` } } });
    await prisma.plant.deleteMany({ where: { plant_code: `${PREFIX}-P` } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: `${PREFIX}-LE` } });

    for (const loginId of [LOGIN_ID, `${LOGIN_ID}-ro`]) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!user) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    for (const roleCode of [ROLE, ROLE_NO_WRITE]) {
      const role = await prisma.role.findUnique({ where: { role_code: roleCode } });
      if (!role) continue;
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
