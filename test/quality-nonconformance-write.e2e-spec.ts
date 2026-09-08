/**
 * 부적합 등록 · 처분 판정 의뢰 (e2e) — I-21 PR ⑥(심장 A).
 * `POST /quality/nonconformances` · `POST …/{nonconformanceId}:request-disposition` 둘뿐이다.
 *
 * ⭐⭐ **이 파일의 절반은 «갈래 순서»를 관측한다**(§3-4 — 「순서가 판정이다」). 한 요청이 두
 * 규칙을 «동시에» 어기게 픽스처를 짜야 순서가 보인다 — 한 규칙만 어기는 요청은 어느 순서로
 * 고쳐도 초록이라 되돌림에 안 깨진다(I-20 ④ `RORDER` 선례).
 *
 * ⭐ 픽스처는 LOT 을 «오퍼레이션마다 따로» 쓴다 — 등록이 성공하면 그 LOT 에 «열린» 부적합이
 * 생겨 뒤 시험이 409 를 받는다(테스트 순서 의존을 만들지 않는다).
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

const PREFIX = 'I21NW';
const LOGIN_ID = 'e2e-i21nw-probe';
const PASSWORD = 'PR-부적합등록-비밀번호';
// 쓰기 둘 다 `derived-permissions.ts:254·256` 이 `W-04-07` 하나를 요구한다(실측) —
// `manual-permissions.ts` 는 «안 건드린다»(그 파일은 PR ⑦ · `W-03-10` 몫이다).
const PERMISSION = 'W-04-07';
// ⛔ 권한이 «0개»인 계정으로 재면 「로그인은 됐는데 아무 권한도 없다」와 「이 기능만 없다」를
//    못 가른다 — 조회 전용 화면 권한 하나를 준다.
const NO_WRITE_PERMISSION = 'W-03-01';
const ROLE = 'E2E_I21_NC_WRITE';
const ROLE_NO_WRITE = 'E2E_I21_NC_WRITE_RO';

const NONCONFORMANCES = '/api/quality/nonconformances';

function validator(operation: string, status: number): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const createdSchema = validator('POST /quality/nonconformances', 201);
const requestedSchema = validator('POST /quality/nonconformances/{nonconformanceId}:request-disposition', 200);

describe('부적합 등록 · 처분 판정 의뢰 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noWriteCookie: string[];
  let userId = 0n;

  const ids: Record<string, bigint> = {};
  /** LOT 이름 → id. 등록이 성공하는 시험마다 «자기» LOT 을 쓴다. */
  const lotIds: Record<string, bigint> = {};
  /** 미리 심어 둔 부적합. 의뢰 갈래가 이 행들 위에 선다. */
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
    await makeNonconformanceFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const post = (url: string, asCookie: string[] = cookie) =>
    request(app.getHttpServer()).post(url).set('Cookie', asCookie).set('Idempotency-Key', randomUUID());

  /** 등록 본문 — 「고치고 싶은 칸만」 넘긴다. */
  function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      itemId: Number(ids.item1),
      severityCode: 'MAJOR',
      description: `${PREFIX} 도장 불량`,
      lots: [{ lotId: Number(lotIds.A), affectedQty: 12, uomId: Number(ids.uomA) }],
      ...overrides,
    };
  }

  function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { requestedQty: 10, uomId: Number(ids.uomA), remarks: `${PREFIX} 의뢰 비고`, ...overrides };
  }

  const requestUrl = (nonconformanceId: number) => `${NONCONFORMANCES}/${nonconformanceId}:request-disposition`;

  // ─────────────────────────────── 등록 — 본길 ───────────────────────────────

  it('⭐ 등록 — 201 · 채번 접두어 NC- · statusCode 는 서버가 NOT_REQUESTED 로 연다', async () => {
    const response = await post(NONCONFORMANCES).send(createBody()).expect(201);

    expect(response.body.nonconformanceNo).toMatch(/^NC-\d{8}-\d{4}$/);
    expect(response.body).toMatchObject({
      itemId: Number(ids.item1),
      severityCode: 'MAJOR',
      description: `${PREFIX} 도장 불량`,
      statusCode: 'NOT_REQUESTED',
      sourceCode: 'PRODUCT',
      affectedQtyTotal: 12,
      uomId: Number(ids.uomA),
      dispositionProgressCode: 'NOT_STARTED',
      closedAt: null,
    });
    // ⛔ `versionNo` 는 본문에 안 싣는다(공유계약 A-4) · ETag 도 201 에 안 낸다(계약 미선언).
    expect(response.body).not.toHaveProperty('versionNo');
    expect(createdSchema(response.body)).toBe(true);

    const row = await prisma.nonconformance.findUniqueOrThrow({
      where: { nonconformance_id: BigInt(response.body.nonconformanceId) },
    });
    expect(row.status_code).toBe('NOT_REQUESTED');
    expect(row.version_no).toBe(1);
    expect(row.closed_at).toBeNull();
    // 서버 수신 시각이다 — 본문에 그 칸이 없다(B-6).
    expect(row.opened_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('⭐⭐ 등록 — 다중 LOT: 합은 Decimal 산술이고, before/after 는 «LOT 자신의» 상태다', async () => {
    // ⭐ 0.1 + 0.2 는 실제 부동소수 함정이다(node 실측: 0.1+0.2 === 0.3 → false).
    //   `Number()` 로 접어 더하면 0.30000000000000004 가 나와 이 단언이 깨진다.
    // ⭐ 두 LOT 의 `status_code` 가 «다르다»(NORMAL ↔ INSPECTION_PENDING) — 전건을 첫 LOT
    //   상태로 채우는 변이(`lots[0].status_code` 재사용)를 여기서 잡는다.
    const response = await post(NONCONFORMANCES)
      .send(
        createBody({
          description: `${PREFIX} 다중 LOT`,
          lots: [
            { lotId: Number(lotIds.B), affectedQty: 0.1, uomId: Number(ids.uomA) },
            { lotId: Number(lotIds.C), affectedQty: 0.2, uomId: Number(ids.uomA) },
          ],
        }),
      )
      .expect(201);

    expect(response.body.affectedQtyTotal).toBe(0.3);
    expect(response.body.lots).toHaveLength(2);
    expect(response.body.lots[0]).toMatchObject({
      lotId: Number(lotIds.B),
      affectedQty: 0.1,
      qualityStatusBeforeCode: 'NORMAL',
      qualityStatusAfterCode: 'NORMAL',
    });
    expect(response.body.lots[1]).toMatchObject({
      lotId: Number(lotIds.C),
      affectedQty: 0.2,
      qualityStatusBeforeCode: 'INSPECTION_PENDING',
      qualityStatusAfterCode: 'INSPECTION_PENDING',
    });
    expect(createdSchema(response.body)).toBe(true);
  });

  it('⭐ 등록 — LOT 을 «안» 옮긴다: 상태·판 번호 그대로이고 `lot_status_event` 가 0행이다', async () => {
    const before = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotIds.MOVE } });
    await post(NONCONFORMANCES)
      .send(createBody({ description: `${PREFIX} 전이 없음`, lots: [{ lotId: Number(lotIds.MOVE), affectedQty: 3, uomId: Number(ids.uomA) }] }))
      .expect(201);

    const after = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotIds.MOVE } });
    expect(after.status_code).toBe(before.status_code);
    expect(after.version_no).toBe(before.version_no);
    expect(await prisma.lot_status_event.count({ where: { lot_id: lotIds.MOVE } })).toBe(0);
  });

  it('⭐ 등록 — `sourceCode` 는 대상 LOT 의 입고 «유형»으로 파생한다(RETURN)', async () => {
    const response = await post(NONCONFORMANCES)
      .send(createBody({ description: `${PREFIX} 반품 부적합`, lots: [{ lotId: Number(lotIds.RET), affectedQty: 7, uomId: Number(ids.uomA) }] }))
      .expect(201);

    expect(response.body.sourceCode).toBe('RETURN');
  });

  it('⭐ 등록 — 선택 FK: 값이 있으면 그대로 싣고, `null` 은 «키를 생략»한다(R-13 널 정책)', async () => {
    const response = await post(NONCONFORMANCES)
      .send(
        createBody({
          description: `${PREFIX} 선택 칸`,
          responsibleDepartmentId: Number(ids.department),
          workOrderId: null,
          inspectionResultId: null,
          lots: [{ lotId: Number(lotIds.OPT), affectedQty: 4, uomId: Number(ids.uomA) }],
        }),
      )
      .expect(201);

    expect(response.body.responsibleDepartmentId).toBe(Number(ids.department));
    // 계약이 널을 못 받는 칸(7개)은 키를 생략한다 — 널로 실으면 ajv 가 막는다.
    expect(response.body).not.toHaveProperty('workOrderId');
    // `inspectionResultId` 는 계약이 널을 «허용한» 둘 중 하나다 — 명시로 null 을 싣는다.
    expect(response.body.inspectionResultId).toBeNull();
    expect(createdSchema(response.body)).toBe(true);
  });

  it('⭐ 등록 — 같은 Idempotency-Key 재전송이 행을 늘리지 않고 같은 본문을 준다', async () => {
    const key = randomUUID();
    const body = createBody({ description: `${PREFIX} 멱등`, lots: [{ lotId: Number(lotIds.IDEM), affectedQty: 9, uomId: Number(ids.uomA) }] });
    const send = () => request(app.getHttpServer()).post(NONCONFORMANCES).set('Cookie', cookie).set('Idempotency-Key', key).send(body);

    const first = await send().expect(201);
    const replay = await send().expect(201);

    expect(replay.body.nonconformanceId).toBe(first.body.nonconformanceId);
    expect(await prisma.nonconformance_lot.count({ where: { lot_id: lotIds.IDEM } })).toBe(1);
  });

  it('⭐ 등록 — 종결된 부적합만 있는 LOT 은 «다시» 등록된다(판정은 closed_at IS NULL 로만 한다)', async () => {
    await post(NONCONFORMANCES)
      .send(createBody({ description: `${PREFIX} 재등록`, lots: [{ lotId: Number(lotIds.CLOSED), affectedQty: 6, uomId: Number(ids.uomA) }] }))
      .expect(201);
  });

  // ─────────────────────── 등록 — 400·409 갈래와 «순서» ───────────────────────

  it('⭐⭐ 순서 — 계약 검증 가드가 서비스보다 «앞»이다(`lots: []` + 시드 밖 severityCode → lots RANGE)', async () => {
    const response = await post(NONCONFORMANCES).send(createBody({ lots: [], severityCode: 'NOPE_XYZ' })).expect(400);

    // 서비스가 먼저 돌았다면 `severityCode` INVALID 가 났을 자리다(§3-4 순서 1).
    expect(response.body.errors).toContainEqual(expect.objectContaining({ field: 'lots', code: 'RANGE' }));
    expect(response.body.errors).not.toContainEqual(expect.objectContaining({ field: 'severityCode' }));
  });

  it('⭐⭐ 순서 — 코드값 대조가 참조 존재보다 앞이다(밖 severityCode + 없는 itemId → severityCode INVALID)', async () => {
    const response = await post(NONCONFORMANCES).send(createBody({ severityCode: 'NOPE_XYZ', itemId: 999999999 })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'severityCode', code: 'INVALID' });
  });

  it('⭐⭐ 순서 — 같은 LOT 두 번이 수량 검사보다 앞이다(중복 + affectedQty 0 → lots[1].lotId INVALID)', async () => {
    const response = await post(NONCONFORMANCES)
      .send(
        createBody({
          lots: [
            { lotId: Number(lotIds.VAL), affectedQty: 5, uomId: Number(ids.uomA) },
            { lotId: Number(lotIds.VAL), affectedQty: 0, uomId: Number(ids.uomA) },
          ],
        }),
      )
      .expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'lots[1].lotId', code: 'INVALID' });
  });

  it('⭐⭐ 순서 — 단위 일치가 내용 공백 검사보다 앞이다(단위 혼합 + 공백만 → lots INVALID)', async () => {
    const response = await post(NONCONFORMANCES)
      .send(
        createBody({
          description: '   ',
          lots: [
            { lotId: Number(lotIds.VAL), affectedQty: 5, uomId: Number(ids.uomA) },
            { lotId: Number(lotIds.VAL2), affectedQty: 5, uomId: Number(ids.uomB) },
          ],
        }),
      )
      .expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'lots', code: 'INVALID' });
  });

  it('⭐⭐ 순서 — 참조 존재(400)가 열린 부적합(409)보다 앞이다', async () => {
    await post(NONCONFORMANCES)
      .send(createBody({ itemId: 999999999, lots: [{ lotId: Number(lotIds.OPEN), affectedQty: 5, uomId: Number(ids.uomA) }] }))
      .expect(400);
  });

  it('⭐ 등록 — affectedQty = 0 은 400 RANGE 다(⛔ CHECK 위반 500 이 아니다)', async () => {
    const response = await post(NONCONFORMANCES)
      .send(createBody({ lots: [{ lotId: Number(lotIds.VAL), affectedQty: 0, uomId: Number(ids.uomA) }] }))
      .expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'lots[0].affectedQty', code: 'RANGE' });
  });

  it('⭐ 등록 — 소수 7자리 수량은 400 RANGE 다(numeric(20,6) 반올림이 0 을 만들어 CHECK 를 깬다)', async () => {
    const response = await post(NONCONFORMANCES)
      .send(createBody({ lots: [{ lotId: Number(lotIds.VAL), affectedQty: 0.0000001, uomId: Number(ids.uomA) }] }))
      .expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'lots[0].affectedQty', code: 'RANGE' });
  });

  it('⭐⭐ 등록 — 「공백만」은 REQUIRED 이고 「빈 문자열」은 RANGE 다(두 갈래의 코드가 다르다)', async () => {
    const blank = await post(NONCONFORMANCES).send(createBody({ description: '   ' })).expect(400);
    const empty = await post(NONCONFORMANCES).send(createBody({ description: '' })).expect(400);

    // `minLength:1` 이 `" "` 를 통과시킨다 — 서비스가 REQUIRED 로 막는다(A-12).
    expect(blank.body.errors[0]).toMatchObject({ field: 'description', code: 'REQUIRED' });
    // `""` 은 가드가 `minLength` 로 막아 RANGE 다 — 한 줄로 묶으면 여기가 깨진다.
    expect(empty.body.errors[0]).toMatchObject({ field: 'description', code: 'RANGE' });
  });

  it('⭐ 등록 — 없는 참조는 «전부» 400 INVALID 이고 어느 칸인지 짚는다(⛔ 404 미선언)', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['itemId', { itemId: 999999999 }],
      ['lots[0].lotId', { lots: [{ lotId: 999999999, affectedQty: 5, uomId: Number(ids.uomA) }] }],
      ['lots[0].uomId', { lots: [{ lotId: Number(lotIds.VAL), affectedQty: 5, uomId: 999999999 }] }],
      ['workOrderId', { workOrderId: 999999999 }],
      ['inspectionResultId', { inspectionResultId: 999999999 }],
      ['responsibleDepartmentId', { responsibleDepartmentId: 999999999 }],
    ];
    for (const [field, overrides] of cases) {
      const response = await post(NONCONFORMANCES).send(createBody(overrides)).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field, code: 'INVALID' });
    }
  });

  it('⭐ 등록 — 같은 LOT 에 «열린» 부적합이 있으면 409 DUPLICATE_KEY 이고 봉투에 code 가 실린다', async () => {
    const response = await post(NONCONFORMANCES)
      .send(createBody({ lots: [{ lotId: Number(lotIds.OPEN), affectedQty: 5, uomId: Number(ids.uomA) }] }))
      .expect(409);

    // `ShipmentConflictResponse` 는 `code` 가 required 다 — 없으면 봉투를 어긴다(통보 077).
    expect(response.body).toMatchObject({ code: 'DUPLICATE_KEY', conflictCause: 'user' });
    expect(typeof response.body.message).toBe('string');
  });

  it('⭐ 등록 — 권한 없는 계정은 403 (↩ 게이트를 빼면 201 이 된다)', async () => {
    await post(NONCONFORMANCES, noWriteCookie)
      .send(createBody({ lots: [{ lotId: Number(lotIds.VAL2), affectedQty: 5, uomId: Number(ids.uomA) }] }))
      .expect(403);
  });

  it('⭐⭐ 등록 — 롤백: `nonconformance_lot` 이 실패하면 헤더도 «안 남는다»(한 트랜잭션 · B-8)', async () => {
    // `app.qty_t` 는 numeric(20,6) — 정수 자리가 14 를 넘으면 DB 가 거절한다. 검증을
    // 전부 통과한 뒤 «두 번째» INSERT 에서 터지는 유일한 값이라 앞 단계의 롤백을 관측한다.
    const description = `${PREFIX} 롤백 관측`;
    await post(NONCONFORMANCES)
      .send(createBody({ description, lots: [{ lotId: Number(lotIds.ROLL), affectedQty: 1e15, uomId: Number(ids.uomA) }] }))
      .expect(500);

    // ⛔ 헤더를 따로 커밋하면 여기가 1 이 된다(그 순간 「대상 LOT 이 없는 부적합」이 남는다).
    expect(await prisma.nonconformance.count({ where: { description } })).toBe(0);
    expect(await prisma.nonconformance_lot.count({ where: { lot_id: lotIds.ROLL } })).toBe(0);
    // 멱등 기록도 함께 되돌아간다 — 같은 키가 「처리 중」으로 굳으면 재시도가 영영 막힌다.
    expect(await prisma.idempotency_record.count({ where: { app_user_id: userId, status: 'IN_PROGRESS' } })).toBe(0);
  });

  // ─────────────────────────────── 의뢰 — 본길 ───────────────────────────────

  it('⭐ 의뢰 — 200 · NOT_REQUESTED → PENDING_DECISION · 판 번호 +1 · ETag 가 새 값이다', async () => {
    const response = await post(requestUrl(ncIds.main)).set('If-Match', '4').send(requestBody()).expect(200);

    expect(response.body).toMatchObject({ nonconformanceId: ncIds.main, statusCode: 'PENDING_DECISION' });
    expect(response.headers.etag).toBe('5');
    expect(response.body).not.toHaveProperty('versionNo');
    expect(requestedSchema(response.body)).toBe(true);

    const row = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.main) } });
    expect(row).toMatchObject({ status_code: 'PENDING_DECISION', version_no: 5 });
  });

  it('⭐⭐ 의뢰 — 본문 3칸은 «어디에도» 저장되지 않는다(담을 데가 0 · §1-3)', async () => {
    const id = BigInt(ncIds.discard);
    const before = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: id } });
    const lotsBefore = await prisma.nonconformance_lot.findMany({ where: { nonconformance_id: id }, orderBy: { nonconformance_lot_id: 'asc' } });

    // 대상 수량(30)과 «다른» 의뢰 수량·비고를 보낸다 — 어딘가에 흘러 들어가면 값이 갈린다.
    await post(requestUrl(ncIds.discard)).set('If-Match', String(before.version_no)).send(requestBody({ requestedQty: 17, remarks: `${PREFIX} 흘러들면 안 되는 값` })).expect(200);

    const after = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: id } });
    const lotsAfter = await prisma.nonconformance_lot.findMany({ where: { nonconformance_id: id }, orderBy: { nonconformance_lot_id: 'asc' } });

    // 바뀌어도 되는 칸은 넷뿐이다 — 나머지를 통째로 대조한다.
    expect({ ...after, status_code: '', version_no: 0, updated_at: null, updated_by: null }).toEqual({
      ...before,
      status_code: '',
      version_no: 0,
      updated_at: null,
      updated_by: null,
    });
    expect(lotsAfter).toEqual(lotsBefore);
    expect(after.status_code).toBe('PENDING_DECISION');
    expect(after.version_no).toBe(before.version_no + 1);
  });

  it('⭐ 의뢰 — 같은 Idempotency-Key 재전송이 판 번호를 두 번 올리지 않는다', async () => {
    const key = randomUUID();
    const send = () =>
      request(app.getHttpServer())
        .post(requestUrl(ncIds.idem))
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .set('If-Match', '1')
        .send(requestBody());

    await send().expect(200);
    await send().expect(200);

    const row = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.idem) } });
    expect(row.version_no).toBe(2);
  });

  it('⭐ 의뢰 — requestedQty 의 「한계와 같은 값」(=1)은 통과다(`>=` 이지 `>` 가 아니다)', async () => {
    await post(requestUrl(ncIds.boundary)).set('If-Match', '1').send(requestBody({ requestedQty: 1 })).expect(200);
  });

  // ─────────────────────── 의뢰 — 400·404·409 갈래와 «순서» ───────────────────────

  it('⭐⭐ 순서 — 존재 확인(404)이 본문 형식(400)보다 앞이다(없는 id + requestedQty 0 → 404)', async () => {
    const response = await post(requestUrl(999999999)).set('If-Match', '1').send(requestBody({ requestedQty: 0 })).expect(404);

    expect(response.body).toHaveProperty('errors');
  });

  it('⭐⭐ 순서 — 본문 형식(400)이 업무 상태(409)보다 앞이다(이미 의뢰됨 + requestedQty 0 → 400 RANGE)', async () => {
    const response = await post(requestUrl(ncIds.pending)).set('If-Match', '2').send(requestBody({ requestedQty: 0 })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'requestedQty', code: 'RANGE' });
  });

  it('⭐⭐ 순서 — 업무 상태(409 INVALID_STATE)가 판 번호 대조(409 VERSION_CONFLICT)보다 앞이다', async () => {
    const response = await post(requestUrl(ncIds.pending)).set('If-Match', '999').send(requestBody()).expect(409);

    expect(response.body.code).toBe('INVALID_STATE');
  });

  it('⭐ 의뢰 — requestedQty < 1 은 400 RANGE(계약에 minimum 이 없어 가드가 안 막는다)', async () => {
    const response = await post(requestUrl(ncIds.val)).set('If-Match', '3').send(requestBody({ requestedQty: 0.5 })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'requestedQty', code: 'RANGE' });
  });

  it('⭐ 의뢰 — uomId 가 부적합의 단위와 다르면 400 INVALID', async () => {
    const response = await post(requestUrl(ncIds.val)).set('If-Match', '3').send(requestBody({ uomId: Number(ids.uomB) })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'uomId', code: 'INVALID' });
  });

  it('⭐ 의뢰 — 이미 PENDING_DECISION 이면 409 INVALID_STATE 다(⛔ 400 이 아니다)', async () => {
    const response = await post(requestUrl(ncIds.pending)).set('If-Match', '2').send(requestBody()).expect(409);

    expect(response.body).toMatchObject({ code: 'INVALID_STATE', conflictCause: 'user' });
  });

  it('⭐ 의뢰 — 이미 DECIDED 여도 409 INVALID_STATE 다(전이표의 from 이 NOT_REQUESTED 하나다)', async () => {
    const response = await post(requestUrl(ncIds.decided)).set('If-Match', '5').send(requestBody()).expect(409);

    expect(response.body.code).toBe('INVALID_STATE');
  });

  it('⭐ 의뢰 — If-Match 가 어긋나면 409 VERSION_CONFLICT + currentVersion(⛔ 판이 안 오른다)', async () => {
    const response = await post(requestUrl(ncIds.val)).set('If-Match', '99').send(requestBody()).expect(409);

    expect(response.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: '3', conflictCause: 'user' });
    const row = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(ncIds.val) } });
    expect(row).toMatchObject({ status_code: 'NOT_REQUESTED', version_no: 3 });
  });

  it('⭐ 의뢰 — If-Match 를 안 보내면 400 REQUIRED(가드 · 계약이 «필수»로 선언했다)', async () => {
    const response = await post(requestUrl(ncIds.val)).send(requestBody()).expect(400);

    expect(response.body.errors[0]).toMatchObject({ code: 'REQUIRED' });
  });

  it('⭐ 의뢰 — 권한 없는 계정은 403 (↩ 게이트를 빼면 200 이 된다)', async () => {
    await post(requestUrl(ncIds.val), noWriteCookie).set('If-Match', '3').send(requestBody()).expect(403);
  });

  // ─────────────────────────────── 픽스처 ───────────────────────────────

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: `${PREFIX} 법인`, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: `${PREFIX} 사업부` },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: `${PREFIX} 공장`, timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.plant = plant.plant_id;

    // ⭐ 단위가 «둘»이어야 「단위 혼합 400」도 「의뢰 단위 불일치 400」도 그물에 걸린다.
    const uomA = await prisma.uom.findFirstOrThrow();
    ids.uomA = uomA.uom_id;
    const uomB = await prisma.uom.create({ data: { uom_code: `${PREFIX}-UOM2`, uom_name: `${PREFIX} 보조단위` } });
    ids.uomB = uomB.uom_id;

    const item1 = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT1`, item_name: `${PREFIX} 품목1`, item_type_code: 'FINISHED_GOODS', base_uom_id: uomA.uom_id, lot_controlled: true },
    });
    ids.item1 = item1.item_id;
    const department = await prisma.department.create({ data: { department_code: `${PREFIX}-DEPT`, department_name: `${PREFIX} 품질부서` } });
    ids.department = department.department_id;

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: `${PREFIX} 창고`,
        warehouse_type_code: 'FINISHED',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: { warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: `${PREFIX} 위치`, location_type_code: 'BIN' },
    });

    // ⭐ 상태가 서로 «다른» LOT 들 — `nonconformance_lot` 의 before/after 출처를 잠근다.
    const plan: [string, string][] = [
      ['A', 'DEFECTIVE'],
      ['B', 'NORMAL'],
      ['C', 'INSPECTION_PENDING'],
      ['MOVE', 'DEFECTIVE'],
      ['RET', 'NORMAL'],
      ['OPT', 'NORMAL'],
      ['IDEM', 'DEFECTIVE'],
      ['CLOSED', 'NORMAL'],
      ['OPEN', 'DEFECTIVE'],
      ['ROLL', 'DEFECTIVE'],
      ['VAL', 'DEFECTIVE'],
      ['VAL2', 'NORMAL'],
      ['R1', 'DEFECTIVE'],
      ['R2', 'DEFECTIVE'],
      ['R3', 'DEFECTIVE'],
      ['R4', 'DEFECTIVE'],
      ['R5', 'DEFECTIVE'],
      ['R6', 'DEFECTIVE'],
      ['R7', 'DEFECTIVE'],
    ];
    for (const [suffix, statusCode] of plan) {
      const lot = await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT-${suffix}`,
          item_id: item1.item_id,
          lot_type_code: 'PRODUCT',
          plant_id: plant.plant_id,
          initial_qty: 100,
          uom_id: uomA.uom_id,
          source_type_code: 'INBOUND_RECEIPT_LINE',
          source_id: 1,
          status_code: statusCode,
        },
      });
      lotIds[suffix] = lot.lot_id;
    }

    // ⭐ `sourceCode` 파생 축은 「입고 이력의 유무」가 아니라 `receipt_type_code='RETURN'` 이다 —
    //   반품이 «아닌» 입고를 붙인 LOT(A)이 함께 있어야 그 조건이 그물 안에 든다.
    for (const [suffix, receiptType] of [['RET', 'RETURN'], ['A', 'MATERIAL']] as const) {
      const receipt = await prisma.goods_receipt.create({
        data: {
          goods_receipt_no: `${PREFIX}-GR-${suffix}`,
          receipt_type_code: receiptType,
          plant_id: plant.plant_id,
          warehouse_id: warehouse.warehouse_id,
          receipt_datetime: new Date('2026-09-01T00:00:00.000Z'),
          status_code: 'REGISTERED',
        },
      });
      await prisma.goods_receipt_line.create({
        data: {
          goods_receipt_id: receipt.goods_receipt_id,
          line_no: 1,
          item_id: item1.item_id,
          lot_id: lotIds[suffix],
          receipt_qty: 20,
          uom_id: uomA.uom_id,
          quality_status_code: 'DEFECTIVE',
          inventory_status_code: 'AVAILABLE',
          destination_location_id: location.location_id,
        },
      });
    }
  }

  /** 미리 심는 부적합 — 「열린/종결된」 판정과 의뢰 갈래 전건이 이 위에 선다. */
  async function makeNonconformanceFixtures(): Promise<void> {
    // 409 DUPLICATE_KEY 의 원천 — `closed_at IS NULL`.
    await makeNonconformance('open', 'OPEN', 'PENDING_DECISION', 1, null);
    // 「종결된 것만 있으면 다시 등록된다」의 원천 — `closed_at` 이 있다.
    await makeNonconformance('closed', 'CLOSED', 'DECIDED', 1, new Date('2026-09-02T00:00:00.000Z'));

    // 의뢰 — 성공 갈래. 판 번호를 기본값 1 이 «아닌» 값으로 벌려 ETag·If-Match 가 상수로
    // 새는 변이를 잡는다(main 은 4 → 5).
    await makeNonconformance('main', 'R1', 'NOT_REQUESTED', 4, null);
    await makeNonconformance('discard', 'R2', 'NOT_REQUESTED', 2, null);
    await makeNonconformance('idem', 'R3', 'NOT_REQUESTED', 1, null);
    await makeNonconformance('boundary', 'R4', 'NOT_REQUESTED', 1, null);
    // 의뢰 — 거부 갈래(행이 안 바뀐다).
    await makeNonconformance('pending', 'R5', 'PENDING_DECISION', 2, null);
    await makeNonconformance('decided', 'R6', 'DECIDED', 5, new Date('2026-09-02T00:00:00.000Z'));
    await makeNonconformance('val', 'R7', 'NOT_REQUESTED', 3, null);
  }

  async function makeNonconformance(key: string, lotSuffix: string, statusCode: string, versionNo: number, closedAt: Date | null): Promise<void> {
    const nc = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-${key}`,
        item_id: ids.item1,
        severity_code: 'MINOR',
        description: `${PREFIX} 미리 심은 ${key}`,
        status_code: statusCode,
        opened_at: new Date('2026-09-01T00:00:00.000Z'),
        closed_at: closedAt,
        version_no: versionNo,
      },
    });
    await prisma.nonconformance_lot.create({
      data: {
        nonconformance_id: nc.nonconformance_id,
        lot_id: lotIds[lotSuffix],
        affected_qty: 30,
        uom_id: ids.uomA,
        quality_status_before_code: 'DEFECTIVE',
        quality_status_after_code: 'DEFECTIVE',
      },
    });
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
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '부적합등록', status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '부적합등록용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: PERMISSION } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);

    const readOnly = await prisma.app_user.create({ data: { login_id: `${LOGIN_ID}-ro`, user_name: '부적합조회전용', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: readOnly.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const readOnlyRole = await prisma.role.create({ data: { role_code: ROLE_NO_WRITE, role_name: '부적합조회전용' } });
    await prisma.role_permission.create({ data: { role_id: readOnlyRole.role_id, permission_code: NO_WRITE_PERMISSION } });
    await prisma.user_role.create({ data: { app_user_id: readOnly.app_user_id, role_id: readOnlyRole.role_id } });
    noWriteCookie = await login(`${LOGIN_ID}-ro`);
  }

  /** FK 역순으로 지운다. `beforeAll`·`afterAll` 둘 다 부른다(자가 치유). */
  async function cleanup(): Promise<void> {
    const item = { item: { item_code: { startsWith: `${PREFIX}-IT` } } };
    await prisma.nonconformance_lot.deleteMany({ where: { nonconformance: item } });
    await prisma.nonconformance.deleteMany({ where: item });
    await prisma.lot_status_event.deleteMany({ where: { lot: { lot_no: { startsWith: `${PREFIX}-LOT-` } } } });
    await prisma.goods_receipt_line.deleteMany({ where: { goods_receipt: { goods_receipt_no: { startsWith: `${PREFIX}-GR` } } } });
    await prisma.goods_receipt.deleteMany({ where: { goods_receipt_no: { startsWith: `${PREFIX}-GR` } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: `${PREFIX}-LOT-` } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: `${PREFIX}-LOC` } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: `${PREFIX}-WH` } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-IT` } } });
    await prisma.uom.deleteMany({ where: { uom_code: `${PREFIX}-UOM2` } });
    await prisma.department.deleteMany({ where: { department_code: `${PREFIX}-DEPT` } });
    await prisma.plant.deleteMany({ where: { plant_code: `${PREFIX}-P` } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: `${PREFIX}-BU` } });
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
