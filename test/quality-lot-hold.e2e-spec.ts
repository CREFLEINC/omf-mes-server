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
// ④ #30 — 「이 경로를 못 쓰는」 계정. `POST /quality/lot-holds` 는 W-03-02·W-03-03 을 요구하므로
// 조회 전용 화면 권한 하나(W-03-01)만 준다 — 권한이 «0개»인 계정으로 재면 「로그인은 됐는데
// 아무 권한도 없다」와 「이 기능만 없다」를 못 가른다.
const ROLE_NO_WRITE = 'E2E_I20_LOT_HOLD_RO';
const NO_WRITE_PERMISSION = 'W-03-01';
// 조회 8건은 계약이 403 을 안 선언한다(`permission.guard.ts:37-41`) — 아무 화면 권한이나 충분하다.
const PERMISSION = 'W-03-02';
// ⑤ #33 — `:confirm` 을 실제로 부르기 위한 권한(`derived-permissions.ts:251`).
const CONFIRM_PERMISSION = 'W-01-01';
const PASSWORD = 'PR-LOT보류-비밀번호';
/** ⭐ 「알려둘 것」 ⓕ — `:release` 의 `remarks` 는 **치환**이다. 두 값이 «달라야» 덮어쓴 자리가 보인다. */
const HELD_REMARKS = '등록-비고';
const RELEASE_REMARKS = '해제-비고';

const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-02-02T00:00:00.000Z';

