/**
 * LOT — 추적성의 뿌리. 화면 `M-01-02`·`P-01-01`.
 *
 * ⭐ 이 스위트가 못 박는 것 셋 — 번호 출처 둘의 «실패가 서로 다르다» · 서버가 스스로
 * 보류를 건다 · **원장이 움직인 LOT 은 수량을 못 바꾼다**(A1 이 세운 표를 되읽는다).
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
import { InventoryPostingModule, InventoryPostingService } from '../src/core/inventory-posting';
import { PostingEndpoint } from '../src/core/inventory-posting/posting.types';
import { LOT_NO_LENGTH } from '../src/core/lot/lot-number';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedRoute } from './approval-request.fixture';

const LOGIN_ID = 'e2e-lot-probe';
const NOPERM_ID = 'e2e-lot-noperm';
const PASSWORD = 'LOT-검사-비밀번호';
const PREFIX = 'LOTE2E';
/**
 * ⛔ 자재 MES LOT 번호(`materialMesLotNo`)가 품목 코드를 **9자리 숫자**, 공급사 코드를
 * **6자리 숫자**로 «그대로» 담는다. `LOTE2E-…` 같은 코드는 400 이 된다 — 그래서 이 둘만
 * 숫자로 둔다. 다른 마스터 코드는 PREFIX 를 그대로 쓴다.
 */
const ITEM_CODE = '900000001';
const SUPPLIER_CODE = '900001';
const ROLE = 'E2E_LOT';
const PERMISSIONS = ['M-01-02', 'P-01-01', 'M-01-04', 'M-01-13'];
const DAY = '2026-05-01';

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

const key = (): string => randomUUID();

interface LotBody {
  lotId: number;
  lotNo: string;
  statusCode: string;
  held: boolean;
  initialQty: number;
}

