/**
 * ⭐⭐ 제품 LOT 피킹 확정 — `POST …/shipment-requests/{id}/lines/{lineId}:pick` 200(I-22 PR ⑥).
 * 화면 `M-04-01`. 이 슬라이스의 **심장**이고 **예약 코어의 둘째 사용처**다.
 *
 * ⭐⭐ **R-2(ⓒ안)의 유일한 실관측점이 이 파일이다.** 3관점이 예약 규약을 ⓐ안(「`reserved` 만
 * 올린다」)에서 ⓒ안(「걸고 곧바로 푼다」)으로 뒤집었는데, 그 판정이 코드로 참인지는 아래 넷을
 * **다** 걸어야만 드러난다 — 하나라도 빠지면 ⓐ안으로 짜도 전건 초록이다:
 *   P-2 `picked_qty` +Δ · P-3 `reserved_qty` **순변화 0** · P-5 예약 `consumed = reserved` ·
 *   P-6 `openOnly=true` 에 **안 뜬다**.
 *
 * ⭐ 이 파일이 **유일한 그물**인 자리 — ⑫ 배정 상한(계약도 물리도 안 막는다) · 409 네 사유의
 *   **문구 구분**(`code` 가 넷 다 `INVALID_STATE` 라 문구가 유일한 축이다 · R-18) ·
 *   `picked_qty` 컬럼 부재(P-38).
 * ⚠ e2e 로 **반증되지 않는** 축 넷은 다른 층이 본다 — 채번 순서·`FOR UPDATE OF l`·`reserve→pick`
 *   인자는 `shipment-pick.service.spec.ts`, `FAMILY_CONFLICT_CODE` 는 `family-conflict-code.spec.ts`,
 *   `lotNo` 키 생략은 `shipment-request-view.spec.ts` 다(README §6-3).
 * ⚠ 다른 스위트와 같은 DB 를 쓰므로 정리는 접두어(`SRPKE2E`)로만 한다 — `TRUNCATE` 금지.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
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

const LOGIN_ID = 'e2e-shipment-pick-probe';
const NOPERM_ID = 'e2e-shipment-pick-noperm';
const PASSWORD = '제품피킹-비밀번호';
const PREFIX = 'SRPKE2E';
const ROLE = `${PREFIX}-ROLE`;
/**
 * `:pick` 은 403 을 «선언»했고 `DERIVED_PERMISSIONS:181` 이 이 화면 하나를 요구한다.
 * ⭐ `W-04-01` 은 M4 체인 마디가 «편성»을 HTTP 로 부르기 때문이다(`:180`).
 */
const PERMISSIONS = ['M-04-01', 'W-04-01'];
const BASE = '/api/logistics/shipment-requests';
const WORKER_NO = `${PREFIX}-W1`;
/** 다른 스위트의 목록 창 밖이라 서로를 안 흔든다. */
const SHIP_DATE = '2026-11-04';
/** `blocks_picking` 통제가 겨냥할 LOT 상태 — 통제표가 오늘 0행이라 픽스처를 심어야 돈다. */
const BLOCKED_STATUS = `${PREFIX}-BLOCKED`;
/** ⭐ 같은 표의 **안 걸리는** 축 — 「출고는 막지만 피킹은 안 막는」 상태다(§6-3 ⑵). */
const ISSUE_ONLY_STATUS = `${PREFIX}-ISSUE-ONLY`;
const HOLD_REASON = `${PREFIX}-EXPIRED`;
/** `numeric(20,6)` 의 마지막 자리 — 「한계와 같은 값」의 바로 옆이다(§6-3 ⑸). */
const ONE_SCALE = 0.000001;

interface PickBody {
  lotId: number;
  lotNo?: string;
  pickedQty: number;
  uomId: number;
  pickedAt: string;
}
interface LineBody {
  shipmentRequestLineId: number;
  lineNo: number;
  salesOrderLineId: number | null;
  itemId: number;
  requestedQty: number;
  allocatedQty: number;
  pickedQty: number;
  shippedQty: number;
  uomId: number;
  customerLotRequirement: string | null;
  shippingInspectionRequired: boolean;
  minimumRemainingShelfLifeDays: number | null;
  picks: PickBody[];
}
/** M4 마디가 쓰는 헤더 스키마 — 편성 201 과 상세 200 이 같은 `ShipmentRequest` 다. */
interface RequestBody {
  shipmentRequestId: number;
  salesOrderId: number | null;
  shipmentProgressCode: string;
  lines?: LineBody[];
}
interface ErrorBody {
  errors: { field?: string; code: string; message: string }[];
}
interface ConflictBody {
  code: string;
  message: string;
  conflictCause?: string;
}

function validator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8'),
  ) as object;
  const path = '/logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick';
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/post/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

