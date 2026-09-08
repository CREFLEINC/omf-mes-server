/**
 * `GET /quality/lot-holds` · `GET /quality/lot-holds/{lotHoldId}`(I-20 PR ②a).
 * `GET /quality/lot-hold-events`(②b)·쓰기 2건(④⑤)·코어(③)는 이 파일 밖이다.
 *
 * LOT 은 `prisma` 로 직접 심는다 — 계약에 LOT 단독 등록 오퍼레이션이 없다(0단계 선례
 * `test/quality-lot-status.e2e-spec.ts`). `lot_hold` 도 직접 INSERT 한다 — 등록 오퍼레이션은
 * PR ④ 몫이라 아직 없다.
 *
 * ⭐⭐ **#7 ETag 판정 — 브리프의 반대 결론.** 구현 브리프(§4-2)는 「ETag = `lot_hold.version_no`」
 * 라 적었지만 계약 원문(`contracts/quality-03품질.json:1950`·`:2058`)은 정확히 반대다 —
 * 「이 보류 «행»의 것이 아니라 이 보류가 걸린 «LOT» 의 판 번호(`trace.lot.version_no`)다 …
 * 보류 행 자체는 기록 전용이라 판 번호를 갖지 않는다」(2026-08-24 정정 · omf-mes#190 질문4).
 * 이 계약 실측이 이겨 `lot.version_no` 를 낸다 — 상세 아래 `#7` 이 그 값을 잠근다.
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

const PREFIX = 'I20QH';
const LOGIN_ID = 'e2e-i20qh-probe';
const ROLE = 'E2E_I20_LOT_HOLD';
// 조회 8건은 계약이 403 을 안 선언한다(`permission.guard.ts:37-41`) — 아무 화면 권한이나 충분하다.
const PERMISSION = 'W-03-02';
const PASSWORD = 'PR-LOT보류-비밀번호';

const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-02-02T00:00:00.000Z';

// ⭐ 사건 조회(②b) 전용 기간 — 목록·상세(T1/T2, 2월) 픽스처보다 «이전»(1월)을 쓴다. 목록
// 테스트(#9b)가 `open=false` 전역 목록을 held_at DESC 로 «필터 없이» 앞 2건씩 끊어 보므로,
// 사건 픽스처가 2월보다 «최근»이면 그 페이지 경계 앞에 끼어든다(실측 — 최초엔 3월로 뒀다가 깨졌다).
const EV_BEFORE = '2026-01-10T00:00:00.000Z'; // 기간 «밖»(등록이 기간 전)
const EV_FROM = '2026-01-15T00:00:00.000Z'; // 기간 시작 — 동시에 T_10(경계 포함 · 동률 축)
const T_11 = '2026-01-15T11:00:00.000Z';
const T_12 = '2026-01-15T12:00:00.000Z';
const T_13 = '2026-01-15T13:00:00.000Z';
const T_14 = '2026-01-15T14:00:00.000Z';
const T_15 = '2026-01-15T15:00:00.000Z'; // EVPARTIAL 의 released_at(리뷰 Major-2)
const T_16 = '2026-01-15T16:00:00.000Z'; // EV_EXACT1·EV_EXACT2 의 held_at(리뷰 Minor-3)
const EV_TO = '2026-01-16T00:00:00.000Z'; // 기간 끝 — 동시에 경계 제외 픽스처의 held_at

interface LotHoldItem {
  lotHoldId: number;
  lotId: number;
  lotNo: string;
  itemId: number;
  reasonCode: string;
  statusCode: string;
  heldBy?: number;
  heldAt: string;
  releasedAt?: string;
  lotStatusCode?: string;
}
interface LotHoldListBody {
  items: LotHoldItem[];
  page: { page: number; size: number; total: number };
}

interface LotHoldEventItem {
  lotHoldId: number;
  eventTypeCode: string;
  occurredAt: string;
  lotId: number;
  lotNo: string;
  itemId: number;
  actorId?: number;
  actorName?: string;
  reasonCode: string;
  releaseReasonCode?: string;
  targetLotStatusCode?: string;
}
interface LotHoldEventListBody {
  items: LotHoldEventItem[];
  page: { page: number; size: number; total: number };
}

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

describe('LOT 보류 목록·상세 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let plantId: number;
  let item1Id: number;
  let item2Id: number;
  let uomId: number;
  let heldByAId: number;
  let heldByBId: number;

  const lotId: Record<string, number> = {};
  const lotHoldId: Record<string, number> = {};
  const lotNo: Record<string, string> = {
    OPEN: `${PREFIX}-LOT-OPEN`,
    RELEASED: `${PREFIX}-LOT-RELEASED`,
    EXACT1: `${PREFIX}-LOT-EXACT-1`,
    EXACT2: `${PREFIX}-LOT-EXACT-12`,
    LEGACY: `${PREFIX}-LOT-LEGACY`,
    // ⭐ 사건 조회(②b) 전용 — 접두어를 «다르게» 둔다(cleanup() 은 plant 로 걷어 영향 없음).
    // 기존 목록 테스트(#9·#9b)가 `lotNo.startsWith(PREFIX)` 로 자기 픽스처만 골라내는데,
    // `PREFIX` 로 시작하면 held_at(3월 · 더 최근)이 그 테스트의 DESC 순서 단언을 깬다.
    EVBOTH: `LOT-EV-BOTH-${PREFIX}`,
    EVBEFORE: `LOT-EV-BEFORE-${PREFIX}`,
    EVLEGACY: `LOT-EV-LEGACY-${PREFIX}`,
    EVOPEN2: `LOT-EV-OPEN2-${PREFIX}`,
    EVTIE: `LOT-EV-TIE-${PREFIX}`,
    EVBOUNDARY: `LOT-EV-BOUNDARY-${PREFIX}`,
    EVPARTIAL: `LOT-EV-PARTIAL-${PREFIX}`, // 리뷰 Major-2 — 부분 해제(R-2)
    // 리뷰 Minor-3 — EV_EXACT1 은 EV_EXACT2 lotNo 문자열의 «정확한 접두»다(EXACT1/EXACT2 선례와 같은 짝).
    EV_EXACT1: `LOT-EV-EXACT1-${PREFIX}`,
    EV_EXACT2: `LOT-EV-EXACT1-${PREFIX}X`,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeUser();
    await makeLots();
    await makeEventLots();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── 1. 목록 — open 기본값 ───────────────────────────────────────────────

  it('목록 — open 기본이 true 다(해제된 보류가 안 나온다)', async () => {
    const body = await listAll(''); // open 을 아예 안 보낸다 — 기본값 판정
    const names = body.items.map((i) => i.lotNo);
    expect(names).toContain(lotNo.OPEN);
    expect(names).not.toContain(lotNo.RELEASED);
  });

  // ── 2. 목록 — open=false 는 «전체»다 ─────────────────────────────────────

  it('⭐ 목록 — open=false 는 «전체»다(해제된 것 + 열린 것) (↩ 「해제된 것만」으로 읽으면 깨진다)', async () => {
    const body = await listAll(`open=false`);
    const names = body.items.map((i) => i.lotNo);
    expect(names).toContain(lotNo.OPEN); // 열린 것도 나온다
    expect(names).toContain(lotNo.RELEASED); // 해제된 것도 나온다

    // 변이체 검증 — open=false 를 「해제된 것만」으로 되돌리면 OPEN 이 사라진다(R-19).
  });

  // ── 3. 목록 — lotNo 정확 일치 ────────────────────────────────────────────

  it('목록 — lotNo 는 «정확히» 일치다 (↩ 부분 일치로 바꾸면 깨진다)', async () => {
    const body = await listAll(`lotNo=${lotNo.EXACT1}`);
    expect(body.items.map((i) => i.lotNo)).toEqual([lotNo.EXACT1]);
  });

  // ── 4. 목록 — heldFrom 만 400 PAIR ──────────────────────────────────────

  it('목록 — heldFrom 만 보내면 400 PAIR (↩ 쌍 검사를 빼면 깨진다)', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`/api/quality/lot-holds?heldFrom=${T1}`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'heldTo', code: 'PAIR' });
  });

  // ── 4b. 목록 — heldFrom~heldTo 는 [from, to) 반열림이다 ──────────────────

  it(
    '⭐ 목록 — heldFrom~heldTo 는 [from, to) 반열림이다 — 끝 경계와 «같은 값»은 빠진다 ' +
      '(↩ 끝 경계를 «이하»로 바꾸거나 시작 경계를 «초과»로 바꾸거나 절을 지우면 깨진다)',
    async () => {
      // held_at=T1(RELEASED·LEGACY) 은 시작 경계(gte)와 같은 값이라 포함, held_at=T2(OPEN·
      // EXACT1·EXACT2) 는 끝 경계(lt)와 같은 값이라 제외 — heldFrom·heldTo 를 «함께» 보낸다.
      const body = await listAll(`open=false&heldFrom=${T1}&heldTo=${T2}`);
      const names = body.items.map((i) => i.lotNo);
      expect(names).toContain(lotNo.RELEASED);
      expect(names).toContain(lotNo.LEGACY);
      expect(names).not.toContain(lotNo.OPEN);
      expect(names).not.toContain(lotNo.EXACT1);
      expect(names).not.toContain(lotNo.EXACT2);
    },
  );

  // ── 5. 목록 — reasonCode·heldBy·itemId·lotId 필터 ────────────────────────

  it('목록 — reasonCode·heldBy·itemId·lotId 가 각각 거른다', async () => {
    // ⛔ §4 자가 변이 점검에서 드러난 자리 — open 기본(true)이 RELEASED 를 이미 가려서
    // reasonCode·heldBy·itemId 절을 지워도 「안 걸리는 행」 단언이 초록으로 살아남았다.
    // open=false 로 RELEASED 를 화면에 들여놓아야 각 필터가 «단독으로» 거르는 것이 반증된다.
    const byReason = await listAll(`open=false&reasonCode=DIMENSION_ABNORMAL`);
    expect(byReason.items.map((i) => i.lotNo)).toContain(lotNo.OPEN);
    expect(byReason.items.map((i) => i.lotNo)).not.toContain(lotNo.RELEASED); // 안 걸리는 행(R-19)
    expect(byReason.page.total).toBe(byReason.items.length); // Minor-2 — total 이 필터와 같은 조건이다

    const byHeldBy = await listAll(`open=false&heldBy=${heldByAId}`);
    expect(byHeldBy.items.map((i) => i.lotNo)).toContain(lotNo.OPEN);
    expect(byHeldBy.items.map((i) => i.lotNo)).not.toContain(lotNo.RELEASED);

    const byItem = await listAll(`open=false&itemId=${item1Id}`);
    expect(byItem.items.map((i) => i.lotNo)).toContain(lotNo.OPEN);
    expect(byItem.items.map((i) => i.lotNo)).not.toContain(lotNo.RELEASED); // item2 소속

    const byLotId = await listAll(`lotId=${lotId.OPEN}`); // Minor-1 — R-23 과 같은 지적
    expect(byLotId.items.map((i) => i.lotNo)).toEqual([lotNo.OPEN]);
  });

  // ── 6. 상세 — 404 · 200 + ETag ───────────────────────────────────────────

  it('상세 — 404 · 200 + ETag 헤더', async () => {
    await request(app.getHttpServer())
      .get(`/api/quality/lot-holds/999999999`)
      .set('Cookie', cookie)
      .expect(404);

    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-holds/${lotHoldId.OPEN}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.headers.etag).toBeDefined();
    expect(response.body.lotHoldId).toBe(lotHoldId.OPEN);
  });

  // ── 7. 상세 — ETag 출처(계약 실측 정정) ──────────────────────────────────

  it(
    '⭐⭐ 상세 — ETag 가 trace.lot.version_no 다(lot_hold.version_no 가 «아니다» — 계약 실측이 브리프를 뒤집는다) ' +
      '(↩ lot_hold.version_no 를 내면 깨진다)',
    async () => {
      // 픽스처가 둘을 «서로 다른 값»으로 심었다 — 같으면 어느 쪽을 내도 초록이라 반증이 안 된다.
      const lotRow = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId.OPEN) } });
      const holdRow = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.OPEN) } });
      expect(lotRow.version_no).not.toBe(holdRow.version_no);

      const response = await request(app.getHttpServer())
        .get(`/api/quality/lot-holds/${lotHoldId.OPEN}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(Number(response.headers.etag)).toBe(lotRow.version_no);
      expect(Number(response.headers.etag)).not.toBe(holdRow.version_no);
    },
  );

  // ── 8. 상세 — 마이그 전 보류는 lotStatusCode 키가 없다 ───────────────────

  it('⭐⭐ 상세 — 마이그 전에 태어난 보류는 lotStatusCode 키가 «없다»(널 금지) (↩ NULL 을 그대로 실으면 깨진다)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-holds/${lotHoldId.LEGACY}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body).not.toHaveProperty('lotStatusCode');

    // 대조 — target_lot_status_code 가 채워진 OPEN 은 키가 «있다».
    const opened = await request(app.getHttpServer())
      .get(`/api/quality/lot-holds/${lotHoldId.OPEN}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(opened.body.lotStatusCode).toBe('INSPECTION_PENDING');
  });

  // ── 9. 목록 — 기본 정렬(R-10) · 동률 구간 페이지 경계 ────────────────────

  it(
    '⭐ 목록 — 기본 정렬은 held_at DESC · lot_hold_id DESC 다(동률을 2차 키로 깬다) ' +
      '(↩ 방향을 뒤집거나 2차 키를 지우면 깨진다)',
    async () => {
      // held_at=T2 삼중 동률(OPEN·EXACT1·EXACT2)이 lot_hold_id DESC 로 갈리는 것까지 배열
      // 전체를 통째로 단언한다 — toContain 으로는 순서·2차 키가 반증되지 않는다.
      const body = await listAll('open=false');
      const ids = body.items.filter((i) => i.lotNo.startsWith(PREFIX)).map((i) => i.lotHoldId);
      expect(ids).toEqual([lotHoldId.EXACT2, lotHoldId.EXACT1, lotHoldId.OPEN, lotHoldId.LEGACY, lotHoldId.RELEASED]);
    },
  );

  it(
    '⭐ 목록 — held_at 동률 구간이 page 경계에 걸려도 중복·누락이 없다(size=2, page=1/2) ' +
      '(↩ 2차 정렬 키를 지우면 동률 구간의 페이지 경계가 흔들린다)',
    async () => {
      const page = async (n: number): Promise<number[]> => {
        const response = await request(app.getHttpServer())
          .get(`/api/quality/lot-holds?open=false&size=2&page=${n}`)
          .set('Cookie', cookie)
          .expect(200);
        return (response.body as LotHoldListBody).items
          .filter((i) => i.lotNo.startsWith(PREFIX))
          .map((i) => i.lotHoldId);
      };
      // 3중 동률(EXACT2·EXACT1·OPEN) 의 셋째 행(OPEN)이 page=1/2 경계에 걸린다.
      const page1 = await page(1);
      const page2 = await page(2);
      expect(page1).toEqual([lotHoldId.EXACT2, lotHoldId.EXACT1]);
      expect(page2).toEqual([lotHoldId.OPEN, lotHoldId.LEGACY]);
      expect(new Set([...page1, ...page2]).size).toBe(page1.length + page2.length); // 중복 0
    },
  );

  it('목록·상세 — 계약 스키마를 통과한다(ajv)', async () => {
    const listResponse = await request(app.getHttpServer())
      .get(`/api/quality/lot-holds?lotNo=${lotNo.OPEN}`) // ⛔ 계약 10칸에 plantId 축이 없다(Nit-1)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /quality/lot-holds');
    expect(listValidate(listResponse.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detailResponse = await request(app.getHttpServer())
      .get(`/api/quality/lot-holds/${lotHoldId.OPEN}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /quality/lot-holds/{lotHoldId}');
    expect(detailValidate(detailResponse.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
  });

  // ═══ GET /quality/lot-hold-events(②b) ══════════════════════════════════

  // ── 9. 사건 — 기간 필수 ───────────────────────────────────────────────

  it('⭐ 사건 — 기간 없이 부르면 400 REQUIRED (↩ 계약 가드의 required 를 서비스가 대신 놓치면 깨진다)', async () => {
    const rejected = await request(app.getHttpServer()).get('/api/quality/lot-hold-events').set('Cookie', cookie).expect(400);
    expect(rejected.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'occurredFrom', code: 'REQUIRED' }),
        expect.objectContaining({ field: 'occurredTo', code: 'REQUIRED' }),
      ]),
    );
  });

  // ── 9b. 사건 — [from, to) 반열림 양끝 경계 ───────────────────────────────

  it(
    '⭐ 사건 — occurredFrom~occurredTo 는 [from, to) 반열림이다(양끝 경계와 같은 값) ' +
      '(↩ gte→gt 또는 lt→lte 로 바꾸면 깨진다)',
    async () => {
      const body = await listEvents('');
      const ids = body.items.map((i) => i.lotHoldId);
      expect(ids).toContain(lotHoldId.EVBOTH); // held_at === occurredFrom(시작 경계) — 포함
      expect(ids).toContain(lotHoldId.EVTIE); // 〃(동률)
      expect(ids).not.toContain(lotHoldId.EVBOUNDARY); // held_at === occurredTo(끝 경계) — 제외
      expect(body.page.total).toBe(9);
    },
  );

  // ── 10. 사건 — 한 보류가 최대 두 행 ───────────────────────────────────

  it(
    '⭐⭐ 사건 — 한 보류가 최대 두 행이다(EVBOTH 가 HELD·RELEASED 둘) · actorId·actorName·itemId 값도 잠근다 ' +
      '(↩ 보류 «문서» 목록을 그대로 내면 한 행만 나온다 · 리뷰 Major-1·Minor-4 — actorName·해제 가지 actorId·itemId 값은 아무도 안 봤다)',
    async () => {
      const body = await listEvents(`lotId=${lotId.EVBOTH}`);
      expect(body.items).toHaveLength(2);
      const byType = Object.fromEntries(body.items.map((i) => [i.eventTypeCode, i]));
      // EVBOTH 는 held_by(A) ≠ released_by(B) 라 두 가지의 actorId·actorName 이 축이 갈린다 —
      // 이 두 toMatchObject 가 「RELEASED 가지의 actorId 를 held_by 로 잘못 실어도 초록」이던
      // 반증 불가(N3)와 「actorName JOIN 을 안 해도 초록」이던 반증 불가(N1)를 함께 닫는다.
      expect(byType.HELD).toMatchObject({
        lotHoldId: lotHoldId.EVBOTH,
        occurredAt: EV_FROM,
        actorId: heldByAId,
        actorName: 'LOT보류검사',
        itemId: item1Id,
        holdQty: 40,
        uomId,
        releaseCondition: '재검사 후 판정 대기',
      });
      expect(byType.RELEASED).toMatchObject({
        lotHoldId: lotHoldId.EVBOTH,
        occurredAt: T_13,
        actorId: heldByBId,
        actorName: 'LOT보류검사행위자B',
        itemId: item1Id,
        holdQty: 40,
        uomId,
        releaseCondition: '재검사 후 판정 대기',
      });
    },
  );

  // ── 11. 사건 — 기간 전 등록·기간 안 해제 ─────────────────────────────

  it(
    '⭐ 사건 — 「기간 «전»에 등록되고 기간 «안»에 해제된 보류」의 RELEASED 만 나온다 ' +
      '(↩ held_at 하나로 거르면 이 행이 통째로 사라진다 — 계약이 이름 적은 함정)',
    async () => {
      const body = await listEvents(`lotId=${lotId.EVBEFORE}`);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ eventTypeCode: 'RELEASED', lotHoldId: lotHoldId.EVBEFORE, occurredAt: T_11 });
    },
  );

  // ── 12. 사건 — eventTypeCode 는 가지를 끈다 ──────────────────────────

  it(
    '⭐ 사건 — eventTypeCode 는 UNION 의 가지를 «통째로» 끈다 ' +
      '(↩ released_at IS NULL 을 WHERE 에 걸면 3값 논리로 사라진다)',
    async () => {
      const released = await listEvents('eventTypeCode=RELEASED');
      expect(released.items).toHaveLength(3); // EVBOTH · EVBEFORE · EVPARTIAL
      expect(released.items.every((i) => i.eventTypeCode === 'RELEASED')).toBe(true); // HELD 가 0건

      const held = await listEvents('eventTypeCode=HELD');
      expect(held.items).toHaveLength(6); // EVBOTH·EVLEGACY·EVOPEN2·EVTIE·EV_EXACT1·EV_EXACT2
      expect(held.items.every((i) => i.eventTypeCode === 'HELD')).toBe(true);
      // ⭐ EVBOTH 는 «나중에 해제»됐지만(released_at NOT NULL) HELD 사건은 여전히 나온다 —
      // `eventTypeCode=HELD AND released_at IS NULL` 로 잘못 구현하면 이 행이 사라진다.
      expect(held.items.map((i) => i.lotHoldId)).toContain(lotHoldId.EVBOTH);
    },
  );

  // ── 13. 사건 — releaseReasonCode 는 RELEASED 만 ──────────────────────

  it('사건 — RELEASED 행에 releaseReasonCode 가 있고 HELD 행에는 «없다» (↩ 양쪽에 채우면 깨진다)', async () => {
    const body = await listEvents(`lotId=${lotId.EVBOTH}`);
    const byType = Object.fromEntries(body.items.map((i) => [i.eventTypeCode, i]));
    expect(byType.RELEASED.releaseReasonCode).toBe('RETEST_PASS');
    expect(byType.HELD).not.toHaveProperty('releaseReasonCode');
  });

  // ── 14. 사건 — reasonCode 는 두 가지 다 등록 사유 ────────────────────

  it(
    '⭐ 사건 — RELEASED 행에도 reasonCode(등록 사유)가 실리고, reasonCode 필터도 두 가지 «다» 본다 ' +
      '(↩ 비우거나 HELD 가지만 보면 깨진다)',
    async () => {
      const body = await listEvents(`lotId=${lotId.EVBOTH}`);
      const byType = Object.fromEntries(body.items.map((i) => [i.eventTypeCode, i]));
      expect(byType.HELD.reasonCode).toBe('FOREIGN_MATTER_SUSPECTED');
      expect(byType.RELEASED.reasonCode).toBe('FOREIGN_MATTER_SUSPECTED'); // 해제 사유가 아니라 «등록» 사유다

      // EVBEFORE 는 RELEASED 사건만 기간 안에 있다 — reason_code(등록 사유)로 걸려야 잡힌다.
      const filtered = await listEvents('reasonCode=CLAIM_RECALL');
      expect(filtered.items.map((i) => i.lotHoldId)).toEqual([lotHoldId.EVBEFORE]);
    },
  );

  // ── 15. 사건 — targetLotStatusCode 두 칸 ─────────────────────────────

  it(
    '⭐⭐ 사건 — targetLotStatusCode 가 HELD·RELEASED 에서 «다른 칸»이다(§0 #1) · 부분 해제(R-2)는 RELEASED 여도 키가 «없다» ' +
      '(↩ 한 칸으로 합치거나 COALESCE 로 폴백하면 깨진다 · 리뷰 Major-2 — 그 경로 픽스처가 0행이었다)',
    async () => {
      const body = await listEvents(`lotId=${lotId.EVBOTH}`);
      const byType = Object.fromEntries(body.items.map((i) => [i.eventTypeCode, i]));
      expect(byType.HELD.targetLotStatusCode).toBe('INSPECTION_PENDING');
      expect(byType.RELEASED.targetLotStatusCode).toBe('NORMAL');

      // EVPARTIAL — release_target_lot_status_code 가 NULL(부분 해제, LOT 미이동) ⇒
      // RELEASED 사건이어도 targetLotStatusCode 키가 없어야 한다(R-2 — 「보류 → 정상」을
      // 지어내면 안 움직인 LOT 이 이력에 이동한 것처럼 그려진다).
      const partial = await listEvents(`lotId=${lotId.EVPARTIAL}`);
      expect(partial.items).toHaveLength(1);
      expect(partial.items[0]).toMatchObject({ eventTypeCode: 'RELEASED', lotHoldId: lotHoldId.EVPARTIAL });
      expect(partial.items[0]).not.toHaveProperty('targetLotStatusCode');
    },
  );

  // ── 16. 사건 — actorId 키 생략 ────────────────────────────────────────

  it(
    '⭐ 사건 — held_by 가 NULL 인 보류는 actorId·actorName 키가 «없다»(계약 required 결손 특성화 · 통보 072) · ' +
      'target_lot_status_code 가 NULL 이면 targetLotStatusCode 키도 «없다» ' +
      '(↩ 0 을 넣거나 null 을 그대로 실으면 깨진다 · 뒤 단언은 리뷰 Minor-5)',
    async () => {
      const body = await listEvents(`lotId=${lotId.EVLEGACY}`);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).not.toHaveProperty('actorId');
      expect(body.items[0]).not.toHaveProperty('actorName');
      expect(body.items[0]).not.toHaveProperty('targetLotStatusCode');
    },
  );

  // ── 필터 나머지 — actorId·itemId·lotNo·lotTypeCode ───────────────────

  it('사건 — actorId·itemId·lotNo·lotTypeCode 가 각각 거른다', async () => {
    const byActorA = await listEvents(`actorId=${heldByAId}`);
    // A 는 held_by(EVBOTH·EVTIE·EVOPEN2) «와» released_by(EVBEFORE·EVPARTIAL) 를 함께 본다 —
    // 등록·해제 «둘 다».
    expect(byActorA.items.map((i) => i.lotHoldId).sort()).toEqual(
      [lotHoldId.EVBOTH, lotHoldId.EVTIE, lotHoldId.EVOPEN2, lotHoldId.EVBEFORE, lotHoldId.EVPARTIAL].sort(),
    );
    const byActorB = await listEvents(`actorId=${heldByBId}`);
    expect(byActorB.items).toEqual([expect.objectContaining({ lotHoldId: lotHoldId.EVBOTH, eventTypeCode: 'RELEASED' })]);

    const byItem1 = await listEvents(`itemId=${item1Id}`);
    expect(byItem1.items.map((i) => i.lotHoldId).sort()).toEqual(
      [lotHoldId.EVBOTH, lotHoldId.EVBOTH, lotHoldId.EVLEGACY, lotHoldId.EV_EXACT1, lotHoldId.EV_EXACT2].sort(),
    );

    const byLotNo = await listEvents(`lotNo=${lotNo.EVBEFORE}`);
    expect(byLotNo.items.map((i) => i.lotHoldId)).toEqual([lotHoldId.EVBEFORE]);

    // ⭐ 리뷰 Minor-3 — 「정확히 일치」가 접두 일치와 구별되는지. EV_EXACT1 의 lotNo 는
    // EV_EXACT2 의 lotNo 문자열의 «정확한 접두»다(목록 테스트 EXACT1/EXACT2 와 같은 짝) —
    // LIKE 로 새면 둘 다 걸린다.
    const byLotNoExact = await listEvents(`lotNo=${lotNo.EV_EXACT1}`);
    expect(byLotNoExact.items.map((i) => i.lotHoldId)).toEqual([lotHoldId.EV_EXACT1]);

    const byLotType = await listEvents('lotTypeCode=PRODUCT');
    expect(byLotType.items.map((i) => i.lotHoldId)).toEqual([lotHoldId.EVTIE]);
  });

  // ── page.total ────────────────────────────────────────────────────────

  it('사건 — page.total 은 count(where) 가 findMany 의 where 와 같은 조건이다', async () => {
    const body = await listEvents(`itemId=${item1Id}`);
    expect(body.page.total).toBe(body.items.length);
    expect(body.page.total).toBe(5);
  });

  // ── 17. 사건 — sort=occurredAsc + 동률 2차 키 ────────────────────────

  it(
    '⭐ 사건 — sort=occurredAsc 가 UNION 전체를 정렬한다(페이지 2 확인) · 동률은 lot_hold_id 로 깬다 ' +
      '(↩ 페이지 안에서만 정렬하거나 2차 키를 지우면 깨진다)',
    async () => {
      expect(lotHoldId.EVBOTH).toBeLessThan(lotHoldId.EVTIE); // 동률 전제 — EVBOTH 가 먼저 만들어졌다

      const page = async (n: number): Promise<number[]> => {
        const response = await request(app.getHttpServer())
          .get(`/api/quality/lot-hold-events?occurredFrom=${EV_FROM}&occurredTo=${EV_TO}&sort=occurredAsc&size=2&page=${n}`)
          .set('Cookie', cookie)
          .expect(200);
        return (response.body as LotHoldEventListBody).items.map((i) => i.lotHoldId);
      };
      // ASC 전체: EVBOTH.HELD·EVTIE.HELD(동률·EV_FROM) → EVBEFORE.RELEASED(T_11) → EVLEGACY.HELD(T_12)
      //          → EVBOTH.RELEASED(T_13) → EVOPEN2.HELD(T_14) — 앱에서 가지를 따로 페이지하면 이 순서가 깨진다.
      expect(await page(1)).toEqual([lotHoldId.EVBOTH, lotHoldId.EVTIE]);
      expect(await page(2)).toEqual([lotHoldId.EVBEFORE, lotHoldId.EVLEGACY]);
      expect(await page(3)).toEqual([lotHoldId.EVBOTH, lotHoldId.EVOPEN2]);

      // 기본(occurredDesc)에서는 동률 2차 키 방향이 반대다 — lot_hold_id 가 더 큰 EVTIE 가 먼저.
      const desc = await listEvents('');
      const tieAtFromDesc = desc.items.filter((i) => i.occurredAt === EV_FROM).map((i) => i.lotHoldId);
      expect(tieAtFromDesc).toEqual([lotHoldId.EVTIE, lotHoldId.EVBOTH]);
    },
  );

  // ── 사건 — 계약 스키마 ───────────────────────────────────────────────

  it('사건 — 계약 스키마를 통과한다(ajv)', async () => {
    // ⛔ item2Id 로 좁힌다 — item1Id 쪽 EVLEGACY 는 actorId 를 «의도적으로» 생략한 행이라
    // (§4-4 · 통보 072 — 계약 required 결손 특성화) 전건을 그대로 물리면 ajv 가 당연히 막는다.
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-hold-events?occurredFrom=${EV_FROM}&occurredTo=${EV_TO}&itemId=${item2Id}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /quality/lot-hold-events');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /** `size` 를 넉넉히 준다 — 목록 질의에 `plantId` 축이 없어(계약 10칸) 다른 슬라이스의 fixture 도 섞일 수 있다. */
  async function listAll(query: string): Promise<LotHoldListBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-holds?size=100&${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as LotHoldListBody;
  }

  /** 기간은 `[EV_FROM, EV_TO)` 로 고정 — 호출부는 그 밖의 질의만 붙인다. */
  async function listEvents(query: string, status = 200): Promise<LotHoldEventListBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-hold-events?size=100&occurredFrom=${EV_FROM}&occurredTo=${EV_TO}&${query}`)
      .set('Cookie', cookie)
      .expect(status);
    return response.body as LotHoldEventListBody;
  }

  async function login(): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'LOT보류검사', status_code: 'EMPLOYED' },
    });
    heldByAId = Number(user.app_user_id);
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'LOT보류검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: PERMISSION } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    // 두 번째 행위자 — heldBy 필터가 「거르는」 것을 보이려면 값이 서로 달라야 한다.
    const other = await prisma.app_user.create({
      data: { login_id: `${LOGIN_ID}-b`, user_name: 'LOT보류검사행위자B', status_code: 'EMPLOYED' },
    });
    heldByBId = Number(other.app_user_id);
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'LOT보류검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'LOT보류검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item1 = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT1`, item_name: 'LOT보류검사품목1', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    item1Id = Number(item1.item_id);
    const item2 = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT2`, item_name: 'LOT보류검사품목2', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    item2Id = Number(item2.item_id);
  }

  /**
   * LOT 넷 + `lot_hold` 넷.
   * - OPEN — item1 · 열린 보류(§0 #1 「등록 도착」 채움 · `target_lot_status_code='INSPECTION_PENDING'`) ·
   *   `lot.version_no` 를 5로 올려 `lot_hold.version_no`(기본 1)와 «다른 값»으로 심는다(#7).
   * - RELEASED — item2 · 해제된 보류만(open 기본/전체 갈림 · reasonCode·heldBy·itemId 「안 걸리는 행」).
   * - EXACT1·EXACT2 — `lotNo` 정확 일치 반증(EXACT2 는 EXACT1 의 겹문자열).
   * - LEGACY — `target_lot_status_code` 를 «안 채운» 보류(마이그 전 태생 특성화 · #8).
   */
  async function makeLots(): Promise<void> {
    lotId.OPEN = await newLot('OPEN', item1Id, 'INSPECTION_PENDING');
    await prisma.lot.update({ where: { lot_id: BigInt(lotId.OPEN) }, data: { version_no: 5 } });
    const openHold = await prisma.lot_hold.create({
      data: {
        lot_id: lotId.OPEN,
        reason_code: 'DIMENSION_ABNORMAL',
        status_code: 'HELD',
        held_by: heldByAId,
        held_at: new Date(T2),
        target_lot_status_code: 'INSPECTION_PENDING',
      },
    });
    lotHoldId.OPEN = Number(openHold.lot_hold_id);

    lotId.RELEASED = await newLot('RELEASED', item2Id, 'NORMAL');
    const releasedHold = await prisma.lot_hold.create({
      data: {
        lot_id: lotId.RELEASED,
        reason_code: 'CLAIM_RECALL',
        status_code: 'HELD',
        held_by: heldByBId,
        held_at: new Date(T1),
        released_by: heldByBId,
        released_at: new Date(T2),
        release_reason_code: 'INVESTIGATION_CLEARED',
        target_lot_status_code: 'DEFECTIVE',
        release_target_lot_status_code: 'NORMAL',
      },
    });
    lotHoldId.RELEASED = Number(releasedHold.lot_hold_id);

    lotId.EXACT1 = await newLot('EXACT1', item1Id, 'NORMAL');
    const exact1Hold = await prisma.lot_hold.create({
      data: { lot_id: lotId.EXACT1, reason_code: 'OTHER', status_code: 'HELD', held_at: new Date(T2) },
    });
    lotHoldId.EXACT1 = Number(exact1Hold.lot_hold_id);
    lotId.EXACT2 = await newLot('EXACT2', item1Id, 'NORMAL');
    const exact2Hold = await prisma.lot_hold.create({
      data: { lot_id: lotId.EXACT2, reason_code: 'OTHER', status_code: 'HELD', held_at: new Date(T2) },
    });
    lotHoldId.EXACT2 = Number(exact2Hold.lot_hold_id);

    lotId.LEGACY = await newLot('LEGACY', item1Id, 'INSPECTION_PENDING');
    const legacyHold = await prisma.lot_hold.create({
      data: {
        lot_id: lotId.LEGACY,
        reason_code: 'INCOMING_INSPECTION_WAIT',
        status_code: 'HELD',
        held_at: new Date(T1),
        // ⛔ target_lot_status_code 를 안 준다 — 마이그 전에 태어난 행을 흉내낸다(NULL 백필 0).
      },
    });
    lotHoldId.LEGACY = Number(legacyHold.lot_hold_id);
  }

  /**
   * 사건 조회(②b) 전용 — LOT 아홉 + `lot_hold` 아홉(EV_EXACT1·EV_EXACT2 는 기존 EXACT1·EXACT2
   * LOT 을 재사용한다). 기간 질의는 `[EV_FROM, EV_TO)`.
   * - EVBOTH — `held_at=EV_FROM`(경계 포함) · `released_at=T_13` · held_by≠released_by(actorId
   *   가 둘을 함께 본다) · target_lot_status_code≠release_target_lot_status_code(§0 #1) ·
   *   holdQty·uomId·releaseCondition 을 실측 채운다(리뷰 Minor-2 — 세 칸이 픽스처 전건 NULL 이었다).
   * - EVBEFORE — `held_at=EV_BEFORE`(기간 «밖» — HELD 는 안 나온다) · `released_at=T_11`(기간
   *   «안» — RELEASED 만 나온다 · #11 이 이 오퍼레이션의 존재 이유).
   * - EVLEGACY — `held_by=NULL`(actorId 키 생략 특성화 · #16). 열린 채로 둔다.
   * - EVOPEN2 — item2 · `held_at=T_14` · held_by=A. 열린 채로 둔다.
   * - EVTIE — `held_at=EV_FROM`(EVBOTH 와 «동률» — 2차 키 `lot_hold_id` 로 깬다) · `lot_type_code='PRODUCT'`.
   * - EVBOUNDARY — `held_at=EV_TO`(끝 경계와 «같은 값» — 미만이라 빠진다).
   * - ⭐ EVPARTIAL(리뷰 Major-2) — `held_at=EV_BEFORE`(기간 밖) · `released_at=T_15`(기간 안) ·
   *   **`release_target_lot_status_code` 를 안 준다** — R-2(부분 해제는 LOT 을 안 옮긴다) 경로에
   *   픽스처가 0행이던 구멍을 막는다. RELEASED 사건이어도 `targetLotStatusCode` 키가 없어야 한다.
   * - ⭐ EV_EXACT1·EV_EXACT2(리뷰 Minor-3) — 기존 `lotId.EXACT1`/`EXACT2`(`lotNo` 가 서로 접두
   *   관계 — `…-EXACT-1` ↔ `…-EXACT-12`)에 `held_at=T_16` 인 사건을 하나씩 심어, `lotNo` 필터가
   *   «정확히 일치」인지(부분 일치로 새면 EXACT1 질의에 EXACT2 도 걸린다) 사건 조회에서도 잠근다.
   */
  async function makeEventLots(): Promise<void> {
    lotId.EVBOTH = await newLot('EVBOTH', item1Id, 'NORMAL');
    const both = await prisma.lot_hold.create({
      data: {
        lot_id: lotId.EVBOTH,
        reason_code: 'FOREIGN_MATTER_SUSPECTED',
        status_code: 'HELD',
        held_by: heldByAId,
        held_at: new Date(EV_FROM),
        target_lot_status_code: 'INSPECTION_PENDING',
        hold_qty: 40,
        uom_id: BigInt(uomId),
        release_condition: '재검사 후 판정 대기',
        released_by: heldByBId,
        released_at: new Date(T_13),
        release_reason_code: 'RETEST_PASS',
        release_target_lot_status_code: 'NORMAL',
      },
    });
    lotHoldId.EVBOTH = Number(both.lot_hold_id);

    lotId.EVBEFORE = await newLot('EVBEFORE', item2Id, 'NORMAL');
    const before = await prisma.lot_hold.create({
      data: {
        lot_id: lotId.EVBEFORE,
        reason_code: 'CLAIM_RECALL',
        status_code: 'HELD',
        held_by: heldByBId,
        held_at: new Date(EV_BEFORE),
        target_lot_status_code: 'DEFECTIVE',
        released_by: heldByAId,
        released_at: new Date(T_11),
        release_reason_code: 'INVESTIGATION_CLEARED',
        release_target_lot_status_code: 'NORMAL',
      },
    });
    lotHoldId.EVBEFORE = Number(before.lot_hold_id);

    lotId.EVLEGACY = await newLot('EVLEGACY', item1Id, 'INSPECTION_PENDING');
    const legacy2 = await prisma.lot_hold.create({
      data: { lot_id: lotId.EVLEGACY, reason_code: 'OTHER', status_code: 'HELD', held_at: new Date(T_12) },
    });
    lotHoldId.EVLEGACY = Number(legacy2.lot_hold_id);

    lotId.EVOPEN2 = await newLot('EVOPEN2', item2Id, 'INSPECTION_PENDING');
    const open2 = await prisma.lot_hold.create({
      data: {
        lot_id: lotId.EVOPEN2,
        reason_code: 'DIMENSION_ABNORMAL',
        status_code: 'HELD',
        held_by: heldByAId,
        held_at: new Date(T_14),
        target_lot_status_code: 'INSPECTION_PENDING',
      },
    });
    lotHoldId.EVOPEN2 = Number(open2.lot_hold_id);

    lotId.EVTIE = await newLot('EVTIE', item2Id, 'INSPECTION_PENDING', 'PRODUCT');
    const tie = await prisma.lot_hold.create({
      data: {
        lot_id: lotId.EVTIE,
        reason_code: 'DIMENSION_ABNORMAL',
        status_code: 'HELD',
        held_by: heldByAId,
        held_at: new Date(EV_FROM),
        target_lot_status_code: 'INSPECTION_PENDING',
      },
    });
    lotHoldId.EVTIE = Number(tie.lot_hold_id);

    lotId.EVBOUNDARY = await newLot('EVBOUNDARY', item1Id, 'INSPECTION_PENDING');
    const boundary = await prisma.lot_hold.create({
      data: { lot_id: lotId.EVBOUNDARY, reason_code: 'OTHER', status_code: 'HELD', held_at: new Date(EV_TO) },
    });
    lotHoldId.EVBOUNDARY = Number(boundary.lot_hold_id);

    // ⭐ 리뷰 Major-2 — 부분 해제(R-2): LOT 을 안 옮겨 release_target_lot_status_code 가 NULL 이다.
    lotId.EVPARTIAL = await newLot('EVPARTIAL', item2Id, 'INSPECTION_PENDING');
    const partial = await prisma.lot_hold.create({
      data: {
        lot_id: lotId.EVPARTIAL,
        reason_code: 'APPEARANCE_ABNORMAL',
        status_code: 'HELD',
        held_at: new Date(EV_BEFORE),
        target_lot_status_code: 'INSPECTION_PENDING',
        released_by: heldByAId,
        released_at: new Date(T_15),
        release_reason_code: 'MANAGER_OVERRIDE',
        // ⛔ release_target_lot_status_code 를 안 준다 — 부분 해제라 LOT 이 안 움직였다.
      },
    });
    lotHoldId.EVPARTIAL = Number(partial.lot_hold_id);

    // ⭐ 리뷰 Minor-3 — lotNo 가 서로 «정확한 접두» 관계인 LOT 짝(목록 테스트 EXACT1/EXACT2 와
    // 같은 모양). ⛔ 기존 EXACT1/EXACT2 LOT 을 재사용하지 않는다 — 그 LOT 에 `lot_hold` 를
    // 더 심으면 `/quality/lot-holds` 목록의 「lotNo 정확 일치(단건)」·「기본 정렬(5건 고정 배열)」
    // 테스트가 행 수 증가로 깨진다(실측 — 최초 시도에서 그렇게 깨졌다).
    lotId.EV_EXACT1 = await newLot('EV_EXACT1', item1Id, 'NORMAL');
    const evExact1 = await prisma.lot_hold.create({
      data: { lot_id: lotId.EV_EXACT1, reason_code: 'OTHER', status_code: 'HELD', held_at: new Date(T_16) },
    });
    lotHoldId.EV_EXACT1 = Number(evExact1.lot_hold_id);

    lotId.EV_EXACT2 = await newLot('EV_EXACT2', item1Id, 'NORMAL');
    const evExact2 = await prisma.lot_hold.create({
      data: { lot_id: lotId.EV_EXACT2, reason_code: 'OTHER', status_code: 'HELD', held_at: new Date(T_16) },
    });
    lotHoldId.EV_EXACT2 = Number(evExact2.lot_hold_id);
  }

  async function newLot(key: string, forItemId: number, statusCode: string, lotTypeCode = 'MATERIAL'): Promise<number> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: lotNo[key],
        item_id: BigInt(forItemId),
        lot_type_code: lotTypeCode,
        plant_id: BigInt(plantId),
        initial_qty: 100,
        uom_id: BigInt(uomId),
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: BigInt(plantId),
        status_code: statusCode,
      },
    });
    return Number(lot.lot_id);
  }

  /** 자가 치유 — 역순(§8-2): lot_hold → lot → item → plant → legal_entity → app_user/role. */
  async function cleanup(): Promise<void> {
    await prisma.lot_hold.deleteMany({ where: { lot: { plant: { plant_code: { startsWith: PREFIX } } } } });
    await prisma.lot.deleteMany({ where: { plant: { plant_code: { startsWith: PREFIX } } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    for (const loginId of [LOGIN_ID, `${LOGIN_ID}-b`]) {
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
