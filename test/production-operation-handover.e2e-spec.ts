/**
 * 공정 인계 3건 — 조회 2건(I-25 PR ①) + 확정 등록 1건(PR ②).
 *
 * ⭐ 조회가 보는 인계는 **직접 INSERT** 한다(PR ① 픽스처). 등록이 만드는 인계는 **실제 쓰기**로
 *    만들고 «조회로» 되읽는다 — PR ① 이 남긴 숙제(Minor-3)가 그 자리다: `received_at` 을 채운
 *    행이 0 이라 「헤더 8칸」 경로가 안 돌았다. ⛔ 그 행을 픽스처로 위조하지 않는다.
 * ⭐ 등록은 **별도 W/O 쌍**(woC→woD)을 쓴다 — 조회 픽스처(woA·woB)에 섞이면 PR ① 의 배열
 *    단언이 실행 순서에 매인다.
 * ⭐ 응답은 키 집합이 아니라 **`toEqual` 로 값까지** 못박는다 — 계약이 int64 로만 선언해
 *    「어느 물리 칸에서 왔나」를 ajv 가 못 본다(§7-1 ⓑ · PR ① 리뷰).
 * ⛔ `TRUNCATE` 를 쓰지 않는다 — 원장 행을 한 건도 만들지 않는다(I-25 §4-1 ⛔ 없는 것).
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

const LOGIN_ID = 'e2e-oh-probe';
const PASSWORD = 'OH-공정인계-비밀번호';
const PREFIX = 'OHE2E';
const HANDOVERS = '/api/production/operation-handovers';
const T1 = '2026-09-08T01:00:00.000Z';
const T2 = '2026-09-08T03:00:00.000Z';
/** `statusCode` 는 `x-no-code-key` 다 — 서버가 대조하지 않는 자유 문자다(§1-5). */
const STATUS_MAIN = 'HANDED_OVER';
const STATUS_OTHER = 'CUSTOM_STATUS';
/** 등록 전용 — 조회 픽스처의 두 시각(T1·T2)과 «다른» 날짜다(채번 기간 키가 이 날짜다). */
const HANDED_OVER_AT = '2026-09-09T04:05:06.000Z';
/** `mdm.worker` 에 실재해야 한다 — 없는 사번은 400 `INVALID` 갈래다(§4-1 ①). */
const WORKER_NO = `${PREFIX}-W1`;

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

