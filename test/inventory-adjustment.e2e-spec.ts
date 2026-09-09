/**
 * 재고 조정 조회 3건 — `GET /inventory/adjustments`·`/{inventoryAdjustmentId}`·
 * `/{inventoryAdjustmentId}/lines`. 화면 `W-01-12`. 등록·치환·상신·전기는 뒤 PR(②③④) 몫이라
 * 이 스위트는 전표를 **prisma 로 직접 INSERT** 한다(계약 경로가 아직 없다).
 *
 * ⚠ **시퀀서 순서에 기댄다** — `alphabetical-sequencer.js` 는 파일 이름 순으로 돈다.
 * `inventory-adjustment` 는 `inventory-balance`·`inventory-posting`·`inventory-transaction`
 * 보다 **앞**이다(cleanup 이 `TRUNCATE inventory.inventory_transaction_line,
 * inventory.inventory_transaction CASCADE` 를 돈다) — 우리 흔적을 뒤 스위트가 치운다
 * (I-4.md §10-1).
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

const LOGIN_ID = 'e2e-ia-probe';
const NOPERM_ID = 'e2e-ia-noperm';
const APPROVER_ID = 'e2e-ia-approver';
const PASSWORD = '조정-조회-비밀번호';
const PREFIX = 'IAE2E';
const ROLE = 'E2E_IA';
const APPROVER_ROLE = 'E2E_IA_APPROVER';
// `W-01-10` 은 잔액을 세우는 입고 API 를 부르려고 든다(잔액은 손으로 넣지 않는다).
const PERMISSIONS = ['W-01-12', 'W-01-10'];
/** 결재함(`:approve`·`:reject` 와 그 상세 GET) 몫 — 승인자에게만 필요하다. */
const APPROVER_PERMISSIONS = ['W-03-09'];
/** 계약이 승인 유형을 못박아 본문이 받지 않는다. 대상 유형과 같은 문자열이다. */
const APPROVAL_TYPE = 'INVENTORY_ADJUSTMENT';
const DAY = '2026-06-01';
const AT = '2026-06-01T01:00:00.000Z';

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

/** 치환·상신이 함께 쓰는 한 벌 — 전표 id · 지금 토큰 · 살아 있는 라인 id. */
interface Fixture {
  inventoryAdjustmentId: number;
  versionNo: number;
  lineIds: number[];
}

interface AdjustmentBody {
  inventoryAdjustmentId: number;
  inventoryAdjustmentNo: string;
  statusCode: string;
  reasonCode: string;
  inventoryCountId: number | null;
  adjustedAt: string | null;
}

