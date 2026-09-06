/**
 * 출고 조회 3건 + 전기 + 등록 — `GET /logistics/goods-issues`·`/{goodsIssueId}`·
 * `/{goodsIssueId}/lines` 와 `POST /logistics/goods-issues/{goodsIssueId}:post` ·
 * `POST /logistics/goods-issues`.
 * 화면 `W-01-05`(반품)·`W-01-06`(기타 출고)·`P-01-02`(현장 QR)·`W-04-10`(제품 폐기).
 *
 * ⛔ `:post` 갈래는 전표를 **직접 INSERT** 한다(`insertRegisteredIssue`) — 등록 갈래(`createIssue`)
 * 와 갈라 두어야 한쪽이 깨져도 다른 쪽 판정이 남는다.
 * ⭐ 그리고 **잔액은 직접 INSERT 하지 않는다** — `POST /logistics/goods-receipts` 를 «부른다»
 * (I-4.md §6-5). `inventory_balance` 는 트리거가 지키는 표라 손으로 넣으면 차원 11칸을
 * 우리가 맞춰야 하고, 그것이 `:post` 가 되읽는 바로 그 값이다.
 *
 * ⚠ **시퀀서 순서에 기댄다** — `alphabetical-sequencer.js` 는 파일 이름 순으로 돈다.
 * `logistics-goods-issue` 가 `logistics-goods-receipt` **앞**이다. 뒤 스위트
 * (`logistics-goods-receipt.e2e-spec.ts`) 의 `cleanup()` 첫 줄 `TRUNCATE
 * inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE` 가
 * `goods_issue_line.inventory_transaction_line_id` FK 때문에 `logistics.goods_issue_line`
 * 까지 비운다 — 이 스위트가 먼저 끝나 무해하지만, 역순으로 돌면 조용히 깨진다
 * (I-4.md §8-3 ⓘ).
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

const LOGIN_ID = 'e2e-gi-probe';
const NOPERM_ID = 'e2e-gi-noperm';
const PASSWORD = 'GI-조회-비밀번호';
const PREFIX = 'GIE2E';
const ROLE = 'E2E_GI';
const DAY = '2026-05-04';
const AT = '2026-05-04T02:00:00.000Z';
/** 입고(잔액 세우기) + 출고 전기. `:post` 는 `derived-permissions.ts:170` 이 이미 갖는다. */
const PERMISSIONS = ['W-01-10', 'W-01-06'];

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface IssueBody {
  goodsIssueId: number;
  goodsIssueNo: string;
  issueTypeCode: string;
  statusCode: string;
  destinationTypeCode: string | null;
  destinationId: number | null;
  erpMessageQueued: boolean;
}
interface Fixture extends IssueBody {
  goodsIssueLineId: number;
  goodsIssueLineIds: number[];
  versionNo: number;
}

/** 잔액 한 벌 — 입고 API 가 세운 LOT 과 그 입고 전표(원천 문서로 가리킨다). */
interface Stock {
  lotId: number;
  goodsReceiptId: number;
}