describe('공정 인계 3건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let woAId: number;
  let woBId: number;
  /** 등록 전용 — woC 는 기본 WIP 위치가 locA · woD 는 locB · woE 는 **NULL**(400 갈래). */
  let woCId: number;
  let woDId: number;
  let woEId: number;
  let lotAId: number;
  let lotBId: number;
  let uomId: number;
  let locAId: number;
  let locBId: number;
  /** ho1·ho2 동률(T1) · ho3 다른 시각(T2) · ho4 반대 방향(from↔to) · ho5 다른 statusCode. */
  let ho1Id: number;
  let ho2Id: number;
  let ho3Id: number;
  let ho4Id: number;
  let ho5Id: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    // 자가 치유 — 앞 회차가 죽어 남긴 행을 먼저 지운다.
    await cleanup();
    await makeFixtures();
    cookie = await login(LOGIN_ID, null, []);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록 200 + 응답 키 집합(헤더 7칸 · receivedAt 은 전 행 NULL 이라 빠진다 · 라인 4칸)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&statusCode=${STATUS_MAIN}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(validator('GET /production/operation-handovers')(response.body)).toBe(true);
    const [item] = response.body.items;
    // `version_no`·감사 4칸(created_at·created_by·updated_at·updated_by)이 새면 ajv 는 못 잡는다
    // (additionalProperties 미선언) — 통째 단언이 유일한 그물이다.
    expect(Object.keys(item).sort()).toEqual([
      'fromWorkOrderId',
      'handedOverAt',
      'handoverNo',
      'lines',
      'operationHandoverId',
      'statusCode',
      'toWorkOrderId',
    ]);
    // `line_no`·`receivedQty`·위치 두 칸이 새면 마찬가지로 ajv 가 못 잡는다.
    expect(Object.keys(item.lines[0]).sort()).toEqual([
      'handoverQty',
      'lotId',
      'operationHandoverLineId',
      'uomId',
    ]);
  });

  it('⭐ 정렬 — handed_over_at desc + operation_handover_id desc(동률 두 행 포함 배열 통째)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&statusCode=${STATUS_MAIN}`)
      .set('Cookie', cookie)
      .expect(200);

    // ho3(T2) 가 먼저, T1 동률(ho1·ho2)은 PK desc 로 ho2 가 ho1 보다 앞선다.
    expect(response.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId)).toEqual([
      ho3Id,
      ho2Id,
      ho1Id,
    ]);
  });

  it('⭐ fromWorkOrderId·toWorkOrderId 필터가 방향을 가른다(반대 방향 행이 안 섞인다)', async () => {
    const fromA = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}`)
      .set('Cookie', cookie)
      .expect(200);
    const fromIds = fromA.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId);
    expect(fromIds).toEqual(expect.arrayContaining([ho1Id, ho2Id, ho3Id, ho5Id]));
    // ho4 는 from=woB·to=woA 다 — fromWorkOrderId=woA 로는 안 잡힌다.
    expect(fromIds).not.toContain(ho4Id);

    const toA = await request(app.getHttpServer())
      .get(`${HANDOVERS}?toWorkOrderId=${woAId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(toA.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId)).toEqual([
      ho4Id,
    ]);
  });

  it('⭐ statusCode 필터 — 문자 그대로 건다(x-no-code-key)', async () => {
    const other = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&statusCode=${STATUS_OTHER}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(other.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId)).toEqual([
      ho5Id,
    ]);

    // 필터를 지우면 ho5(다른 status)가 섞인다 — 이 행이 없으면 상수 하나뿐이라 필터 제거가 초록이 된다.
    const unfiltered = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(unfiltered.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId)).toEqual(
      expect.arrayContaining([ho5Id]),
    );
  });

  it('목록이 handedOverFrom 이상 handedOverTo 미만 반개구간으로 걸러진다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&handedOverFrom=${T1}&handedOverTo=${T2}`)
      .set('Cookie', cookie)
      .expect(200);

    // gte T1 — T1 행(ho1·ho2·ho5)은 포함. lt T2 — T2 정각의 ho3 는 제외(반개구간 · L-3).
    const ids = response.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId);
    expect(new Set(ids)).toEqual(new Set([ho1Id, ho2Id, ho5Id]));
    expect(ids).not.toContain(ho3Id);
  });

  it('page=2&size=1 — items 1건 + page.total 이 필터 기준. 상한 없는 size 는 200 으로 잘린다', async () => {
    // fromWorkOrderId=woA 전체 4건: 정렬 [ho3, ho5, ho2, ho1](T2 먼저 · T1 동률은 PK desc).
    const page1 = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&page=1&size=1`)
      .set('Cookie', cookie)
      .expect(200);
    expect(page1.body.page).toMatchObject({ page: 1, size: 1, total: 4 });
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.items[0].operationHandoverId).toBe(ho3Id);

    const page2 = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&page=2&size=1`)
      .set('Cookie', cookie)
      .expect(200);
    expect(page2.body.page).toMatchObject({ page: 2, size: 1, total: 4 });
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].operationHandoverId).toBe(ho5Id);

    // 계약이 이 목록에 상한을 선언하지 않았다 — 가드는 통과시키고 `pageRequest` 가 자른다(§1-2).
    const uncapped = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&size=1000`)
      .set('Cookie', cookie)
      .expect(200);
    expect(uncapped.body.page.size).toBe(200);
    expect(uncapped.body.items.length).toBeLessThanOrEqual(200);
  });

  it('상세 200 · 라인이 line_no 오름차순 · 없는 id 는 404', async () => {
    const response = await request(app.getHttpServer())
      .get(`${HANDOVERS}/${ho3Id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(validator('GET /production/operation-handovers/{operationHandoverId}')(response.body)).toBe(true);
    // ho3 는 line_no 2 를 «먼저» 심었다 — 저장 순서가 아니라 line_no 로 정렬한다.
    expect(response.body.lines.map((line: { lotId: number }) => line.lotId)).toEqual([lotAId, lotBId]);
    expect(response.body).toMatchObject({ operationHandoverId: ho3Id, fromWorkOrderId: woAId, toWorkOrderId: woBId });

    await request(app.getHttpServer()).get(`${HANDOVERS}/999999999`).set('Cookie', cookie).expect(404);
  });

  /**
   * `POST /production/operation-handovers` — I-25 PR ②. 계약이 이 하나에만 403 을 선언하므로
   * 조회 전용 `cookie` 대신 이 describe 전용 세션 둘을 쓴다(① 의 `login()` 을 고치지 않는다).
   */
  describe('POST /production/operation-handovers', () => {
    const POST_LOGIN_ID = 'e2e-oh-post';
    const POST_ROLE = 'E2E_OH_POST';
    const NO_PERM_LOGIN_ID = 'e2e-oh-post-np';
    const NO_PERM_ROLE = 'E2E_OH_POST_NP';

    let postCookie: string[];
    let noPermCookie: string[];
    let created: request.Response;

    interface PostOptions {
      key?: string;
      cookie?: string[];
      workerNo?: string | null;
      ifMatch?: string;
    }

    function post(payload: object, options: PostOptions = {}) {
      const call = request(app.getHttpServer())
        .post(HANDOVERS)
        .set('Cookie', options.cookie ?? postCookie)
        .set('Idempotency-Key', options.key ?? randomUUID());
      if (options.workerNo !== null) call.set('X-Worker-No', options.workerNo ?? WORKER_NO);
      if (options.ifMatch !== undefined) call.set('If-Match', options.ifMatch);
      return call.send(payload);
    }

    /** 수량을 **소수**로 둔다 — 계약이 `type: number` 라 정수만 쓰면 Decimal→number 가 안 보인다. */
    function handoverBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        fromWorkOrderId: woCId,
        toWorkOrderId: woDId,
        handedOverAt: HANDED_OVER_AT,
        lines: [
          { lotId: lotAId, handoverQty: 12.5, uomId },
          { lotId: lotBId, handoverQty: 7.25, uomId },
        ],
        ...overrides,
      };
    }

    beforeAll(async () => {
      postCookie = await login(POST_LOGIN_ID, POST_ROLE, ['M-02-01']);
      noPermCookie = await login(NO_PERM_LOGIN_ID, NO_PERM_ROLE, []);
      created = await post(handoverBody());
    });

    afterAll(async () => {
      for (const loginId of [POST_LOGIN_ID, NO_PERM_LOGIN_ID]) {
        const target = await prisma.app_user.findUnique({ where: { login_id: loginId } });
        if (!target) continue;
        await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
        await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
        await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
        await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
      }
      for (const roleCode of [POST_ROLE, NO_PERM_ROLE]) {
        await prisma.role_permission.deleteMany({ where: { role: { role_code: roleCode } } });
        await prisma.role.deleteMany({ where: { role_code: roleCode } });
      }
    });

    it('⭐ 픽스처의 id 가 서로 다르다 — 값 단언이 «출처»를 가를 수 있게 하는 전제', () => {
      // 하나라도 같으면 뒤바뀜 변이가 값까지 같아 안 잡힌다(§7-1 ⓑ · PR ① 리뷰).
      const ids = [woCId, woDId, woEId, lotAId, lotBId, uomId, locAId, locBId];
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('⭐ 201 — 응답 8칸을 «값»까지 통째로 못박는다(receivedAt 포함)', async () => {
      expect(created.status).toBe(201);
      const validate = validator('POST /production/operation-handovers', 201);
      expect(validate(created.body)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);

      // ⭐ 키 집합만 보면 「있어야 할 칸이 어느 물리 칸에서 왔나」를 못 본다 — 값으로 못박는다.
      expect(created.body).toEqual({
        operationHandoverId: expect.any(Number),
        handoverNo: expect.stringMatching(/^OH-\d{8}-\d{4}$/),
        fromWorkOrderId: woCId,
        toWorkOrderId: woDId,
        statusCode: STATUS_MAIN,
        handedOverAt: HANDED_OVER_AT,
        // ⭐ 계약이 인계·인수를 «한 행위»로 접었다 — 두 시각이 같다(R-2).
        receivedAt: HANDED_OVER_AT,
        lines: [
          { operationHandoverLineId: expect.any(Number), lotId: lotAId, handoverQty: 12.5, uomId },
          { operationHandoverLineId: expect.any(Number), lotId: lotBId, handoverQty: 7.25, uomId },
        ],
      });
    });

    it('⭐ 조회가 그 행을 8칸으로 되읽는다 — PR ① 이 못 돌린 「receivedAt 이 찬 헤더」 경로', async () => {
      const detail = await request(app.getHttpServer())
        .get(`${HANDOVERS}/${created.body.operationHandoverId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(validator('GET /production/operation-handovers/{operationHandoverId}')(detail.body)).toBe(true);
      // 8칸이다 — PR ① 픽스처는 `received_at` 이 전 행 NULL 이라 7칸 경로만 돌았다(Minor-3).
      expect(Object.keys(detail.body).sort()).toEqual([
        'fromWorkOrderId',
        'handedOverAt',
        'handoverNo',
        'lines',
        'operationHandoverId',
        'receivedAt',
        'statusCode',
        'toWorkOrderId',
      ]);
      expect(detail.body).toEqual(created.body);
    });

    it('⭐ DB — received_qty = handoverQty · 위치 두 칸이 두 W/O 의 기본 WIP 위치 · line_no 1..N', async () => {
      const handoverId = BigInt(created.body.operationHandoverId as number);
      const header = await prisma.operation_handover.findUniqueOrThrow({
        where: { operation_handover_id: handoverId },
      });
      expect(header.status_code).toBe(STATUS_MAIN);
      expect(header.handed_over_at.toISOString()).toBe(HANDED_OVER_AT);
      expect(header.received_at?.toISOString()).toBe(HANDED_OVER_AT);

      // ⭐ 응답에 «안 나오는» 칸 넷이다 — 이 DB 단언이 유일한 그물이다(§7-6).
      const lines = await prisma.operation_handover_line.findMany({
        where: { operation_handover_id: handoverId },
        orderBy: { line_no: 'asc' },
      });
      expect(
        lines.map((line) => ({
          lineNo: line.line_no,
          lotId: Number(line.source_lot_id),
          handoverQty: Number(line.handover_qty),
          receivedQty: Number(line.received_qty),
          sourceLocationId: Number(line.source_location_id),
          destinationLocationId: Number(line.destination_location_id),
        })),
      ).toEqual([
        { lineNo: 1, lotId: lotAId, handoverQty: 12.5, receivedQty: 12.5, sourceLocationId: locAId, destinationLocationId: locBId },
        { lineNo: 2, lotId: lotBId, handoverQty: 7.25, receivedQty: 7.25, sourceLocationId: locAId, destinationLocationId: locBId },
      ]);
    });

    it('⭐ 채번 — OH-{YYYYMMDD}-{SEQ4} 이고 기간 키가 handedOverAt 의 UTC 날짜다 · 둘째 건이 +1', async () => {
      expect(created.body.handoverNo).toContain(`OH-${HANDED_OVER_AT.slice(0, 10).replace(/-/g, '')}-`);
      const first = await post(handoverBody()).expect(201);
      const second = await post(handoverBody()).expect(201);
      const seq = (no: string) => Number(no.slice(-4));
      expect(seq(second.body.handoverNo)).toBe(seq(first.body.handoverNo) + 1);
    });

    it('fromWorkOrderId 와 toWorkOrderId 가 같으면 400 INVALID(CHECK 앞당김)', async () => {
      const response = await post(handoverBody({ toWorkOrderId: woCId })).expect(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: 'toWorkOrderId', code: 'INVALID' }),
      );
    });

    it('⭐ 기본 WIP 위치가 NULL 인 W/O 는 400 INVALID(자리 1 — 못 풀면 거부한다)', async () => {
      const asSource = await post(handoverBody({ fromWorkOrderId: woEId })).expect(400);
      expect(asSource.body.errors).toContainEqual(
        expect.objectContaining({ field: 'fromWorkOrderId', code: 'INVALID' }),
      );
      const asDestination = await post(handoverBody({ toWorkOrderId: woEId })).expect(400);
      expect(asDestination.body.errors).toContainEqual(
        expect.objectContaining({ field: 'toWorkOrderId', code: 'INVALID' }),
      );
    });

    it('라인 수량 0 은 400 RANGE · 없는 lotId 는 400 INVALID(404 가 아니다)', async () => {
      const zero = await post(handoverBody({ lines: [{ lotId: lotAId, handoverQty: 0, uomId }] })).expect(400);
      expect(zero.body.errors).toContainEqual(
        expect.objectContaining({ field: 'lines[0].handoverQty', code: 'RANGE' }),
      );
      const missing = await post(
        handoverBody({ lines: [{ lotId: 999999999, handoverQty: 1, uomId }] }),
      ).expect(400);
      expect(missing.body.errors).toContainEqual(
        expect.objectContaining({ field: 'lines[0].lotId', code: 'INVALID' }),
      );
    });

    it('X-Worker-No 가 없으면 400 REQUIRED · 없는 사번이면 400 INVALID', async () => {
      const absent = await post(handoverBody(), { workerNo: null }).expect(400);
      expect(absent.body.errors).toContainEqual(
        expect.objectContaining({ field: 'X-Worker-No', code: 'REQUIRED' }),
      );
      const unknown = await post(handoverBody(), { workerNo: `${PREFIX}-NOPE` }).expect(400);
      expect(unknown.body.errors).toContainEqual(
        expect.objectContaining({ field: 'X-Worker-No', code: 'INVALID' }),
      );
    });

    it('⭐ 같은 Idempotency-Key 재전송이 인계를 두 벌 만들지 않는다(행 수를 센다)', async () => {
      const key = randomUUID();
      const before = await prisma.operation_handover.count({ where: { from_work_order_id: BigInt(woCId) } });
      const first = await post(handoverBody(), { key }).expect(201);
      const again = await post(handoverBody(), { key }).expect(201);
      expect(again.body).toEqual(first.body);
      const after = await prisma.operation_handover.count({ where: { from_work_order_id: BigInt(woCId) } });
      // 행 수를 안 세면 반증이 안 된다 — 응답만 보면 두 벌이 생겨도 초록이다.
      expect(after).toBe(before + 1);
      expect(
        await prisma.operation_handover_line.count({
          where: { operation_handover_id: BigInt(first.body.operationHandoverId as number) },
        }),
      ).toBe(2);
    });

    it('같은 키 · 다른 본문은 409 DUPLICATE_KEY · conflictCause=user', async () => {
      const key = randomUUID();
      await post(handoverBody(), { key }).expect(201);
      const conflict = await post(handoverBody({ handedOverAt: '2026-09-09T05:00:00.000Z' }), { key }).expect(409);
      expect(conflict.body).toMatchObject({ code: 'DUPLICATE_KEY', conflictCause: 'user' });
    });

    it('무권한 사용자는 403', async () => {
      // ⭐ `derived-permissions.ts:230` 의 `['M-02-01']` 이 살아 있음을 증명한다.
      await post(handoverBody(), { cookie: noPermCookie }).expect(403);
    });

    it('If-Match 는 「선택」이라 틀린 버전을 보내도 201(받되 버린다)', async () => {
      await post(handoverBody(), { ifMatch: '"999"' }).expect(201);
    });
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '공정인계검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '공정인계검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '공정인계검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '공정인계검사품목',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '공정인계검사창고',
        warehouse_type_code: 'WIP',
        management_level_code: 'LOCATION',
      },
    });
    const locationA = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC-A`,
        location_name: '공정인계검사위치A',
        location_type_code: 'BIN',
      },
    });
    locAId = Number(locationA.location_id);
    const locationB = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC-B`,
        location_name: '공정인계검사위치B',
        location_type_code: 'BIN',
      },
    });
    locBId = Number(locationB.location_id);
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    const operation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
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
        plan_date: new Date('2026-09-08T00:00:00.000Z'),
        planned_qty: 100,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    const workOrder = async (suffix: string, defaultWipLocationId: bigint | null = null) =>
      prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-${suffix}`,
          production_plan_id: plan.production_plan_id,
          routing_operation_id: operation.routing_operation_id,
          item_id: item.item_id,
          order_qty: 100,
          uom_id: uom.uom_id,
          status_code: 'IN_PROGRESS',
          default_wip_location_id: defaultWipLocationId,
        },
      });
    const woA = await workOrder('WOA');
    woAId = Number(woA.work_order_id);
    const woB = await workOrder('WOB');
    woBId = Number(woB.work_order_id);
    // 등록 전용 쌍 — 두 기본 WIP 위치를 **서로 다르게** 둔다(뒤바뀜 변이를 값이 잡는다 · §7-1 ⓑ).
    woCId = Number((await workOrder('WOC', locationA.location_id)).work_order_id);
    woDId = Number((await workOrder('WOD', locationB.location_id)).work_order_id);
    // 기본 WIP 위치가 NULL — 자리 1 의 400 갈래를 지켜본다.
    woEId = Number((await workOrder('WOE')).work_order_id);

    await prisma.worker.create({
      data: {
        worker_no: WORKER_NO,
        worker_name: '공정인계검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
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
          source_id: woA.work_order_id,
          status_code: 'NORMAL',
        },
      });
    const lotA = await lot('A');
    lotAId = Number(lotA.lot_id);
    const lotB = await lot('B');
    lotBId = Number(lotB.lot_id);

    const handover = async (
      suffix: string,
      fromWorkOrderId: bigint,
      toWorkOrderId: bigint,
      handedOverAt: string,
      statusCode: string,
      lines: { lineNo: number; lotId: bigint; qty: number }[],
    ) =>
      prisma.operation_handover.create({
        data: {
          handover_no: `${PREFIX}-HO-${suffix}`,
          from_work_order_id: fromWorkOrderId,
          to_work_order_id: toWorkOrderId,
          status_code: statusCode,
          handed_over_at: new Date(handedOverAt),
          operation_handover_line: {
            create: lines.map((line) => ({
              line_no: line.lineNo,
              source_lot_id: line.lotId,
              handover_qty: line.qty,
              uom_id: uom.uom_id,
              source_location_id: locationA.location_id,
              destination_location_id: locationB.location_id,
            })),
          },
        },
      });

    ho1Id = Number(
      (await handover('1', woA.work_order_id, woB.work_order_id, T1, STATUS_MAIN, [
        { lineNo: 1, lotId: lotA.lot_id, qty: 10 },
      ])).operation_handover_id,
    );
    ho2Id = Number(
      (await handover('2', woA.work_order_id, woB.work_order_id, T1, STATUS_MAIN, [
        { lineNo: 1, lotId: lotB.lot_id, qty: 20 },
      ])).operation_handover_id,
    );
    // ⭐ line_no 를 «역순»으로 심는다 — 상세가 저장 순서가 아니라 line_no 로 정렬함을 증명한다.
    ho3Id = Number(
      (await handover('3', woA.work_order_id, woB.work_order_id, T2, STATUS_MAIN, [
        { lineNo: 2, lotId: lotB.lot_id, qty: 15 },
        { lineNo: 1, lotId: lotA.lot_id, qty: 5 },
      ])).operation_handover_id,
    );
    // 반대 방향 — from↔to 를 바꿔 fromWorkOrderId 필터가 방향을 가르는지 본다.
    ho4Id = Number(
      (await handover('4', woB.work_order_id, woA.work_order_id, T1, STATUS_MAIN, [
        { lineNo: 1, lotId: lotA.lot_id, qty: 1 },
      ])).operation_handover_id,
    );
    ho5Id = Number(
      (await handover('5', woA.work_order_id, woB.work_order_id, T1, STATUS_OTHER, [
        { lineNo: 1, lotId: lotA.lot_id, qty: 1 },
      ])).operation_handover_id,
    );
  }

  /** 역할 코드가 널이면 역할을 안 붙인다(조회 전용 세션). */
  async function login(loginId: string, roleCode: string | null, permissions: string[]): Promise<string[]> {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: '공정인계검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    if (roleCode !== null) {
      const role = await prisma.role.create({ data: { role_code: roleCode, role_name: '공정인계검사용' } });
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
    const orderScope = { production_plan: { plan_no: { startsWith: PREFIX } } };
    // ⭐ 등록이 만든 인계의 번호는 `OH-{YYYYMMDD}-{SEQ4}` 라 PREFIX 가 아니다 — W/O 축으로 되짚는다.
    const handoverWhere = {
      OR: [
        { handover_no: { startsWith: PREFIX } },
        {
          work_order_operation_handover_from_work_order_idTowork_order: {
            work_order_no: { startsWith: PREFIX },
          },
        },
      ],
    };
    await prisma.operation_handover_line.deleteMany({ where: { operation_handover: handoverWhere } });
    await prisma.operation_handover.deleteMany({ where: handoverWhere });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: orderScope });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});
