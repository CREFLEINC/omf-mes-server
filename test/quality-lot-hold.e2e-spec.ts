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

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /** `size` 를 넉넉히 준다 — 목록 질의에 `plantId` 축이 없어(계약 10칸) 다른 슬라이스의 fixture 도 섞일 수 있다. */
  async function listAll(query: string): Promise<LotHoldListBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/lot-holds?size=100&${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as LotHoldListBody;
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

  async function newLot(key: string, forItemId: number, statusCode: string): Promise<number> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: lotNo[key],
        item_id: BigInt(forItemId),
        lot_type_code: 'MATERIAL',
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
