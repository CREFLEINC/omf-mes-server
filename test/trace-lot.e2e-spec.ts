/**
 * LOT — 추적성의 뿌리. 화면 `M-01-02`·`P-01-01`.
 *
 * ⭐ 이 스위트가 못 박는 것 셋 — 번호 출처 둘의 «실패가 서로 다르다» · 서버가 스스로
 * 보류를 건다 · **원장이 움직인 LOT 은 수량을 못 바꾼다**(A1 이 세운 표를 되읽는다).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedRoute } from './approval-request.fixture';
import { InboundLotFixture, closeInboundLotFixture, issueAndReceive, terminalAuth } from './support/inbound-lot-fixture';

const LOGIN_ID = 'e2e-lot-probe';
const NOPERM_ID = 'e2e-lot-noperm';
const PASSWORD = 'LOT-검사-비밀번호';
const PREFIX = 'LOTE2E';
/**
 * 자재 MES LOT 번호(`materialMesLotNo`)는 이제 구분자 5칸 형식이라(통보 277), 품목·공급사
 * 코드를 **원본 그대로** 담는다 — 하이픈·글자가 섞인 실 하노이 품목 코드 모양을 그대로 쓴다.
 * ⭐ 옛 34자리 전부-숫자 형식은 이런 코드를 전부 거절했다(#620 — 실 품목 9,813건 중 5건만
 * 통과). 여기 값이 그 형식을 통과하는 것 자체가 #620 회귀 확인이다.
 */