describe('출고 조회 3건 · 전기 · 등록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let plantId: number;
  let warehouseId: number;
  let locationId: number;
  let destinationLocationId: number;
  let itemId: number;
  let uomId: number;
  let lotId: number;
  let goodsReceiptId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeUser();
    // 조회 e2e 가 쓰는 기본 LOT 에도 잔액을 세워 둔다 — 원천 문서 id 가 여기서 난다.
    const seed = await stock(lotId);
    goodsReceiptId = seed.goodsReceiptId;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('GET /logistics/goods-issues — 목록이 뜬다 · page 메타가 있다', async () => {
    const { goodsIssueId } = await insertRegisteredIssue();

    const response = await request(app.getHttpServer())
      // ⭐ 이 스위트가 전표를 여럿 만든다 — 기본 50쪽에서 `toContain` 하려면 축을 닫아야 한다.
      .get(`/api/logistics/goods-issues?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/goods-issues');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.page).toMatchObject({ page: 1, size: 50 });
    expect(response.body.items.map((row: IssueBody) => row.goodsIssueId)).toContain(goodsIssueId);
  });

  it('GET /logistics/goods-issues?issueTypeCode= — 유형으로 걸린다', async () => {
    const target = await insertRegisteredIssue({ issueTypeCode: 'SUPPLIER_RETURN' });
    const other = await insertRegisteredIssue({ issueTypeCode: 'OTHER' });

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues?q=${PREFIX}&issueTypeCode=SUPPLIER_RETURN`)
      .set('Cookie', cookie)
      .expect(200);
    const ids = response.body.items.map((row: IssueBody) => row.goodsIssueId);
    expect(ids).toContain(target.goodsIssueId);
    expect(ids).not.toContain(other.goodsIssueId);
  });

  it('GET /logistics/goods-issues?statusCode= — 상태로 걸린다', async () => {
    const posted = await insertRegisteredIssue({ statusCode: 'POSTED' });
    const registered = await insertRegisteredIssue({ statusCode: 'REGISTERED' });

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues?q=${PREFIX}&statusCode=POSTED`)
      .set('Cookie', cookie)
      .expect(200);
    const ids = response.body.items.map((row: IssueBody) => row.goodsIssueId);
    expect(ids).toContain(posted.goodsIssueId);
    expect(ids).not.toContain(registered.goodsIssueId);
  });

  it('GET /logistics/goods-issues?supplierId= — 반품 건이 도착지 짝으로 걸린다', async () => {
    const supplierId = 900000001;
    const returned = await insertRegisteredIssue({
      issueTypeCode: 'SUPPLIER_RETURN',
      destinationTypeCode: 'PARTNER',
      destinationId: supplierId,
    });
    // 자체 폐기 — 도착지 짝을 통째로 비운다. 이 필터로 안 잡힌다(사실이 그렇다).
    const disposal = await insertRegisteredIssue({
      issueTypeCode: 'OTHER',
      destinationTypeCode: null,
      destinationId: null,
    });

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues?q=${PREFIX}&supplierId=${supplierId}`)
      .set('Cookie', cookie)
      .expect(200);
    const ids = response.body.items.map((row: IssueBody) => row.goodsIssueId);
    expect(ids).toContain(returned.goodsIssueId);
    expect(ids).not.toContain(disposal.goodsIssueId);
  });

  it('GET /logistics/goods-issues/{id} — 200 에 ETag 가 실린다', async () => {
    const { goodsIssueId } = await insertRegisteredIssue();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues/${goodsIssueId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/goods-issues/{goodsIssueId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.headers.etag).toMatch(/^\d+$/);
    expect(response.body.goodsIssue).not.toHaveProperty('versionNo');
    // 계약 required 밖이라 ajv 가 못 잡는 둘 — 널 키 비생략(§2-2) · `erpMessageQueued:false` 고정(§8-3 ⓕ).
    expect(response.body.goodsIssue).toMatchObject({
      erpMessageQueued: false,
      approvalRequestId: null,
      reasonCode: null,
      replacementExpected: null,
      remarks: null,
    });
  });

  it('GET /logistics/goods-issues/{id} — 없는 id 는 404', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/goods-issues/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('GET /logistics/goods-issues/{id}/lines — ETag 를 안 내린다(자식 컬렉션)', async () => {
    const { goodsIssueId } = await insertRegisteredIssue();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues/${goodsIssueId}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/goods-issues/{goodsIssueId}/lines');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // express 약한 ETag 가 늘 붙는다 — 우리가 실은 numeric ETag 가 아니면 된다.
    expect(response.headers.etag ?? '').not.toMatch(/^\d+$/);
  });

  it('조회 3건은 403 을 내지 않는다(계약 미선언)', async () => {
    const { goodsIssueId } = await insertRegisteredIssue();

    const list = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues?q=${PREFIX}`)
      .set('Cookie', cookie);
    const detail = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues/${goodsIssueId}`)
      .set('Cookie', cookie);
    const lines = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues/${goodsIssueId}/lines`)
      .set('Cookie', cookie);

    expect(list.status).not.toBe(403);
    expect(detail.status).not.toBe(403);
    expect(lines.status).not.toBe(403);
  });

  it('POST …:post — 200 · balance 가 줄고 inventory_transaction_line 이 선다', async () => {
    const fixture = await stockedIssue(10, 100);

    const response = await postIssue(fixture).expect(200);
    const validate = validator('POST /logistics/goods-issues/{goodsIssueId}:post');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const balance = await prisma.inventory_balance.findFirstOrThrow({
      where: { item_id: itemId, lot_id: fixture.lotId, location_id: locationId },
    });
    expect(Number(balance.on_hand_qty)).toBe(90);
    const ledger = await prisma.inventory_transaction_line.findMany({
      where: { item_id: itemId, lot_id: fixture.lotId, from_location_id: locationId },
    });
    expect(ledger).toHaveLength(1);
    // ⛔ 출고는 출발지만 싣는다 — 도착지가 있으면 이동이지 출고가 아니다.
    expect(ledger[0].to_location_id).toBeNull();
  });

  it('POST …:post — goods_issue_line.inventory_transaction_line_id 가 채워진다', async () => {
    const fixture = await stockedIssue();

    await postIssue(fixture).expect(200);

    const line = await prisma.goods_issue_line.findUniqueOrThrow({
      where: { goods_issue_line_id: fixture.goodsIssueLineId },
    });
    expect(line.inventory_transaction_line_id).not.toBeNull();
  });

  it('POST …:post — status_code 가 POSTED 로 가고 version_no 가 오른다', async () => {
    const fixture = await stockedIssue();

    const response = await postIssue(fixture).expect(200);

    expect(response.body).toMatchObject({ statusCode: 'POSTED' });
    const row = await prisma.goods_issue.findUniqueOrThrow({
      where: { goods_issue_id: fixture.goodsIssueId },
    });
    expect(row.version_no).toBe(fixture.versionNo + 1);
  });

  it('POST …:post — 200 본문에 lines 가 없다(GoodsIssue 헤더다)', async () => {
    const fixture = await stockedIssue();

    const response = await postIssue(fixture).expect(200);

    // 계약 응답 스키마가 `GoodsIssueDetailResponse` 가 아니라 `GoodsIssue` 다.
    expect(response.body).not.toHaveProperty('lines');
    expect(response.body).not.toHaveProperty('goodsIssue');
    expect(response.body).toMatchObject({ goodsIssueId: fixture.goodsIssueId });
  });

  it('POST …:post — 응답에 ETag 가 없다(계약 미선언)', async () => {
    const fixture = await stockedIssue();

    const response = await postIssue(fixture).expect(200);

    // express 약한 ETag 가 늘 붙는다 — 우리가 실은 numeric ETag 가 아니면 된다.
    expect(response.headers.etag ?? '').not.toMatch(/^\d+$/);
  });

  it('POST …:post — 재전기는 400 STATE_LOCKED 다', async () => {
    const fixture = await stockedIssue(10, 100);
    await postIssue(fixture).expect(200);

    // ⛔ 409 가 아니다 — 409 는 If-Match 저장 충돌 전용이다(I-4.md §3-7).
    const rejected = await postIssue(fixture, fixture.versionNo + 1).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('POST …:post — 라인 0건 전표는 400 LINE_REQUIRED 다(빈 원장을 세우지 않는다)', async () => {
    const fixture = await insertRegisteredIssue({ lines: [] });

    const rejected = await postIssue(fixture).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'LINE_REQUIRED', field: 'lines' });
  });

  it('POST …:post — 같은 Idempotency-Key 재전송은 앞의 응답을 그대로 준다(원장 1건)', async () => {
    const fixture = await stockedIssue(10, 100);
    const key = randomUUID();
    const send = (): request.Test =>
      request(app.getHttpServer())
        .post(`/api/logistics/goods-issues/${fixture.goodsIssueId}:post`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .set('If-Match', String(fixture.versionNo))
        .send({ businessDate: DAY, occurredAt: AT });

    const first = await send().expect(200);
    const second = await send().expect(200);

    expect(second.body).toEqual(first.body);
    const ledger = await prisma.inventory_transaction.findMany({
      where: { idempotency_key: `GOODS_ISSUE:${fixture.goodsIssueNo}` },
    });
    expect(ledger).toHaveLength(1);
  });

  it('POST …:post — If-Match 가 없으면 400 · 낡으면 409', async () => {
    const fixture = await stockedIssue();

    await request(app.getHttpServer())
      .post(`/api/logistics/goods-issues/${fixture.goodsIssueId}:post`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ businessDate: DAY, occurredAt: AT })
      .expect(400);

    await postIssue(fixture, fixture.versionNo + 99).expect(409);
  });

  it('POST …:post — 잔액보다 많이 내면 400 NEGATIVE_BALANCE', async () => {
    // 트리거(`check_balance_qty`)가 500 으로 새지 않는다 — 도메인이 먼저 막는다(§3-3).
    const fixture = await stockedIssue(101, 100);

    const rejected = await postIssue(fixture).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'lines[0].issueQty',
      code: 'NEGATIVE_BALANCE',
    });
  });

  it('POST …:post — 남의 id 는 404', async () => {
    await request(app.getHttpServer())
      .post('/api/logistics/goods-issues/999999999:post')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ businessDate: DAY, occurredAt: AT })
      .expect(404);
  });

  it('POST …:post — 권한 없는 사용자는 403', async () => {
    const fixture = await stockedIssue();

    await request(app.getHttpServer())
      .post(`/api/logistics/goods-issues/${fixture.goodsIssueId}:post`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(fixture.versionNo))
      .send({ businessDate: DAY, occurredAt: AT })
      .expect(403);
  });

  it('POST …:post — 상신하지 않은 출고는 승인 없이 전기된다(계약 「비어 있으면 승인을 타지 않은 출고다」)', async () => {
    // 폐기 사유를 실어도 상신 흔적이 0건이면 통과한다 — 게이트를 걸 축이 데이터에 없다
    // (I-4.md §4-2 · 문의 030). 「승인 없이 나간 건」은 사후에 화면이 가려낸다.
    const fixture = await stockedIssue(10, 100, { reasonCode: 'OTHER' });

    const response = await postIssue(fixture).expect(200);

    expect(response.body).toMatchObject({ statusCode: 'POSTED', approvalRequestId: null });
  });

  it('POST …:post — SCRAPPED LOT 도 전기된다(judgment_type_control 이 비어 있다 · 결정 10 의 단일 지점)', async () => {
    const fixture = await stockedIssue(10, 100);
    await prisma.lot.update({
      where: { lot_id: fixture.lotId },
      data: { status_code: 'SCRAPPED' },
    });

    // ⛔ 문자열 집합으로 막았으면 폐기(`W-01-06`)·반품(`W-01-05`) 업무가 전건 400 이 된다.
    await postIssue(fixture).expect(200);
  });

  it('POST …:post — 같은 위치·LOT 라인이 둘이면 합계로 검사한다', async () => {
    const lot = await makeLot();
    await stock(lot, 10);
    const fixture = await insertRegisteredIssue({
      lines: [
        { qty: 6, lotId: lot },
        { qty: 6, lotId: lot },
      ],
    });

    // 라인별로 보면 6 ≤ 10 이라 둘 다 통과하고 둘째 UPDATE 에서 트리거가 500 을 낸다.
    const rejected = await postIssue(fixture).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'NEGATIVE_BALANCE' });
  });

  it('POST …:post — destinationTypeCode 가 LOCATION 이면 도착 위치 잔액이 는다', async () => {
    const lot = await makeLot();
    await stock(lot, 100);
    const fixture = await insertRegisteredIssue({
      destinationTypeCode: 'LOCATION',
      destinationId: destinationLocationId,
      lines: [{ qty: 10, lotId: lot }],
    });

    await postIssue(fixture).expect(200);

    const arrived = await prisma.inventory_balance.findFirstOrThrow({
      where: { item_id: itemId, lot_id: lot, location_id: destinationLocationId },
    });
    expect(Number(arrived.on_hand_qty)).toBe(10);
  });

  it('POST /logistics/goods-issues — 201 · ETag 가 실린다(입고와 갈리는 자리)', async () => {
    const response = await createIssue().expect(201);

    const validate = validator('POST /logistics/goods-issues', 201);
    expect(validate(response.body)).toBe(true);
    // ⭐ 입고 201 은 계약이 헤더를 안 선언해 ETag 가 없다 — 출고는 선언한다(I-4.md §1-1).
    expect(response.headers.etag).toBe('1');
    // 규칙 미등재라 기본 패턴 `GI-{YYYYMMDD}-{SEQ4}` 다 — 자릿수는 넓게 본다(카운터를 안 지운다).
    // 날짜 자리는 클라이언트 `businessDate`(DAY) 다 — 「오늘」로 잡으면 여기서 갈린다(C-8).
    expect(response.body.goodsIssue.goodsIssueNo).toMatch(/^GI-20260504-\d{4,}$/);
    expect(response.body.goodsIssue.erpMessageQueued).toBe(false);
  });

  it('POST /logistics/goods-issues — postImmediately:false 면 REGISTERED 이고 원장이 안 선다', async () => {
    const lot = await makeLot();
    await stock(lot, 100);

    const response = await createIssue({
      postImmediately: false,
      lines: [{ itemId, lotId: lot, issueQty: 10, uomId, sourceLocationId: locationId }],
    }).expect(201);

    expect(response.body.goodsIssue.statusCode).toBe('REGISTERED');
    // 원장을 안 지나므로 `businessDate`·`occurredAt` 을 실을 표가 없다(I-4.md §2-5).
    const ledger = await prisma.inventory_transaction.findMany({
      where: { transaction_no: response.body.goodsIssue.goodsIssueNo },
    });
    expect(ledger).toHaveLength(0);
    const balance = await prisma.inventory_balance.findFirstOrThrow({
      where: { item_id: itemId, lot_id: lot, location_id: locationId },
    });
    expect(Number(balance.on_hand_qty)).toBe(100);
  });

  it('POST /logistics/goods-issues — postImmediately:true 면 POSTED 이고 balance 가 준다', async () => {
    const lot = await makeLot();
    await stock(lot, 100);

    const response = await createIssue({
      postImmediately: true,
      lines: [{ itemId, lotId: lot, issueQty: 10, uomId, sourceLocationId: locationId }],
    }).expect(201);

    // 「등록과 전기가 같은 트랜잭션이다」(계약) — 상태를 옮긴 것이 아니라 처음부터 POSTED 다.
    expect(response.body.goodsIssue.statusCode).toBe('POSTED');
    expect(response.headers.etag).toBe('1');
    expect(response.body.lines[0].inventoryTransactionLineId).not.toBeNull();
    const balance = await prisma.inventory_balance.findFirstOrThrow({
      where: { item_id: itemId, lot_id: lot, location_id: locationId },
    });
    expect(Number(balance.on_hand_qty)).toBe(90);
  });

  it('POST /logistics/goods-issues — 자체 폐기(도착지 짝 비움)로 등록된다', async () => {
    // 「나가서 없어지는 물건에는 도착지가 없다」(계약) — 짝을 비우는 것이 그 표현이다.
    const response = await createIssue({
      destinationTypeCode: null,
      destinationId: null,
      reasonCode: 'OTHER',
    }).expect(201);

    expect(response.body.goodsIssue.destinationTypeCode).toBeNull();
    expect(response.body.goodsIssue.destinationId).toBeNull();
  });

  it('POST /logistics/goods-issues — 같은 Idempotency-Key 재전송은 전표를 둘 만들지 않는다', async () => {
    const key = randomUUID();
    const before = await prisma.goods_issue.count();

    const first = await createIssue({}, key).expect(201);
    const second = await createIssue({}, key).expect(201);

    expect(second.body).toEqual(first.body);
    expect(await prisma.goods_issue.count()).toBe(before + 1);
  });

  it('POST /logistics/goods-issues — 권한 없는 사용자는 403', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/goods-issues')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        issueTypeCode: 'OTHER',
        sourceDocumentTypeCode: 'GOODS_RECEIPT',
        sourceDocumentId: goodsReceiptId,
        sourceWarehouseId: warehouseId,
        issuedAt: AT,
        businessDate: DAY,
        occurredAt: AT,
        lines: [{ itemId, lotId, issueQty: 10, uomId, sourceLocationId: locationId }],
      })
      .expect(403);

    expect(response.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('POST /logistics/goods-issues — X-Worker-No 가 없어도 400 이 아니다', async () => {
    // `WorkerNoOptional` 이다 — 주체는 계정 세션이 낸다(I-4.md §6-4 · `plan.md` §5 규칙 9).
    const response = await createIssue().expect(201);

    expect(response.request.getHeader('X-Worker-No')).toBeUndefined();
  });

  it('POST /logistics/goods-issues — 응답 detail 의 lines 가 요청 순서대로 lineNo 1..N 이다', async () => {
    const second = await makeLot();

    const response = await createIssue({
      lines: [
        // 본문의 `goodsIssueLineId` 는 무시된다 — 「서버가 부여하며 화면이 정하지 않는다」(계약).
        { goodsIssueLineId: 999999, itemId, lotId, issueQty: 3, uomId, sourceLocationId: locationId },
        { itemId, lotId: second, issueQty: 4, uomId, sourceLocationId: locationId },
      ],
    }).expect(201);

    expect(response.body.lines.map((row: { lineNo: number }) => row.lineNo)).toEqual([1, 2]);
    expect(response.body.lines.map((row: { lotId: number }) => row.lotId)).toEqual([lotId, second]);
    expect(response.body.lines[0].goodsIssueLineId).not.toBe(999999);
  });

  it('POST — postImmediately:true + destinationTypeCode=LOCATION 이면 도착 위치 잔액이 는다(M-01-08 갈래)', async () => {
    const lot = await makeLot();
    await stock(lot, 100);

    await createIssue({
      postImmediately: true,
      destinationTypeCode: 'LOCATION',
      destinationId: destinationLocationId,
      lines: [{ itemId, lotId: lot, issueQty: 10, uomId, sourceLocationId: locationId }],
    }).expect(201);

    const arrived = await prisma.inventory_balance.findFirstOrThrow({
      where: { item_id: itemId, lot_id: lot, location_id: destinationLocationId },
    });
    expect(Number(arrived.on_hand_qty)).toBe(10);
  });

  it('POST /logistics/goods-issues — postImmediately:true 가 400 이면 전표도 안 남는다(같은 트랜잭션)', async () => {
    const lot = await makeLot();
    await stock(lot, 5);
    const before = await prisma.goods_issue.count();

    const rejected = await createIssue({
      postImmediately: true,
      lines: [{ itemId, lotId: lot, issueQty: 10, uomId, sourceLocationId: locationId }],
    }).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ code: 'NEGATIVE_BALANCE' });
    expect(await prisma.goods_issue.count()).toBe(before);
  });

  /** 등록 본문 한 벌 — 겹치는 8칸은 여기 두고 갈래마다 덮어쓴다. */
  function createIssue(body: Record<string, unknown> = {}, key = randomUUID()): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/goods-issues')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send({
        issueTypeCode: 'OTHER',
        // 원천 3값 중 M1 최단 경로 — 픽스처 입고 전표를 그대로 가리킨다(I-4.md §1-4 ①).
        sourceDocumentTypeCode: 'GOODS_RECEIPT',
        sourceDocumentId: goodsReceiptId,
        sourceWarehouseId: warehouseId,
        issuedAt: AT,
        businessDate: DAY,
        occurredAt: AT,
        lines: [{ itemId, lotId, issueQty: 10, uomId, sourceLocationId: locationId }],
        ...body,
      });
  }

  let issueSeq = 0;
  /**
   * PR ③ 의 `:post` e2e 는 전표를 직접 INSERT 한다 — 등록 API 를 안 탄다(I-4.md §6-5 · R-3).
   * ⚠ 여기 넣는 칸 집합은 `create()` 가 INSERT 하는 것과 어긋나면 안 된다 —
   *   단위 `등록 — 결과가 ③ 픽스처와 같은 모양이다` 가 그 대조를 지킨다.
   * ⭐ PR ③ 이 `approvalRequestId`·`reasonCode` 와 **라인 배열**을 더했다 — 「같은 위치·LOT
   * 라인이 둘」과 승인 갈래가 그것을 쓴다. 기존 호출은 인자 없이 그대로 통과한다.
   */
  async function insertRegisteredIssue(
    overrides: {
      issueTypeCode?: string;
      statusCode?: string;
      destinationTypeCode?: string | null;
      destinationId?: number | null;
      issuedAt?: string;
      approvalRequestId?: number;
      reasonCode?: string;
      lines?: { qty: number; lotId?: number; locationId?: number }[];
    } = {},
  ): Promise<Fixture> {
    issueSeq += 1;
    const issue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-${issueSeq}`,
        issue_type_code: overrides.issueTypeCode ?? 'OTHER',
        source_document_type_code: 'GOODS_RECEIPT',
        source_document_id: goodsReceiptId,
        source_warehouse_id: warehouseId,
        destination_type_code: overrides.destinationTypeCode ?? null,
        destination_id: overrides.destinationId ?? null,
        issued_at: new Date(overrides.issuedAt ?? AT),
        status_code: overrides.statusCode ?? 'REGISTERED',
        ...(overrides.reasonCode === undefined ? {} : { reason_code: overrides.reasonCode }),
        ...(overrides.approvalRequestId === undefined
          ? {}
          : { approval_request_id: overrides.approvalRequestId }),
      },
    });
    const drafts = overrides.lines ?? [{ qty: 10 }];
    const lineIds: number[] = [];
    for (const [index, draft] of drafts.entries()) {
      const created = await prisma.goods_issue_line.create({
        data: {
          goods_issue_id: issue.goods_issue_id,
          line_no: index + 1,
          item_id: itemId,
          lot_id: draft.lotId ?? lotId,
          issue_qty: draft.qty,
          uom_id: uomId,
          source_location_id: draft.locationId ?? locationId,
        },
      });
      lineIds.push(Number(created.goods_issue_line_id));
    }
    return {
      goodsIssueId: Number(issue.goods_issue_id),
      goodsIssueNo: issue.goods_issue_no,
      issueTypeCode: issue.issue_type_code,
      statusCode: issue.status_code,
      destinationTypeCode: issue.destination_type_code,
      destinationId: issue.destination_id === null ? null : Number(issue.destination_id),
      erpMessageQueued: false,
      goodsIssueLineId: lineIds[0],
      goodsIssueLineIds: lineIds,
      versionNo: issue.version_no,
    };
  }

  let lotSeq = 0;
  /** LOT 하나. 상태는 `LOT_STATUS` 값이다 — `SCRAPPED` 갈래는 뒤에서 UPDATE 로 만든다. */
  async function makeLot(): Promise<number> {
    lotSeq += 1;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${lotSeq}`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 1000,
        uom_id: uomId,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    return Number(lot.lot_id);
  }

  /**
   * ⭐ 잔액을 **입고 API 로** 세운다(I-4.md §6-5) — 직접 INSERT 는 트리거가 지키는 11칸
   * 차원을 우리가 맞춰야 하고, 그것이 `:post` 가 되읽는 값이다. 그 호출이 적치 지시도
   * 함께 만든다(cleanup ③).
   */
  async function stock(lot: number, qty = 100, locationOf = (): number => locationId): Promise<Stock> {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        receiptTypeCode: 'MATERIAL',
        plantId,
        warehouseId,
        receiptDatetime: AT,
        businessDate: DAY,
        lines: [
          {
            itemId,
            lotId: lot,
            receiptQty: qty,
            uomId,
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode: 'AVAILABLE',
            destinationLocationId: locationOf(),
          },
        ],
      })
      .expect(201);
    return { lotId: lot, goodsReceiptId: response.body.goodsReceipt.goodsReceiptId };
  }

  /** 전기할 수 있는 전표 하나 — LOT 을 새로 만들고 잔액을 세운 뒤 등록 전표를 붙인다. */
  async function stockedIssue(
    qty = 10,
    onHand = 100,
    overrides: Parameters<typeof insertRegisteredIssue>[0] = {},
  ): Promise<Fixture & Stock> {
    const lot = await makeLot();
    const stocked = await stock(lot, onHand);
    const issue = await insertRegisteredIssue({ ...overrides, lines: [{ qty, lotId: lot }] });
    return { ...issue, ...stocked };
  }

  function postIssue(fixture: Fixture, version = fixture.versionNo): request.Test {
    return request(app.getHttpServer())
      .post(`/api/logistics/goods-issues/${fixture.goodsIssueId}:post`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(version))
      .send({ businessDate: DAY, occurredAt: AT });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '출고조회검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '출고조회검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '출고조회검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);

    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '출고조회검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    itemId = Number(item.item_id);

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '출고조회검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);

    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '출고조회검사위치',
        location_type_code: 'BIN',
      },
    });
    locationId = Number(location.location_id);

    // `destinationTypeCode='LOCATION'` 갈래가 쓸 도착 위치 — 같은 창고의 다른 칸이다.
    const destination = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC2`,
        location_name: '출고검사도착위치',
        location_type_code: 'BIN',
      },
    });
    destinationLocationId = Number(destination.location_id);

    lotId = await makeLot();
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '출고조회검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // ⚠ 조회 3건은 계약이 403 을 선언하지 않아 이 권한들과 무관하다 — 잔액을 세우는
    //   입고(`W-01-10`)와 전기(`W-01-06`)에만 쓴다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '출고조회검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '출고권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);
    cookie = await login();
  }

  async function login(loginId: string = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /**
   * §6-5 ①~⑬ 순서 그대로. ⛔ ①이 첫 줄인 이유 — 원장은 트리거가 UPDATE·DELETE 를 막아
   * TRUNCATE 뿐이고, `goods_issue_line.inventory_transaction_line_id` FK 때문에 CASCADE 가
   * `goods_issue_line`·`goods_receipt_line`·`putaway_task` 까지 함께 비운다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    // 잔액을 세우는 입고 API 호출이 라인마다 적치 지시를 만든다(§6-5 ③).
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.putaway_task
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_issue_spare_line
       WHERE goods_issue_id IN (SELECT goods_issue_id FROM logistics.goods_issue
              WHERE source_warehouse_id IN (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'))`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_issue_line
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    // ⭐ FK 를 먼저 끊는다(I-4.md §6-5 ⑥) — approval_request_id 는 이 PR 에선 늘 NULL 이지만
    //   순서 자리를 잡아 둔다(PR ⑤ 가 실제로 채우기 시작한다).
    await prisma.$executeRawUnsafe(`
      UPDATE logistics.goods_issue SET approval_request_id = NULL
       WHERE source_warehouse_id IN (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_issue
       WHERE source_warehouse_id IN (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt_line
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
    // ⛔ `app.numbering_counter` 는 지우지 않는다(I-2 R-10 ⓔ) — 입고 픽스처가 GR·PT 를 뽑는다.
  }
});