describe('재고 조정 7 오퍼레이션 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let approverCookie: string[];
  let approverUserId: bigint;
  const routeIds: bigint[] = [];

  let plantId: number;
  let warehouseId: number;
  let locationId: number;
  /** 잔액이 «없는» 위치 — 0행 갈래. */
  let emptyLocationId: number;
  /** 잔액 행이 «둘인» 위치 — 차원이 갈리는 갈래. */
  let dualLocationId: number;
  /** 다른 공장의 위치 — 공장 단일 검사 갈래. */
  let otherPlantLocationId: number;
  /** ⭐ 같은 공장 · «다른 사업부» 창고의 위치 — 공장 축만 본다는 것의 반대 갈래. */
  let otherUnitLocationId: number;
  let otherUnitWarehouseId: number;
  /** 전기 전용 위치들 — 전기가 잔액을 «움직이므로» 앞 시험과 섞이면 기대값이 무너진다. */
  let postDownLocationId: number;
  let postUpLocationId: number;
  /** §10-6 의 A(100)·B(30) — 증·감이 섞인 한 전표가 이 둘을 80·35 로 만든다. */
  let mixFromLocationId: number;
  let mixToLocationId: number;
  let postGeneralLocationId: number;
  let flowLocationId: number;
  /** ⭐ `negative_stock_allowed = true` 품목 한 벌 — I-4 와 갈리는 자리다. */
  let negItemId: number;
  let negLotId: number;
  let negLocationId: number;
  let itemId: number;
  let lotId: number;
  let uomId: number;
  let inventoryCountId: number;
  let inventoryCountLineId: number;
  /** 다른 실사의 라인 — 「남의 실사 라인을 가리켰나」 갈래. */
  let otherCountLineId: number;

  /** 전기 완료(조회됨) · 미전기(REGISTERED · adjustedAt=NULL) 한 벌씩. */
  let postedId: number;
  let registeredId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeUsers();
    await makeAdjustments();
    await makeBalances();
    // 결재선은 `prisma/seed.ts` 에 0건이라 픽스처로 한 벌 심는다.
    routeIds.push(await seedRoute(prisma, APPROVAL_TYPE, [approverUserId]));
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('GET /inventory/adjustments — 목록이 뜨고 page 메타가 있다', async () => {
    const body = await list('');
    expect(body.page).toMatchObject({ page: 1, size: 50 });
    expect(body.items.map((i) => i.inventoryAdjustmentId)).toEqual(
      expect.arrayContaining([postedId, registeredId]),
    );
  });

  it('목록이 statusCode 로 걸러진다', async () => {
    const posted = await list('statusCode=POSTED');
    expect(posted.items.map((i) => i.inventoryAdjustmentId)).toEqual([postedId]);

    const registered = await list('statusCode=REGISTERED');
    expect(registered.items.map((i) => i.inventoryAdjustmentId)).toEqual([registeredId]);
  });

  it('⭐ 목록이 reasonCode 로 걸러진다 — 헤더 사유 축이다', async () => {
    const body = await list('reasonCode=SYSTEM_ERROR_CORRECTION');
    expect(body.items.map((i) => i.inventoryAdjustmentId)).toEqual([registeredId]);
  });

  it('목록이 inventoryCountId 로 걸러진다', async () => {
    const body = await list(`inventoryCountId=${inventoryCountId}`);
    expect(body.items.map((i) => i.inventoryAdjustmentId)).toEqual([postedId]);
  });

  it('목록이 adjustedAtFrom·adjustedAtTo 구간으로 걸러진다 — 미전기 전표는 안 잡힌다', async () => {
    const inRange = await list('adjustedAtFrom=2026-06-01&adjustedAtTo=2026-06-01');
    expect(inRange.items.map((i) => i.inventoryAdjustmentId)).toEqual([postedId]);

    const outOfRange = await list('adjustedAtFrom=2026-06-02&adjustedAtTo=2026-06-02');
    expect(outOfRange.items).toHaveLength(0);
  });

  it('⭐ 숫자 축에 글자가 섞이면 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .get('/api/inventory/adjustments?inventoryCountId=abc')
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'inventoryCountId', code: 'INVALID' });
  });

  it('상세가 200 에 ETag 로 version_no 를 내리고 본문이 {inventoryAdjustment, lines} 다', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/inventory/adjustments/${postedId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.headers.etag).toBe('1');

    const validate = validator('GET /inventory/adjustments/{inventoryAdjustmentId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(detail.body.inventoryAdjustment.inventoryAdjustmentId).toBe(postedId);
    expect(detail.body.lines).toHaveLength(1);
  });

  it('없는 상세는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/inventory/adjustments/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⭐ GET …/lines 는 ETag 를 안 내린다(자식 컬렉션) · 없는 id 는 404', async () => {
    const lines = await request(app.getHttpServer())
      .get(`/api/inventory/adjustments/${postedId}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    expect(lines.headers.etag ?? '').not.toMatch(/^\d+$/);

    const validate = validator('GET /inventory/adjustments/{inventoryAdjustmentId}/lines');
    expect(validate(lines.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(lines.body.items).toHaveLength(1);
    expect(lines.body.items[0].lineNo).toBe(1);

    await request(app.getHttpServer())
      .get('/api/inventory/adjustments/999999999/lines')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⭐ 권한을 묻지 않는다 — 계약이 조회 3건에 403 을 선언하지 않았다', async () => {
    const contract = JSON.parse(
      readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    expect(contract.paths['/inventory/adjustments'].get.responses['403']).toBeUndefined();

    await request(app.getHttpServer())
      .get('/api/inventory/adjustments')
      .set('Cookie', noPermCookie)
      .expect(200);
  });


  // ── 등록 ────────────────────────────────────────────────────────────────

  it('required 2 로 만들면 201 · statusCode 가 REGISTERED · ETag 가 실린다', async () => {
    const response = await create({ reasonCode: 'COUNT_VARIANCE', lines: [line(-2)] }).expect(201);
    const validate = validator('POST /inventory/adjustments', 201);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.inventoryAdjustment.statusCode).toBe('REGISTERED');
    expect(response.headers.etag).toBe('1');
  });

  it('inventoryAdjustmentNo 가 IA-{YYYYMMDD}-{SEQ4} 형식이다', async () => {
    const response = await create({ reasonCode: 'COUNT_VARIANCE', lines: [line(-1)] }).expect(201);
    expect(response.body.inventoryAdjustment.inventoryAdjustmentNo).toMatch(/^IA-\d{8}-\d{4}$/);
  });

  it('응답 lines 가 요청 순서대로 lineNo 1..N 이다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [line(-1), line(3)],
    }).expect(201);
    expect(response.body.lines.map((l: { lineNo: number }) => l.lineNo)).toEqual([1, 2]);
    expect(response.body.lines.map((l: { adjustmentQty: number }) => l.adjustmentQty)).toEqual([-1, 3]);
  });

  it('⭐ 라인 reasonCode 를 안 보내면 헤더 값이 복사되어 응답에 실린다', async () => {
    const response = await create({ reasonCode: 'HOPPER_MEASUREMENT', lines: [line(-1)] }).expect(201);
    expect(response.body.lines[0].reasonCode).toBe('HOPPER_MEASUREMENT');

    const explicit = await create({
      reasonCode: 'HOPPER_MEASUREMENT',
      lines: [{ ...line(-1), reasonCode: 'OTHER' }],
    }).expect(201);
    expect(explicit.body.lines[0].reasonCode).toBe('OTHER');
  });

  it('⭐ 저장된 라인의 quality/inventory status 가 잔액 행의 값이다', async () => {
    const response = await create({ reasonCode: 'COUNT_VARIANCE', lines: [line(-2)] }).expect(201);
    const row = await prisma.inventory_adjustment_line.findFirstOrThrow({
      where: { inventory_adjustment_id: response.body.inventoryAdjustment.inventoryAdjustmentId },
    });
    expect(row.quality_status_code).toBe('NORMAL');
    expect(row.inventory_status_code).toBe('AVAILABLE');
  });

  it('⭐ 잔액이 없는 위치에 증(+) 라인은 400 INVALID 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [{ ...line(5), locationId: emptyLocationId }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'lines[0].locationId', code: 'INVALID' });
  });

  it('⭐ 잔액이 없는 위치에 감(−) 라인은 400 NEGATIVE_BALANCE 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [{ ...line(-5), locationId: emptyLocationId }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({
      field: 'lines[0].locationId',
      code: 'NEGATIVE_BALANCE',
    });
  });

  it('⭐ 잔액 행이 둘인 위치는 400 INVALID 다 — 어느 차원을 조정할지 정할 수 없다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [{ ...line(-1), locationId: dualLocationId }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'lines[0].locationId', code: 'INVALID' });
  });

  it('adjustmentQty 0 은 400 INVALID · lines [] 는 400 LINE_REQUIRED 다', async () => {
    const zero = await create({ reasonCode: 'COUNT_VARIANCE', lines: [line(0)] }).expect(400);
    expect(zero.body.errors[0]).toMatchObject({
      field: 'lines[0].adjustmentQty',
      code: 'INVALID',
    });

    const empty = await create({ reasonCode: 'COUNT_VARIANCE', lines: [] }).expect(400);
    expect(empty.body.errors[0]).toMatchObject({ field: 'lines', code: 'LINE_REQUIRED' });
  });

  it('⭐ inventoryCountId·inventoryCountLineId 를 보내면 둘 다 저장되고 응답에 실린다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      inventoryCountId,
      lines: [{ ...line(-2), inventoryCountLineId }],
    }).expect(201);
    expect(response.body.inventoryAdjustment.inventoryCountId).toBe(inventoryCountId);
    expect(response.body.lines[0].inventoryCountLineId).toBe(inventoryCountLineId);
  });

  it('라인 reasonCode 가 코드값 밖이면 400 INVALID 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [{ ...line(-1), reasonCode: 'NOT_A_REASON' }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({
      field: 'lines[0].reasonCode',
      code: 'INVALID',
    });
  });

  it('sendToErp 를 false 로 보내도 201 이고 erpMessageQueued 는 false 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      sendToErp: false,
      lines: [line(-1)],
    }).expect(201);
    expect(response.body.inventoryAdjustment.erpMessageQueued).toBe(false);
  });

  it('⭐ 라인이 두 공장에 걸치면 400 INVALID 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [line(-1), { ...line(-1), locationId: otherPlantLocationId }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'lines[1].locationId', code: 'INVALID' });
  });

  it('무권한 계정은 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/inventory/adjustments')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'COUNT_VARIANCE', lines: [line(-1)] })
      .expect(403);
  });

  it('⭐ 사업부가 갈려도 같은 공장이면 통과한다 — 400 은 공장 축만 본다(과잉 차단 금지)', async () => {
    // ⚠ 법인은 갈릴 수 «없다» — 잔액의 법인 축은 창고가 아니라 «공장»에서 나온다
    //   (`inventory-posting.service.ts` `orgAxis`). 같은 공장이면 법인도 같다.
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [line(-1), { ...line(-1), locationId: otherUnitLocationId }],
    }).expect(201);

    expect(response.body.lines).toHaveLength(2);
  });

  // ── 치환 ────────────────────────────────────────────────────────────────

  it('PUT …/lines — 200 · 라인이 통째로 바뀌고 부모 version_no 가 오른다', async () => {
    const fixture = await registered();

    const response = await replaceLines(fixture, [
      { ...item(-4), inventoryAdjustmentLineId: fixture.lineIds[0] },
      item(7),
    ]).expect(200);

    const validate = validator('PUT /inventory/adjustments/{inventoryAdjustmentId}/lines');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.items.map((row: { lineNo: number }) => row.lineNo)).toEqual([1, 2]);
    expect(response.body.items.map((row: { adjustmentQty: number }) => row.adjustmentQty)).toEqual([-4, 7]);
    // 첫 라인은 «살아 남고» 둘째는 새로 난다 — 전량 교체의 뜻이다.
    expect(response.body.items[0].inventoryAdjustmentLineId).toBe(fixture.lineIds[0]);
    const header = await prisma.inventory_adjustment.findUniqueOrThrow({
      where: { inventory_adjustment_id: fixture.inventoryAdjustmentId },
    });
    expect(header.version_no).toBe(fixture.versionNo + 1);
  });

  it('⭐ 응답 ETag 가 오른 값이고 그대로 :request-approval 이 된다 — 상세 GET 을 다시 안 돈다', async () => {
    const fixture = await registered();

    const replaced = await replaceLines(fixture, [item(-1)]).expect(200);

    expect(replaced.headers.etag).toBe(String(fixture.versionNo + 1));
    await requestApproval(fixture, Number(replaced.headers.etag)).expect(202);
  });

  it('요청에서 빠진 기존 행은 삭제된다', async () => {
    const fixture = await registered([line(-2), line(3)]);

    const response = await replaceLines(fixture, [
      { ...item(-2), inventoryAdjustmentLineId: fixture.lineIds[1] },
    ]).expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].inventoryAdjustmentLineId).toBe(fixture.lineIds[1]);
  });

  it('lineNo 가 1..N 으로 재부여된다 — 1↔2 맞바꾸기가 uq 를 안 깬다', async () => {
    const fixture = await registered([line(-2), line(3)]);

    const response = await replaceLines(fixture, [
      { ...item(3), inventoryAdjustmentLineId: fixture.lineIds[1] },
      { ...item(-2), inventoryAdjustmentLineId: fixture.lineIds[0] },
    ]).expect(200);

    expect(response.body.items.map((row: { inventoryAdjustmentLineId: number }) => row.inventoryAdjustmentLineId)).toEqual([
      fixture.lineIds[1],
      fixture.lineIds[0],
    ]);
    expect(response.body.items.map((row: { lineNo: number }) => row.lineNo)).toEqual([1, 2]);
  });

  it('⭐ 치환도 잔액 행에서 두 상태 칸을 다시 읽어 저장한다 · 잔액 0행이면 400', async () => {
    const fixture = await registered();

    await replaceLines(fixture, [item(-1)]).expect(200);
    const row = await prisma.inventory_adjustment_line.findFirstOrThrow({
      where: { inventory_adjustment_id: fixture.inventoryAdjustmentId },
    });
    expect(row.quality_status_code).toBe('NORMAL');
    expect(row.inventory_status_code).toBe('AVAILABLE');

    const rejected = await replaceLines(
      { ...fixture, versionNo: fixture.versionNo + 1 },
      [{ ...item(-1), locationId: emptyLocationId }],
    ).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'items[0].locationId',
      code: 'NEGATIVE_BALANCE',
    });
  });

  it('빈 items 는 400 LINE_REQUIRED · 수량 0 은 400 INVALID — 오류가 `items` 를 짚는다', async () => {
    const fixture = await registered();

    const empty = await replaceLines(fixture, []).expect(400);
    expect(empty.body.errors[0]).toMatchObject({ field: 'items', code: 'LINE_REQUIRED' });

    const zero = await replaceLines(fixture, [item(0)]).expect(400);
    expect(zero.body.errors[0]).toMatchObject({ field: 'items[0].adjustmentQty', code: 'INVALID' });
  });

  it('⭐ 남의 실사 라인을 가리키면 400 INVALID — 헤더가 가리키는 실사의 라인만 받는다', async () => {
    const created = await create({
      reasonCode: 'COUNT_VARIANCE',
      inventoryCountId,
      lines: [{ ...line(-2), inventoryCountLineId }],
    }).expect(201);
    const fixture: Fixture = {
      inventoryAdjustmentId: created.body.inventoryAdjustment.inventoryAdjustmentId,
      versionNo: Number(created.headers.etag),
      lineIds: [],
    };

    const rejected = await replaceLines(fixture, [
      { ...item(-2), inventoryCountLineId: otherCountLineId },
    ]).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'items[0].inventoryCountLineId',
      code: 'INVALID',
    });
    // 제 실사의 라인은 그대로 통과한다.
    await replaceLines(fixture, [{ ...item(-2), inventoryCountLineId }]).expect(200);
  });

  it('남의 전표 라인 id 를 실으면 400 INVALID 다', async () => {
    const other = await registered();
    const fixture = await registered();

    const rejected = await replaceLines(fixture, [
      { ...item(-1), inventoryAdjustmentLineId: other.lineIds[0] },
    ]).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'items[0].inventoryAdjustmentLineId',
      code: 'INVALID',
    });
  });

  it('If-Match 가 없으면 400 REQUIRED · 낡으면 409 다', async () => {
    const fixture = await registered();

    const bare = await request(app.getHttpServer())
      .put(`/api/inventory/adjustments/${fixture.inventoryAdjustmentId}/lines`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ items: [item(-1)] });
    expect(bare.status).toBe(400);
    expect(bare.body.errors[0]).toMatchObject({ code: 'REQUIRED' });

    await replaceLines(fixture, [item(-1)]).expect(200);
    // 같은 토큰을 다시 쓰면 저장 충돌이다 — 재로드하면 풀린다.
    const stale = await replaceLines(fixture, [item(-1)]);
    expect(stale.status).toBe(409);
  });

  it('전기된 조정의 치환은 400 STATE_LOCKED 다', async () => {
    const response = await replaceLines({ inventoryAdjustmentId: postedId, versionNo: 1, lineIds: [] }, [
      item(-1),
    ]);

    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('⭐ 전기된 조정은 «잔액이 사라진 뒤»에도 STATE_LOCKED 다 — 상태를 잔액보다 먼저 본다', async () => {
    // 전기가 그 위치 재고를 소진한 형상을 잔액 «행이 없는» 위치로 대신 만든다. 상태를 나중에
    // 보면 잔액 판정이 먼저 400 `NEGATIVE_BALANCE` 를 내어 계약이 못박은 갈래가 가려진다.
    const response = await replaceLines({ inventoryAdjustmentId: postedId, versionNo: 1, lineIds: [] }, [
      { ...item(-1), locationId: otherPlantLocationId },
    ]);

    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('무권한 계정의 치환은 403 이다(manual-permissions 등록 확인)', async () => {
    const fixture = await registered();

    // 미등록이면 `PermissionGuard` 가 던져 500 이다 — 403 이 나온다는 것이 등록의 증거다.
    await request(app.getHttpServer())
      .put(`/api/inventory/adjustments/${fixture.inventoryAdjustmentId}/lines`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(fixture.versionNo))
      .send({ items: [item(-1)] })
      .expect(403);
  });

  // ── 상신 ────────────────────────────────────────────────────────────────

  it('POST …:request-approval — 202 · FK 가 채워지고 상태·버전은 그대로다', async () => {
    const fixture = await registered();
    const validate = validator('POST /inventory/adjustments/{inventoryAdjustmentId}:request-approval', 202);

    const response = await requestApproval(fixture).expect(202);

    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    const created = await prisma.approval_request.findUniqueOrThrow({
      where: { approval_request_id: response.body.approvalRequestId },
    });
    expect(created).toMatchObject({
      approval_type_code: APPROVAL_TYPE,
      target_type_code: APPROVAL_TYPE,
      target_id: BigInt(fixture.inventoryAdjustmentId),
      status_code: 'PENDING',
    });
    const header = await prisma.inventory_adjustment.findUniqueOrThrow({
      where: { inventory_adjustment_id: fixture.inventoryAdjustmentId },
    });
    expect(Number(header.approval_request_id)).toBe(response.body.approvalRequestId);
    // ⛔ 상태를 안 옮기고 버전도 안 올린다 — 202 에 ETag 가 없다.
    expect(header.status_code).toBe('REGISTERED');
    expect(header.version_no).toBe(fixture.versionNo);
    expect(response.headers.etag ?? '').not.toMatch(/^\d+$/);
  });

  it('POST …:request-approval — 결재선이 없으면 400 ROUTE_NOT_FOUND', async () => {
    const fixture = await registered();
    await prisma.approval_route.updateMany({
      where: { approval_route_id: { in: routeIds } },
      data: { is_active: false },
    });

    let response: request.Response;
    try {
      response = await requestApproval(fixture);
    } finally {
      // 요청이 죽어도 되돌린다 — 안 그러면 뒤따르는 상신 e2e 가 전부 이 코드로 무너진다.
      await prisma.approval_route.updateMany({
        where: { approval_route_id: { in: routeIds } },
        data: { is_active: true },
      });
    }
    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  });

  it('POST …:request-approval — 두 번 부르면 400 APPROVAL_IN_PROGRESS · 반려 뒤엔 새 요청이 선다', async () => {
    const fixture = await registered();
    const first = await requestApproval(fixture).expect(202);

    // 버전이 그대로라 같은 토큰을 다시 쓴다.
    const again = await requestApproval(fixture);
    expect(again.status).toBe(400);
    expect(again.body.errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });

    await decide('reject', first.body.approvalRequestId, { comment: '수량을 다시 보세요' });
    const second = await requestApproval(fixture).expect(202);
    // 번복이 아니라 «새» 요청이다(공유계약 J-6).
    expect(second.body.approvalRequestId).not.toBe(first.body.approvalRequestId);
  });

  it('POST …:request-approval — 낡은 If-Match 면 409 · 무권한은 403', async () => {
    const fixture = await registered();
    // 치환이 부모 버전을 올려 두면 상신이 든 토큰이 낡는다.
    await replaceLines(fixture, [item(-1)]).expect(200);

    const stale = await requestApproval(fixture);
    expect(stale.status).toBe(409);

    await request(app.getHttpServer())
      .post(`/api/inventory/adjustments/${fixture.inventoryAdjustmentId}:request-approval`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(fixture.versionNo + 1))
      .send({ reason: '무권한 상신' })
      .expect(403);
  });

  it('⭐ 승인 대기 중 치환은 400 APPROVAL_IN_PROGRESS · 승인이 끝나면 400 STATE_LOCKED', async () => {
    const fixture = await registered();
    const submitted = await requestApproval(fixture).expect(202);

    const pending = await replaceLines(fixture, [item(-1)]);
    expect(pending.status).toBe(400);
    expect(pending.body.errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });

    // 승인이 «끝난» 뒤에도 막는다 — 승인자가 본 라인이 그대로 원장에 나가야 한다.
    await decide('approve', submitted.body.approvalRequestId);
    const approved = await replaceLines(fixture, [item(-1)]);
    expect(approved.status).toBe(400);
    expect(approved.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', field: 'items' });
  });

  // ── 전기(`:post`) ───────────────────────────────────────────────────────

  it('⭐ 감(−) 전기 — 200 · 잔액이 줄고 원장 라인에 from 만 실린다', async () => {
    const fixture = await registered([lineAt({ locationId: postDownLocationId, adjustmentQty: -20 })]);

    const response = await post(fixture).expect(200);

    expect(response.body).toMatchObject({ statusCode: 'POSTED' });
    expect(await onHand(postDownLocationId)).toBe(20);
    const [entry] = await ledgerOf(fixture.inventoryAdjustmentId);
    // ⛔ 부호는 끝점이 말한다 — 원장 라인은 `qty > 0` CHECK 라 절댓값이 실린다.
    expect(Number(entry.qty)).toBe(20);
    expect(Number(entry.from_location_id)).toBe(postDownLocationId);
    expect(entry.to_location_id).toBeNull();
    expect(Number(entry.from_qty_after_transaction)).toBe(20);
  });

  it('⭐ 증(+) 전기 — 잔액이 늘고 원장 라인에 to 만 실린다', async () => {
    const fixture = await registered([lineAt({ locationId: postUpLocationId, adjustmentQty: 5 })]);

    await post(fixture).expect(200);

    expect(await onHand(postUpLocationId)).toBe(45);
    const [entry] = await ledgerOf(fixture.inventoryAdjustmentId);
    expect(Number(entry.qty)).toBe(5);
    expect(entry.from_location_id).toBeNull();
    expect(Number(entry.to_location_id)).toBe(postUpLocationId);
    expect(Number(entry.to_qty_after_transaction)).toBe(45);
  });

  it('⭐ 증·감이 섞인 한 전표가 원장 하나(헤더 1 · 라인 2)로 나가고 두 잔액이 각각 오르내린다', async () => {
    // §10-6 — A 100 · B 30 → (A −20 · B +5) → A 80 · B 35.
    const fixture = await registered([
      lineAt({ locationId: mixFromLocationId, adjustmentQty: -20 }),
      lineAt({ locationId: mixToLocationId, adjustmentQty: 5 }),
    ]);

    await post(fixture).expect(200);

    expect(await onHand(mixFromLocationId)).toBe(80);
    expect(await onHand(mixToLocationId)).toBe(35);
    const headers = await prisma.inventory_transaction.findMany({
      where: { source_document_type_code: 'INVENTORY_ADJUSTMENT', source_document_id: fixture.inventoryAdjustmentId },
    });
    expect(headers).toHaveLength(1);
    const entries = await ledgerOf(fixture.inventoryAdjustmentId);
    expect(entries).toHaveLength(2);
    // ⭐ 라인 순서가 보존되고 가름이 라인마다 «독립»이다 — 뒤집으면 여기가 깨진다.
    expect(entries.map((row) => row.line_no)).toEqual([1, 2]);
    expect(Number(entries[0].from_location_id)).toBe(mixFromLocationId);
    expect(entries[0].to_location_id).toBeNull();
    expect(Number(entries[0].from_qty_after_transaction)).toBe(80);
    expect(entries[1].from_location_id).toBeNull();
    expect(Number(entries[1].to_location_id)).toBe(mixToLocationId);
    expect(Number(entries[1].to_qty_after_transaction)).toBe(35);
  });

  it('⭐ 원장 헤더가 조정을 가리킨다 — 판별자·원천 id·번호·영업일 · 공장은 라인 위치에서 역산한다', async () => {
    const fixture = await registered([lineAt({ locationId: postGeneralLocationId, adjustmentQty: -1 })]);
    const detail = await getDetail(fixture.inventoryAdjustmentId);

    await post(fixture).expect(200);

    const header = await prisma.inventory_transaction.findFirstOrThrow({
      where: { source_document_type_code: 'INVENTORY_ADJUSTMENT', source_document_id: fixture.inventoryAdjustmentId },
    });
    expect(header.transaction_type_code).toBe('INVENTORY_ADJUSTMENT');
    expect(header.transaction_no).toBe(detail.inventoryAdjustment.inventoryAdjustmentNo);
    expect(header.business_date.toISOString().slice(0, 10)).toBe(DAY);
    expect(header.occurred_at.toISOString()).toBe(AT);
    expect(Number(header.plant_id)).toBe(plantId);
    expect(header.idempotency_key).toBe(`INVENTORY_ADJUSTMENT:${detail.inventoryAdjustment.inventoryAdjustmentNo}`);
  });

  it('⭐ 라인이 두 공장에 걸친 전표는 전기가 400 INVALID 다 — 헤더 공장이 거짓을 적게 된다', async () => {
    // 등록 경로가 이미 막으므로 «저장된» 전표를 직접 심어야 이 갈래를 밟는다.
    const id = await seedTwoPlantAdjustment();

    const response = await request(app.getHttpServer())
      .post(`/api/inventory/adjustments/${id}:post`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ businessDate: DAY, occurredAt: AT });

    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'INVALID', field: 'lines[1].locationId' });
  });

  it('⭐ 되짚기 — inventory_adjustment_line 이 제 원장 라인을 가리킨다(응답에는 안 실린다)', async () => {
    const fixture = await registered([
      lineAt({ locationId: mixFromLocationId, adjustmentQty: -2 }),
      lineAt({ locationId: mixToLocationId, adjustmentQty: 3 }),
    ]);

    const response = await post(fixture).expect(200);

    expect(response.body).not.toHaveProperty('lines');
    const lines = await prisma.inventory_adjustment_line.findMany({
      where: { inventory_adjustment_id: fixture.inventoryAdjustmentId },
      orderBy: { line_no: 'asc' },
    });
    const entries = await ledgerOf(fixture.inventoryAdjustmentId);
    // ⭐ «자리»로 짝지어야 한다 — 어긋나면 라인이 남의 원장 줄을 가리킨다.
    expect(lines.map((row) => row.inventory_transaction_line_id)).toEqual(
      entries.map((row) => row.inventory_transaction_line_id),
    );
    expect(Number(entries[0].from_location_id)).toBe(mixFromLocationId);
    expect(Number(entries[1].to_location_id)).toBe(mixToLocationId);
  });

  it('⭐ POSTED · adjustedAt 이 본문 occurredAt · version_no 가 오른다 · 200 에 lines 도 ETag 도 없다', async () => {
    const fixture = await registered([lineAt({ locationId: postGeneralLocationId, adjustmentQty: -3 })]);

    const response = await post(fixture).expect(200);

    expect(response.body).toMatchObject({ statusCode: 'POSTED', adjustedAt: AT });
    expect(response.body.lines).toBeUndefined();
    // ⛔ ETag 를 «값»으로 재면 못 잡는다 — express 가 본문 해시로 `W/"…"` 를 늘 붙인다.
    //    `setEtag` 는 버전 «숫자»를 쓰므로, 숫자로 안 읽히는 것이 「안 내렸다」의 증거다.
    expect(response.headers.etag).toMatch(/^W\//);
    expect(Number(response.headers.etag)).toBeNaN();
    const after = await request(app.getHttpServer())
      .get(`/api/inventory/adjustments/${fixture.inventoryAdjustmentId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(Number(after.headers.etag)).toBe(fixture.versionNo + 1);
  });

  it('⭐ 재전기는 400 STATE_LOCKED · 같은 Idempotency-Key 재전송은 앞 응답 그대로고 원장이 1건이다', async () => {
    const fixture = await registered([lineAt({ locationId: postGeneralLocationId, adjustmentQty: -4 })]);
    const key = randomUUID();
    const first = await post(fixture, fixture.versionNo, key).expect(200);

    const replayed = await post(fixture, fixture.versionNo, key).expect(200);
    expect(replayed.body).toEqual(first.body);
    // ⛔ 응답만 보면 멱등을 우회해도 초록이다 — 원장을 «되읽어» 1건임을 잰다.
    expect(await ledgerOf(fixture.inventoryAdjustmentId)).toHaveLength(1);

    const again = await post(fixture, fixture.versionNo + 1);
    expect(again.status).toBe(400);
    expect(again.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('⭐ 보유보다 많이 빼면 400 NEGATIVE_BALANCE — 단 negative_stock_allowed 품목은 전기된다', async () => {
    const blocked = await registered([lineAt({ locationId: postGeneralLocationId, adjustmentQty: -600 })]);
    const refused = await post(blocked);
    expect(refused.status).toBe(400);
    expect(refused.body.errors[0]).toMatchObject({
      code: 'NEGATIVE_BALANCE',
      field: 'lines[0].adjustmentQty',
    });
    expect(await onHand(postGeneralLocationId)).toBeGreaterThan(0);

    // ⭐ 같은 형상인데 품목만 갈린다 — 잔액이 «음수»가 되어도 전기된다(화면 `W-01-12` §6).
    const allowed = await registered([
      lineAt({ locationId: negLocationId, itemId: negItemId, lotId: negLotId, adjustmentQty: -25 }),
    ]);
    await post(allowed).expect(200);
    expect(await onHand(negLocationId, negItemId, negLotId)).toBe(-15);
  });

  it('⭐ 승인 축 — 대기 중은 400 APPROVAL_IN_PROGRESS · 반려는 400 APPROVAL_REQUIRED · 무권한 403 · 승인 한 줄', async () => {
    const pendingFixture = await registered([lineAt({ locationId: postGeneralLocationId, adjustmentQty: -5 })]);
    const submitted = await requestApproval(pendingFixture).expect(202);
    const pending = await post(pendingFixture);
    expect(pending.status).toBe(400);
    expect(pending.body.errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });

    await decide('reject', submitted.body.approvalRequestId, { comment: '근거가 모자랍니다' });
    const rejected = await post(pendingFixture);
    expect(rejected.status).toBe(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'APPROVAL_REQUIRED' });

    const noPerm = await request(app.getHttpServer())
      .post(`/api/inventory/adjustments/${pendingFixture.inventoryAdjustmentId}:post`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(pendingFixture.versionNo))
      .send({ businessDate: DAY, occurredAt: AT });
    expect(noPerm.status).toBe(403);

    // ⭐ 한 줄 — 등록 → 상신 → 결재함 승인 → 전기 → 잔액이 준다.
    const flow = await registered([lineAt({ locationId: flowLocationId, adjustmentQty: -10 })]);
    const request2 = await requestApproval(flow).expect(202);
    await decide('approve', request2.body.approvalRequestId);
    await post(flow).expect(200);
    expect(await onHand(flowLocationId)).toBe(40);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /** 치환 본문 한 줄 — 등록의 `line()` 과 칸은 같고 배열 이름만 `items` 다. */
  function item(adjustmentQty: number): Record<string, unknown> {
    return { locationId, itemId, lotId, adjustmentQty, uomId };
  }

  /** 등록 API 로 `REGISTERED` 전표 한 벌 — 치환·상신이 다룰 대상이다. */
  async function registered(lines: Record<string, unknown>[] = [line(-2)]): Promise<Fixture> {
    const created = await create({ reasonCode: 'COUNT_VARIANCE', lines }).expect(201);
    return {
      inventoryAdjustmentId: created.body.inventoryAdjustment.inventoryAdjustmentId,
      versionNo: Number(created.headers.etag),
      lineIds: created.body.lines.map((row: { inventoryAdjustmentLineId: number }) => row.inventoryAdjustmentLineId),
    };
  }

  function replaceLines(fixture: Fixture, items: Record<string, unknown>[]): request.Test {
    return request(app.getHttpServer())
      .put(`/api/inventory/adjustments/${fixture.inventoryAdjustmentId}/lines`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(fixture.versionNo))
      .send({ items });
  }

  function requestApproval(fixture: Fixture, version = fixture.versionNo): request.Test {
    return request(app.getHttpServer())
      .post(`/api/inventory/adjustments/${fixture.inventoryAdjustmentId}:request-approval`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(version))
      .send({ reason: '재고 차이를 닫습니다' });
  }

  /** 결재함(`W-03-09`)의 두 오퍼레이션 — 승인자 계정으로 부른다(단계의 주인이라야 통한다). */
  async function decide(
    action: 'approve' | 'reject',
    approvalRequestId: number,
    body: object = {},
  ): Promise<request.Response> {
    const detail = await request(app.getHttpServer())
      .get(`/api/app/approval-requests/${approvalRequestId}`)
      .set('Cookie', approverCookie)
      .expect(200);
    return request(app.getHttpServer())
      .post(`/api/app/approval-requests/${approvalRequestId}:${action}`)
      .set('Cookie', approverCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', detail.headers.etag as string)
      .send(body)
      .expect(200);
  }

  /** 등록 본문 한 줄 — 위치·품목·수량을 시험마다 갈아 끼운다(전기가 잔액을 움직인다). */
  function lineAt(over: Record<string, unknown>): Record<string, unknown> {
    return { locationId, itemId, lotId, uomId, adjustmentQty: -2, ...over };
  }

  function post(fixture: Fixture, version = fixture.versionNo, key = randomUUID()): request.Test {
    return request(app.getHttpServer())
      .post(`/api/inventory/adjustments/${fixture.inventoryAdjustmentId}:post`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .set('If-Match', String(version))
      .send({ businessDate: DAY, occurredAt: AT });
  }

  async function onHand(location: number, item = itemId, lot = lotId): Promise<number> {
    const row = await prisma.inventory_balance.findFirstOrThrow({
      where: { location_id: location, item_id: item, lot_id: lot },
    });
    return Number(row.on_hand_qty);
  }

  /** 그 조정이 남긴 원장 라인 — `line_no` 오름차순. */
  async function ledgerOf(inventoryAdjustmentId: number) {
    const header = await prisma.inventory_transaction.findFirstOrThrow({
      where: {
        source_document_type_code: 'INVENTORY_ADJUSTMENT',
        source_document_id: inventoryAdjustmentId,
      },
    });
    return prisma.inventory_transaction_line.findMany({
      where: { inventory_transaction_id: header.inventory_transaction_id },
      orderBy: { line_no: 'asc' },
    });
  }

  async function getDetail(inventoryAdjustmentId: number): Promise<{ inventoryAdjustment: AdjustmentBody }> {
    const response = await request(app.getHttpServer())
      .get(`/api/inventory/adjustments/${inventoryAdjustmentId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body;
  }

  /** 등록이 막는 형상이라 손으로 심는다 — 번호 접두어가 cleanup 의 축이다. */
  async function seedTwoPlantAdjustment(): Promise<number> {
    const header = await prisma.inventory_adjustment.create({
      data: {
        inventory_adjustment_no: `IA-${PREFIX}-0003`,
        reason_code: 'COUNT_VARIANCE',
        status_code: 'REGISTERED',
        inventory_adjustment_line: {
          create: [mixFromLocationId, otherPlantLocationId].map((location_id, index) => ({
            line_no: index + 1,
            location_id,
            item_id: itemId,
            lot_id: lotId,
            quality_status_code: 'NORMAL',
            inventory_status_code: 'AVAILABLE',
            adjustment_qty: -1,
            uom_id: uomId,
            reason_code: 'COUNT_VARIANCE',
          })),
        },
      },
      select: { inventory_adjustment_id: true },
    });
    return Number(header.inventory_adjustment_id);
  }

  function line(adjustmentQty: number): Record<string, unknown> {
    return { locationId, itemId, lotId, adjustmentQty, uomId };
  }

  function create(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/api/inventory/adjustments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }

  async function list(query: string): Promise<{ items: AdjustmentBody[]; page: { page: number; size: number; total: number } }> {
    const response = await request(app.getHttpServer())
      .get(`/api/inventory/adjustments?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/adjustments');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '조정검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '조정검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '조정검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '조정검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    plantId = Number(plant.plant_id);
    warehouseId = Number(warehouse.warehouse_id);
    const makeLocation = async (suffix: string, warehouse_id: bigint): Promise<number> => {
      const row = await prisma.location.create({
        data: {
          warehouse_id,
          location_code: `${PREFIX}-LOC${suffix}`,
          location_name: `조정검사위치${suffix}`,
          location_type_code: 'BIN',
        },
      });
      return Number(row.location_id);
    };
    locationId = await makeLocation('', warehouse.warehouse_id);
    emptyLocationId = await makeLocation('-E', warehouse.warehouse_id);
    dualLocationId = await makeLocation('-D', warehouse.warehouse_id);
    postDownLocationId = await makeLocation('-PD', warehouse.warehouse_id);
    postUpLocationId = await makeLocation('-PU', warehouse.warehouse_id);
    mixFromLocationId = await makeLocation('-MA', warehouse.warehouse_id);
    mixToLocationId = await makeLocation('-MB', warehouse.warehouse_id);
    postGeneralLocationId = await makeLocation('-PG', warehouse.warehouse_id);
    flowLocationId = await makeLocation('-PF', warehouse.warehouse_id);
    negLocationId = await makeLocation('-NG', warehouse.warehouse_id);

    // 공장 단일 검사(결정 — 통보 133)용 두 번째 공장 한 벌.
    const plant2 = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P2`,
        plant_name: '조정검사공장2',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const warehouse2 = await prisma.warehouse.create({
      data: {
        plant_id: plant2.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '조정검사창고2',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    otherPlantLocationId = await makeLocation('-X', warehouse2.warehouse_id);

    // ⭐ 같은 «공장» · 다른 사업부 창고 — 400 이 공장 축만 본다는 것을 가른다(과잉 차단 금지).
    // ⚠ 사업부만 갈라야 한다 — 법인을 새로 세우면 창고의 법인과 «공장»의 법인이 어긋난 행이
    //   되고, 잔액의 법인 축은 공장에서 나오므로 검사하려던 갈래를 못 밟는다.
    const unit2 = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU2`,
        business_unit_name: '조정검사사업부2',
      },
    });
    const warehouse3 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit2.business_unit_id,
        warehouse_code: `${PREFIX}-WH3`,
        warehouse_name: '조정검사창고3',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    otherUnitWarehouseId = Number(warehouse3.warehouse_id);
    otherUnitLocationId = await makeLocation('-U', warehouse3.warehouse_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '조정검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: false,
        negative_stock_allowed: false,
      },
    });
    itemId = Number(item.item_id);
    // ⭐ 트리거 `check_balance_qty()` 둘째 갈래를 «반대로» 밟는 품목 — 화면 `W-01-12` §6 이
    //    「음수 재고가 되는 조정」을 인정한 자리다(I-4 는 이 축을 무시했다).
    const negItem = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT-NEG`,
        item_name: '조정검사품목음수',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: false,
        negative_stock_allowed: true,
      },
    });
    negItemId = Number(negItem.item_id);

    const count = await prisma.inventory_count.create({
      data: {
        inventory_count_no: `${PREFIX}-IC`,
        count_type_code: 'CYCLE',
        warehouse_id: warehouse.warehouse_id,
        planned_date: new Date('2026-06-01T00:00:00.000Z'),
        status_code: 'IN_PROGRESS',
      },
    });
    inventoryCountId = Number(count.inventory_count_id);
    const countLine = await prisma.inventory_count_line.create({
      data: {
        inventory_count_id: count.inventory_count_id,
        line_no: 1,
        location_id: locationId,
        item_id: itemId,
        system_qty: 100,
        counted_qty: 98,
        uom_id: uomId,
        counted_at: new Date(AT),
      },
    });
    inventoryCountLineId = Number(countLine.inventory_count_line_id);

    // 둘째 실사 한 벌 — 「남의 실사 라인을 가리켰나」를 가른다.
    const otherCount = await prisma.inventory_count.create({
      data: {
        inventory_count_no: `${PREFIX}-IC2`,
        count_type_code: 'CYCLE',
        warehouse_id: warehouse.warehouse_id,
        planned_date: new Date('2026-06-01T00:00:00.000Z'),
        status_code: 'IN_PROGRESS',
      },
    });
    const otherCountLine = await prisma.inventory_count_line.create({
      data: {
        inventory_count_id: otherCount.inventory_count_id,
        line_no: 1,
        location_id: locationId,
        item_id: itemId,
        system_qty: 100,
        counted_qty: 99,
        uom_id: uomId,
        counted_at: new Date(AT),
      },
    });
    otherCountLineId = Number(otherCountLine.inventory_count_line_id);

    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 200,
        uom_id: uomId,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    lotId = Number(lot.lot_id);
    const negLot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-NEG`,
        item_id: negItemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 20,
        uom_id: uomId,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    negLotId = Number(negLot.lot_id);
  }

  /**
   * ⭐ 잔액을 직접 INSERT 하지 않는다 — 트리거가 지키는 표라 손으로 넣으면 차원 11칸을
   * 우리가 맞춰야 하고, 그것이 등록이 되읽는 바로 그 값이다(I-14.md §10-2). 입고 API 를
   * 부른다. `-D` 위치에는 재고 상태를 갈라 «두 행»을 세운다.
   */
  async function makeBalances(): Promise<void> {
    await receive(locationId, 100, 'AVAILABLE');
    await receive(dualLocationId, 10, 'AVAILABLE');
    await receive(dualLocationId, 10, 'BLOCKED');
    await receive(otherUnitLocationId, 20, 'AVAILABLE', otherUnitWarehouseId);
    // 전기 시험 몫. ⭐ 여기서 선 원장(입고)이 「남의 전표의 원장 라인」이기도 하다 —
    // 되짚기의 `where: { inventory_transaction_id }` 를 잠그는 것이 그 행들이다.
    await receive(postDownLocationId, 40, 'AVAILABLE');
    await receive(postUpLocationId, 40, 'AVAILABLE');
    await receive(mixFromLocationId, 100, 'AVAILABLE');
    await receive(mixToLocationId, 30, 'AVAILABLE');
    await receive(postGeneralLocationId, 500, 'AVAILABLE');
    await receive(flowLocationId, 50, 'AVAILABLE');
    await receive(negLocationId, 10, 'AVAILABLE', warehouseId, negItemId, negLotId);
  }

  async function receive(
    destinationLocationId: number,
    receiptQty: number,
    inventoryStatusCode: string,
    intoWarehouseId = warehouseId,
    intoItemId = itemId,
    intoLotId = lotId,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        receiptTypeCode: 'MATERIAL',
        plantId,
        warehouseId: intoWarehouseId,
        receiptDatetime: AT,
        businessDate: DAY,
        lines: [
          {
            itemId: intoItemId,
            lotId: intoLotId,
            receiptQty,
            uomId,
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode,
            destinationLocationId,
          },
        ],
      })
      .expect(201);
  }

  /** 전기됨(inventoryCountId 로 이어짐) 한 벌 · 미전기 한 벌 — 목록 필터 축을 가른다. */
  async function makeAdjustments(): Promise<void> {
    const posted = await prisma.inventory_adjustment.create({
      data: {
        inventory_adjustment_no: `IA-${PREFIX}-0001`,
        inventory_count_id: inventoryCountId,
        reason_code: 'COUNT_VARIANCE',
        status_code: 'POSTED',
        adjusted_at: new Date('2026-06-01T02:00:00.000Z'),
      },
    });
    postedId = Number(posted.inventory_adjustment_id);
    await prisma.inventory_adjustment_line.create({
      data: {
        inventory_adjustment_id: posted.inventory_adjustment_id,
        line_no: 1,
        location_id: locationId,
        item_id: itemId,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        adjustment_qty: -2,
        uom_id: uomId,
        reason_code: 'COUNT_VARIANCE',
      },
    });

    const registered = await prisma.inventory_adjustment.create({
      data: {
        inventory_adjustment_no: `IA-${PREFIX}-0002`,
        reason_code: 'SYSTEM_ERROR_CORRECTION',
        status_code: 'REGISTERED',
      },
    });
    registeredId = Number(registered.inventory_adjustment_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '조정검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '조정검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    // 결재는 «단계의 주인»이라야 통한다 — 상신자와 다른 계정이 필요하다.
    const approver = await prisma.app_user.create({
      data: { login_id: APPROVER_ID, user_name: '조정결재자', status_code: 'EMPLOYED' },
    });
    approverUserId = approver.app_user_id;
    await prisma.user_credential.create({
      data: { app_user_id: approver.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const approverRole = await prisma.role.create({
      data: { role_code: APPROVER_ROLE, role_name: '조정결재용' },
    });
    await prisma.role_permission.createMany({
      data: APPROVER_PERMISSIONS.map((permission_code) => ({
        role_id: approverRole.role_id,
        permission_code,
      })),
    });
    await prisma.user_role.create({
      data: { app_user_id: approver.app_user_id, role_id: approverRole.role_id },
    });
    approverCookie = await login(APPROVER_ID);
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
   * ⚠ `inventory_adjustment_line.inventory_transaction_line_id` FK 때문에 뒤 스위트
   * (`inventory-balance`·`inventory-posting`·`inventory-transaction`)의 cleanup 이 도는
   * `TRUNCATE … CASCADE` 가 조정 라인까지 비운다(I-14.md §10-1). 우리는 앞선 스위트가
   * 남긴 것과 무관하게 우리 접두어(`IA-{PREFIX}-`)로만 지운다.
   */
  async function cleanup(): Promise<void> {
    // ⭐ 조정부터 지우고 «그 다음» TRUNCATE 한다 — 등록 오퍼레이션이 만든 전표는
    //    `IA-{YYYYMMDD}-` 채번을 받아 접두어로 못 짚고, TRUNCATE 의 CASCADE 가 라인을
    //    통째로 비우면 헤더가 고아로 남아 다음 회차의 실사·마스터 삭제를 막는다.
    //    짚는 축 셋: 우리 계정이 만든 것 · 우리 실사에 매달린 것 · 손으로 심은 번호.
    const isMine = `created_by IN (SELECT app_user_id FROM app.app_user
                                    WHERE login_id IN ('${LOGIN_ID}', '${NOPERM_ID}'))
                    OR inventory_count_id IN (SELECT inventory_count_id FROM inventory.inventory_count
                                               WHERE inventory_count_no LIKE '${PREFIX}%')
                    OR inventory_adjustment_no LIKE 'IA-${PREFIX}-%'`;
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_adjustment_line WHERE inventory_adjustment_id IN
        (SELECT inventory_adjustment_id FROM inventory.inventory_adjustment WHERE ${isMine})`,
    );
    // ⭐ 승인 요청 FK 를 먼저 끊는다 — 전표를 지운 «뒤»라야 요청 행을 지울 수 있다.
    await prisma.$executeRawUnsafe(
      `UPDATE inventory.inventory_adjustment SET approval_request_id = NULL WHERE ${isMine}`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_adjustment WHERE ${isMine}`,
    );
    const owners = `SELECT app_user_id FROM app.app_user
                     WHERE login_id IN ('${LOGIN_ID}', '${NOPERM_ID}', '${APPROVER_ID}')`;
    await prisma.$executeRawUnsafe(
      `DELETE FROM app.approval_step WHERE approval_request_id IN
        (SELECT approval_request_id FROM app.approval_request WHERE requested_by IN (${owners}))`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM app.approval_request WHERE requested_by IN (${owners})`,
    );
    // seedRoute 가 심은 결재선. 단계는 승인자를 짚으므로 사용자보다 먼저 지운다.
    await prisma.$executeRawUnsafe(
      `DELETE FROM app.approval_route_step WHERE approver_user_id IN (${owners})`,
    );
    if (routeIds.length > 0) {
      await prisma.approval_route.deleteMany({ where: { approval_route_id: { in: routeIds } } });
      routeIds.length = 0;
    }
    // ⚠ 뒤 스위트(`inventory-balance`·`inventory-posting`·`inventory-transaction`)와 같은
    //    TRUNCATE 를 돈다 — 우리 앞 스위트가 남긴 것을 지운다(I-14.md §10-1).
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_count_line WHERE inventory_count_id IN
        (SELECT inventory_count_id FROM inventory.inventory_count
          WHERE inventory_count_no LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_count WHERE inventory_count_no LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.putaway_task WHERE item_id IN
        (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN
        (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_balance WHERE warehouse_id IN
        (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    for (const id of [LOGIN_ID, NOPERM_ID, APPROVER_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    for (const code of [ROLE, APPROVER_ROLE]) {
      const role = await prisma.role.findUnique({ where: { role_code: code } });
      if (!role) continue;
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