const ITEM_CODE = '040101-00022S';
const SUPPLIER_CODE = '100019';
const ROLE = 'E2E_LOT';
const PERMISSIONS = ['M-01-02', 'P-01-01', 'M-01-04', 'M-01-13'];
const DAY = '2026-05-01';
const TZ = 'Asia/Ho_Chi_Minh';
const WORKER_NO = `${PREFIX}-W1`;

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
  inboundLotId?: number | null;
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
  let supplierId: number;
  let inboundReceiptId: bigint;
  let lineNo = 0;
  let fx: InboundLotFixture;
  const keys = new Set<string>();

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
    fx = {
      app, issuer: terminalAuth(await terminalToken('POP'), WORKER_NO), receiver: terminalAuth(await terminalToken('MOBILE'), WORKER_NO),
      businessDate: localDate(new Date(), TZ), keys,
    };
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

  /*
   * FR-036 — 입하 원천 등록(`POST /trace/lots`)은 닫혔다. 서비스 검증(번호 출처·채번·식별자 유형·sourceId)보다 먼저 409 라
   * 본문이 무엇이든 같다. 번호 출처·채번·등록 즉시 보류·무검사 입하 LOT·외부 식별자 동시 등록은 입하 LOT 받기가 맡는다.
   */
  it('FR-036 입하 원천 등록은 본문과 관계없이 409 STATE_LOCKED 다 — LOT·IQC 요청이 서지 않는다', async () => {
    const before = await countsOfPlant();
    for (const extra of [
      { numberSourceCode: 'SUPPLIER' },
      { numberSourceCode: 'MES', lotNo: `${PREFIX}-손으로` },
      { numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-SCAN-1` },
      { numberSourceCode: 'MES' },
      { numberSourceCode: 'MES', initialQty: 12.5 },
      { numberSourceCode: 'MES', iqc: false },
      {
        numberSourceCode: 'SUPPLIER',
        lotNo: `${PREFIX}-EXT`,
        externalIdentifiers: [{ identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-SUP-9` }],
      },
      {
        numberSourceCode: 'SUPPLIER',
        lotNo: `${PREFIX}-BADEXT`,
        externalIdentifiers: [{ identifierTypeCode: '없는유형', externalIdentifier: 'x' }],
      },
      { numberSourceCode: 'MES', sourceId: 999999999 },
    ]) {
      const rejected = await post(await body(extra));
      expect([extra, rejected.status]).toEqual([extra, 409]);
      expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    }
    expect(await countsOfPlant()).toEqual(before);
  });

  /**
   * ⭐⭐ R-9 회귀(I-20 PR ②a) + **PR ③ 2-5** — `holdView()` 는 `lotStatusCode` 를 `lot.status_code`
   * (지금 상태)가 아니라 `lot_hold.target_lot_status_code`(등록 때 간 상태)로 채운다. PR ③ 이
   * 코어(`lot-registry.service.ts:96`)에 그 칸을 채우게 해서 **오늘 태어난 보류는 값을 갖는다**.
   * ⛔ 백필은 없다(마이그 0) — PR ③ 이전에 태어난 옛 보류는 칸이 영구히 비고, 널 금지라
   * **키가 생략된다**. 마지막 단언이 그 갈래를 함께 잠근다.
   */
  it('⭐⭐ R-9 — 보류의 lotStatusCode 는 target_lot_status_code 다(lot.status_code 의 「지금」이 아니다)', async () => {
    const lot = await newLot();

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

  it('⭐ 상세가 «해제되지 않은» 보류만 준다 — 푼 것은 이력이지 지금이 아니다', async () => {
    const lot = await newLot();
    expect((await detailOf(lot.lotId)).holds).toHaveLength(1);

    await release(lot.lotId);

    const after = await detailOf(lot.lotId);
    expect(after.holds).toHaveLength(0);
    expect(after.lot.held).toBe(false);
  });

  it('⭐ 목록이 계약 스키마를 만족한다', async () => {
    await newLot();
    const body = await list(`plantId=${plantId}`);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('⭐ lotNo 는 정확 일치다 — 스캔값 하나로 한 건을 집는다', async () => {
    await newLot(`${PREFIX}-EXACT-1`);
    await newLot(`${PREFIX}-EXACT-12`);

    const exact = await list(`lotNo=${PREFIX}-EXACT-1`);
    expect(exact.items.map((l) => l.lotNo)).toEqual([`${PREFIX}-EXACT-1`]);
  });

  it('⭐ q 는 번호와 외부 식별자를 함께 본다', async () => {
    const lot = await newLot(`${PREFIX}-QNO`, [
      { identifierTypeCode: 'ERP_LOT', externalIdentifier: `${PREFIX}-찾을값` },
    ]);

    const byIdentifier = await list(`q=${encodeURIComponent(`${PREFIX}-찾을값`)}`);
    expect(byIdentifier.items.map((l) => l.lotId)).toContain(lot.lotId);

    const byNo = await list(`q=${PREFIX}-QNO`);
    expect(byNo.items.map((l) => l.lotId)).toContain(lot.lotId);
  });

  it('⭐ heldOnly 가 보류 중인 것만 준다', async () => {
    const held = await newLot();
    const released = await newLot();
    await release(released.lotId);

    const ids = (await list(`plantId=${plantId}&heldOnly=true`)).items.map((l) => l.lotId);
    expect(ids).toContain(held.lotId);
    expect(ids).not.toContain(released.lotId);
  });

  it('⛔ 원장이 움직인 LOT 은 수량을 바꿀 수 없다 — A1 이 세운 표를 되읽는다', async () => {
    const lot = await newLot();
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
    const lot = await newLot();
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
    const lot = await newLot();
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

  it('⛔ 없는 LOT 은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/trace/lots/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⭐ 외부식별자 목록이 등록 때 넣은 식별자를 id 오름차순으로 준다', async () => {
    const lot = await newLot(undefined, [
      { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-EL-1` },
      { identifierTypeCode: 'ERP_LOT', externalIdentifier: `${PREFIX}-EL-2` },
    ]);

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
    const lot = await newLot();

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
    const lot = await newLot();
    // 등록이 이미 건 보류(해제 안 됨) 1건에, 해제된 보류 1건을 더 심는다.
    await prisma.lot_hold.create({
      data: {
        lot_id: BigInt(lot.lotId),
        reason_code: 'INCOMING_INSPECTION_WAIT',
        status_code: 'HELD',
        held_by: probeUserId,
        held_at: new Date(),
        released_by: probeUserId,
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
    const lot = await newLot();
    await prisma.lot_hold.create({
      data: {
        lot_id: BigInt(lot.lotId),
        reason_code: 'INCOMING_INSPECTION_WAIT',
        status_code: 'HELD',
        held_by: probeUserId,
        held_at: new Date(),
        released_by: probeUserId,
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
    const lot = await newLot();
    // 등록이 만든 보류보다 «나중»이면서 서로 «동률»인 둘 — 방향과 2차 키를 함께 잠근다.
    const tie = new Date(Date.now() + 60_000);
    for (let i = 0; i < 2; i += 1) {
      await prisma.lot_hold.create({
        data: {
          lot_id: BigInt(lot.lotId),
          reason_code: 'INCOMING_INSPECTION_WAIT',
          status_code: 'HELD',
          held_by: probeUserId,
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
    const lot = await newLot();
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
    const lot = await newLot(undefined, [
      { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-P-1` },
      { identifierTypeCode: 'ERP_LOT', externalIdentifier: `${PREFIX}-P-2` },
    ]);
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
    const lot = await newLot(undefined, [
      { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-Z-1` },
    ]);

    const emptied = await putIdentifiers(lot.lotId, await etagOf(lot.lotId), []).expect(200);
    expect(emptied.body).toEqual({ items: [] });
    expect(await identifiersOf(lot.lotId)).toEqual({ items: [] });
  });

  it('⭐ 같은 멱등 키의 재전송은 한 번만 반영된다 — 버전이 두 번 오르지 않는다', async () => {
    const lot = await newLot();
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
    const lot = await newLot();
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
    const lot = await newLot();
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
    const lot = await newLot();

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
    // 대상은 그 LOT 의 입하 LOT 이고 입하 마감된 것만 요청한다(FR-032).
    const lot = await closedLot();
    const versionBefore = (await prisma.lot.findUniqueOrThrow({ where: { lot_id: lot.lotId } })).version_no;

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
      target_id: BigInt(lot.inboundLotId as number),
      status_code: 'PENDING',
      requested_by: probeUserId,
    });
    // ⛔ 대상 행에 아무것도 안 쓴다 — 승인 FK 칸이 없고 202 에 ETag 도 없다.
    const after = await prisma.lot.findUniqueOrThrow({ where: { lot_id: lot.lotId } });
    expect(after.version_no).toBe(versionBefore);
    // ⛔ 「진행 중 요청은 하나」 — 코어가 두 번째 상신을 막는다.
    const twice = await requestIqcSkip(lot.lotId).expect(400);
    expect(twice.body.errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });
  });

  it('⛔ 사번 헤더가 없으면 400 REQUIRED · 결재선이 없으면 400 ROUTE_NOT_FOUND 다', async () => {
    const lot = await closedLot();

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
    const notInbound = await newLot();
    await prisma.lot.update({
      where: { lot_id: notInbound.lotId },
      data: { source_type_code: 'WORK_ORDER' },
    });
    const notPending = await newLot();
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
    const lot = await newLot();
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
    // ⚠ 라인 수량은 `extra.initialQty` 를 따른다 — LOT 번호의 수량 칸이 이 라인 수량 그대로
    // 실리므로(§2-2 — 단위는 미정, 막지 않는다), 소수 수량 케이스를 만들려면 라인도 같은
    // 값을 받아야 `fromInboundSource` 의 `Decimal.equals` 대조를 통과한다.
    const qty = typeof extra.initialQty === 'number' ? extra.initialQty : 10;
    // ⭐ 기본 라인은 IQC 대상이다 — 이 스위트의 보류·검사 대기 단언은 «수입검사를 기다리는» 입하 LOT 의 것이다.
    //    무검사 라인은 보류 없이 정상으로 선다(omf-all-around#105) — `iqc: false` 로 따로 잰다.
    const { iqc, ...rest } = extra;
    return {
      itemId,
      lotTypeCode: 'MATERIAL',
      plantId,
      initialQty: qty,
      uomId,
      sourceTypeCode: 'INBOUND_RECEIPT_LINE',
      sourceId: await newLine(qty, iqc !== false),
      businessDate: DAY,
      occurredAt: `${DAY}T02:00:00.000Z`,
      ...rest,
    };
  }

  async function newLine(qty: number = 10, inspectionRequired = false): Promise<number> {
    lineNo += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: inboundReceiptId,
        line_no: lineNo,
        item_id: BigInt(itemId),
        received_qty: qty,
        uom_id: BigInt(uomId),
        supplier_lot_label_attached: false,
        inspection_required: inspectionRequired,
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

  /**
   * 입하 LOT 받기로 LOT 하나(피처 005) — 발행 묶음 1개 → `:receive`. 품목이 검사 필요라 검사 대기·입고검사 대기 보류로 선다(마감 전).
   * `lotNo` 는 옛 SUPPLIER 등록(스캔값 = 번호)을 대신해 번호를 바꿔 둔다 — 사전부착 라벨은 MES 번호 형식만 받는다.
   * `externalIdentifiers` 는 옛 등록 때 함께 넣던 식별자 — 치환(PUT)으로 넣는다.
   */
  async function newLot(lotNo?: string, externalIdentifiers?: Record<string, unknown>[]): Promise<LotBody> {
    const { lots } = await issueAndReceive(fx, { plantId, supplierId, itemId, lotQty: 10, lotCount: 1 });
    const lotId = lots[0].lotId;
    if (lotNo !== undefined) await prisma.lot.update({ where: { lot_id: BigInt(lotId) }, data: { lot_no: lotNo } });
    if (externalIdentifiers !== undefined) {
      await putIdentifiers(lotId, await etagOf(lotId), externalIdentifiers).expect(200);
    }
    return (await detailOf(lotId)).lot;
  }

  /** 입하 마감된 입하 LOT 의 자재 관리 LOT — IQC 생략은 마감된 입하 LOT 만 요청한다(FR-032). */
  async function closedLot(): Promise<LotBody> {
    // 앞 시험의 LOT 들이 붙은 입하 중 입하 LOT 을 먼저 마감한다 — 이 LOT 하나만의 입하 LOT 을 세운다.
    const open = await prisma.inbound_lot.findFirst({ where: { supplier_id: BigInt(supplierId), item_id: BigInt(itemId), status_code: 'RECEIVING' } });
    if (open !== null) await closeInboundLotFixture(fx, Number(open.inbound_lot_id));
    const lot = await newLot();
    await closeInboundLotFixture(fx, lot.inboundLotId as number);
    return (await detailOf(lot.lotId)).lot;
  }

  async function countsOfPlant(): Promise<number[]> {
    return Promise.all([
      prisma.lot.count({ where: { plant_id: BigInt(plantId) } }),
      prisma.inspection_request.count({ where: { item_id: BigInt(itemId) } }),
    ]);
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T-${type}`, plant_id: BigInt(plantId), terminal_type_code: type, status_code: 'RUNNING' },
    });
    return app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId,
    });
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
      data: { released_by: probeUserId, released_at: new Date(), release_reason_code: 'INSPECTION_PASSED' },
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
        business_unit_id: unit.business_unit_id,
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
        // 이 스위트의 보류·검사 대기 단언은 «수입검사를 기다리는» 입하 LOT 의 것이다 — 받기가 품목 기준으로 건다.
        inspection_required: true,
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

    // FR-036 시험이 보내는 옛 모양 입하 줄(`sourceId`)의 머리 — 옛 등록 경로가 닫혀 직접 심는다.
    const supplier = await prisma.partner.create({
      data: { partner_code: SUPPLIER_CODE, partner_name: 'LOT검사공급사' },
    });
    supplierId = Number(supplier.partner_id);
    await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: 'LOT검사작업자', business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
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
    // 입하 LOT 받기(피처 005)가 남긴 행 — LOT·입하 LOT 보다 먼저 지운다.
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    await prisma.$executeRawUnsafe(
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants}))`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM quality.inspection_request WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code = '${ITEM_CODE}')`,
    );
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
    // omf-all-around#18 — IQC 의뢰가 LOT 을 FK 로 쥔다. LOT 보다 먼저 지운다.
    await prisma.$executeRawUnsafe(`
      DELETE FROM quality.inspection_request
       WHERE lot_id IN (SELECT lot_id FROM trace.lot
                         WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'))`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    await prisma.$executeRawUnsafe(`DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM quality.inspection_plan_version
       WHERE inspection_plan_id IN (
         SELECT inspection_plan_id FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
    );
    const keyList = [...keys].map((k) => `'${k}'`).join(',');
    if (keyList !== '') await prisma.$executeRawUnsafe(`DELETE FROM app.idempotency_record WHERE idempotency_key IN (${keyList})`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit.audit_event WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`);
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
