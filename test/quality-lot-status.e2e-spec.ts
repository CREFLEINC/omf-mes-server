/**
 * `GET /quality/lot-statuses`(I-20 PR ①a1) · `GET /quality/lot-status-summary`(PR ①a2).
 * `W-03-01`·`W-03-02`·`W-03-03` 이 함께 쓴다(§4-1). `lot-status-transitions`(①c) 는 여기 없다.
 *
 * LOT 갈래 7(L1~L7)은 슬라이스 계획 §8-1 을 그대로 쓴다(창고·수량 4칸을 `inventory_balance` 로
 * 접는 §0 #5 · 정렬의 NULL 자리·2차 정렬 키 R-10 · 3값 논리 함정을 `EXISTS`/`NOT EXISTS` 로 피하는
 * §0 #5 를 전건 반증한다). ⭐ **①a2 가 L6 의 `lot_type_code` 를 `PRODUCT` 로 바꿨다**(원래
 * `MATERIAL`) — 기존 17건은 그 칸 값을 단언하지 않아 안 깨진다. `statusCode × lotTypeCode` 를
 * 「합치지 않는다」(§8-3 #18)를 반증하려면 한 상태 안에 유형이 «둘» 있어야 한다(NORMAL = L1·L5
 * `MATERIAL` + L6 `PRODUCT`).
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

const LOGIN_ID = 'e2e-lot-status-probe';
const PASSWORD = 'LOT상태-검사-비밀번호';
const PREFIX = 'I20QA';
const ROLE = 'E2E_LOT_STATUS';
const PERMISSION = 'W-03-01';

// 최근 전이 시각 축 — 정렬·기간 경계 단언이 이 값들로 순서를 못 박는다(브리프 §7).
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';
const T4 = '2026-01-04T00:00:00.000Z';
const T5 = '2026-01-05T00:00:00.000Z';

function validator(path = 'lot-statuses', status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8'),
  ) as object;
  const pointer = `/paths/~1quality~1${path}/get/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface LotStatusItem {
  lotId: number;
  lotNo: string;
  itemId: number;
  lotTypeCode: string;
  lotStatusCode: string;
  versionNo: number;
  warehouseId?: number;
  locationId?: number;
  onHandQty?: number;
  heldQty?: number;
  availableQty?: number;
  uomId?: number;
  openHoldCount: number;
  fullyHeld: boolean;
  latestTransitionAt?: string;
  latestReasonCode?: string;
}
interface LotStatusListBody {
  items: LotStatusItem[];
  page: { page: number; size: number; total: number };
}
interface LotStatusSummaryBody {
  counts: { statusCode: string; lotTypeCode?: string; lotCount: number }[];
  asOf: string;
  outOfScopeCount?: number;
}

describe('LOT 품질 상태 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let plantId: number;
  let itemId: number;
  let uomId: number;
  let warehouse1Id: number;
  let location1Id: number;
  let warehouse2Id: number;
  let location2Id: number;

  const lotId: Record<string, number> = {};
  const lotNo: Record<string, string> = {
    L1: `${PREFIX}-LOT-G1`,
    L2: `${PREFIX}-LOT-F2`,
    L3: `${PREFIX}-LOT-E3`,
    L4: `${PREFIX}-LOT-D4`,
    L5: `${PREFIX}-LOT-C5`,
    L6: `${PREFIX}-LOT-B6`,
    L7: `${PREFIX}-LOT-A7`,
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
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록 — 기본 정렬이 latestTransitionDesc 다 (↩ 기본 sort 를 바꾸면 깨진다)', async () => {
    const body = await list(`plantId=${plantId}`);
    expect(body.items.map((i) => i.lotNo)).toEqual(
      ['L5', 'L4', 'L3', 'L2', 'L7', 'L6', 'L1'].map((k) => lotNo[k]),
    );
  });

  it('목록 — sort=lotNoAsc 가 서버 «전체»를 정렬한다(페이지 2에서 확인) (↩ 현재 페이지만 정렬하면 깨진다)', async () => {
    const body = await list(`plantId=${plantId}&sort=lotNoAsc&page=2&size=3`);
    expect(body.items.map((i) => i.lotNo)).toEqual(['L4', 'L3', 'L2'].map((k) => lotNo[k]));
  });

  it('목록 — 허용 밖 sort 는 400 INVALID (↩ enum 검증을 빼면 깨진다 · 계약 가드가 낸다)', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`/api/quality/lot-statuses?sort=없는정렬`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'sort', code: 'INVALID' });
  });

  it('목록 — sort=latestTransitionAsc 는 NULL 이 뒤로 가고 lot_id ASC 로 동률을 깬다(Minor-4 — 기본 정렬만 돌리면 반대 방향의 NULLS LAST 버그를 놓친다)', async () => {
    const body = await list(`plantId=${plantId}&sort=latestTransitionAsc`);
    expect(body.items.map((i) => i.lotNo)).toEqual(
      ['L2', 'L3', 'L4', 'L5', 'L1', 'L6', 'L7'].map((k) => lotNo[k]),
    );
  });

  it('목록 — 보류가 «없는» LOT(L6)이 excludeFullyHeld=true 에서 사라지지 않는다 · 전량 보류(L2·L4)는 사라진다 (↩ NOT EXISTS 를 nullable 조인 칸의 NOT(…) 으로 바꾸면 L6 이 사라진다)', async () => {
    const body = await list(`plantId=${plantId}&excludeFullyHeld=true`);
    const names = body.items.map((i) => i.lotNo);
    expect(names).toContain(lotNo.L6);
    expect(names).not.toContain(lotNo.L2);
    expect(names).not.toContain(lotNo.L4);
  });

  it('목록 — heldOnly=true 는 열린 보류가 있는 것만(L2·L3·L4) 이다 (↩ released_at 조건을 빼면 깨진다)', async () => {
    const body = await list(`plantId=${plantId}&heldOnly=true`);
    expect(body.items.map((i) => i.lotNo).sort()).toEqual(
      [lotNo.L2, lotNo.L3, lotNo.L4].sort(),
    );
  });

  it('목록 — 해제된 보류만 있는 L5 는 heldOnly 에서 빠진다 (↩ 위와 같은 자리)', async () => {
    const body = await list(`plantId=${plantId}&heldOnly=true`);
    expect(body.items.map((i) => i.lotNo)).not.toContain(lotNo.L5);
  });

  it('목록 — 창고가 둘인 L6 은 warehouseId·locationId 칸이 «없다» · 창고가 하나뿐인 L1 은 «있다» (↩ 첫 행을 고르게 바꾸면 L6 에 값이 생긴다)', async () => {
    const body = await list(`plantId=${plantId}`);
    const l6 = itemOf(body, lotNo.L6);
    const l1 = itemOf(body, lotNo.L1);
    expect(l6.warehouseId).toBeUndefined();
    expect(l6.locationId).toBeUndefined();
    expect(l1.warehouseId).toBe(warehouse1Id);
    expect(l1.locationId).toBe(location1Id);
  });

  it('목록 — warehouseId 필터가 «창고가 둘인» L6 을 살린다(Major-2 — 접힌 bal.warehouse_id 로 걸면 L6 이 사라진다)', async () => {
    const body = await list(`plantId=${plantId}&warehouseId=${warehouse1Id}`);
    const names = body.items.map((i) => i.lotNo);
    expect(names).toContain(lotNo.L6);
    expect(names).not.toContain(lotNo.L7);
  });

  it('목록 — locationId 도 같다(Major-2)', async () => {
    const body = await list(`plantId=${plantId}&locationId=${location1Id}`);
    const names = body.items.map((i) => i.lotNo);
    expect(names).toContain(lotNo.L6);
    expect(names).not.toContain(lotNo.L7);
  });

  it('목록 — itemId·lotStatusCode·lotTypeCode 필터가 각각 «걸리는 행»과 «안 걸리는 행»을 가른다', async () => {
    const byOtherItem = await list(`plantId=${plantId}&itemId=${itemId + 1}`);
    expect(byOtherItem.items).toHaveLength(0);
    const byItem = await list(`plantId=${plantId}&itemId=${itemId}`);
    expect(byItem.items.map((i) => i.lotNo)).toContain(lotNo.L1);

    const byStatus = await list(`plantId=${plantId}&lotStatusCode=DEFECTIVE`);
    expect(byStatus.items.map((i) => i.lotNo)).toEqual([lotNo.L4]);

    const byOtherType = await list(`plantId=${plantId}&lotTypeCode=PACKAGING`);
    expect(byOtherType.items).toHaveLength(0);
    const byType = await list(`plantId=${plantId}&lotTypeCode=MATERIAL`);
    expect(byType.items.map((i) => i.lotNo)).toContain(lotNo.L1);
  });

  it('목록 — 잔액 행이 0인 L7 도 나온다(LEFT JOIN) — onHandQty 키가 «없다» (↩ INNER JOIN 으로 바꾸면 L7 이 사라진다)', async () => {
    const body = await list(`plantId=${plantId}`);
    const l7 = itemOf(body, lotNo.L7);
    expect(l7).toBeDefined();
    expect(l7.onHandQty).toBeUndefined();
  });

  it('목록 — 전량 보류인 L2 는 heldQty 가 onHandQty 와 같다 (↩ SUM(hold_qty)(NULL→0)로 두면 0 이 나온다)', async () => {
    const body = await list(`plantId=${plantId}`);
    const l2 = itemOf(body, lotNo.L2);
    expect(l2.onHandQty).toBe(1000);
    expect(l2.heldQty).toBe(1000);
  });

  it('목록 — availableQty = onHandQty − heldQty 이고 blocked_qty 를 안 본다 (↩ inventory_balance.available_qty 를 그대로 실으면 다른 값이 나온다)', async () => {
    // L3 의 inventory_balance.blocked_qty=999(미끼) — inventory_balance 의 GENERATED
    // available_qty(=on_hand-reserved-picked-blocked=4000-999=3001)를 그대로 실으면
    // 이 값(3500=4000-500)과 달라져 이 단언이 잡는다.
    const body = await list(`plantId=${plantId}`);
    const l3 = itemOf(body, lotNo.L3);
    expect(l3.onHandQty).toBe(4000);
    expect(l3.heldQty).toBe(500);
    expect(l3.availableQty).toBe(3500);
  });

  it('목록 — fullyHeld 는 «해제되지 않은» 전량 보류만 본다(L5 는 false) (↩ released_at 조건을 빼면 L5 가 true 로 나온다)', async () => {
    const body = await list(`plantId=${plantId}`);
    expect(itemOf(body, lotNo.L2).fullyHeld).toBe(true);
    expect(itemOf(body, lotNo.L5).fullyHeld).toBe(false);
    expect(itemOf(body, lotNo.L3).fullyHeld).toBe(false);
  });

  it('목록 — versionNo 가 trace.lot.version_no 다(POST 본문에 그대로 실린다) (↩ 칸을 빼면 계약 required 위반)', async () => {
    const body = await list(`plantId=${plantId}`);
    expect(itemOf(body, lotNo.L1).versionNo).toBe(1);
  });

  it('목록 — transitionFrom 만 보내면 400 PAIR (↩ 쌍 검사를 빼면 깨진다)', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`/api/quality/lot-statuses?transitionFrom=${T1}`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'transitionTo', code: 'PAIR' });
  });

  it('목록 — transitionTo 와 «같은 시각»의 행은 빠진다(반열림) (↩ < 를 <= 로 바꾸면 L5 가 나온다)', async () => {
    const body = await list(
      `plantId=${plantId}&transitionFrom=${T1}&transitionTo=${T5}`,
    );
    const names = body.items.map((i) => i.lotNo);
    expect(names).toEqual(expect.arrayContaining([lotNo.L2, lotNo.L3, lotNo.L4]));
    expect(names).not.toContain(lotNo.L5);
    expect(names).not.toContain(lotNo.L1);
    expect(names).not.toContain(lotNo.L6);
    expect(names).not.toContain(lotNo.L7);
  });

  it('목록 — q 는 lot_no 부분 일치다(정확 일치가 아니다)', async () => {
    const body = await list(`plantId=${plantId}&q=E3`);
    expect(body.items.map((i) => i.lotNo)).toEqual([lotNo.L3]);
  });

  it('목록 — page.total 이 필터 전체 기준이다(페이지 안에서 세지 않는다)', async () => {
    const body = await list(`plantId=${plantId}&heldOnly=true&size=2&page=1`);
    expect(body.items).toHaveLength(2);
    expect(body.page.total).toBe(3);
  });

  it('목록·상세 — 계약 스키마를 통과한다(ajv)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-statuses?plantId=${plantId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator();
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  // ── 요약 `GET /quality/lot-status-summary`(PR ①a2 · §8-3 #17~#22) ────────

  it('요약 — 목록과 «같은 필터»가 걸린다(itemId 를 주면 둘 다 줄어든다) (↩ 필터 빌더를 갈라 두면 깨진다 · #175)', async () => {
    const baseline = await list(`plantId=${plantId}&itemId=${itemId}`);
    expect(baseline.page.total).toBe(7);

    // 요약 합계 == 목록 total(m-5) — #175 가 막으려는 것은 「카드와 목록이 서로 다른 것을 센다」.
    const baseSummary = await summary(`plantId=${plantId}&itemId=${itemId}`);
    expect(baseSummary.counts.reduce((sum, c) => sum + c.lotCount, 0)).toBe(baseline.page.total);

    // 이 플랜트 안에서는 아무 LOT 도 갖지 않는 itemId — 「안 걸리는 행」 쪽(R-19).
    const bogusItemId = itemId + 1_000_000;
    const shrunkList = await list(`plantId=${plantId}&itemId=${bogusItemId}`);
    expect(shrunkList.items).toHaveLength(0);

    const shrunkSummary = await summary(`plantId=${plantId}&itemId=${bogusItemId}`);
    const total = shrunkSummary.counts.reduce((sum, c) => sum + c.lotCount, 0);
    expect(total).toBe(0);
  });

  it('요약 — statusCode × lotTypeCode 로 갈린다(합치지 않는다) (↩ lotTypeCode 를 접으면 깨진다 · L-7)', async () => {
    const body = await summary(`plantId=${plantId}`);
    const normalCells = body.counts.filter((c) => c.statusCode === 'NORMAL');
    // NORMAL = L1·L5(MATERIAL) + L6(PRODUCT) — 합쳐 한 행이면 이 길이가 1 이 된다.
    expect(normalCells).toHaveLength(2);
    expect(normalCells.find((c) => c.lotTypeCode === 'MATERIAL')?.lotCount).toBe(2);
    expect(normalCells.find((c) => c.lotTypeCode === 'PRODUCT')?.lotCount).toBe(1);
  });

  it('요약 — R-16 으로 뒤집는다: LOT_STATUS 4값 전건이 나온다(행이 없는 상태도 0 으로) (↩ 실재하는 조합만 내면 깨진다)', async () => {
    // warehouseId=창고1 로 좁히면 SCRAPPED(L7)는 잔액 행이 0 이라 걸리는 LOT 이 없다 —
    // 그래도 4값 전건이므로 SCRAPPED 행은 남고 lotTypeCode 는 «키가 없다»(모른다 · L-8).
    const body = await summary(`plantId=${plantId}&warehouseId=${warehouse1Id}`);
    // NORMAL 은 창고1 안에서도 유형이 둘(L1·L5=MATERIAL · L6=PRODUCT)이라 두 칸으로 갈린다 —
    // 「4값 전건」은 «상태의 종류»가 넷 다 있다는 뜻이지 행 개수가 4 라는 뜻이 아니다(§4-2).
    const statuses = new Set(body.counts.map((c) => c.statusCode));
    expect(statuses).toEqual(new Set(['DEFECTIVE', 'INSPECTION_PENDING', 'NORMAL', 'SCRAPPED']));

    const scrapped = body.counts.find((c) => c.statusCode === 'SCRAPPED');
    expect(scrapped).toEqual({ statusCode: 'SCRAPPED', lotCount: 0 });
    expect(scrapped).not.toHaveProperty('lotTypeCode');

    const defective = body.counts.find((c) => c.statusCode === 'DEFECTIVE');
    expect(defective?.lotCount).toBe(1);
  });

  it('요약 — lotStatusCode 필터가 왔어도 4값 전건이다(필터 밖 셋은 lotCount:0) (↩ 필터가 오면 1값만 내면 깨진다 · Major M-1)', async () => {
    // DEFECTIVE = L4 하나(MATERIAL) — lotTypeCode 분기가 없어 「4행」이 정확히 나온다.
    const body = await summary(`plantId=${plantId}&lotStatusCode=DEFECTIVE`);
    expect(body.counts).toEqual([
      { statusCode: 'NORMAL', lotCount: 0 },
      { statusCode: 'INSPECTION_PENDING', lotCount: 0 },
      { statusCode: 'DEFECTIVE', lotTypeCode: 'MATERIAL', lotCount: 1 },
      { statusCode: 'SCRAPPED', lotCount: 0 },
    ]);
    // BOGUS 는 계약에 enum 이 없어 가드가 안 막지만, 사용자 입력을 그대로 statusCode 로
    // «되돌리지» 않는다 — WHERE 절만 좁히고 카드축은 여전히 고정 4값이다.
    const bogus = await summary(`plantId=${plantId}&lotStatusCode=BOGUS`);
    expect(bogus.counts).toEqual([
      { statusCode: 'NORMAL', lotCount: 0 },
      { statusCode: 'INSPECTION_PENDING', lotCount: 0 },
      { statusCode: 'DEFECTIVE', lotCount: 0 },
      { statusCode: 'SCRAPPED', lotCount: 0 },
    ]);
  });

  it('요약 — transitionFrom 만 보내면 400 PAIR (↩ 목록과 같은 검증 · 요약 쪽 호출을 지워도 안 깨지면 반증 불가 · Minor m-1)', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`/api/quality/lot-status-summary?plantId=${plantId}&transitionFrom=${T1}`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'transitionTo', code: 'PAIR' });
  });

  it('요약 — outOfScopeCount 키가 «없다» (↩ 0 을 넣으면 깨진다 · L-8)', async () => {
    const body = await summary(`plantId=${plantId}`);
    expect(body).not.toHaveProperty('outOfScopeCount');
  });

  it('요약 — asOf 가 응답에 있다(required) (↩ 칸을 빼면 깨진다)', async () => {
    const before = Date.now();
    const body = await summary(`plantId=${plantId}`);
    const asOf = Date.parse(body.asOf);
    expect(Number.isNaN(asOf)).toBe(false);
    expect(asOf).toBeGreaterThanOrEqual(before);
    expect(asOf).toBeLessThanOrEqual(Date.now());
  });

  it('요약 — 계약 스키마를 통과한다(ajv) (↩ 아무 칸이나 모양이 틀리면 깨진다)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-status-summary?plantId=${plantId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('lot-status-summary');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function itemOf(body: LotStatusListBody, lotNoValue: string): LotStatusItem {
    const found = body.items.find((i) => i.lotNo === lotNoValue);
    if (!found) throw new Error(`픽스처 누락: ${lotNoValue}`);
    return found;
  }

  async function list(query: string): Promise<LotStatusListBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-statuses?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as LotStatusListBody;
  }

  async function summary(query: string): Promise<LotStatusSummaryBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-status-summary?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as LotStatusSummaryBody;
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
      data: { login_id: LOGIN_ID, user_name: 'LOT상태검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'LOT상태검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: PERMISSION } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'LOT상태검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'LOT상태검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'LOT상태검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: 'LOT상태검사품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    itemId = Number(item.item_id);

    const wh1 = await prisma.warehouse.create({
      data: { plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH1`, warehouse_name: 'LOT상태검사창고1', warehouse_type_code: 'RAW', management_level_code: 'LOCATION' },
    });
    warehouse1Id = Number(wh1.warehouse_id);
    const loc1 = await prisma.location.create({
      data: { warehouse_id: wh1.warehouse_id, location_code: `${PREFIX}-LOC1`, location_name: 'LOT상태검사위치1', location_type_code: 'BIN' },
    });
    location1Id = Number(loc1.location_id);

    const wh2 = await prisma.warehouse.create({
      data: { plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH2`, warehouse_name: 'LOT상태검사창고2', warehouse_type_code: 'RAW', management_level_code: 'LOCATION' },
    });
    warehouse2Id = Number(wh2.warehouse_id);
    const loc2 = await prisma.location.create({
      data: { warehouse_id: wh2.warehouse_id, location_code: `${PREFIX}-LOC2`, location_name: 'LOT상태검사위치2', location_type_code: 'BIN' },
    });
    location2Id = Number(loc2.location_id);
  }

  /** LOT 갈래 7(계획 §8-1) — plant_code 접두어 `I20QA` 아래. */
  async function makeLots(): Promise<void> {
    lotId.L1 = await newLot('L1', 'NORMAL');
    lotId.L2 = await newLot('L2', 'INSPECTION_PENDING');
    lotId.L3 = await newLot('L3', 'INSPECTION_PENDING');
    lotId.L4 = await newLot('L4', 'DEFECTIVE');
    lotId.L5 = await newLot('L5', 'NORMAL');
    lotId.L6 = await newLot('L6', 'NORMAL', 'PRODUCT');
    lotId.L7 = await newLot('L7', 'SCRAPPED');

    await newBalance(lotId.L1, warehouse1Id, location1Id, 4000);
    // L1 — 창고2 에 0 수량 잔액 행(Major-1 반증) — 전량 이동/소진 뒤 남는 0 행이 창고 접기를
    // 「창고가 둘」로 잘못 세면 안 된다(아래 「창고가 하나뿐인 L1」 단언이 이 행으로 못 박는다).
    await newBalance(lotId.L1, warehouse2Id, location2Id, 0);
    await newBalance(lotId.L2, warehouse1Id, location1Id, 1000);
    await newBalance(lotId.L3, warehouse1Id, location1Id, 4000, { blockedQty: 999 });
    await newBalance(lotId.L4, warehouse1Id, location1Id, 800);
    await newBalance(lotId.L5, warehouse1Id, location1Id, 2000);
    await newBalance(lotId.L6, warehouse1Id, location1Id, 300);
    await newBalance(lotId.L6, warehouse2Id, location2Id, 300);
    // L7 — 잔액 행 0 (LEFT JOIN 반증).

    // L2 — 전량 보류(열림) · INCOMING_INSPECTION_WAIT.
    await prisma.lot_hold.create({
      data: { lot_id: lotId.L2, reason_code: 'INCOMING_INSPECTION_WAIT', status_code: 'HELD', held_at: new Date(T2) },
    });
    // L3 — 부분 보류(열림 500).
    await prisma.lot_hold.create({
      data: { lot_id: lotId.L3, hold_qty: 500, uom_id: uomId, reason_code: 'DIMENSION_ABNORMAL', status_code: 'HELD', held_at: new Date(T3) },
    });
    // L4 — 전량 보류(열림) · CLAIM_RECALL.
    await prisma.lot_hold.create({
      data: { lot_id: lotId.L4, reason_code: 'CLAIM_RECALL', status_code: 'HELD', held_at: new Date(T4) },
    });
    // L5 — 전량 보류(해제됨). held=T1 · released=T5(경계값) — fullyHeld·기간 반열림 단언이 이 값을 쓴다.
    await prisma.lot_hold.create({
      data: {
        lot_id: lotId.L5,
        reason_code: 'APPEARANCE_ABNORMAL',
        status_code: 'HELD',
        held_at: new Date(T1),
        released_at: new Date(T5),
        release_reason_code: 'INVESTIGATION_CLEARED',
      },
    });
  }

  async function newLot(key: string, statusCode: string, lotTypeCode = 'MATERIAL'): Promise<number> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: lotNo[key],
        item_id: BigInt(itemId),
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

  async function newBalance(
    forLotId: number,
    forWarehouseId: number,
    forLocationId: number,
    onHandQty: number,
    options: { blockedQty?: number } = {},
  ): Promise<void> {
    const plant = await prisma.plant.findUniqueOrThrow({ where: { plant_id: BigInt(plantId) } });
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: plant.legal_entity_id,
        business_unit_id: (await prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: BigInt(forWarehouseId) } })).business_unit_id,
        plant_id: BigInt(plantId),
        warehouse_id: BigInt(forWarehouseId),
        location_id: BigInt(forLocationId),
        item_id: BigInt(itemId),
        lot_id: BigInt(forLotId),
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: onHandQty,
        blocked_qty: options.blockedQty ?? 0,
        uom_id: BigInt(uomId),
      },
    });
  }

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot_hold
       WHERE lot_id IN (SELECT lot_id FROM trace.lot
                         WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'))`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
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