// ⭐ 사건 조회(②b) 전용 기간 — 목록·상세(T1/T2, 2월) 픽스처보다 «이전»(1월)을 쓴다. 목록
// 테스트(#9b)가 `open=false` 전역 목록을 held_at DESC 로 «필터 없이» 앞 2건씩 끊어 보므로,
// 사건 픽스처가 2월보다 «최근»이면 그 페이지 경계 앞에 끼어든다(실측 — 최초엔 3월로 뒀다가 깨졌다).
const EV_BEFORE = '2026-01-10T00:00:00.000Z'; // 기간 «밖»(등록이 기간 전)
// ⭐ 등록(④) 픽스처가 «미리» 심는 보류의 시각 — 위 두 묶음(2월 목록 · 1월 사건)보다 «먼저»여야
// 한다. 목록 #9b 는 `held_at DESC` 전역 페이지의 앞 4행을 보고 자기 픽스처를 골라내므로,
// 같은 T1 에 새 행을 심으면 그 페이지 경계가 밀려 깨진다(실측 — 최초엔 T1 로 뒀다가 깨졌다).
const W_SEED = '2025-06-01T00:00:00.000Z';
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
  let legalEntityId: bigint;
  let businessUnitId: bigint;
  let warehouseId: number;
  let locationId: number;
  let noWriteCookie: string[];
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
    // ⭐ 등록(④) 전용 — 접두어를 «다르게» 둔다. 위 조회 테스트가 `lotNo.startsWith(PREFIX)` 로
    // 자기 픽스처만 고르는데, `PREFIX` 로 시작하면 등록이 만든 행(held_at = now · 가장 최근)이
    // 그 고정 배열·페이지 경계 단언 앞에 끼어든다.
    WOK1: `LOT-W-OK1-${PREFIX}`,
    WOK2: `LOT-W-OK2-${PREFIX}`,
    WCLAIM: `LOT-W-CLAIM-${PREFIX}`,
    WVAL: `LOT-W-VAL-${PREFIX}`,
    WVAL2: `LOT-W-VAL2-${PREFIX}`,
    WVER1: `LOT-W-VER1-${PREFIX}`,
    WVER2: `LOT-W-VER2-${PREFIX}`,
    WDUP1: `LOT-W-DUP1-${PREFIX}`,
    WDUP2: `LOT-W-DUP2-${PREFIX}`,
    WQTYOK: `LOT-W-QTYOK-${PREFIX}`,
    WQTYNG: `LOT-W-QTYNG-${PREFIX}`,
    WPENDING: `LOT-W-PENDING-${PREFIX}`,
    WR12A: `LOT-W-R12A-${PREFIX}`,
    WR12B: `LOT-W-R12B-${PREFIX}`,
    WIDEM: `LOT-W-IDEM-${PREFIX}`,
    WIDEM2: `LOT-W-IDEM2-${PREFIX}`,
    // ⭐ 해제(⑤) 전용 — 위와 같은 이유로 접두어를 다르게 두고, `held_at` 은 W_SEED(가장 «오래된»
    // 시각)라 전역 `held_at DESC` 페이지의 앞줄(#9·#9b)을 흔들지 않는다.
    RFULL: `LOT-R-FULL-${PREFIX}`,
    RREJ: `LOT-R-REJ-${PREFIX}`,
    RFULLQ: `LOT-R-FULLQ-${PREFIX}`,
    RETAG: `LOT-R-ETAG-${PREFIX}`,
    RIDEM: `LOT-R-IDEM-${PREFIX}`,
    RPART: `LOT-R-PART-${PREFIX}`,
    RPART2: `LOT-R-PART2-${PREFIX}`,
    REXACT: `LOT-R-EXACT-${PREFIX}`,
    RRANGE: `LOT-R-RANGE-${PREFIX}`,
    RSCALE: `LOT-R-SCALE-${PREFIX}`,
    RREM: `LOT-R-REM-${PREFIX}`,
    RREM2: `LOT-R-REM2-${PREFIX}`,
    RDONE: `LOT-R-DONE-${PREFIX}`,
    RSTALE: `LOT-R-STALE-${PREFIX}`,
    RORDER: `LOT-R-ORDER-${PREFIX}`,
    ROTHER: `LOT-R-OTHER-${PREFIX}`,
    RR2: `LOT-R-R2-${PREFIX}`,
    RC9: `LOT-R-C9-${PREFIX}`,
    RCONF: `LOT-R-CONF-${PREFIX}`,
    RVAL: `LOT-R-VAL-${PREFIX}`,
    RROUND: `LOT-R-ROUND-${PREFIX}`,
    // ⭐ 리뷰 Major-1 — 「낡은 토큰」과 「초과 수량」을 «동시에» 갖는 LOT(순서 판정 1 의 (d) 축).
    WVSTALE: `LOT-W-VSTALE-${PREFIX}`,
    // ⭐ 리뷰 Major-2 — 「해제된 «전량» 보류」를 가진 LOT(재Hold 가 되는지).
    WREHOLD: `LOT-W-REHOLD-${PREFIX}`,
  };
  /** ⑤ #33 — `:confirm` 이 보류를 닫는 경로를 «진짜로» 태우기 위한 검사 결과(가짜 픽스처 금지). */
  let confirmResultId: number;

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
    await makeWriteLots();
    await makeReleaseLots();
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

  // ═══ POST /quality/lot-holds(④ · 심장 A) ═══════════════════════════════
  //
  // ⚠ 이 절의 테스트들은 «행을 만든다». 위 조회 절(#1~#17)의 고정 배열·`page.total` 단언이
  //   흔들리지 않도록 셋을 지킨다: ⓐ LOT 이름이 `PREFIX` 로 «시작하지 않는다»(조회 단언이
  //   `startsWith(PREFIX)` 로 자기 픽스처만 고른다) ⓑ 등록 시각(now)이 사건 조회 기간
  //   `[EV_FROM, EV_TO)` «밖»이다 ⓒ 이 절이 파일 «맨 뒤»다(jest 는 선언 순서로 돈다).

  it('⭐ 등록 — 201 이고 본문이 «배열»이다 · 계약 스키마를 통과한다 (↩ 객체로 내면 깨진다)', async () => {
    const response = await postHold({
      lots: [await refOf('WOK1')],
      reasonCode: 'FOREIGN_MATTER_SUSPECTED',
      targetLotStatusCode: 'INSPECTION_PENDING',
      releaseCondition: '재검사 후 판정 대기',
    }).expect(201);

    expect(Array.isArray(response.body)).toBe(true);
    const items = response.body as LotHoldItem[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      lotId: lotId.WOK1,
      lotNo: lotNo.WOK1,
      itemId: item1Id,
      statusCode: 'HELD',
      reasonCode: 'FOREIGN_MATTER_SUSPECTED',
      // A12 ⓐ — 「이 보류가 걸었을 때 LOT 이 간 상태」(계약 `LotHold.lotStatusCode`).
      lotStatusCode: 'INSPECTION_PENDING',
      heldBy: heldByAId,
    });
    const validate = validator('POST /quality/lot-holds', 201);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('등록 — 빈 lots 는 400 RANGE · holdQty 0 도 400 RANGE (↩ 두 절을 지우면 깨진다)', async () => {
    const empty = await postHold({ lots: [], reasonCode: 'OTHER', targetLotStatusCode: 'DEFECTIVE' }).expect(400);
    expect(empty.body.errors[0]).toMatchObject({ field: 'lots', code: 'RANGE' });

    const zero = await postHold({
      lots: [await refOf('WVAL')],
      holdQty: 0,
      uomId,
      reasonCode: 'OTHER',
      targetLotStatusCode: 'DEFECTIVE',
    }).expect(400);
    expect(zero.body.errors[0]).toMatchObject({ field: 'holdQty', code: 'RANGE' });
  });

  it('⭐ 등록 — LOT 둘이면 holdQty 를 보낼 수 없다(400 INVALID) (↩ `W-03-03` §5-3 을 빼면 깨진다)', async () => {
    // ⛔ `uomId` 를 «함께» 보낸다 — 빠뜨리면 PAIR 가 먼저 나 이 규칙이 반증되지 않는다.
    const rejected = await postHold({
      lots: [await refOf('WVAL'), await refOf('WVAL2')],
      holdQty: 10,
      uomId,
      reasonCode: 'OTHER',
      targetLotStatusCode: 'DEFECTIVE',
    }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'holdQty', code: 'INVALID' });
  });

  it('⭐ 등록 — holdQty·uomId 는 한쪽만 오면 400 PAIR 다(500 이 «아니다») (↩ ck_lot_hold_qty_uom 으로 흘리면 500 이다)', async () => {
    const onlyQty = await postHold({
      lots: [await refOf('WVAL')],
      holdQty: 10,
      reasonCode: 'OTHER',
      targetLotStatusCode: 'DEFECTIVE',
    }).expect(400);
    expect(onlyQty.body.errors[0]).toMatchObject({ field: 'uomId', code: 'PAIR' });

    const onlyUom = await postHold({
      lots: [await refOf('WVAL')],
      uomId,
      reasonCode: 'OTHER',
      targetLotStatusCode: 'DEFECTIVE',
    }).expect(400);
    expect(onlyUom.body.errors[0]).toMatchObject({ field: 'holdQty', code: 'PAIR' });
  });

  it('⭐ 등록 — target=INSPECTION_PENDING 인데 releaseCondition 이 없으면 400 REQUIRED (↩ 조건부 필수를 빼면 깨진다)', async () => {
    const rejected = await postHold({
      lots: [await refOf('WVAL')],
      reasonCode: 'OTHER',
      targetLotStatusCode: 'INSPECTION_PENDING',
    }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'releaseCondition', code: 'REQUIRED' });
  });

  it(
    '⭐ 등록 — target=DEFECTIVE 인데 releaseCondition 이 있으면 400 INVALID · 도착 상태가 두 값 밖이면 400 INVALID ' +
      '(↩ 「받지 않는다」를 무시하거나 값 목록을 LOT_STATUS 4값으로 넓히면 깨진다)',
    async () => {
      const withCondition = await postHold({
        lots: [await refOf('WVAL')],
        reasonCode: 'OTHER',
        targetLotStatusCode: 'DEFECTIVE',
        releaseCondition: '있으면 안 된다',
      }).expect(400);
      expect(withCondition.body.errors[0]).toMatchObject({ field: 'releaseCondition', code: 'INVALID' });

      // `NORMAL` 은 `LOT_STATUS` 시드 4값 «안»이라 `assertCodeValues` 는 통과한다 —
      // 두 값(INSPECTION_PENDING·DEFECTIVE)으로 좁히는 절이 «없으면» 이 요청이 200 으로 샌다.
      const wrongTarget = await postHold({
        lots: [await refOf('WVAL')],
        reasonCode: 'OTHER',
        targetLotStatusCode: 'NORMAL',
      }).expect(400);
      expect(wrongTarget.body.errors[0]).toMatchObject({ field: 'targetLotStatusCode', code: 'INVALID' });
    },
  );

  it(
    '⭐⭐ 등록 — 같은 lotId 를 두 번 담으면 400 INVALID 다(404 가 «아니다») ' +
      '(↩ 중복 검사를 빼면 `WHERE lot_id IN (n,n)` 이 한 행이라 「행수」 판정이 404 를 낸다 · §12-1 ⓑ · 결정 — 통보 081)',
    async () => {
      const ref = await refOf('WVAL');
      const rejected = await postHold({
        lots: [ref, ref],
        reasonCode: 'CLAIM_RECALL',
        targetLotStatusCode: 'DEFECTIVE',
      }).expect(400);
      expect(rejected.body.errors[0]).toMatchObject({ field: 'lots', code: 'INVALID' });
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WVAL) } })).toBe(0);
    },
  );

  it(
    '⭐⭐ 등록 — 값 목록 밖 reasonCode 는 400 INVALID 다(§3-1 0단계) ' +
      '(↩ assertCodeValues 를 지우면 201 이 나고 lot_hold 1행이 선다 — `trace.lot_hold.reason_code` 에 FK 가 «0개»라 ' +
      '다른 방어가 하나도 없고, 그 코드가 lot_status_event 에도 실려 화면이 라벨을 못 푼다 · 리뷰 Major-3)',
    async () => {
      const rejected = await postHold({
        lots: [await refOf('WVAL')],
        reasonCode: 'NOT_A_CODE',
        targetLotStatusCode: 'DEFECTIVE',
      }).expect(400);
      expect(rejected.body.errors[0]).toMatchObject({ field: 'reasonCode', code: 'INVALID' });
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WVAL) } })).toBe(0);
    },
  );

  it(
    '⭐⭐ 등록 — lots[].versionNo 가 하나만 틀려도 «전체»가 409 이고 conflictingLotId 가 그 LOT 이다 · ' +
      '버전 대조가 업무 게이트(DUPLICATE_HOLD)보다 «먼저» 난다 ' +
      '(↩ 부분 성공을 허용하거나 b↔c 순서를 뒤집으면 깨진다 · 순서 판정 1)',
    async () => {
      const fresh = await refOf('WVER1');
      const stale = await refOf('WVER2');
      expect(stale.versionNo).toBe(3); // 픽스처 전제 — 보낼 토큰(1)이 «진짜로» 낡았다

      const rejected = await postHold({
        lots: [fresh, { lotId: stale.lotId, versionNo: 1 }],
        reasonCode: 'CLAIM_RECALL',
        targetLotStatusCode: 'DEFECTIVE',
      }).expect(409);

      expect(rejected.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        conflictCause: 'user',
        conflictingLotId: lotId.WVER2,
        currentVersion: '3',
        currentLotStatusCode: 'NORMAL',
      });
      // ⭐ WVER2 는 «열린 전량 보류»도 갖고 있다 — (b)와 (c)의 순서를 뒤집으면 이 응답이
      //   `DUPLICATE_HOLD` 로 바뀐다. 그 자리가 이 단언의 존재 이유다.
      expect(rejected.body.code).not.toBe('DUPLICATE_HOLD');
      expectConflictEnvelope(rejected.body);
      // 판정 3 — 하나라도 어긋나면 «전체» 거부다(성한 WVER1 에도 행이 안 선다).
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WVER1) } })).toBe(0);
    },
  );

  it(
    '⭐⭐ 등록 — 낡은 토큰 «과» 초과 수량을 동시에 가진 LOT 은 VERSION_CONFLICT 가 «먼저»다 ' +
      '(↩ (b)버전 대조를 (d)HOLD_QTY_EXCEEDED 뒤로 옮기면 응답이 HOLD_QTY_EXCEEDED 로 바뀐다 · 순서 판정 1 의 «둘째 절반» · 리뷰 Major-1)',
    async () => {
      const stale = await refOf('WVSTALE');
      expect(stale.versionNo).toBe(3); // 픽스처 전제 — 보낼 토큰(1)이 «진짜로» 낡았다
      // 500(열린 부분 보류) + 3,600 = 4,100 > 4,000(잔액) ⇒ (d) 만 보면 HOLD_QTY_EXCEEDED 다.
      const rejected = await postHold({
        lots: [{ lotId: stale.lotId, versionNo: 1 }],
        holdQty: 3600,
        uomId,
        reasonCode: 'APPEARANCE_ABNORMAL',
        targetLotStatusCode: 'INSPECTION_PENDING',
        releaseCondition: '외관 재검',
      }).expect(409);

      expect(rejected.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        conflictingLotId: lotId.WVSTALE,
        currentVersion: '3',
        currentLotStatusCode: 'NORMAL',
      });
      expect(rejected.body.code).not.toBe('HOLD_QTY_EXCEEDED');
      expectConflictEnvelope(rejected.body);
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WVSTALE), released_at: null } })).toBe(1);
    },
  );

  it(
    '⭐⭐ 등록 — 열린 «전량» 보류가 있으면 409 DUPLICATE_HOLD 이고 conflictingLotId 가 «그» LOT 이다 ' +
      '(↩ 중복 판정을 빼거나 「첫 LOT」을 실으면 깨진다)',
    async () => {
      const rejected = await postHold({
        lots: [await refOf('WDUP1'), await refOf('WDUP2')],
        reasonCode: 'CLAIM_RECALL',
        targetLotStatusCode: 'DEFECTIVE',
      }).expect(409);
      expect(rejected.body).toMatchObject({ code: 'DUPLICATE_HOLD', conflictingLotId: lotId.WDUP2 });
      expect(rejected.body.conflictingLotId).not.toBe(lotId.WDUP1);
      expectConflictEnvelope(rejected.body);
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WDUP1) } })).toBe(0);
    },
  );

  it(
    '⛔⛔ 특성화 — 조회의 `allowed=true` 는 「실행하면 된다」가 «아니다» · ' +
      '바로 위 시험이 «같은 LOT» 에서 409 DUPLICATE_HOLD 를 받는다 (I-20 §12-1 ⓐ · 부채 #337)',
    async () => {
      // ⭐ 이 단언은 **버그를 잡는 것이 아니라 갈림을 «못 박는» 것**이다.
      //    `lot-status-transition.service.ts:rowOf` 의 `allowed` 는 전이표 `from` 판정 «하나»다 —
      //    열린 보류 개수도 전량 보류 존재도 안 본다(결정 — 통보 084). 최종 판정은 실행측이
      //    409/200 으로 낸다. 그 결정이 옳든 그르든, **재는 자리가 0건**이라 다음 사람이
      //    ⓐ `allowed` 를 「실행 가능」으로 읽거나 ⓑ 질의를 더 붙여 «조용히» 뜻을 바꿀 수 있었다.
      // ⛔ 이 시험이 빨개지면 「고쳐서 초록으로」 만들지 마라 — 통보 084 를 다시 여는 자리다.
      const openHolds = await prisma.lot_hold.count({
        where: { lot_id: BigInt(lotId.WDUP2), released_at: null },
      });
      expect(openHolds).toBe(1); // 픽스처 전제 — 열린 «전량» 보류가 하나 있다.

      const response = await request(app.getHttpServer())
        .get(`/api/quality/lot-status-transitions?lotId=${lotId.WDUP2}`)
        .set('Cookie', cookie)
        .expect(200);
      const body = response.body as {
        currentLotStatusCode: string;
        transitions: { actionCode: string; allowed: boolean; blockedReason?: string }[];
      };

      expect(body.currentLotStatusCode).toBe('NORMAL');
      const createHolds = body.transitions.filter((row) => row.actionCode === 'CREATE_HOLD');
      // 공허 방지 — 걸러진 것이 0건이면 아래 루프가 아무것도 안 본다.
      expect(createHolds.length).toBeGreaterThan(0);
      for (const row of createHolds) {
        expect(row.allowed).toBe(true);
        expect(row).not.toHaveProperty('blockedReason');
      }
    },
  );

  it(
    '⭐⭐ 등록 — 해제된 «전량» 보류가 있는 LOT 은 «다시» 보류할 수 있다(클레임·리콜 재Hold) ' +
      '(↩ assertNoOpenFullHold 에서 `released_at: null` 을 지우면 409 DUPLICATE_HOLD 로 막혀, 한 번 풀린 LOT 이 ' +
      '영영 재Hold 불가가 된다 — ⑤(:release)가 서면 해제된 LOT 전건이 그 상태다 · 리뷰 Major-2)',
    async () => {
      // 픽스처 전제 — 이 LOT 의 보류는 「전량(hold_qty NULL)」이고 「이미 해제됨」이다.
      const closed = await prisma.lot_hold.findMany({ where: { lot_id: BigInt(lotId.WREHOLD) } });
      expect(closed).toHaveLength(1);
      expect(closed[0].hold_qty).toBeNull();
      expect(closed[0].released_at).not.toBeNull();

      const response = await postHold({
        lots: [await refOf('WREHOLD')],
        reasonCode: 'CLAIM_RECALL',
        targetLotStatusCode: 'DEFECTIVE',
      }).expect(201);
      expect((response.body as LotHoldItem[])[0].lotId).toBe(lotId.WREHOLD);
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WREHOLD), released_at: null } })).toBe(1);
      expect(await statusOf('WREHOLD')).toBe('DEFECTIVE');
    },
  );

  it(
    '⭐⭐ 등록 — 기존 500 + 신규 3,500 = 보유 4,000 은 «통과»한다(경계) ' +
      '(↩ `>` 를 `>=` 로 바꾸거나 해제된 보류 9,999 를 합계에 넣으면 깨진다)',
    async () => {
      // 「보유」 = `inventory_balance.on_hand_qty` 의 `lot_id` 축 합. // 결정 — 통보 076
      const response = await postHold({
        lots: [await refOf('WQTYOK')],
        holdQty: 3500,
        uomId,
        reasonCode: 'APPEARANCE_ABNORMAL',
        targetLotStatusCode: 'INSPECTION_PENDING',
        releaseCondition: '외관 재검',
      }).expect(201);
      expect((response.body as { holdQty?: number }[])[0].holdQty).toBe(3500);
    },
  );

  it('⭐ 등록 — 기존 500 + 신규 3,501 은 409 HOLD_QTY_EXCEEDED (↩ 합계 판정을 빼거나 열린 보류를 안 세면 깨진다)', async () => {
    const rejected = await postHold({
      lots: [await refOf('WQTYNG')],
      holdQty: 3501,
      uomId,
      reasonCode: 'APPEARANCE_ABNORMAL',
      targetLotStatusCode: 'INSPECTION_PENDING',
      releaseCondition: '외관 재검',
    }).expect(409);
    expect(rejected.body).toMatchObject({ code: 'HOLD_QTY_EXCEEDED', conflictingLotId: lotId.WQTYNG });
    expectConflictEnvelope(rejected.body);
    expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WQTYNG), released_at: null } })).toBe(1);
  });

  it(
    '⭐⭐ 등록 — 성공하면 lot_hold 1행 + lot.status_code 이동 + lot_status_event 1행이 «함께» 선다(B-8) ' +
      '(↩ 트랜잭션을 쪼개거나 전이 배선을 빼면 깨진다)',
    async () => {
      const before = await refOf('WOK2');
      expect(await statusOf('WOK2')).toBe('NORMAL');

      const response = await postHold({
        lots: [before],
        reasonCode: 'DIMENSION_ABNORMAL',
        targetLotStatusCode: 'INSPECTION_PENDING',
        releaseCondition: '치수 재측정',
      }).expect(201);
      const holdId = (response.body as LotHoldItem[])[0].lotHoldId;

      const holds = await prisma.lot_hold.findMany({ where: { lot_id: BigInt(lotId.WOK2) } });
      expect(holds).toHaveLength(1);
      expect(holds[0].hold_qty).toBeNull(); // ⛔ 전량 보류는 NULL 이다(0 이 아니다)
      expect(holds[0].target_lot_status_code).toBe('INSPECTION_PENDING');
      expect(holds[0].held_by).toBe(BigInt(heldByAId));

      expect(await statusOf('WOK2')).toBe('INSPECTION_PENDING');

      const events = await prisma.lot_status_event.findMany({ where: { lot_id: BigInt(lotId.WOK2) } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        previous_status_code: 'NORMAL',
        new_status_code: 'INSPECTION_PENDING',
        transition_code: 'C10',
        source_document_type_code: 'LOT_HOLD',
        source_document_id: BigInt(holdId),
        reason_code: 'DIMENSION_ABNORMAL',
        changed_by: BigInt(heldByAId),
      });
      // ⭐ 리뷰 Nit-1 — `held_at` 과 `changed_at` 이 「한 시각을 나눠 쓴다」는 주석이 단언으로
      //   안 잠겨 있었다(둘을 다른 시각으로 바꾸는 변이가 초록이었다).
      expect(events[0].changed_at).toEqual(holds[0].held_at);
    },
  );

  it('⭐ 등록 — target=DEFECTIVE 는 C9 다(NORMAL LOT 에서 선다) (↩ 액션 매핑을 뒤바꾸면 transition_code 가 C10 이 된다)', async () => {
    await postHold({
      lots: [await refOf('WCLAIM')],
      reasonCode: 'CLAIM_RECALL',
      targetLotStatusCode: 'DEFECTIVE',
    }).expect(201);
    expect(await statusOf('WCLAIM')).toBe('DEFECTIVE');
    const events = await prisma.lot_status_event.findMany({ where: { lot_id: BigInt(lotId.WCLAIM) } });
    expect(events).toHaveLength(1);
    expect(events[0].transition_code).toBe('C9');
  });

  it(
    '⭐⭐ 등록 — INSPECTION_PENDING LOT 에 target=DEFECTIVE(C9)는 400 STATE_LOCKED 이고 lot_hold 가 «한 행도» 안 남는다 ' +
      '(↩ C9 의 from 을 넓히면 200 이 된다 · 결정 — 통보 080 · 순서 판정 2·3)',
    async () => {
      const rejected = await postHold({
        lots: [await refOf('WPENDING')],
        reasonCode: 'CLAIM_RECALL',
        targetLotStatusCode: 'DEFECTIVE',
      }).expect(400);
      expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      // ⭐ INSERT(e)가 전이(f)보다 «먼저» 서는데도 전체가 롤백된다 — 그것이 B-8 이다.
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WPENDING) } })).toBe(0);
      expect(await prisma.lot_status_event.count({ where: { lot_id: BigInt(lotId.WPENDING) } })).toBe(0);
      expect(await statusOf('WPENDING')).toBe('INSPECTION_PENDING');
    },
  );

  it(
    '⭐⭐ 등록 — N LOT 등록에서 lot_status_event.source_document_id 가 LOT 마다 «자기» lot_hold_id 다(R-12) ' +
      '(↩ 배치 한 칸(sourceDocumentId)으로 담으면 둘째 LOT 이 «첫» 보류를 가리켜 깨진다)',
    async () => {
      const response = await postHold({
        lots: [await refOf('WR12A'), await refOf('WR12B')],
        reasonCode: 'FOREIGN_MATTER_SUSPECTED',
        targetLotStatusCode: 'INSPECTION_PENDING',
        releaseCondition: '이물 재검',
      }).expect(201);

      const items = response.body as LotHoldItem[];
      expect(items).toHaveLength(2);
      // 반환 순서 = 입력 순서(코어 `holdWithin` 의 규약).
      expect(items.map((i) => i.lotId)).toEqual([lotId.WR12A, lotId.WR12B]);
      expect(items[0].lotHoldId).not.toBe(items[1].lotHoldId);

      for (const item of items) {
        const events = await prisma.lot_status_event.findMany({ where: { lot_id: BigInt(item.lotId) } });
        expect(events).toHaveLength(1);
        expect(events[0].source_document_type_code).toBe('LOT_HOLD');
        expect(events[0].source_document_id).toBe(BigInt(item.lotHoldId));
      }
    },
  );

  it('⭐ 등록 — 없는 lotId 가 섞이면 404 다(400 이 «아니다») (↩ 계약이 404 를 선언한 것을 뒤집으면 깨진다)', async () => {
    await postHold({
      lots: [await refOf('WVAL'), { lotId: 999999999, versionNo: 1 }],
      reasonCode: 'CLAIM_RECALL',
      targetLotStatusCode: 'DEFECTIVE',
    }).expect(404);
    expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WVAL) } })).toBe(0);
  });

  it('등록 — 권한 없는 계정은 403 (↩ 게이트를 빼면 201 이 된다)', async () => {
    await postHold(
      { lots: [await refOf('WVAL')], reasonCode: 'CLAIM_RECALL', targetLotStatusCode: 'DEFECTIVE' },
      { asCookie: noWriteCookie },
    ).expect(403);
    expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WVAL) } })).toBe(0);
  });

  it('⭐ 등록 — 같은 Idempotency-Key 재전송이 새 행을 안 만든다 (↩ runIdempotent 를 빼면 두 행이 선다)', async () => {
    const key = randomUUID();
    const body = {
      lots: [await refOf('WIDEM')],
      reasonCode: 'OTHER',
      targetLotStatusCode: 'INSPECTION_PENDING',
      releaseCondition: '재확인',
    };
    const first = await postHold(body, { key }).expect(201);
    const again = await postHold(body, { key }).expect(201);

    expect((again.body as LotHoldItem[])[0].lotHoldId).toBe((first.body as LotHoldItem[])[0].lotHoldId);
    expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WIDEM) } })).toBe(1);
    expect(await prisma.lot_status_event.count({ where: { lot_id: BigInt(lotId.WIDEM) } })).toBe(1);
  });

  it(
    '⭐⭐ 등록 — 같은 키·«다른» 본문 재전송은 409 이고 `code` 가 `DUPLICATE_KEY` 다 · 두 번째 보류가 «안» 선다 ' +
      '(↩ runIdempotent 에 FAMILY_CONFLICT_CODE 를 안 넘기거나 값을 INVALID_STATE 로 바꾸면 깨진다 · #337 ⓐ · 결정 — 통보 077)',
    async () => {
      // 이 오퍼레이션의 409 봉투는 `QualityConflictResponse` 이고 `code` 가 **required** 다 —
      // 멱등 흡수가 내는 409 만 그 칸을 비워 두고 있었다(I-19 §12-1 ⓐ).
      const key = randomUUID();
      const ref = await refOf('WIDEM2');
      await postHold({ lots: [ref], reasonCode: 'OTHER', targetLotStatusCode: 'DEFECTIVE' }, { key }).expect(201);

      const rejected = await postHold(
        { lots: [ref], reasonCode: 'CLAIM_RECALL', targetLotStatusCode: 'DEFECTIVE' },
        { key },
      ).expect(409);

      expectConflictEnvelope(rejected.body);
      expect(rejected.body.code).toBe('DUPLICATE_KEY');
      expect(rejected.body.conflictCause).toBe('user');
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.WIDEM2) } })).toBe(1);
    },
  );

  // ═══ POST /quality/lot-holds/{lotHoldId}:release(⑤ · 심장 B) ═══════════
  //
  // ⭐⭐ **If-Match 토큰은 `trace.lot.version_no` 다**(R-24 · 계약 `:1950`·`:2058`).
  //   ⛔ `lot_hold.version_no` 가 아니다 — 픽스처가 그 칸을 «다른 값(7)»으로 심어 두어
  //   원천을 바꾸면 아래 #34·#44·#39 가 함께 깨진다.
  // ⚠ 이 절도 «행을 만든다»(잔량 보류 · `lot_status_event`). 위 조회 절이 안 흔들리도록
  //   LOT 이름은 `LOT-R-…` 이고 픽스처 `held_at` 은 W_SEED(가장 오래된 시각)다.

  it(
    '⭐⭐ 해제 — 이미 해제된 보류는 400 STATE_LOCKED 다(409 가 «아니다») ' +
      '(↩ 재로드하면 풀리는 충돌로 읽어 409 로 내면 깨진다 · §3-3 ⑦ · 공유계약 G-1)',
    async () => {
      const rejected = await release('RDONE', acceptBody(), 400);
      expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      expect(rejected.body).not.toHaveProperty('conflictCause'); // 409 봉투가 «아니다»
      expect(await statusOf('RDONE')).toBe('INSPECTION_PENDING');
    },
  );

  it(
    '⭐⭐ 해제 — `:confirm` 이 닫은 보류에 `:release` 하면 400 STATE_LOCKED 다 ' +
      '(↩ 「열린 것만 본다」를 빼면 한 보류가 «두 번» 닫힌다 · §0 #2 ⓐ)',
    async () => {
      // ⭐ 가짜로 `released_at` 을 심지 않는다 — 검사 확정 경로를 «진짜로» 태워야 「두 번
      //   닫힌다」가 반증된다(③b 에서 가짜 tx 가 orderBy 를 무시했던 자리와 같은 함정).
      const result = await prisma.inspection_result.findUniqueOrThrow({
        where: { inspection_result_id: BigInt(confirmResultId) },
      });
      await request(app.getHttpServer())
        .post(`/api/quality/inspection-results/${confirmResultId}:confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', String(result.version_no))
        .send({})
        .expect(200);

      const closed = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RCONF) } });
      expect(closed.released_at).not.toBeNull(); // 확정이 정말로 닫았다(픽스처 전제)
      expect(closed.release_reason_code).toBe('INCOMING_INSPECTION_PASSED');

      const rejected = await release('RCONF', acceptBody(), 400);
      expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    },
  );

  it(
    '해제 — 낡은 If-Match 면 409 VERSION_CONFLICT + currentVersion·currentLotStatusCode ' +
      '(↩ 대조를 빼면 200 이 된다)',
    async () => {
      const rejected = await release('RSTALE', acceptBody(), 409, { version: 1 });
      expect(rejected.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        conflictCause: 'user',
        currentVersion: '3',
        currentLotStatusCode: 'INSPECTION_PENDING',
      });
      // 거부됐으니 보류는 열린 채다.
      const hold = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RSTALE) } });
      expect(hold.released_at).toBeNull();
    },
  );

  it(
    '⭐ 해제 — 버전 대조가 「이미 해제됨」보다 «먼저» 난다(409 이지 400 이 아니다) ' +
      '(↩ b↔c 순서를 뒤집으면 이 응답이 400 STATE_LOCKED 로 바뀐다 · 판정 1)',
    async () => {
      // RORDER 는 «둘 다» 어긋난다 — 낡은 토큰(1 ≠ 3) «그리고» 이미 해제된 보류.
      const rejected = await release('RORDER', acceptBody(), 409, { version: 1 });
      expect(rejected.body.code).toBe('VERSION_CONFLICT');
      expect(rejected.body.currentVersion).toBe('3');
    },
  );

  it(
    '⭐⭐ 해제 — 전량 해제면 열린 보류가 0 이 되어 LOT 이 NORMAL 로 간다(C7) · `release_target_lot_status_code` 가 채워진다 ' +
      '(↩ 「0 일 때만 이동」을 빼거나 C7↔C8 액션을 바꾸면 깨진다 · 계약 스키마도 함께 잠근다)',
    async () => {
      const response = await release('RFULL', acceptBody(), 200);
      expect(response.body).toMatchObject({ lotHoldId: lotHoldId.RFULL, releaseReasonCode: 'RETEST_PASS' });
      expect(response.body.releasedAt).toBeDefined();

      expect(await statusOf('RFULL')).toBe('NORMAL');
      const events = await prisma.lot_status_event.findMany({ where: { lot_id: BigInt(lotId.RFULL) } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        previous_status_code: 'INSPECTION_PENDING',
        new_status_code: 'NORMAL',
        transition_code: 'C7',
        source_document_type_code: 'LOT_HOLD',
        source_document_id: BigInt(lotHoldId.RFULL),
        reason_code: 'RETEST_PASS',
        changed_by: BigInt(heldByAId),
      });
      // ⭐ R-2 의 «움직인» 쪽 — 실제로 보냈으므로 도착이 남는다(아래 R-2 시험이 반대쪽을 잠근다).
      const hold = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RFULL) } });
      expect(hold.release_target_lot_status_code).toBe('NORMAL');
      expect(hold.released_by).toBe(BigInt(heldByAId));

      const validate = validator('POST /quality/lot-holds/{lotHoldId}:release');
      expect(validate(response.body)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
    },
  );

  it(
    '⭐ 해제 — target=DEFECTIVE 면 C8 이고 LOT 이 불량으로 간다 ' +
      '(↩ 액션 매핑을 뒤바꾸면 transition_code 가 C7 이 된다)',
    async () => {
      await release('RREJ', rejectBody(), 200);
      expect(await statusOf('RREJ')).toBe('DEFECTIVE');
      const events = await prisma.lot_status_event.findMany({ where: { lot_id: BigInt(lotId.RREJ) } });
      expect(events).toHaveLength(1);
      expect(events[0].transition_code).toBe('C8');
      expect(events[0].new_status_code).toBe('DEFECTIVE');
    },
  );

  it(
    '⭐⭐ 해제 — 부분 해제는 잔량 보류 행을 «새로» 만들고 원 행 `hold_qty` 를 «안 줄인다»(B-3) ' +
      '(↩ 원 행의 수량을 깎으면 깨진다 · 잔량 행의 held_at·held_by 는 «지금·이 사람»이다)',
    async () => {
      await release('RPART', { ...acceptBody(), releaseQty: 40 }, 200);

      const holds = await prisma.lot_hold.findMany({
        where: { lot_id: BigInt(lotId.RPART) },
        orderBy: { lot_hold_id: 'asc' },
      });
      expect(holds).toHaveLength(2);
      const [origin, remainder] = holds;
      expect(Number(origin.hold_qty)).toBe(100); // ⛔ 60 으로 «안» 줄인다
      expect(origin.released_at).not.toBeNull();
      expect(Number(remainder.hold_qty)).toBe(60);
      expect(remainder.released_at).toBeNull();
      expect(remainder.reason_code).toBe(origin.reason_code);
      expect(remainder.held_by).toBe(BigInt(heldByAId));
      expect(remainder.held_at.getTime()).toBeGreaterThan(origin.held_at.getTime()); // 문의 079
    },
  );

  it(
    '⭐⭐ 해제 — 부분 해제는 LOT 을 «안 움직인다»(200 이고 lot_status_event 0행) · ETag 도 «그대로»다 ' +
      '(↩ 잔량 행을 세고도 옮기거나, 안 움직였다고 400 을 내면 깨진다 · 판정 3)',
    async () => {
      const before = await lotVersionOf('RPART2');
      const response = await release('RPART2', { ...acceptBody(), releaseQty: 30 }, 200);

      expect(await statusOf('RPART2')).toBe('INSPECTION_PENDING'); // 안 움직였다
      expect(await prisma.lot_status_event.count({ where: { lot_id: BigInt(lotId.RPART2) } })).toBe(0);
      // ⭐⭐ 토큰이 `trace.lot.version_no` 라서 LOT 이 안 움직이면 ETag 가 «안 오른다» —
      //   방금 보낸 If-Match 를 그대로 다시 쓸 수 있다. (`lot_hold.version_no`(7)가 아니다.)
      expect(Number(response.headers.etag)).toBe(before);
      expect(await lotVersionOf('RPART2')).toBe(before);
      expect(Number(response.headers.etag)).not.toBe(7);
    },
  );

  it(
    '⭐⭐ 해제 — 다른 열린 보류가 남으면 LOT 이 «안 움직인다»(200) · 대상 «한 건»만 닫힌다 ' +
      '(↩ `releaseWithin` 의 target 을 `lotHoldIds` 로 안 좁히면 같은 사유의 다른 보류까지 닫히고 LOT 이 NORMAL 로 «풀린다»)',
    async () => {
      // ⭐ 두 보류의 `reason_code` 가 «같다» — 좁히기를 `{ lotId, reasonCode }` 로 바꿔도
      //   컴파일은 되므로, 둘째 보류가 열린 채 남는 이 단언이 유일한 그물이다.
      const response = await release('ROTHER', acceptBody(), 200);
      expect(response.body.lotHoldId).toBe(lotHoldId.ROTHER);

      expect(await statusOf('ROTHER')).toBe('INSPECTION_PENDING');
      expect(await prisma.lot_status_event.count({ where: { lot_id: BigInt(lotId.ROTHER) } })).toBe(0);
      const other = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.ROTHER_B) } });
      expect(other.released_at).toBeNull(); // ⭐ 남의 보류는 안 닫혔다
    },
  );

  it(
    '⭐⭐ 해제 — LOT 이 «안 움직인» 해제는 `release_target_lot_status_code` 가 «비어 있다»(R-2) ' +
      '(↩ 요청값을 그냥 저장하면 이력의 「전이」 열에 「보류 → 정상」이 «거짓»으로 그려진다)',
    async () => {
      await release('RR2', acceptBody(), 200);
      const hold = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RR2) } });
      expect(hold.released_at).not.toBeNull(); // 해제는 됐다
      expect(hold.release_reason_code).toBe('RETEST_PASS'); // 사유는 남는다
      expect(hold.release_target_lot_status_code).toBeNull(); // ⭐ 도착만 비운다
      // 대조 — 「걸었을 때 간 상태」(등록 도착)는 그대로다. 두 칸을 섞으면 이것도 깨진다.
      expect(hold.target_lot_status_code).toBe('INSPECTION_PENDING');
      expect(await statusOf('RR2')).toBe('INSPECTION_PENDING');
    },
  );

  it(
    '⭐⭐ 해제 — `releaseQty == hold_qty` 는 잔량 행을 «안 만들고» LOT 이 움직인다(R-6 · 한계와 같은 값) ' +
      '(↩ 잔량 0 행을 세우면 `app.qty_t CHECK (VALUE >= 0)` 를 통과해 조용히 서고 LOT 이 영영 안 움직인다)',
    async () => {
      await release('REXACT', { ...acceptBody(), releaseQty: 100 }, 200);

      const holds = await prisma.lot_hold.findMany({ where: { lot_id: BigInt(lotId.REXACT) } });
      expect(holds).toHaveLength(1); // ⭐ 잔량 행이 «없다»
      expect(holds[0].released_at).not.toBeNull();
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.REXACT), released_at: null } })).toBe(0);
      expect(await statusOf('REXACT')).toBe('NORMAL'); // openAfter 0 → 움직인다
      expect(holds[0].release_target_lot_status_code).toBe('NORMAL'); // 움직였으니 도착이 남는다
    },
  );

  it(
    '⭐⭐ 해제 — 잔량이 컬럼 스케일 «아래»로 떨어지는 releaseQty(소수 7자리)는 400 RANGE 고 «아무것도» 안 남는다 ' +
      '(↩ 자리수 검사를 지우거나 `> 6` 을 넓히면 200 이고, 잔량 `1e-7` 이 `numeric(20,6)` 에 **0 으로 접혀** ' +
      '「보류 수량 0 짜리 열린 보류」가 조용히 서서 LOT 이 영영 안 움직인다 — R-6 이 막으려던 그 문장)',
    async () => {
      const before = await lotVersionOf('RSCALE');
      // ⭐ 「한계와 «한 자리 넘는» 값」(R-19) — REXACT 의 「정수 자리에서 같은 값」은 이 자리를 못 잡는다.
      const rejected = await release('RSCALE', { ...acceptBody(), releaseQty: 99.9999999 }, 400);
      expect(rejected.body.errors[0]).toMatchObject({ field: 'releaseQty', code: 'RANGE' });

      const holds = await prisma.lot_hold.findMany({ where: { lot_id: BigInt(lotId.RSCALE) } });
      expect(holds).toHaveLength(1); // ⭐ 「보류 수량 0」 잔량 행이 «안» 섰다
      expect(holds[0].released_at).toBeNull();
      expect(await prisma.lot_status_event.count({ where: { lot_id: BigInt(lotId.RSCALE) } })).toBe(0);
      expect(await statusOf('RSCALE')).toBe('INSPECTION_PENDING');
      expect(await lotVersionOf('RSCALE')).toBe(before);
    },
  );

  it(
    '⭐⭐ 해제 — `remarks` 는 **치환**이다: 원 행에 실리고 · 안 보내면 등록 비고가 그대로 남고 · 잔량 행은 «등록» 비고를 물려받는다 ' +
      '(↩ 해제 본문의 `remarks` 를 안 실으면 첫 단언이 깨진다 · 계획 「알려둘 것」 ⓕ · 통보 071)',
    async () => {
      // ⓐ 보냈다 — 원 행의 비고가 «덮인다». 칸이 하나뿐이라 등록 비고는 원 행에서 사라진다.
      await release('RREM', { ...acceptBody(), releaseQty: 40, remarks: RELEASE_REMARKS }, 200);
      const holds = await prisma.lot_hold.findMany({
        where: { lot_id: BigInt(lotId.RREM) },
        orderBy: { lot_hold_id: 'asc' },
      });
      expect(holds).toHaveLength(2);
      expect(holds[0].remarks).toBe(RELEASE_REMARKS);
      // ⓑ 잔량 행은 «등록» 비고를 물려받는다 — 해제 비고가 새 보류의 비고로 흘러가지 «않는다».
      expect(holds[1].remarks).toBe(HELD_REMARKS);

      // ⓒ 안 보내면 무변경이다 — 널로 지우지 «않는다»(I-19 「알려둘 것」 ⓒ 와 반대 방향).
      await release('RREM2', acceptBody(), 200);
      const kept = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RREM2) } });
      expect(kept.released_at).not.toBeNull();
      expect(kept.remarks).toBe(HELD_REMARKS);
    },
  );

  it(
    '⭐⭐ 해제 — DEFECTIVE LOT(C9 로 걸린 보류)은 400 STATE_LOCKED 이고 «아무것도» 안 남는다 ' +
      '(↩ C7·C8 의 from 을 넓히면 200 이 된다 · 결정 — 통보 071)',
    async () => {
      const rejected = await release('RC9', acceptBody(), 400);
      expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      // ⭐ 해제 UPDATE 가 전이보다 «먼저» 서는데도 전체가 롤백된다 — 그것이 B-8 이다.
      const hold = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RC9) } });
      expect(hold.released_at).toBeNull();
      expect(await prisma.lot_status_event.count({ where: { lot_id: BigInt(lotId.RC9) } })).toBe(0);
      expect(await statusOf('RC9')).toBe('DEFECTIVE');
    },
  );

  it('해제 — releaseQty 가 hold_qty 를 넘으면 400 RANGE (↩ `>` 를 지우면 음수 잔량이 CHECK 로 500 이 된다)', async () => {
    const rejected = await release('RRANGE', { ...acceptBody(), releaseQty: 150 }, 400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'releaseQty', code: 'RANGE' });
    const hold = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RRANGE) } });
    expect(hold.released_at).toBeNull();
  });

  it('해제 — 전량 보류(hold_qty NULL)에 releaseQty 를 주면 400 INVALID (↩ 빼면 잔량 계산에 뺄 원본이 없다)', async () => {
    const rejected = await release('RFULLQ', { ...acceptBody(), releaseQty: 10 }, 400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'releaseQty', code: 'INVALID' });
    expect(await statusOf('RFULLQ')).toBe('INSPECTION_PENDING');
  });

  it(
    '⭐⭐ 해제 — 응답 ETag 가 «오른» trace.lot.version_no 다(lot_hold.version_no 가 «아니다») ' +
      '(↩ ETag 원천을 lot_hold.version_no 로 바꾸면 깨진다 · R-24)',
    async () => {
      const before = await lotVersionOf('RETAG');
      const holdBefore = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RETAG) } });
      expect(holdBefore.version_no).not.toBe(before); // 픽스처 전제 — 둘이 «다른 값»이다

      const response = await release('RETAG', acceptBody(), 200, { version: before });
      expect(Number(response.headers.etag)).toBe(before + 1);
      expect(await lotVersionOf('RETAG')).toBe(before + 1);
      // ⛔ 해제는 `lot_hold.version_no` 를 읽지도 «쓰지도» 않는다(R-24 — 죽은 칸).
      const holdAfter = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RETAG) } });
      expect(holdAfter.version_no).toBe(holdBefore.version_no);
      expect(Number(response.headers.etag)).not.toBe(holdAfter.version_no);
    },
  );

  it(
    '⭐ 해제 — 도착 상태가 NORMAL·DEFECTIVE 밖이면 400 INVALID (↩ 두 값으로 좁히는 절을 빼면 액션이 없어 500 이거나 조용히 샌다)',
    async () => {
      // `INSPECTION_PENDING` 은 `LOT_STATUS` 시드 4값 «안»이라 `assertCodeValues` 는 통과한다 —
      // 등록(C10)의 도착이지 해제(C7·C8)의 도착이 아니다. 두 표를 합치면 이 요청이 샌다.
      const rejected = await release('RVAL', { targetLotStatusCode: 'INSPECTION_PENDING', releaseReasonCode: 'RETEST_PASS' }, 400);
      expect(rejected.body.errors[0]).toMatchObject({ field: 'targetLotStatusCode', code: 'INVALID' });
    },
  );

  it('해제 — releaseQty 0 은 400 RANGE (↩ 절을 지우면 「전량 보류」로 오인된다 — 전량은 NULL 이지 0 이 아니다)', async () => {
    const rejected = await release('RVAL', { ...acceptBody(), releaseQty: 0 }, 400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'releaseQty', code: 'RANGE' });
  });

  it('해제 — 값 목록 밖 releaseReasonCode 는 400 INVALID 다(트랜잭션 «밖») (↩ assertCodeValues 를 빼면 ck_lot_hold_release_reason 밖 값이 저장된다)', async () => {
    const rejected = await release('RVAL', { targetLotStatusCode: 'NORMAL', releaseReasonCode: 'NOT_A_REASON' }, 400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'releaseReasonCode', code: 'INVALID' });
  });

  it('해제 — 없는 lotHoldId 는 404 다 (↩ 계약이 404 를 선언한 것을 뒤집으면 깨진다)', async () => {
    await request(app.getHttpServer())
      .post('/api/quality/lot-holds/999999999:release')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send(acceptBody())
      .expect(404);
  });

  it('해제 — 권한 없는 계정은 403 (↩ 게이트를 빼면 200 이 된다)', async () => {
    await release('RVAL', acceptBody(), 403, { asCookie: noWriteCookie });
    const hold = await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: BigInt(lotHoldId.RVAL) } });
    expect(hold.released_at).toBeNull();
  });

  it(
    '⭐⭐ ④↔⑤ 왕복 — 전량 보류를 해제한 뒤 «같은 LOT 에 다시» 보류할 수 있다(201) ' +
      '(↩ 등록의 중복 판정에서 `released_at: null` 필터가 빠지면, `:release` 가 들어온 뒤로는 ' +
      '해제된 LOT 전건이 영영 409 DUPLICATE_HOLD 가 된다 — ④ 리뷰 Major-2 가 ⑤ 로 «전면화»되는 자리)',
    async () => {
      // ⓐ 전량 해제 — 열린 보류가 0 이 되어 LOT 이 NORMAL 로 간다(C7).
      await release('RROUND', acceptBody(), 200);
      expect(await statusOf('RROUND')).toBe('NORMAL');
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.RROUND), released_at: null } })).toBe(0);
      // 「안 걸리는 행」이 실제로 남아 있다 — 닫힌 전량 보류 한 건.
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.RROUND), hold_qty: null } })).toBe(1);

      // ⓑ 그 LOT 에 «다시» 전량 보류 — C9(NORMAL → DEFECTIVE)로 선다.
      const registered = await postHold({
        lots: [await refOf('RROUND')],
        reasonCode: 'CLAIM_RECALL',
        targetLotStatusCode: 'DEFECTIVE',
      }).expect(201);
      expect((registered.body as LotHoldItem[])[0].lotId).toBe(lotId.RROUND);
      expect(await statusOf('RROUND')).toBe('DEFECTIVE');
      expect(await prisma.lot_hold.count({ where: { lot_id: BigInt(lotId.RROUND), released_at: null } })).toBe(1);
    },
  );

  it('⭐ 해제 — 같은 Idempotency-Key 재전송이 두 번 해제하지 않는다 (↩ runVersioned 를 빼면 둘째가 400 STATE_LOCKED 다)', async () => {
    const key = randomUUID();
    const version = await lotVersionOf('RIDEM');
    const first = await release('RIDEM', acceptBody(), 200, { version, idempotencyKey: key });
    const again = await release('RIDEM', acceptBody(), 200, { version, idempotencyKey: key });

    expect(again.body.lotHoldId).toBe(first.body.lotHoldId);
    expect(again.body.releasedAt).toBe(first.body.releasedAt);
    expect(Number(again.headers.etag)).toBe(Number(first.headers.etag));
    expect(await prisma.lot_status_event.count({ where: { lot_id: BigInt(lotId.RIDEM) } })).toBe(1);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /** 계약 `LotHoldRelease` — 재판정 «합격»(C7 · 도착 정상). */
  function acceptBody(): { targetLotStatusCode: string; releaseReasonCode: string } {
    return { targetLotStatusCode: 'NORMAL', releaseReasonCode: 'RETEST_PASS' };
  }

  /** 재판정 «불합격»(C8 · 도착 불량). */
  function rejectBody(): { targetLotStatusCode: string; releaseReasonCode: string } {
    return { targetLotStatusCode: 'DEFECTIVE', releaseReasonCode: 'RETEST_FAIL' };
  }

  /**
   * ⭐⭐ If-Match 기본값이 **LOT 의 `version_no`** 다(R-24) — `lot_hold.version_no` 가 아니다.
   * 픽스처가 보류 쪽을 7 로 심어 두어, 원천을 바꾸면 토큰이 안 맞아 409 로 떨어진다.
   */
  async function release(
    key: string,
    body: object,
    status: number,
    options: { version?: number; idempotencyKey?: string; asCookie?: string[] } = {},
  ): Promise<request.Response> {
    const version = options.version ?? (await lotVersionOf(key));
    return request(app.getHttpServer())
      .post(`/api/quality/lot-holds/${lotHoldId[key]}:release`)
      .set('Cookie', options.asCookie ?? cookie)
      .set('Idempotency-Key', options.idempotencyKey ?? randomUUID())
      .set('If-Match', String(version))
      .send(body)
      .expect(status);
  }

  async function lotVersionOf(key: string): Promise<number> {
    return (await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId[key]) } })).version_no;
  }

  /**
   * 해제(⑤) 픽스처 — LOT 하나 + 보류 하나가 기본이다. 전부 `INSPECTION_PENDING` 에서 시작한다
   * (C7·C8 의 `from` 이 그 한 값이다). `held_at` 은 W_SEED — 위 조회 절의 페이지 경계 밖이다.
   * - RFULL·RREJ — 열린 전량 보류. C7·C8 이 각각 선다. RVAL — 거절 갈래 전용(끝까지 열려 있다).
   * - RROUND — ④↔⑤ 왕복(해제한 뒤 «다시» 보류할 수 있다).
   * - RFULLQ — 전량 보류(`hold_qty` NULL)에 `releaseQty` 를 주는 갈래(400 INVALID).
   * - RETAG — ETag 원천(R-24). RIDEM — 멱등.
   * - RPART·RPART2 — 부분 해제(잔량 행 · LOT 안 움직임). REXACT — 「한계와 같은 값」(R-6).
   * - RRANGE — 초과(400 RANGE). RSCALE — 「한계보다 «한 자리 더»」(소수 7자리 · 400 RANGE).
   * - RREM·RREM2 — `remarks` 치환(등록 비고를 심어 둔다 · 「알려둘 것」 ⓕ).
   * - RDONE — 이미 해제된 보류(400 STATE_LOCKED). RSTALE — `lot.version_no=3`(낡은 토큰).
   * - RORDER — 낡은 토큰 «그리고» 이미 해제됨(b↔c 순서 판정).
   * - ROTHER·RR2 — 같은 사유의 열린 보류 «둘»(좁히기 · R-2).
   * - RC9 — `DEFECTIVE` LOT(C9 로 걸린 보류) — C7·C8 의 `from` 밖(통보 071).
   * - RCONF — `:confirm` 이 닫을 수입검사 보류 + 그 검사 의뢰·결과.
   */
  async function makeReleaseLots(): Promise<void> {
    for (const key of ['RFULL', 'RREJ', 'RFULLQ', 'RETAG', 'RIDEM', 'RVAL', 'RROUND']) {
      lotId[key] = await newLot(key, item1Id, 'INSPECTION_PENDING');
      lotHoldId[key] = await newReleasableHold(lotId[key], {});
    }
    for (const key of ['RPART', 'RPART2', 'REXACT', 'RRANGE', 'RSCALE']) {
      lotId[key] = await newLot(key, item1Id, 'INSPECTION_PENDING');
      lotHoldId[key] = await newReleasableHold(lotId[key], { holdQty: 100 });
    }
    // ⭐ `remarks` 치환(계획 「알려둘 것」 ⓕ) — 등록 비고를 «심어야» 「덮는다」와 「그대로 둔다」가 갈린다.
    lotId.RREM = await newLot('RREM', item1Id, 'INSPECTION_PENDING');
    lotHoldId.RREM = await newReleasableHold(lotId.RREM, { holdQty: 100, remarks: HELD_REMARKS });
    lotId.RREM2 = await newLot('RREM2', item1Id, 'INSPECTION_PENDING');
    lotHoldId.RREM2 = await newReleasableHold(lotId.RREM2, { remarks: HELD_REMARKS });
    lotId.RDONE = await newLot('RDONE', item1Id, 'INSPECTION_PENDING');
    lotHoldId.RDONE = await newReleasableHold(lotId.RDONE, { released: true });

    // ⭐ 「진짜로 낡은」 토큰을 보내려면 서버 쪽이 1 이 아니어야 한다(#34·#35).
    for (const key of ['RSTALE', 'RORDER']) {
      lotId[key] = await newLot(key, item1Id, 'INSPECTION_PENDING');
      await prisma.lot.update({ where: { lot_id: BigInt(lotId[key]) }, data: { version_no: 3 } });
    }
    lotHoldId.RSTALE = await newReleasableHold(lotId.RSTALE, {});
    lotHoldId.RORDER = await newReleasableHold(lotId.RORDER, { released: true });

    for (const key of ['ROTHER', 'RR2']) {
      lotId[key] = await newLot(key, item1Id, 'INSPECTION_PENDING');
      lotHoldId[key] = await newReleasableHold(lotId[key], {});
      // ⭐ 사유가 «같은» 둘째 보류 — 좁히기를 사유 축으로 바꿔도 컴파일되므로 이 행이 그물이다.
      lotHoldId[`${key}_B`] = await newReleasableHold(lotId[key], {});
    }

    lotId.RC9 = await newLot('RC9', item1Id, 'DEFECTIVE');
    lotHoldId.RC9 = await newReleasableHold(lotId.RC9, { targetLotStatusCode: 'DEFECTIVE' });

    await makeConfirmFixture();
  }

  /** ⑤ #33 — `:confirm` 이 수입검사 보류를 «진짜로» 닫게 하는 최소 픽스처. */
  async function makeConfirmFixture(): Promise<void> {
    lotId.RCONF = await newLot('RCONF', item1Id, 'INSPECTION_PENDING');
    lotHoldId.RCONF = await newReleasableHold(lotId.RCONF, { reason: 'INCOMING_INSPECTION_WAIT' });
    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-WK`,
        worker_name: 'LOT보류검사원',
        business_unit_id: businessUnitId,
        plant_id: BigInt(plantId),
        status_code: 'EMPLOYED',
      },
    });
    const inspectionRequest = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-IRQ`,
        // ⛔ `PQC` 가 아니다 — C14 전개(같은 W/O 의 생산LOT 일괄 전이)를 안 태운다.
        inspection_type_code: 'INCOMING',
        target_type_code: 'LOT',
        target_id: BigInt(lotId.RCONF),
        item_id: BigInt(item1Id),
        lot_id: BigInt(lotId.RCONF),
        target_qty: 10,
        uom_id: BigInt(uomId),
        status_code: 'REQUESTED',
        requested_at: new Date(W_SEED),
      },
    });
    const result = await prisma.inspection_result.create({
      data: {
        inspection_result_no: `${PREFIX}-IRS`,
        inspection_request_id: inspectionRequest.inspection_request_id,
        inspected_qty: 10,
        accepted_qty: 10,
        uom_id: BigInt(uomId),
        inspector_id: worker.worker_id,
        inspected_at: new Date(W_SEED),
        status_code: 'DRAFT',
        overall_judgment_code: 'ACCEPTED',
        idempotency_key: `${PREFIX}-IRS-KEY`,
      },
    });
    confirmResultId = Number(result.inspection_result_id);
  }

  /**
   * ⭐ `version_no` 를 **7** 로 심는다 — `lot.version_no`(1 또는 3)와 «다른 값»이라야 ETag·If-Match
   * 의 원천을 `lot_hold` 로 바꾸는 변이가 반증된다(R-24). ⛔ 서버는 이 칸을 읽지도 쓰지도 않는다.
   */
  async function newReleasableHold(
    forLotId: number,
    options: { holdQty?: number; reason?: string; released?: boolean; targetLotStatusCode?: string; remarks?: string },
  ): Promise<number> {
    const hold = await prisma.lot_hold.create({
      data: {
        lot_id: forLotId,
        reason_code: options.reason ?? 'APPEARANCE_ABNORMAL',
        status_code: 'HELD',
        held_by: heldByAId,
        held_at: new Date(W_SEED),
        target_lot_status_code: options.targetLotStatusCode ?? 'INSPECTION_PENDING',
        remarks: options.remarks ?? null,
        version_no: 7,
        ...(options.holdQty === undefined ? {} : { hold_qty: options.holdQty, uom_id: BigInt(uomId) }),
        ...(options.released
          ? {
              released_by: heldByBId,
              released_at: new Date(W_SEED),
              release_reason_code: 'INVESTIGATION_CLEARED',
              release_target_lot_status_code: 'NORMAL',
            }
          : {}),
      },
    });
    return Number(hold.lot_hold_id);
  }


  /** 등록 본문의 `lots[]` 한 항목 — ⭐ `version_no` 는 전이 때마다 오르므로 «지금» 읽는다. */
  async function refOf(key: string): Promise<{ lotId: number; versionNo: number }> {
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId[key]) } });
    return { lotId: lotId[key], versionNo: lot.version_no };
  }

  /**
   * 409 셋은 계약이 이 오퍼레이션에 «전용»으로 준 봉투(`QualityConflictResponse`)다 —
   * 값 대조(`toMatchObject`)만으로는 봉투 «적합»이 안 잡힌다(리뷰 Minor-2).
   */
  function expectConflictEnvelope(body: unknown): void {
    const validate = validator('POST /quality/lot-holds', 409);
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  }

  async function statusOf(key: string): Promise<string> {
    return (await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId[key]) } })).status_code;
  }

  /** ⛔ `If-Match` 를 «안» 보낸다 — 이 등록만 토큰을 본문 `lots[].versionNo` 로 싣는다(계약 `:4091`). */
  function postHold(body: object, options: { asCookie?: string[]; key?: string } = {}) {
    return request(app.getHttpServer())
      .post('/api/quality/lot-holds')
      .set('Cookie', options.asCookie ?? cookie)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  }


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

  async function login(loginId = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
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
    // ⑤ #33 이 `POST /quality/inspection-results/{id}:confirm` 을 «진짜로» 부른다 — 그 경로의
    // 권한(`derived-permissions.ts:251`)이 W-01-01 이라 함께 준다.
    for (const permission of [PERMISSION, CONFIRM_PERMISSION]) {
      await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
    }
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    // 두 번째 행위자 — heldBy 필터가 「거르는」 것을 보이려면 값이 서로 달라야 한다.
    const other = await prisma.app_user.create({
      data: { login_id: `${LOGIN_ID}-b`, user_name: 'LOT보류검사행위자B', status_code: 'EMPLOYED' },
    });
    heldByBId = Number(other.app_user_id);

    // ④ #30 — 등록 권한이 «없는» 계정.
    const readOnly = await prisma.app_user.create({
      data: { login_id: `${LOGIN_ID}-c`, user_name: 'LOT보류검사조회전용', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: readOnly.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const readOnlyRole = await prisma.role.create({ data: { role_code: ROLE_NO_WRITE, role_name: 'LOT보류조회전용' } });
    await prisma.role_permission.create({
      data: { role_id: readOnlyRole.role_id, permission_code: NO_WRITE_PERMISSION },
    });
    await prisma.user_role.create({ data: { app_user_id: readOnly.app_user_id, role_id: readOnlyRole.role_id } });
    noWriteCookie = await login(`${LOGIN_ID}-c`);
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'LOT보류검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    legalEntityId = entity.legal_entity_id;
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'LOT보류검사사업부' },
    });
    businessUnitId = unit.business_unit_id;
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'LOT보류검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = Number(plant.plant_id);

    // ④ #25·#26 — `inventory_balance.on_hand_qty` 가 「보유 수량」의 원천이라 창고·위치가 필요하다.
    const warehouse = await prisma.warehouse.create({
      data: { plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH`, warehouse_name: 'LOT보류검사창고', warehouse_type_code: 'RAW', management_level_code: 'LOCATION' },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const location = await prisma.location.create({
      data: { warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: 'LOT보류검사위치', location_type_code: 'BIN' },
    });
    locationId = Number(location.location_id);

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

  /**
   * ⭐ 등록(④) 전용 픽스처. LOT 열넷 — 이름은 `PREFIX` 로 «시작하지 않는다»(조회 단언 보호).
   * - WOK1·WOK2 — `NORMAL`. 성공 경로(#18 배열 · #27 세 행이 함께 선다).
   * - WCLAIM — `NORMAL`. C9(target=DEFECTIVE)가 «서는» 쪽(액션 매핑 반증).
   * - WVAL·WVAL2 — `NORMAL`. 400 갈래 전용(행을 만들지 않는다). WVAL 은 404·중복·403 도 쓴다.
   * - WVER1 — `NORMAL`(버전 그대로). WVER2 — `version_no=3` 으로 올리고 **열린 전량 보류**를
   *   함께 심는다. ⭐ 그 보류가 **판정 1**(버전 대조가 업무 게이트보다 먼저)의 반증 장치다 —
   *   순서를 뒤집으면 #23 의 응답이 `DUPLICATE_HOLD` 로 바뀐다.
   * - WDUP1(보류 0) · WDUP2(열린 전량 보류) — `conflictingLotId` 가 «둘째» LOT 인 것을 잠근다
   *   (「첫 LOT 을 싣는다」로 바꾸면 깨진다).
   * - WQTYOK·WQTYNG — 잔액 4,000 + 열린 «부분» 보류 500. ⭐ WQTYOK 에는 **해제된** 보류
   *   9,999 도 심는다 — `released_at IS NULL` 필터를 지우면 경계 통과(#25)가 깨진다.
   * - WPENDING — `INSPECTION_PENDING`. C9 의 `from` 밖(#28 · 통보 080).
   * - WR12A·WR12B — `NORMAL` 둘. R-12(LOT 마다 자기 `lot_hold_id`).
   * - WIDEM — `NORMAL`. 멱등 재전송. WIDEM2 — 같은 키·«다른» 본문 재전송(#337 ⓐ).
   */
  async function makeWriteLots(): Promise<void> {
    for (const key of ['WOK1', 'WOK2', 'WCLAIM', 'WVAL', 'WVAL2', 'WVER1', 'WDUP1', 'WR12A', 'WR12B', 'WIDEM', 'WIDEM2']) {
      lotId[key] = await newLot(key, item1Id, 'NORMAL');
    }
    lotId.WPENDING = await newLot('WPENDING', item1Id, 'INSPECTION_PENDING');

    lotId.WVER2 = await newLot('WVER2', item1Id, 'NORMAL');
    await prisma.lot.update({ where: { lot_id: BigInt(lotId.WVER2) }, data: { version_no: 3 } });
    await newFullHold(lotId.WVER2);

    lotId.WDUP2 = await newLot('WDUP2', item1Id, 'NORMAL');
    await newFullHold(lotId.WDUP2);

    lotId.WQTYOK = await newLot('WQTYOK', item1Id, 'NORMAL');
    await newBalance(lotId.WQTYOK, 4000);
    await newPartialHold(lotId.WQTYOK, 500);
    // 「안 걸리는 행」 — 해제된 보류는 합계에 들지 않는다(필터를 지우면 #25 가 409 로 깨진다).
    await prisma.lot_hold.create({
      data: {
        lot_id: lotId.WQTYOK,
        hold_qty: 9999,
        uom_id: BigInt(uomId),
        reason_code: 'OTHER',
        status_code: 'HELD',
        held_at: new Date(W_SEED),
        released_at: new Date(W_SEED),
        release_reason_code: 'INVESTIGATION_CLEARED',
      },
    });

    lotId.WQTYNG = await newLot('WQTYNG', item1Id, 'NORMAL');
    await newBalance(lotId.WQTYNG, 4000);
    await newPartialHold(lotId.WQTYNG, 500);

    // ⭐⭐ 리뷰 Major-1 — 「낡은 토큰(version_no=3)」 + 「초과 수량(500 + 3,600 > 4,000)」을 «한
    // LOT» 이 동시에 갖는다. `holdQty` 는 LOT 1건에서만 오므로(2건 이상은 400) 순서 판정 1 의
    // «(d) HOLD_QTY_EXCEEDED 축»은 이런 LOT 없이는 반증이 불가능하다 — WVER2 는 잔액이 0건이라
    // (c) DUPLICATE_HOLD 축만 잡았다.
    lotId.WVSTALE = await newLot('WVSTALE', item1Id, 'NORMAL');
    await prisma.lot.update({ where: { lot_id: BigInt(lotId.WVSTALE) }, data: { version_no: 3 } });
    await newBalance(lotId.WVSTALE, 4000);
    await newPartialHold(lotId.WVSTALE, 500);

    // ⭐⭐ 리뷰 Major-2 — 「해제된 «전량» 보류」(hold_qty NULL + released_at NOT NULL). 이 행이
    // 없으면 `assertNoOpenFullHold` 의 `released_at: null` 필터를 지워도 초록이고, 그 회귀는 이
    // 오퍼레이션의 존재 이유를 죽인다 — 한 번 전량 보류됐다 «풀린» LOT 이 영영 재Hold 불가가
    // 된다(그게 계약이 이 경로에 적은 클레임·리콜 재Hold 다). ⑤(:release)가 서면 해제된 LOT
    // 전건이 그 상태가 된다.
    lotId.WREHOLD = await newLot('WREHOLD', item1Id, 'NORMAL');
    await prisma.lot_hold.create({
      data: {
        lot_id: lotId.WREHOLD,
        reason_code: 'CLAIM_RECALL',
        status_code: 'HELD',
        held_at: new Date(W_SEED),
        released_by: heldByAId,
        released_at: new Date(W_SEED),
        release_reason_code: 'INVESTIGATION_CLEARED',
        release_target_lot_status_code: 'NORMAL',
        // ⛔ hold_qty 를 안 준다 — 「전량」이 NULL 이다. 부분(9,999)으로 두면 다른 함수의
        //    필터만 닫히고 이 자리는 그대로 열린다(리뷰 Major-2 가 짚은 「반쪽」이 그것이다).
      },
    });
  }

  function newFullHold(forLotId: number) {
    return prisma.lot_hold.create({
      // ⛔ 전량 보류는 `hold_qty` 가 **NULL** 이다(0 이 아니다) — DUPLICATE_HOLD 의 판정 축.
      data: { lot_id: forLotId, reason_code: 'CLAIM_RECALL', status_code: 'HELD', held_at: new Date(W_SEED) },
    });
  }

  function newPartialHold(forLotId: number, qty: number) {
    return prisma.lot_hold.create({
      data: { lot_id: forLotId, hold_qty: qty, uom_id: BigInt(uomId), reason_code: 'DIMENSION_ABNORMAL', status_code: 'HELD', held_at: new Date(W_SEED) },
    });
  }

  function newBalance(forLotId: number, onHandQty: number) {
    return prisma.inventory_balance.create({
      data: {
        legal_entity_id: legalEntityId,
        business_unit_id: businessUnitId,
        plant_id: BigInt(plantId),
        warehouse_id: BigInt(warehouseId),
        location_id: BigInt(locationId),
        item_id: BigInt(item1Id),
        lot_id: BigInt(forLotId),
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: onHandQty,
        // 미끼 — 계약이 두 자리에서 「`blocked_qty` 를 쓰지 않는다」고 못 박았다(`:1845`·`:4299`).
        blocked_qty: 999,
        uom_id: BigInt(uomId),
      },
    });
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

  /**
   * 자가 치유 — 역순(§8-2): lot_status_event·lot_hold·inventory_balance → lot → location →
   * warehouse → item → plant → business_unit → legal_entity → app_user/role.
   * ⭐ `lot_status_event` 는 ④ 가 처음 만든다 — 빼면 `lot` 삭제가 FK 로 막힌다.
   */
  async function cleanup(): Promise<void> {
    // ⑤ #33 픽스처 — `lot` 을 참조하므로 LOT 보다 «먼저» 지운다.
    await prisma.inspection_result.deleteMany({
      where: { inspection_request: { inspection_request_no: { startsWith: PREFIX } } },
    });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.lot_status_event.deleteMany({ where: { lot: { plant: { plant_code: { startsWith: PREFIX } } } } });
    await prisma.lot_hold.deleteMany({ where: { lot: { plant: { plant_code: { startsWith: PREFIX } } } } });
    await prisma.inventory_balance.deleteMany({ where: { plant: { plant_code: { startsWith: PREFIX } } } });
    await prisma.lot.deleteMany({ where: { plant: { plant_code: { startsWith: PREFIX } } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    for (const loginId of [LOGIN_ID, `${LOGIN_ID}-b`, `${LOGIN_ID}-c`]) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!user) continue;
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
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