/** UTC 날짜의 자정. 서버가 잔여 유효기간의 「오늘」을 이 축에서 뽑는다. */
function utcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function utcDayAfter(days: number): string {
  return new Date(utcMidnight() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('제품 LOT 피킹 확정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let probeUserId = 0;
  let seq = 0;
  let actorUserId: bigint;

  const ids = {
    entity: 0n,
    unit: 0n,
    plant: 0n,
    warehouse1: 0n,
    warehouse2: 0n,
    location1: 0n,
    location2: 0n,
    uom1: 0,
    uom2: 0,
    item1: 0,
    item2: 0,
    customer: 0,
    shipTo: 0,
    salesOrder: 0n,
    salesOrderLine: 0,
    codeValue: 0n,
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
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── P-1 ~ P-7 · ⭐⭐ ⓒ안의 관측점 · 응답 모양 ──────────────────────────────
  it('P-1 200 이고 계약 ShipmentRequestLine 스키마를 만족한다', async () => {
    const s = await scenario();

    const body = await pick(s, { pickedQty: 30 });

    const validate = validator();
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('P-2 ⭐⭐ inventory_balance.picked_qty 가 Δ 만큼 오른다', async () => {
    const s = await scenario({ onHand: 100 });
    const before = await balanceOf(s.lotId);

    await pick(s, { pickedQty: 30 });

    const after = await balanceOf(s.lotId);
    // ⛔ ⓐ안(예약만 건다)으로 짜면 이 칸이 안 움직여 깨진다(R-2).
    expect(after.picked_qty.minus(before.picked_qty)).toEqual(new Prisma.Decimal(30));
    expect(after.on_hand_qty).toEqual(before.on_hand_qty);
  });

  it('P-3 ⭐⭐ inventory_balance.reserved_qty 는 순변화가 「0」 이다', async () => {
    const s = await scenario({ onHand: 100 });
    const before = await balanceOf(s.lotId);

    await pick(s, { pickedQty: 30 });

    const after = await balanceOf(s.lotId);
    // ⛔ ⓐ안이면 Δ 만큼 올라 깨진다 — 걸고 «곧바로» 푸는 것이 ⓒ안의 정의다.
    expect(after.reserved_qty).toEqual(before.reserved_qty);
    expect(after.reserved_qty).toEqual(new Prisma.Decimal(0));
  });

  it('P-4 available_qty 가 Δ 만큼 내린다', async () => {
    const s = await scenario({ onHand: 100 });
    const before = await balanceOf(s.lotId);

    await pick(s, { pickedQty: 30 });

    const after = await balanceOf(s.lotId);
    expect((after.available_qty as Prisma.Decimal).minus(before.available_qty as Prisma.Decimal)).toEqual(
      new Prisma.Decimal(-30),
    );
  });

  it('P-5 ⭐⭐ 예약 행이 하나 생기고 consumed_qty = reserved_qty 다 (저장 칸 직접 조회)', async () => {
    const s = await scenario({ onHand: 100 });

    await pick(s, { pickedQty: 30 });

    const rows = await reservationsOf(s.lineId);
    expect(rows).toHaveLength(1);
    // ⛔ ⓐ안이면 `consumed = 0` 이라 깨진다. ⭐ 저장 칸(`created_by`·`reservation_no`)은 응답에
    //   실리지 않아 여기서 «직접 조회»해야 반증된다(README §6-3 「저장 칸」 부류).
    expect({
      reserved: rows[0].reserved_qty.toString(),
      consumed: rows[0].consumed_qty.toString(),
      released: rows[0].released_qty.toString(),
      type: rows[0].reservation_type_code,
      source: rows[0].source_document_type_code,
      sourceId: Number(rows[0].source_document_id),
      status: rows[0].status_code,
      itemId: Number(rows[0].item_id),
      lotId: Number(rows[0].lot_id),
      warehouseId: Number(rows[0].warehouse_id),
      locationId: Number(rows[0].location_id),
      uomId: Number(rows[0].uom_id),
      createdBy: Number(rows[0].created_by),
      numbered: rows[0].reservation_no.length > 0,
    }).toEqual({
      reserved: '30',
      consumed: '30',
      released: '0',
      type: 'SHIPMENT',
      source: 'SHIPMENT_REQUEST_LINE',
      sourceId: s.lineId,
      status: 'REGISTERED',
      itemId: ids.item1,
      lotId: s.lotId,
      warehouseId: Number(ids.warehouse1),
      locationId: Number(ids.location1),
      uomId: ids.uom1,
      createdBy: probeUserId,
      numbered: true,
    });
  });

  it('P-6 ⭐⭐ GET /inventory/reservations?openOnly=true 에 그 예약이 「안」 뜬다', async () => {
    const s = await scenario({ onHand: 100 });

    await pick(s, { pickedQty: 30 });

    // ⛔ `lotId` 로 좁힌다 — 이 목록은 원천 «유형» 축이 없어 `scenario()` 가 심은
    //    `PRODUCTION_ORDER` 미끼(같은 id · `lot_id` 널)까지 함께 세기 때문이다(#409 인계).
    const open = await reservationList({ sourceDocumentId: s.lineId, lotId: s.lotId, openOnly: true });
    const all = await reservationList({ sourceDocumentId: s.lineId, lotId: s.lotId });
    // ⛔ ⓐ안이면 열린 채 떠서 «자재» 피킹 목록을 오염시킨다(`M-01-08`).
    expect(open.total).toBe(0);
    expect(all.total).toBe(1);
  });

  it('P-7 reservationNo 가 RS-{YYYYMMDD}-{SEQ4} 다', async () => {
    const s = await scenario({ onHand: 100 });

    await pick(s, { pickedQty: 30 });

    const [row] = await reservationsOf(s.lineId);
    expect(row.reservation_no).toMatch(/^RS-\d{8}-\d{4,}$/);
    expect(row.reservation_no.slice(3, 11)).toBe(utcDayAfter(0).replace(/-/g, ''));
  });

  // ── P-8 ~ P-11 · 누적 규약 · 라인 잠금 ─────────────────────────────────────
  it('P-8 ⭐⭐ 두 번 집으면 pickedQty 가 「합」이다 (누적 ≠ 대체)', async () => {
    const s = await scenario({ onHand: 100, allocated: 80 });

    await pick(s, { pickedQty: 30 });
    const body = await pick(s, { pickedQty: 25 });

    // ⛔ I-8 식 「대체」(`delta = pickedQty − line.picked_qty`)로 짜면 55 가 아니라 25 다.
    expect(body.pickedQty).toBe(55);
    const balance = await balanceOf(s.lotId);
    expect(balance.picked_qty).toEqual(new Prisma.Decimal(55));
  });

  it('P-9 두 번 집으면 예약 행이 「둘」이고 picks 도 둘이다', async () => {
    const s = await scenario({ onHand: 100, allocated: 80 });

    await pick(s, { pickedQty: 30 });
    const body = await pick(s, { pickedQty: 25 });

    const rows = await reservationsOf(s.lineId);
    // 한 행을 UPDATE 하면 「이번에 집은 내역」이 사라진다 — 배열 통째로 대조한다.
    expect(rows.map((row) => row.reserved_qty.toString())).toEqual(['30', '25']);
    expect(body.picks.map((row) => row.pickedQty)).toEqual([30, 25]);
  });

  it('P-10 picks[].pickedAt 이 예약의 created_at 이다', async () => {
    const s = await scenario({ onHand: 100 });

    const body = await pick(s, { pickedQty: 30 });

    const [row] = await reservationsOf(s.lineId);
    expect(body.picks.map((p) => p.pickedAt)).toEqual([row.created_at.toISOString()]);
  });

  it('P-11 ⭐ 같은 작업지시의 「다른 두 라인」을 동시에 피킹해도 둘 다 200 이다', async () => {
    const s = await scenario({ onHand: 100, lines: 2 });
    const second = await stockedLot({ onHand: 100 });

    const [a, b] = await Promise.all([
      call(s.requestId, s.lineIds[0], { lotId: s.lotId, pickedQty: 10, uomId: ids.uom1 }),
      call(s.requestId, s.lineIds[1], { lotId: second, pickedQty: 20, uomId: ids.uom1 }),
    ]);

    // ⚠ `FOR UPDATE OF l` 을 `FOR UPDATE` 로 바꿔도 둘은 «직렬화될 뿐» 결국 성공한다 —
    //   그 변이를 결정적으로 죽이는 것은 `shipment-pick.service.spec.ts` 의 SQL 단언이다.
    //   여기서는 「헤더 잠금이 교착으로 번지지 않는다」를 확인한다.
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await reservationsOf(s.lineIds[0])).length).toBe(1);
    expect((await reservationsOf(s.lineIds[1])).length).toBe(1);
  });

  // ── P-12 ~ P-15 · 400 · 404 갈래 ──────────────────────────────────────────
  it('P-12 pickedQty = 0 이면 400 RANGE 다', async () => {
    const s = await scenario();

    const errors = await reject(s, { pickedQty: 0 });

    // ⭐ 04 는 `exclusiveMinimum` 이 없다 — 서비스가 유일한 그물이다.
    expect(errors).toMatchObject([{ field: 'pickedQty', code: 'RANGE' }]);
  });

  it('P-13 pickedQty 가 음수면 400 RANGE 다', async () => {
    const s = await scenario();

    const errors = await reject(s, { pickedQty: -5 });

    expect(errors).toMatchObject([{ field: 'pickedQty', code: 'RANGE' }]);
  });

  it('P-14 없는 라인 · 「다른 작업지시」의 라인이면 404 다', async () => {
    const s = await scenario();
    const other = await scenario();

    const missing = await call(s.requestId, 99_999_999, body(s));
    const foreign = await call(other.requestId, s.lineId, body(s));

    // ⛔ 부모 id 대조를 빼면 남의 작업지시의 라인을 집을 수 있다.
    expect([missing.status, foreign.status]).toEqual([404, 404]);
  });

  it('P-15 X-Worker-No 가 없으면 400 REQUIRED 다', async () => {
    const s = await scenario();

    const missing = await call(s.requestId, s.lineId, body(s), { workerNo: null });
    // ⭐ 「보냈지만 비었다」도 부재다 — `trim()` 갈래를 지우면 여기서만 죽는다.
    const blank = await call(s.requestId, s.lineId, body(s), { workerNo: '  ' });

    // ⛔ 계약 가드가 헤더를 안 본다 — 서버가 유일한 그물이다.
    expect([missing.status, blank.status]).toEqual([400, 400]);
    for (const response of [missing, blank]) {
      expect((response.body as ErrorBody).errors).toMatchObject([
        { field: 'X-Worker-No', code: 'REQUIRED' },
      ]);
    }
  });

  // ── P-16 ~ P-19 · 409 사유 ① 보류 · 통제 · ⭐ 순서 ─────────────────────────
  it('P-16 ⭐ Hold + 가용 부족 + 배정 초과를 동시에 어기면 「Hold」 사유가 나온다', async () => {
    // ⑦ → ⑪ → ⑫ 가 계약 문장의 순서다 — 셋에 동시에 걸리는 픽스처가 «첫 사유»를 받는다.
    const s = await scenario({ onHand: 1, allocated: 1, requested: 1, hold: 'open' });

    const conflict = await rejectConflict(s, { pickedQty: 100 });

    expect(conflict.code).toBe('INVALID_STATE');
    expect(conflict.message).toContain('보류');
    expect(conflict.message).not.toContain('가용');
    expect(conflict.message).not.toContain('배정');
  });

  it('P-17 ⭐ 미해제 lot_hold 면 409 INVALID_STATE 이고 message 에 보류 사유가 실린다', async () => {
    const s = await scenario({ onHand: 100, hold: 'open' });

    const conflict = await rejectConflict(s, { pickedQty: 30 });

    // ⛔ `code` 만 보면 409 네 사유가 서로를 못 죽인다 — 문구가 유일한 축이다(R-18).
    expect(conflict).toMatchObject({ code: 'INVALID_STATE', conflictCause: 'user' });
    expect(conflict.message).toBe(`보류 중인 LOT 입니다. (사유: ${HOLD_REASON})`);
  });

  it('P-18 해제된 lot_hold 는 안 막는다', async () => {
    const s = await scenario({ onHand: 100, hold: 'released' });

    const body = await pick(s, { pickedQty: 30 });

    // ⛔ `released_at IS NULL` 을 빼면 해제된 보류가 LOT 을 영구히 막는다.
    expect(body.pickedQty).toBe(30);
  });

  it('P-19 blocks_picking 통제 행이 걸린 LOT 상태면 409 다', async () => {
    const s = await scenario({ onHand: 100, lotStatus: BLOCKED_STATUS });

    const conflict = await rejectConflict(s, { pickedQty: 30 });

    expect(conflict.code).toBe('INVALID_STATE');
    expect(conflict.message).toBe('피킹이 막힌 LOT 상태입니다.');
  });

  // ── P-20 ~ P-24 · 409 사유 ② 가용 · ③ 배정 (경계) ─────────────────────────
  it('P-20 ⭐ available_qty 와 「같은」 양은 통과한다', async () => {
    const s = await scenario({ onHand: 40, allocated: 40, requested: 40 });

    const body = await pick(s, { pickedQty: 40 });

    // `>` 로 조이면 전량 피킹이 막힌다.
    expect(body.pickedQty).toBe(40);
    expect((await balanceOf(s.lotId)).available_qty).toEqual(new Prisma.Decimal(0));
  });

  it('P-21 available_qty + 0.000001 이면 409 이고 message 에 가용 수량이 실린다', async () => {
    const s = await scenario({ onHand: 40, allocated: 100, requested: 100 });

    const conflict = await rejectConflict(s, { pickedQty: 40 + ONE_SCALE });

    // ⛔ 하한을 빼면 코어의 트리거가 500 을 낸다.
    expect(conflict.code).toBe('INVALID_STATE');
    expect(conflict.message).toBe('가용 재고가 모자랍니다. (가용 40)');
  });

  it('P-22 ⭐ allocatedQty − Σ예약 과 「같은」 양은 통과한다', async () => {
    const s = await scenario({ onHand: 100, allocated: 40, requested: 100 });

    await pick(s, { pickedQty: 15 });
    const body = await pick(s, { pickedQty: 25 });

    // `>=` 로 조이면 전량 배정 피킹이 막힌다.
    expect(body.pickedQty).toBe(40);
  });

  it('P-23 배정을 한 스케일 넘으면 409 이고 message 에 배정·기피킹이 실린다', async () => {
    const s = await scenario({ onHand: 1000, allocated: 40, requested: 100 });
    await pick(s, { pickedQty: 15 });

    const conflict = await rejectConflict(s, { pickedQty: 25 + ONE_SCALE });

    expect(conflict.code).toBe('INVALID_STATE');
    expect(conflict.message).toBe('배정 수량을 넘습니다. (배정 40 · 이미 피킹 15)');
  });

  it('P-24 ⭐ 0.1 집고 0.2 집으면 배정 0.3 을 「안」 넘는다', async () => {
    const s = await scenario({ onHand: 10, allocated: 0.3, requested: 0.3 });

    await pick(s, { pickedQty: 0.1 });
    const body = await pick(s, { pickedQty: 0.2 });

    // ⛔ `Number` 로 접으면 0.30000000000000004 > 0.3 이라 409 가 된다(§6-3 ⑸).
    expect(body.pickedQty).toBe(0.3);
  });

  // ── P-25 ~ P-28 · 400 잔여 유효기간 (⭐ R-4 로 409 → 400) ──────────────────
  it('P-25 ⭐ 잔여 유효기간이 하한과 「정확히 같으면」 통과한다', async () => {
    const s = await scenario({ onHand: 100, shelfLife: 30, expiry: utcDayAfter(30) });

    const body = await pick(s, { pickedQty: 30 });

    expect(body.pickedQty).toBe(30);
  });

  it('P-26 하루 모자라면 400 RANGE 이고 message 에 요구일·실제일이 실린다', async () => {
    const s = await scenario({ onHand: 100, shelfLife: 30, expiry: utcDayAfter(29) });

    const errors = await reject(s, { pickedQty: 30 });

    // ⛔ 409 로 내면 깨진다 — 「재로드로 풀린다」가 아니라 시간이 갈수록 나빠진다(R-4).
    expect(errors).toMatchObject([
      {
        field: 'lotId',
        code: 'RANGE',
        message: '잔여 유효기간이 모자랍니다. (요구 30일 · 실제 29일)',
      },
    ]);
    expect(errors).toHaveLength(1);
  });

  it('P-27 하한이 걸린 라인에서 expiry_date 가 널이면 400 이다', async () => {
    const s = await scenario({ onHand: 100, shelfLife: 30, expiry: null });

    const errors = await reject(s, { pickedQty: 30 });

    // ⛔ 「모른다」는 「충분하다」가 아니다.
    expect(errors).toMatchObject([{ field: 'lotId', code: 'RANGE' }]);
    expect(errors[0].message).toContain('유효기간이 없는 LOT');
  });

  it('P-28 하한이 null 인 라인은 expiry_date 가 널이어도 통과한다', async () => {
    const s = await scenario({ onHand: 100, shelfLife: null, expiry: null });

    const body = await pick(s, { pickedQty: 30 });

    // 무조건 판정하면 하한 없는 라인이 통째로 막힌다.
    expect(body.pickedQty).toBe(30);
  });

  // ── P-29 ~ P-32 · 참조·차원 ───────────────────────────────────────────────
  it('P-29 LOT 품목이 라인과 다르거나 없는 LOT 이면 400 INVALID 다', async () => {
    const s = await scenario({ onHand: 100 });
    const foreign = await stockedLot({ onHand: 100, item: ids.item2 });

    const mismatch = await reject(s, { lotId: foreign });
    const missing = await reject(s, { lotId: 99_999_999 });

    expect(mismatch).toMatchObject([{ field: 'lotId', code: 'INVALID' }]);
    expect(missing).toMatchObject([{ field: 'lotId', code: 'INVALID' }]);
  });

  it('P-30 uomId 가 라인의 단위와 다르면 400 INVALID 다 (⛔ 환산 없음)', async () => {
    const s = await scenario({ onHand: 100 });

    const errors = await reject(s, { uomId: ids.uom2 });

    expect(errors).toMatchObject([{ field: 'uomId', code: 'INVALID' }]);
  });

  it('P-31 ⭐ (품목·LOT) 잔액이 「둘」이면 400 INVALID 다', async () => {
    const s = await scenario({ onHand: 100, secondWarehouse: true });

    const errors = await reject(s, { pickedQty: 30 });

    // ⛔ 첫 행을 조용히 고르면 «다른 창고»의 재고를 예약하게 된다(통보 196).
    expect(errors).toMatchObject([{ field: 'lotId', code: 'INVALID' }]);
    expect(errors[0].message).toContain('재고 차원이 둘 이상');
  });

  it('P-32 잔액 행이 0건이면 409 다 (⛔ 행을 만들지 않는다)', async () => {
    const s = await scenario({ onHand: 0 });

    const conflict = await rejectConflict(s, { pickedQty: 30 });

    expect(conflict.code).toBe('INVALID_STATE');
    expect(conflict.message).toBe('그 LOT 의 재고가 없습니다.');
    expect(
      await prisma.inventory_balance.count({ where: { lot_id: BigInt(s.lotId) } }),
    ).toBe(0);
  });

  // ── P-33 ~ P-38 · 상태·멱등·권한·응답·스키마 ──────────────────────────────
  it('P-33 ⭐ 헤더·라인 version_no 가 둘 다 안 오른다', async () => {
    const s = await scenario({ onHand: 100 });
    const before = await versionsOf(s);

    await pick(s, { pickedQty: 30 });

    // If-Match 를 받는 쓰기가 이 계약에 0건이라 올리면 화면 토큰만 낡는다.
    expect(await versionsOf(s)).toEqual(before);
    expect(before).toEqual({ header: 1, line: 1 });
  });

  it('P-34 같은 Idempotency-Key 재전송이 예약을 하나만 만든다', async () => {
    const s = await scenario({ onHand: 100 });
    const key = randomUUID();

    const first = await call(s.requestId, s.lineId, body(s), { key });
    const second = await call(s.requestId, s.lineId, body(s), { key });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await reservationsOf(s.lineId)).toHaveLength(1);
    expect((await balanceOf(s.lotId)).picked_qty).toEqual(new Prisma.Decimal(30));
  });

  it('P-35 ⭐ 권한 없는 세션이면 403 이다', async () => {
    const s = await scenario({ onHand: 100 });

    const response = await call(s.requestId, s.lineId, body(s), { session: noPermCookie });

    // ⚠ 권한 미등재였다면 가드가 던져 403 이 아니라 500 이다.
    expect(response.status).toBe(403);
  });

  it('P-36 200 응답의 picks 가 배열이고 pickedQty 합과 맞는다', async () => {
    const s = await scenario({ onHand: 100, allocated: 80 });

    await pick(s, { pickedQty: 12 });
    const body = await pick(s, { pickedQty: 18 });

    expect(body.picks).toHaveLength(2);
    expect(body.picks.reduce((sum, row) => sum + row.pickedQty, 0)).toBe(body.pickedQty);
  });

  it('P-37 ⭐ 409 응답에 code 키가 「있다」', async () => {
    const s = await scenario({ onHand: 100, hold: 'open' });

    const response = await call(s.requestId, s.lineId, body(s));

    // ⛔ 공용 `ConflictException` 은 `code` 를 «선택»으로 둔다 — 안 넘기면 required 위반이다.
    expect(response.status).toBe(409);
    expect(Object.keys(response.body as object)).toContain('code');
  });

  it('P-38 ⭐ shipment_request_line.picked_qty 컬럼을 만들지 않았다', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'logistics' AND table_name = 'shipment_request_line'`;

    // ⛔ 칸을 세우면 예약 롤업과 두 벌 장부가 된다 — 누적 피킹의 정본은 예약 행이다.
    expect(columns.map((row) => row.column_name)).not.toContain('picked_qty');
  });

  it('P-39 ⭐⭐ 라인 13칸 + picks 5칸이 「제 출처」에서 온다', async () => {
    // ⭐ requested·allocated·shipped·picked 넷이 서로 «다른 값»이어야 뒤바꿈이 죽는다(§6-3 ⑵).
    const s = await scenario({
      onHand: 100,
      requested: 100,
      allocated: 40,
      shipped: 7,
      shelfLife: 5,
      lines: 2,
      salesOrderLine: true,
      lotRequirement: `${PREFIX}-고객LOT조건`,
      inspection: true,
    });
    // ⛔ 같은 타입끼리 뒤바꿔도 ajv 는 통과한다 — 축마다 값이 달라야 값 단언이 산다.
    expect(new Set([s.lineIds[1], s.lotId, ids.item1, ids.uom1, ids.salesOrderLine]).size).toBe(5);

    const body = await pick({ ...s, lineId: s.lineIds[1] }, { pickedQty: 12 });

    const [row] = await reservationsOf(s.lineIds[1]);
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(s.lotId) } });
    expect(body).toEqual({
      shipmentRequestLineId: s.lineIds[1],
      lineNo: 2,
      salesOrderLineId: ids.salesOrderLine,
      itemId: ids.item1,
      requestedQty: 100,
      allocatedQty: 40,
      pickedQty: 12,
      shippedQty: 7,
      uomId: ids.uom1,
      customerLotRequirement: `${PREFIX}-고객LOT조건`,
      shippingInspectionRequired: true,
      minimumRemainingShelfLifeDays: 5,
      picks: [
        {
          lotId: s.lotId,
          lotNo: lot.lot_no,
          pickedQty: 12,
          uomId: ids.uom1,
          pickedAt: row.created_at.toISOString(),
        },
      ],
    });
  });

  // ── P-40 ~ P-42 · 리뷰(#559)가 실측으로 연 세 자리 ────────────────────────
  it('P-40 ⭐ numeric(20,6) 아래로 접히는 수량은 400 RANGE 다 (500 이 아니다)', async () => {
    const s = await scenario({ onHand: 100 });

    const errors = await reject(s, { pickedQty: 0.0000001 });

    // ⛔ `> 0` 만 보면 ⑪·⑫ 를 `Decimal` 로 정확히 통과한 뒤 예약 INSERT 가 `0.000000` 으로
    //   접혀 `inventory_reservation_reserved_qty_check` 를 깨고 **500** 이 나간다(리뷰 실측).
    expect(errors).toMatchObject([{ field: 'pickedQty', code: 'RANGE' }]);
    expect(errors[0].message).toContain('소수점 6자리');
    expect(await reservationsOf(s.lineId)).toHaveLength(0);
  });

  it('P-41 ⭐⭐ 같은 id 의 PRODUCTION_ORDER 예약을 ⑫ 가 「이미 피킹」으로 세지 않는다', async () => {
    // `scenario()` 가 라인 id 와 «같은 숫자»의 `PRODUCTION_ORDER` 예약(999)을 늘 심는다.
    const s = await scenario({ onHand: 100, allocated: 40, requested: 100 });
    const decoy = await foreignReservationsOf(s.lineId);
    expect(decoy.map((row) => row.reserved_qty.toString())).toEqual(['999']);

    const body = await pick(s, { pickedQty: 40 });

    // ⛔ ⑫ 의 축은 `(유형, id)` **둘 다**다 — 유형을 빼면 999 를 세어 배정 40 을 넘겼다며
    //   409 로 «정상 피킹»을 거부한다. 응답 롤업(③b `picksByLine`)도 같은 축을 쓴다.
    expect(body.pickedQty).toBe(40);
    expect(body.picks.map((row) => row.pickedQty)).toEqual([40]);
  });

  it('P-42 ⭐ 「출고만 막는」 통제 행은 피킹을 안 막는다', async () => {
    const s = await scenario({ onHand: 100, lotStatus: ISSUE_ONLY_STATUS });

    const body = await pick(s, { pickedQty: 30 });

    // ⛔ `blocks_picking: true` 필터를 빼면 `blocks_issue` 만 켠 행이 피킹을 막는다.
    expect(body.pickedQty).toBe(30);
  });

  // ── M4 체인 마디 (§8-8 · PR ⑦b) ──────────────────────────────────────────

  it('M4 ⭐⭐ 지시서 → 편성 → 피킹 이 HTTP 로 이어지고 진행이 PICKING → PICKED 로 오른다', async () => {
    // ⛔ 중간을 Prisma 로 «건너뛰지 않는다» — 편성·피킹·조회 셋 다 HTTP 다. LOT 과 잔액만 픽스처인데
    //    04 계약에 그 둘을 세우는 오퍼레이션이 0건이고 ㉖ 판매오더도 등록 경로가 0건이라 다른 길이 없다.
    const lotId = await stockedLot({ onHand: 100 });

    // ㉖ 지시서 → ㉗ 편성. 판매오더를 걸어 두 문서가 실제로 이어진 것을 응답에서 본다.
    const created = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        salesOrderId: Number(ids.salesOrder),
        customerId: ids.customer,
        shipToPartnerId: ids.shipTo,
        fulfillmentPlantId: Number(ids.plant),
        requestedShipDate: SHIP_DATE,
        lines: [
          {
            salesOrderLineId: ids.salesOrderLine,
            itemId: ids.item1,
            requestedQty: 50,
            allocatedQty: 50,
            uomId: ids.uom1,
            shippingInspectionRequired: false,
          },
        ],
      })
      .expect(201);
    const header = created.body as RequestBody;
    expect(header.salesOrderId).toBe(Number(ids.salesOrder));
    const lineId = (header.lines ?? [])[0].shipmentRequestLineId;
    // 편성 직후 — `A = R` 이고 `P = 0` 이라 이미 `PICKING` 이다(§5-1). 여기서부터 «움직이는지»를 본다.
    expect(header.shipmentProgressCode).toBe('PICKING');

    // ㉙ 제품 LOT 피킹 — 편성이 «돌려준» id 로만 부른다. 체인이 끊기면 404 다.
    const partial = await call(header.shipmentRequestId, lineId, {
      lotId,
      pickedQty: 20,
      uomId: ids.uom1,
    }).expect(200);
    expect((partial.body as LineBody).pickedQty).toBe(20);

    const midway = await getRequest(header.shipmentRequestId);
    expect(midway.shipmentProgressCode).toBe('PICKING');
    expect((midway.lines ?? [])[0].pickedQty).toBe(20);

    // ⭐ 남은 30 을 마저 집으면 `P = A` 라 `PICKED` 로 오른다 — 축이 «상수»가 아님을 여기서 잠근다.
    //    (`shipmentProgressCode` 를 'PICKING' 으로 고정하는 변이가 위 두 단언만으로는 안 죽는다.)
    await call(header.shipmentRequestId, lineId, { lotId, pickedQty: 30, uomId: ids.uom1 }).expect(200);
    const done = await getRequest(header.shipmentRequestId);
    expect(done.shipmentProgressCode).toBe('PICKED');
    expect((done.lines ?? [])[0].pickedQty).toBe(50);
  });

  // ── 픽스처 ────────────────────────────────────────────────────────────────

  interface Scenario {
    requestId: number;
    lineId: number;
    lineIds: number[];
    lotId: number;
  }

  interface ScenarioSpec {
    onHand?: number;
    secondWarehouse?: boolean;
    requested?: number;
    allocated?: number;
    shipped?: number;
    shelfLife?: number | null;
    expiry?: string | null;
    lotStatus?: string;
    hold?: 'open' | 'released';
    lines?: number;
    salesOrderLine?: boolean;
    lotRequirement?: string;
    inspection?: boolean;
  }

  /**
   * ⭐ 시험마다 «자기» 작업지시·LOT·잔액을 새로 세운다 — 상태를 물려주면 `--randomize` 에서
   * 순서에 물린 시험이 된다(README §6-3 「고쳤으면 망가뜨려서 다시 확인」과 같은 이유).
   */
  async function scenario(spec: ScenarioSpec = {}): Promise<Scenario> {
    const lotId = await stockedLot(spec);
    seq += 1;
    const header = await prisma.shipment_request.create({
      data: {
        shipment_request_no: `${PREFIX}-SR-${seq}`,
        customer_id: BigInt(ids.customer),
        ship_to_partner_id: BigInt(ids.shipTo),
        fulfillment_plant_id: BigInt(ids.plant),
        requested_ship_date: new Date(`${SHIP_DATE}T00:00:00.000Z`),
        status_code: 'REGISTERED',
      },
    });
    const lineIds: number[] = [];
    for (let index = 0; index < (spec.lines ?? 1); index += 1) {
      const line = await prisma.shipment_request_line.create({
        data: {
          shipment_request_id: header.shipment_request_id,
          line_no: index + 1,
          sales_order_line_id: spec.salesOrderLine === true ? BigInt(ids.salesOrderLine) : null,
          item_id: BigInt(ids.item1),
          requested_qty: spec.requested ?? 100,
          allocated_qty: spec.allocated ?? 100,
          shipped_qty: spec.shipped ?? 0,
          uom_id: BigInt(ids.uom1),
          customer_lot_requirement: spec.lotRequirement ?? null,
          shipping_inspection_required: spec.inspection ?? false,
          minimum_remaining_shelf_life_days:
            spec.shelfLife === undefined ? null : spec.shelfLife,
        },
      });
      lineIds.push(Number(line.shipment_request_line_id));
    }
    // ⭐⭐ 라인 id 와 «같은 숫자»를 쓰는 `PRODUCTION_ORDER` 예약을 **성공·실패 경로 둘 다**에
    //   심는다(§6-3 ⑵·⑶). 두 표의 시퀀스가 별개라 현장에서 흔히 겹치고, ⑫ 나 ③b 의 롤업이
    //   원천 «유형» 축을 빼면 그 999 를 「이미 피킹」으로 세어 정상 피킹이 409 가 된다
    //   (#409 인계 · `shipment-request-query.service.ts:166` 이 같은 경고를 적어 뒀다).
    // ⛔ `lot_id` 는 널이다 — `GET /inventory/reservations` 가 유형 축을 안 갖고 있어
    //   P-6 이 `lotId` 로 갈라야 하기 때문이다.
    for (const lineId of lineIds) {
      seq += 1;
      await prisma.inventory_reservation.create({
        data: {
          reservation_no: `${PREFIX}-RS-${seq}`,
          reservation_type_code: 'PRODUCTION',
          source_document_type_code: 'PRODUCTION_ORDER',
          source_document_id: BigInt(lineId),
          item_id: BigInt(ids.item1),
          warehouse_id: ids.warehouse1,
          reserved_qty: 999,
          uom_id: BigInt(ids.uom1),
          status_code: 'REGISTERED',
        },
      });
    }
    return {
      requestId: Number(header.shipment_request_id),
      lineId: lineIds[0],
      lineIds,
      lotId,
    };
  }

  /** LOT + (필요하면) 잔액 행. `onHand: 0` 이면 잔액을 «안 만든다» — 0 이 있는 것과 다르다. */
  async function stockedLot(
    spec: { onHand?: number; secondWarehouse?: boolean; expiry?: string | null; lotStatus?: string; hold?: 'open' | 'released'; item?: number } = {},
  ): Promise<number> {
    seq += 1;
    const expiry = spec.expiry === undefined ? utcDayAfter(3650) : spec.expiry;
    const itemId = spec.item ?? ids.item1;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${seq}`,
        item_id: BigInt(itemId),
        lot_type_code: 'PRODUCT',
        plant_id: ids.plant,
        initial_qty: 1000,
        uom_id: BigInt(ids.uom1),
        expiry_date: expiry === null ? null : new Date(`${expiry}T00:00:00.000Z`),
        source_type_code: 'WORK_ORDER',
        source_id: 1,
        status_code: spec.lotStatus ?? 'NORMAL',
      },
    });
    const onHand = spec.onHand ?? 100;
    if (onHand > 0) {
      await makeBalance(lot.lot_id, itemId, onHand, ids.warehouse1, ids.location1);
      // ⭐ `BAL-1`·`BAL-2` — 같은 (품목·LOT)의 잔액 행 둘. 창고가 다르다.
      if (spec.secondWarehouse === true) {
        await makeBalance(lot.lot_id, itemId, onHand, ids.warehouse2, ids.location2);
      }
    }
    if (spec.hold !== undefined) {
      await prisma.lot_hold.create({
        data: {
          lot_id: lot.lot_id,
          reason_code: HOLD_REASON,
          status_code: 'HELD',
          held_by: actorUserId,
          held_at: new Date('2026-09-01T00:00:00.000Z'),
          // ⛔ `ck_lot_hold_release_reason` 이 해제 시각과 해제 사유를 «함께» 요구한다.
          ...(spec.hold === 'released'
            ? {
                released_at: new Date('2026-09-02T00:00:00.000Z'),
                released_by: actorUserId,
                release_reason_code: `${PREFIX}-RELEASED`,
              }
            : {}),
        },
      });
    }
    return Number(lot.lot_id);
  }

  async function makeBalance(
    lotId: bigint,
    itemId: number,
    qty: number,
    warehouseId: bigint,
    locationId: bigint,
  ): Promise<void> {
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: ids.entity,
        business_unit_id: ids.unit,
        plant_id: ids.plant,
        warehouse_id: warehouseId,
        location_id: locationId,
        item_id: BigInt(itemId),
        lot_id: lotId,
        quality_status_code: 'GOOD',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: qty,
        uom_id: BigInt(ids.uom1),
      },
    });
  }

  // ── 호출 ──────────────────────────────────────────────────────────────────

  function body(s: Scenario, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return { lotId: s.lotId, pickedQty: 30, uomId: ids.uom1, ...overrides };
  }

  function call(
    shipmentRequestId: number,
    shipmentRequestLineId: number,
    payload: Record<string, unknown>,
    options: { workerNo?: string | null; key?: string; session?: string[] } = {},
  ): request.Test {
    const test = request(app.getHttpServer())
      .post(`${BASE}/${shipmentRequestId}/lines/${shipmentRequestLineId}:pick`)
      .set('Cookie', options.session ?? cookie)
      .set('Idempotency-Key', options.key ?? randomUUID());
    if (options.workerNo !== null) test.set('X-Worker-No', options.workerNo ?? WORKER_NO);
    return test.send(payload);
  }

  /** M4 마디의 마지막 마디 — 상세 조회도 HTTP 다(③b `GET …/{id}`). */
  async function getRequest(shipmentRequestId: number): Promise<RequestBody> {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/${shipmentRequestId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as RequestBody;
  }

  async function pick(s: Scenario, overrides: Record<string, unknown> = {}): Promise<LineBody> {
    const response = await call(s.requestId, s.lineId, body(s, overrides)).expect(200);
    return response.body as LineBody;
  }

  async function reject(
    s: Scenario,
    overrides: Record<string, unknown> = {},
  ): Promise<{ field?: string; code: string; message: string }[]> {
    const response = await call(s.requestId, s.lineId, body(s, overrides)).expect(400);
    return (response.body as ErrorBody).errors;
  }

  async function rejectConflict(
    s: Scenario,
    overrides: Record<string, unknown> = {},
  ): Promise<ConflictBody> {
    const response = await call(s.requestId, s.lineId, body(s, overrides)).expect(409);
    return response.body as ConflictBody;
  }

  async function reservationList(query: {
    sourceDocumentId: number;
    lotId: number;
    openOnly?: boolean;
  }): Promise<{ items: { inventoryReservationId: number }[]; total: number }> {
    const openOnly = query.openOnly === true ? '&openOnly=true' : '';
    const response = await request(app.getHttpServer())
      .get(
        `/api/inventory/reservations?sourceDocumentId=${query.sourceDocumentId}` +
          `&lotId=${query.lotId}${openOnly}`,
      )
      .set('Cookie', cookie)
      .expect(200);
    const body = response.body as {
      items: { inventoryReservationId: number }[];
      page: { total: number };
    };
    return { items: body.items, total: body.page.total };
  }

  function balanceOf(lotId: number) {
    return prisma.inventory_balance.findFirstOrThrow({
      where: { lot_id: BigInt(lotId), warehouse_id: ids.warehouse1 },
    });
  }

  function reservationsOf(lineId: number) {
    return prisma.inventory_reservation.findMany({
      where: {
        source_document_type_code: 'SHIPMENT_REQUEST_LINE',
        source_document_id: BigInt(lineId),
      },
      orderBy: { inventory_reservation_id: 'asc' },
    });
  }

  /** 같은 id 를 쓰는 «남의» 예약 — P-41 이 그 존재부터 단언한다(§6-3 ⑵). */
  function foreignReservationsOf(lineId: number) {
    return prisma.inventory_reservation.findMany({
      where: {
        source_document_type_code: 'PRODUCTION_ORDER',
        source_document_id: BigInt(lineId),
      },
      orderBy: { inventory_reservation_id: 'asc' },
    });
  }

  async function versionsOf(s: Scenario): Promise<{ header: number; line: number }> {
    const header = await prisma.shipment_request.findUniqueOrThrow({
      where: { shipment_request_id: BigInt(s.requestId) },
      select: { version_no: true },
    });
    const line = await prisma.shipment_request_line.findUniqueOrThrow({
      where: { shipment_request_line_id: BigInt(s.lineId) },
      select: { version_no: true },
    });
    return { header: header.version_no, line: line.version_no };
  }

  // ── 마스터 ────────────────────────────────────────────────────────────────

  async function makeMasters(): Promise<void> {
    const [uom1, uom2] = await prisma.uom.findMany({ take: 2, orderBy: { uom_id: 'asc' } });
    ids.uom1 = Number(uom1.uom_id);
    ids.uom2 = Number(uom2.uom_id);

    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '제품피킹검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    ids.entity = entity.legal_entity_id;
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '제품피킹검사사업부',
      },
    });
    ids.unit = unit.business_unit_id;
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '제품피킹검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    ids.plant = plant.plant_id;

    for (const [index, key] of (['warehouse1', 'warehouse2'] as const).entries()) {
      const warehouse = await prisma.warehouse.create({
        data: {
          plant_id: plant.plant_id,
          business_unit_id: unit.business_unit_id,
          warehouse_code: `${PREFIX}-WH${index + 1}`,
          warehouse_name: `제품피킹검사창고${index + 1}`,
          warehouse_type_code: 'FINISHED',
          management_level_code: 'LOCATION',
        },
      });
      ids[key] = warehouse.warehouse_id;
      const location = await prisma.location.create({
        data: {
          warehouse_id: warehouse.warehouse_id,
          location_code: `${PREFIX}-LOC${index + 1}`,
          location_name: `제품피킹검사위치${index + 1}`,
          location_type_code: 'BIN',
        },
      });
      ids[index === 0 ? 'location1' : 'location2'] = location.location_id;
    }

    for (const [key, suffix] of [
      ['item1', 'IT1'],
      ['item2', 'IT2'],
    ] as const) {
      const item = await prisma.item.create({
        data: {
          item_code: `${PREFIX}-${suffix}`,
          item_name: `제품피킹검사품목${suffix}`,
          item_type_code: 'FINISHED',
          base_uom_id: BigInt(ids.uom1),
        },
      });
      ids[key] = Number(item.item_id);
    }
    // ⭐ 배송처를 고객과 «다른» 파트너로 세운다 — 같으면 두 칸을 뒤바꿔도 안 잡힌다(§6-3 ⑵).
    for (const [key, suffix] of [
      ['customer', 'C1'],
      ['shipTo', 'SH1'],
    ] as const) {
      const partner = await prisma.partner.create({
        data: { partner_code: `${PREFIX}-${suffix}`, partner_name: `제품피킹검사파트너${suffix}` },
      });
      ids[key] = Number(partner.partner_id);
    }

    const salesOrder = await prisma.sales_order.create({
      data: {
        sales_order_no: `${PREFIX}-SO`,
        customer_id: BigInt(ids.customer),
        ship_to_partner_id: BigInt(ids.shipTo),
        order_date: new Date('2026-11-01T00:00:00.000Z'),
        status_code: 'RECEIVED',
        sales_order_line: {
          create: [
            { line_no: 1, item_id: BigInt(ids.item1), uom_id: BigInt(ids.uom1), ordered_qty: 500 },
          ],
        },
      },
      include: { sales_order_line: true },
    });
    ids.salesOrder = salesOrder.sales_order_id;
    ids.salesOrderLine = Number(salesOrder.sales_order_line[0].sales_order_line_id);

    // ⭐ `judgment_type_control` 은 오늘 0행이라 P-19 가 픽스처를 심어야 돈다.
    // ⭐⭐ **두 행**을 심는다 — 「피킹을 막는」 행과 「출고만 막는」 행. 한 행뿐이면
    //   `blocks_picking: true` 필터를 지워도 안 죽는다(§6-3 ⑵ · 리뷰 Minor-1).
    const group = await prisma.code_group.findFirstOrThrow({ orderBy: { code_group_id: 'asc' } });
    for (const [suffix, name, control] of [
      ['BLK', '제품피킹검사차단', { blocks_picking: true, lot_status_code: BLOCKED_STATUS }],
      ['ISS', '제품피킹검사출고차단', { blocks_issue: true, lot_status_code: ISSUE_ONLY_STATUS }],
    ] as const) {
      const codeValue = await prisma.code_value.create({
        data: { code_group_id: group.code_group_id, code: `${PREFIX}-${suffix}`, code_name: name },
      });
      if (suffix === 'BLK') ids.codeValue = codeValue.code_value_id;
      await prisma.judgment_type_control.create({
        data: { code_value_id: codeValue.code_value_id, ...control },
      });
    }
  }

  /** `:pick` 은 403 을 «선언»한 자리다 — 권한 있는 세션과 없는 세션을 둘 다 세운다. */
  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '제품피킹검사', status_code: 'EMPLOYED' },
    });
    actorUserId = user.app_user_id;
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '제품피킹검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    await prisma.user_data_scope.create({ data: {
      app_user_id: user.app_user_id, business_unit_id: ids.unit, plant_id: ids.plant,
    } });
    probeUserId = Number(user.app_user_id);

    const noPerm = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '제품피킹무권한', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: noPerm.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
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

  async function cleanup(): Promise<void> {
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`;
    const partners = `SELECT partner_id FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`;
    const warehouses = `SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`;
    for (const sql of [
      // ⛔ 예약은 «품목» 축으로 지운다 — `reservation_no` 는 채번이 정하는 값이라 변이 하네스가
      //    바꾸는 바로 그 자리다(접두어로 지우면 실패한 회차의 행이 남아 FK 로 정리를 막는다).
      `DELETE FROM inventory.inventory_reservation WHERE item_id IN (${items})`,
      `DELETE FROM inventory.inventory_balance WHERE item_id IN (${items})`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (
         SELECT shipment_request_id FROM logistics.shipment_request
          WHERE customer_id IN (${partners}))`,
      `DELETE FROM logistics.shipment_request WHERE customer_id IN (${partners})`,
      `DELETE FROM logistics.sales_order_line WHERE sales_order_id IN (
         SELECT sales_order_id FROM logistics.sales_order WHERE sales_order_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.sales_order WHERE sales_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.location WHERE warehouse_id IN (${warehouses})`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.user_data_scope WHERE app_user_id IN (
         SELECT app_user_id FROM app.app_user WHERE login_id IN ('${LOGIN_ID}', '${NOPERM_ID}'))`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.judgment_type_control WHERE code_value_id IN (
         SELECT code_value_id FROM mdm.code_value WHERE code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.code_value WHERE code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    for (const loginId of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_data_scope.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