describe('LOT (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let posting: InventoryPostingService;
  let cookie: string[];
  let noPermCookie: string[];
  // PR ② — 상신 주체와 `IQC_SKIP` 결재선(DB 에 0행이라 픽스처가 세운다 · 시드는 안 고친다).
  let probeUserId: bigint;
  let iqcRouteId: bigint;

  let plantId: number;
  let itemId: number;
  let uomId: number;
  let here: PostingEndpoint;
  let inboundReceiptId: bigint;
  let lineNo = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, InventoryPostingModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    posting = app.get(InventoryPostingService);

    await cleanup();
    await makeUsers();
    await makeMasters();
    iqcRouteId = await seedRoute(prisma, 'IQC_SKIP', [probeUserId]);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/trace/lots')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(await body({ numberSourceCode: 'MES' }))
      .expect(403);
  });

  it('⛔ SUPPLIER 인데 번호가 없으면 400 이다', async () => {
    const rejected = await post(await body({ numberSourceCode: 'SUPPLIER' })).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'lotNo', code: 'REQUIRED' });
  });

  it('⛔ MES 인데 번호를 보내면 400 이다', async () => {
    const rejected = await post(
      await body({ numberSourceCode: 'MES', lotNo: `${PREFIX}-손으로` }),
    ).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'lotNo', code: 'INVALID' });
  });

  it('⭐ SUPPLIER 는 스캔값이 그대로 번호가 된다', async () => {
    const lot = await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-SCAN-1` });
    expect(lot.lotNo).toBe(`${PREFIX}-SCAN-1`);
  });

  it('⛔ 같은 공장에 같은 번호는 400 이다 — 재시도해도 안 풀린다', async () => {
    await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-DUP` });

    const rejected = await post(
      await body({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-DUP` }),
    ).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'lotNo',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['plantId', 'lotNo'],
    });
  });

  it('⭐ MES 는 서버가 34자리로 매긴다 — 화면은 번호를 안 보낸다', async () => {
    const first = await create({ numberSourceCode: 'MES' });
    const second = await create({ numberSourceCode: 'MES' });

    expect(first.lotNo).toHaveLength(LOT_NO_LENGTH);
    expect(second.lotNo).toHaveLength(LOT_NO_LENGTH);
    expect(first.lotNo).not.toBe(second.lotNo);
    // ⛔ 「M 으로 시작한다」가 아니다 — 입하에서 난 자재 LOT 은 `materialMesLotNo` 가 매기고
    // 품목 코드 9자리로 «시작한다»(생산 LOT 만 기존 `mesLotNo` 의 M 체계를 쓴다 · #610).
    expect(first.lotNo.startsWith(ITEM_CODE)).toBe(true);
    expect(second.lotNo.startsWith(ITEM_CODE)).toBe(true);
    // 34자리가 전부 숫자다 — 모바일 스캔 화면의 정본 형식.
    expect(first.lotNo).toMatch(/^\d{34}$/);
  });

  it('⭐ 등록 즉시 보류가 걸린다 — 화면이 보내지 않고 서버가 건다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    expect(lot.held).toBe(true);

    const holds = await prisma.lot_hold.findMany({ where: { lot_id: lot.lotId } });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ reason_code: 'INCOMING_INSPECTION_WAIT', released_at: null });
  });

  /**
   * ⭐⭐ R-9 회귀(I-20 PR ②a) + **PR ③ 2-5** — `holdView()` 는 `lotStatusCode` 를 `lot.status_code`
   * (지금 상태)가 아니라 `lot_hold.target_lot_status_code`(등록 때 간 상태)로 채운다. PR ③ 이
   * 코어(`lot-registry.service.ts:96`)에 그 칸을 채우게 해서 **오늘 태어난 보류는 값을 갖는다**.
   * ⛔ 백필은 없다(마이그 0) — PR ③ 이전에 태어난 옛 보류는 칸이 영구히 비고, 널 금지라
   * **키가 생략된다**. 마지막 단언이 그 갈래를 함께 잠근다.
   */
  it('⭐⭐ R-9 — 보류의 lotStatusCode 는 target_lot_status_code 다(lot.status_code 의 「지금」이 아니다)', async () => {
    const lot = await create({ numberSourceCode: 'MES' });

    const before = await detailOf(lot.lotId);
    const hold = before.holds[0] as { lotHoldId: number; lotStatusCode?: string };
    expect(hold.lotStatusCode).toBe('INSPECTION_PENDING'); // ⭐ 2-5 — 코어가 등록 때 채운다

    await prisma.lot.update({ where: { lot_id: BigInt(lot.lotId) }, data: { status_code: 'NORMAL' } });

    const after = await detailOf(lot.lotId);
    const movedHold = after.holds[0] as { lotStatusCode?: string };
    expect(after.lot.statusCode).toBe('NORMAL'); // LOT 은 옮겨졌다
    expect(movedHold.lotStatusCode).toBe('INSPECTION_PENDING'); // 그래도 「등록 때」 값 그대로 — lot.status_code 를 베끼면 'NORMAL' 이 나와 깨진다

    await prisma.lot_hold.update({
      where: { lot_hold_id: BigInt(hold.lotHoldId) },
      data: { target_lot_status_code: null },
    });
    const legacy = await detailOf(lot.lotId);
    expect(legacy.holds[0]).not.toHaveProperty('lotStatusCode'); // 옛 행(백필 안 함) — 널 금지로 키 생략
  });

  it('⭐ 등록하면 상태가 검사 대기다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    expect(lot.statusCode).toBe('INSPECTION_PENDING');
  });

  it('⭐ 외부 식별자를 함께 받는다', async () => {
    const lot = await create({
      numberSourceCode: 'SUPPLIER',
      lotNo: `${PREFIX}-EXT`,
      externalIdentifiers: [
        { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-SUP-9` },
      ],
    });

    const detail = await detailOf(lot.lotId);
    expect(detail.externalIdentifiers).toHaveLength(1);
    expect(detail.externalIdentifiers[0]).toMatchObject({
      identifierTypeCode: 'SUPPLIER_LOT',
      externalIdentifier: `${PREFIX}-SUP-9`,
    });
  });

  it('⛔ 마스터에 없는 식별자 유형은 400 이다', async () => {
    await post(
      await body({
        numberSourceCode: 'SUPPLIER',
        lotNo: `${PREFIX}-BADEXT`,
        externalIdentifiers: [
          { identifierTypeCode: '없는유형', externalIdentifier: 'x' },
        ],
      }),
    ).expect(400);
  });

  it('⭐ 상세가 «해제되지 않은» 보류만 준다 — 푼 것은 이력이지 지금이 아니다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    expect((await detailOf(lot.lotId)).holds).toHaveLength(1);

    await release(lot.lotId);

    const after = await detailOf(lot.lotId);
    expect(after.holds).toHaveLength(0);
    expect(after.lot.held).toBe(false);
  });

  it('⭐ 목록이 계약 스키마를 만족한다', async () => {
    await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-LIST` });
    const body = await list(`plantId=${plantId}`);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('⭐ lotNo 는 정확 일치다 — 스캔값 하나로 한 건을 집는다', async () => {
    await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-EXACT-1` });
    await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-EXACT-12` });

    const exact = await list(`lotNo=${PREFIX}-EXACT-1`);
    expect(exact.items.map((l) => l.lotNo)).toEqual([`${PREFIX}-EXACT-1`]);
  });

  it('⭐ q 는 번호와 외부 식별자를 함께 본다', async () => {
    const lot = await create({
      numberSourceCode: 'SUPPLIER',
      lotNo: `${PREFIX}-QNO`,
      externalIdentifiers: [
        { identifierTypeCode: 'ERP_LOT', externalIdentifier: `${PREFIX}-찾을값` },
      ],
    });

    const byIdentifier = await list(`q=${encodeURIComponent(`${PREFIX}-찾을값`)}`);
    expect(byIdentifier.items.map((l) => l.lotId)).toContain(lot.lotId);

    const byNo = await list(`q=${PREFIX}-QNO`);
    expect(byNo.items.map((l) => l.lotId)).toContain(lot.lotId);
  });

  it('⭐ heldOnly 가 보류 중인 것만 준다', async () => {
    const held = await create({ numberSourceCode: 'MES' });
    const released = await create({ numberSourceCode: 'MES' });
    await release(released.lotId);

    const ids = (await list(`plantId=${plantId}&heldOnly=true`)).items.map((l) => l.lotId);
    expect(ids).toContain(held.lotId);
    expect(ids).not.toContain(released.lotId);
  });

  it('⛔ 원장이 움직인 LOT 은 수량을 바꿀 수 없다 — A1 이 세운 표를 되읽는다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const etag = await etagOf(lot.lotId);

    await prisma.$transaction((tx) =>
      posting.post(tx, {
        businessDate: DAY,
        occurredAt: new Date(`${DAY}T02:00:00.000Z`),
        transactionTypeCode: 'RECEIPT',
        transactionNo: `${PREFIX}-GR-${lot.lotId}`,
        statusCode: 'POSTED',
        plantId,
        sourceDocumentTypeCode: 'GOODS_RECEIPT',
        sourceDocumentId: 1,
        idempotencyKey: `${PREFIX}-${randomUUID()}`,
        lines: [{ itemId, lotId: lot.lotId, qty: 5, uomId, to: here, ownershipTypeCode: 'OWNED' }],
      }),
    );

    const rejected = await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ initialQty: 99 })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'initialQty',
      code: 'STATE_LOCKED',
    });
  });

  it('⭐ 원장이 안 움직였으면 수량을 고칠 수 있다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const etag = await etagOf(lot.lotId);

    const updated = await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ initialQty: 42, remarks: '고침' })
      .expect(200);
    expect(updated.body.lot.initialQty).toBe(42);
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);
  });

  it('⛔ 수정이 If-Match 를 쓰고, 낡은 값은 409 다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const etag = await etagOf(lot.lotId);

    await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ initialQty: 7 })
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ initialQty: 8 })
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⛔ 없는 sourceId 는 400 INVALID 다 — 고아 참조를 더 이상 안 받는다', async () => {
    const rejected = await post(
      await body({ numberSourceCode: 'MES', sourceId: 999999999 }),
    ).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'sourceId', code: 'INVALID' });
  });

  it('⛔ 없는 LOT 은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/trace/lots/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⭐ 외부식별자 목록이 등록 때 넣은 식별자를 id 오름차순으로 준다', async () => {
    const lot = await create({
      numberSourceCode: 'SUPPLIER',
      lotNo: `${PREFIX}-EXTLIST`,
      externalIdentifiers: [
        { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-EL-1` },
        { identifierTypeCode: 'ERP_LOT', externalIdentifier: `${PREFIX}-EL-2` },
      ],
    });

    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lot.lotId}/external-identifiers`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /trace/lots/{lotId}/external-identifiers');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.items.map((i: { identifierTypeCode: string }) => i.identifierTypeCode)).toEqual([
      'SUPPLIER_LOT',
      'ERP_LOT',
    ]);
  });

  it('⭐ 식별자가 없는 LOT 은 빈 목록이다 — 404 가 아니다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });

    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lot.lotId}/external-identifiers`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body).toEqual({ items: [] });
  });

  it('⛔ 없는 LOT 의 외부식별자 목록은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/trace/lots/999999999/external-identifiers')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⭐ 보류 목록 기본값은 해제되지 않은 것만 준다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    // 등록이 이미 건 보류(해제 안 됨) 1건에, 해제된 보류 1건을 더 심는다.
    await prisma.lot_hold.create({
      data: {
        lot_id: BigInt(lot.lotId),
        reason_code: 'INCOMING_INSPECTION_WAIT',
        status_code: 'HELD',
        held_at: new Date(),
        released_at: new Date(),
        release_reason_code: 'INSPECTION_PASSED',
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lot.lotId}/holds`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /trace/lots/{lotId}/holds');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // ⭐ R-6 — 배열을 통째로 단언하지 않는다. 우리가 소유한 칸만 본다.
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].releasedAt).toBeNull();
  });

  it('⭐ activeOnly=false 는 「해제된 것만」이 아니라 «전체»다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    await prisma.lot_hold.create({
      data: {
        lot_id: BigInt(lot.lotId),
        reason_code: 'INCOMING_INSPECTION_WAIT',
        status_code: 'HELD',
        held_at: new Date(),
        released_at: new Date(),
        release_reason_code: 'INSPECTION_PASSED',
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lot.lotId}/holds?activeOnly=false`)
      .set('Cookie', cookie)
      .expect(200);
    // ⭐ R-6 — 길이만 본다(내용 전체를 박지 않는다).
    expect(response.body.items).toHaveLength(2);
  });

  it('⭐ R-5 — 보류 정렬은 `heldAt desc` · 동률은 `lotHoldId desc` 로 닫는다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    // 등록이 만든 보류보다 «나중»이면서 서로 «동률»인 둘 — 방향과 2차 키를 함께 잠근다.
    const tie = new Date(Date.now() + 60_000);
    for (let i = 0; i < 2; i += 1) {
      await prisma.lot_hold.create({
        data: {
          lot_id: BigInt(lot.lotId),
          reason_code: 'INCOMING_INSPECTION_WAIT',
          status_code: 'HELD',
          held_at: tie,
        },
      });
    }

    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lot.lotId}/holds?activeOnly=false`)
      .set('Cookie', cookie)
      .expect(200);

    const items = response.body.items as { lotHoldId: number; heldAt: string }[];
    expect(items).toHaveLength(3);
    // ⑤ 방향 — desc 를 asc 로 되돌리면 깨진다.
    expect(new Date(items[1].heldAt).getTime()).toBeGreaterThan(new Date(items[2].heldAt).getTime());
    // ⑥ 2차 키 — 동률 두 행은 lotHoldId 가 큰 쪽이 앞이다. 2차 키를 빼면 순서가 흔들린다.
    expect(items[0].lotHoldId).toBeGreaterThan(items[1].lotHoldId);
  });

  it('⭐ 보류 목록의 첫 행이 상세 GET 의 첫 보류와 완전히 같다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const detail = await detailOf(lot.lotId);

    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lot.lotId}/holds`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items[0]).toEqual(detail.holds[0]);
  });

  it('⛔ 없는 LOT 의 보류 목록은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/trace/lots/999999999/holds')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── PR ② 쓰기 2건 ───────────────────────────────────────────────────────

  it('⭐ 외부식별자 치환 — 빠진 기존 행이 사라지고 부모 ETag 가 +1 이다', async () => {
    const lot = await create({
      numberSourceCode: 'SUPPLIER',
      lotNo: `${PREFIX}-EXTPUT`,
      externalIdentifiers: [
        { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-P-1` },
        { identifierTypeCode: 'ERP_LOT', externalIdentifier: `${PREFIX}-P-2` },
      ],
    });
    const etag = await etagOf(lot.lotId);

    const replaced = await putIdentifiers(lot.lotId, etag, [
      { identifierTypeCode: 'CUSTOMER_LOT', externalIdentifier: `${PREFIX}-P-3` },
    ]).expect(200);
    const validate = validator('PUT /trace/lots/{lotId}/external-identifiers');
    expect(validate(replaced.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // ⭐ R-6 — 우리가 소유한 칸만 본다(배열을 통째로 박지 않는다).
    expect(
      replaced.body.items.map((i: { externalIdentifier: string }) => i.externalIdentifier),
    ).toEqual([`${PREFIX}-P-3`]);
    // 치환 응답과 조회가 같은 뷰·같은 정렬을 쓴다.
    expect(await identifiersOf(lot.lotId)).toEqual(replaced.body);
    // ⭐ 부모의 토큰이 옮겨진다 — 상세 GET 이 `externalIdentifiers` 를 싣기 때문이다.
    expect(Number(await etagOf(lot.lotId))).toBe(Number(etag) + 1);
  });

  it('⭐ 0행 치환은 전건 삭제다 — 계약이 minItems 를 안 걸었다', async () => {
    const lot = await create({
      numberSourceCode: 'SUPPLIER',
      lotNo: `${PREFIX}-EXTZERO`,
      externalIdentifiers: [
        { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-Z-1` },
      ],
    });

    const emptied = await putIdentifiers(lot.lotId, await etagOf(lot.lotId), []).expect(200);
    expect(emptied.body).toEqual({ items: [] });
    expect(await identifiersOf(lot.lotId)).toEqual({ items: [] });
  });

  it('⭐ 같은 멱등 키의 재전송은 한 번만 반영된다 — 버전이 두 번 오르지 않는다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const etag = await etagOf(lot.lotId);
    const items = [{ identifierTypeCode: 'ERP_LOT', externalIdentifier: `${PREFIX}-IDEM` }];
    const idempotencyKey = key();

    const first = await putIdentifiers(lot.lotId, etag, items, idempotencyKey).expect(200);
    const again = await putIdentifiers(lot.lotId, etag, items, idempotencyKey).expect(200);

    expect(again.body).toEqual(first.body);
    expect(Number(await etagOf(lot.lotId))).toBe(Number(etag) + 1);
    expect(await prisma.lot_external_identifier.count({ where: { lot_id: lot.lotId } })).toBe(1);
  });

  it('⛔ 치환의 If-Match 는 필수고, 낡은 값은 409 다 — 없는 LOT 은 404 다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const etag = await etagOf(lot.lotId);

    await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}/external-identifiers`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ items: [] })
      .expect(400);

    await putIdentifiers(lot.lotId, etag, []).expect(200);
    const stale = await putIdentifiers(lot.lotId, etag, []).expect(409);
    expect(stale.body.conflictCause).toBe('user');

    // ⛔ 없는 LOT 은 409 가 아니라 404 다 — 잠금 문장이 0행인 것과 버전이 어긋난 것은 다르다.
    await putIdentifiers(999999999, etag, []).expect(404);
  });

  it('⛔ 요청 «안» 5칸 중복은 400 UNIQUE_VIOLATION · partnerId 만 다르면 통과한다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const supplier = await prisma.partner.findFirstOrThrow({
      where: { partner_code: SUPPLIER_CODE },
    });
    const same = { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-DUPID` };

    const rejected = await putIdentifiers(lot.lotId, await etagOf(lot.lotId), [
      same,
      same,
    ]).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'items.1.externalIdentifier',
      code: 'UNIQUE_VIOLATION',
    });

    // ⭐ 표현식 인덱스의 `COALESCE(partner_id,0)` 축 — 널과 값은 다른 행이다.
    const accepted = await putIdentifiers(lot.lotId, await etagOf(lot.lotId), [
      { ...same, partnerId: Number(supplier.partner_id) },
      { ...same, partnerId: null },
    ]).expect(200);
    expect(accepted.body.items).toHaveLength(2);
    // 삽입 순서 = id 오름차순(계획 §3-2 ⓔ). 재조회 정렬이 뒤집히면 여기서 깨진다 —
    // 같은 자원이 치환 응답과 목록 조회에서 반대 순서로 보이는 것을 막는다.
    expect(
      accepted.body.items.map((item: { partnerId?: number }) => item.partnerId ?? null),
    ).toEqual([Number(supplier.partner_id), null]);
  });

  it('⛔ 마스터에 없는 유형·없는 거래처는 400 INVALID 다 — FK 위반이 500 으로 새지 않는다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });

    const badCode = await putIdentifiers(lot.lotId, await etagOf(lot.lotId), [
      { identifierTypeCode: 'NO_SUCH_TYPE', externalIdentifier: `${PREFIX}-BAD` },
    ]).expect(400);
    expect(badCode.body.errors[0]).toMatchObject({
      field: 'items.0.identifierTypeCode',
      code: 'INVALID',
    });

    const badPartner = await putIdentifiers(lot.lotId, await etagOf(lot.lotId), [
      { identifierTypeCode: 'ERP_LOT', externalIdentifier: `${PREFIX}-BAD2`, partnerId: 999999999 },
    ]).expect(400);
    expect(badPartner.body.errors[0]).toMatchObject({
      field: 'items.0.partnerId',
      code: 'INVALID',
    });
  });

  it('⭐ IQC 생략 요청은 202 다 — 다형 축 세 칸이 서고 LOT 은 그대로다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });

    const accepted = await requestIqcSkip(lot.lotId).expect(202);
    const validate = validator('POST /trace/lots/{lotId}:request-iqc-skip', 202);
    expect(validate(accepted.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const row = await prisma.approval_request.findUniqueOrThrow({
      where: { approval_request_id: BigInt(accepted.body.approvalRequestId) },
    });
    expect(row).toMatchObject({
      approval_type_code: 'IQC_SKIP',
      target_type_code: 'INBOUND_LOT',
      target_id: BigInt(lot.lotId),
      status_code: 'PENDING',
      requested_by: probeUserId,
    });
    // ⛔ 대상 행에 아무것도 안 쓴다 — 승인 FK 칸이 없고 202 에 ETag 도 없다.
    const after = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lot.lotId } });
    expect(after.version_no).toBe(1);
    // ⛔ 「진행 중 요청은 하나」 — 코어가 두 번째 상신을 막는다.
    const twice = await requestIqcSkip(lot.lotId).expect(400);
    expect(twice.body.errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });
  });

  it('⛔ 사번 헤더가 없으면 400 REQUIRED · 결재선이 없으면 400 ROUTE_NOT_FOUND 다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });

    const noWorker = await requestIqcSkip(lot.lotId, { workerNo: null }).expect(400);
    expect(noWorker.body.errors[0]).toMatchObject({ field: 'X-Worker-No', code: 'REQUIRED' });

    // §3-3 7행 — 없는 LOT 은 404 다. 이 갈래를 지우면 자격 검사가 null 을 만나 500 이 샌다.
    await requestIqcSkip(999999999).expect(404);

    // 결재선을 잠시 내린다 — 오늘 DB 에 `IQC_SKIP` 결재선이 0행이라 이 400 이 기본값이다.
    // ⚠ 되돌리기는 `finally` 다 — 중간에 깨지면 뒤의 상신 테스트가 통째로 400 이 된다.
    await setRouteActive(false);
    try {
      const noRoute = await requestIqcSkip(lot.lotId).expect(400);
      expect(noRoute.body.errors[0]).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    } finally {
      await setRouteActive(true);
    }
  });

  it('⭐ 자격 두 축은 «서로 다른» 코드로 갈린다 — 원천 INVALID · 상태 STATE_LOCKED', async () => {
    const notInbound = await create({ numberSourceCode: 'MES' });
    await prisma.lot.update({
      where: { lot_id: notInbound.lotId },
      data: { source_type_code: 'WORK_ORDER' },
    });
    const notPending = await create({ numberSourceCode: 'MES' });
    await prisma.lot.update({
      where: { lot_id: notPending.lotId },
      data: { status_code: 'NORMAL' },
    });

    // 두 LOT 을 다 세운 «뒤» 채번 카운터를 집는다 — LOT 채번은 여기 셈에서 빠져야 한다.
    const counters = async () =>
      (await prisma.numbering_counter.aggregate({ _sum: { last_value: true } }))._sum.last_value ??
      0n;
    const before = await counters();

    const bySource = await requestIqcSkip(notInbound.lotId).expect(400);
    expect(bySource.body.errors[0]).toMatchObject({ field: 'lotId', code: 'INVALID' });

    const byStatus = await requestIqcSkip(notPending.lotId).expect(400);
    expect(byStatus.body.errors[0]).toMatchObject({ field: 'lotId', code: 'STATE_LOCKED' });

    // ⭐ 결번도 없다 — 채번을 자격 검사 «위»로 옮기면 카운터가 2 올라 여기서 깨진다
    //    (계획 §3-1 3 · I-24 R-6). 행 개수만 세면 채번 순서를 못 본다.
    expect(await counters()).toBe(before);
    expect(
      await prisma.approval_request.count({
        where: { target_type_code: 'INBOUND_LOT', target_id: BigInt(notInbound.lotId) },
      }),
    ).toBe(0);
  });

  it('⛔ 권한이 없으면 쓰기 둘 다 403 이다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const etag = await etagOf(lot.lotId);

    await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}/external-identifiers`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ items: [] })
      .expect(403);

    await requestIqcSkip(lot.lotId, { as: noPermCookie }).expect(403);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /**
   * ⚠ `sourceId` 는 «실재하는» 입하 라인이어야 한다 — 등록이 그 라인의 `lot_id` 를 채운다.
   * 라인 하나에 LOT 은 하나라 호출마다 새 라인을 심는다.
   */
  async function body(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      itemId,
      lotTypeCode: 'MATERIAL',
      plantId,
      initialQty: 10,
      uomId,
      sourceTypeCode: 'INBOUND_RECEIPT_LINE',
      sourceId: await newLine(),
      businessDate: DAY,
      occurredAt: `${DAY}T02:00:00.000Z`,
      ...extra,
    };
  }

  async function newLine(): Promise<number> {
    lineNo += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: inboundReceiptId,
        line_no: lineNo,
        item_id: BigInt(itemId),
        received_qty: 10,
        uom_id: BigInt(uomId),
        supplier_lot_label_attached: false,
        inspection_required: false,
        status_code: 'REGISTERED',
      },
    });
    return Number(line.inbound_receipt_line_id);
  }

  function post(payload: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/api/trace/lots')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(payload);
  }

  /** ⚠ 201 은 `Lot` 이 아니라 상세 봉투(`lot`·`externalIdentifiers`·`holds`)를 준다. */
  async function create(extra: Record<string, unknown>): Promise<LotBody> {
    const created = await post(await body(extra)).expect(201);
    const validate = validator('POST /trace/lots', 201);
    expect(validate(created.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return created.body.lot as LotBody;
  }

  async function detailOf(
    lotId: number,
  ): Promise<{ lot: LotBody; externalIdentifiers: { identifierTypeCode: string }[]; holds: unknown[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lotId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /trace/lots/{lotId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  /**
   * ⛔ 보류 해제는 «사유»가 함께 있어야 한다 — `ck_lot_hold_release_reason` 이 그 짝을
   * 지킨다(해제 전에는 비어 있고 해제되면 반드시 있다). 해제 경로는 아직 없어 표를 민다.
   */
  async function release(lotId: number): Promise<void> {
    await prisma.lot_hold.updateMany({
      where: { lot_id: lotId },
      data: { released_at: new Date(), release_reason_code: 'INSPECTION_PASSED' },
    });
  }

  async function etagOf(lotId: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lotId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  /** 치환 호출 — If-Match 는 부모 상세 GET 의 ETag 다(계약 B-1-1). */
  function putIdentifiers(
    lotId: number,
    etag: string,
    items: Record<string, unknown>[],
    idempotencyKey: string = key(),
  ): request.Test {
    return request(app.getHttpServer())
      .put(`/api/trace/lots/${lotId}/external-identifiers`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .set('If-Match', etag)
      .send({ items });
  }

  async function identifiersOf(lotId: number): Promise<unknown> {
    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lotId}/external-identifiers`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body;
  }

  async function setRouteActive(isActive: boolean): Promise<void> {
    await prisma.approval_route.update({
      where: { approval_route_id: iqcRouteId },
      data: { is_active: isActive },
    });
  }

  /** ⚠ `workerNo: null` 이면 헤더를 아예 안 보낸다 — 그 자리가 400 `REQUIRED` 다. */
  function requestIqcSkip(
    lotId: number,
    opts: { workerNo?: string | null; as?: string[] } = {},
  ): request.Test {
    const call = request(app.getHttpServer())
      .post(`/api/trace/lots/${lotId}:request-iqc-skip`)
      .set('Cookie', opts.as ?? cookie)
      .set('Idempotency-Key', key());
    if (opts.workerNo !== null) call.set('X-Worker-No', opts.workerNo ?? 'W-0001');
    return call.send({ reason: '긴급 출하분 IQC 생략' });
  }

  async function list(query: string): Promise<{ items: LotBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /trace/lots');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: 'LOT검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: 'LOT검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: 'LOT검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: {
        item_code: ITEM_CODE,
        item_name: 'LOT검사품목',
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
        warehouse_name: 'LOT검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: 'LOT검사위치',
        location_type_code: 'BIN',
      },
    });
    here = {
      warehouseId: Number(warehouse.warehouse_id),
      locationId: Number(location.location_id),
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
    };

    // 등록이 채우는 `inbound_receipt_line.lot_id` 의 상대 — 등록 경로가 없어 직접 심는다.
    const supplier = await prisma.partner.create({
      data: { partner_code: SUPPLIER_CODE, partner_name: 'LOT검사공급사' },
    });
    const receipt = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`,
        supplier_id: supplier.partner_id,
        plant_id: plant.plant_id,
        receipt_datetime: new Date(`${DAY}T02:00:00.000Z`),
        status_code: 'REGISTERED',
      },
    });
    inboundReceiptId = receipt.inbound_receipt_id;
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'LOT검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    probeUserId = user.app_user_id;
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'LOT검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
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

  /** ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — 재고 스위트들과 같은 이유다. */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code = '${ITEM_CODE}')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot_external_identifier
       WHERE lot_id IN (SELECT lot_id FROM trace.lot
                         WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'))`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt_line
       WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt
                                     WHERE inbound_receipt_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot_hold
       WHERE lot_id IN (SELECT lot_id FROM trace.lot
                         WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'))`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code = '${SUPPLIER_CODE}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code = '${ITEM_CODE}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    await cleanupApprovals();
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
  }

  /**
   * ⛔ 승인 요청·결재선은 `app_user` 를 FK 로 쥔다 — 사용자 삭제 «전»에 지운다. 접두어로 쓸지
   * 않고 «이 스위트의 주체»로만 좁힌다(형제 `app-approval-request.e2e-spec.ts:319-334` 와 같은 이유).
   */
  async function cleanupApprovals(): Promise<void> {
    const users = await prisma.app_user.findMany({
      where: { login_id: { in: [LOGIN_ID, NOPERM_ID] } },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    if (userIds.length === 0) return;
    const requests = await prisma.approval_request.findMany({
      where: { requested_by: { in: userIds } },
      select: { approval_request_id: true },
    });
    const requestIds = requests.map((row) => row.approval_request_id);
    await prisma.approval_step.deleteMany({ where: { approval_request_id: { in: requestIds } } });
    await prisma.approval_request.deleteMany({
      where: { approval_request_id: { in: requestIds } },
    });
    const steps = await prisma.approval_route_step.findMany({
      where: { approver_user_id: { in: userIds } },
      select: { approval_route_id: true },
    });
    const routeIds = steps.map((row) => row.approval_route_id);
    await prisma.approval_route_step.deleteMany({
      where: { approval_route_id: { in: routeIds } },
    });
    await prisma.approval_route.deleteMany({ where: { approval_route_id: { in: routeIds } } });
  }
});
