import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { assertWorkerNoPresent } from '../../common/master';
import { InventoryPostingService } from '../../core/inventory-posting';
// ⛔ `index.ts` 가 재수출하지 않는다 — 이 PR 은 코어 파일을 안 고친다(`picking-pick.service.ts:8`).
import { LockedBalanceRow, lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestLineView } from './shipment-request-view';
import { SHIPMENT_REQUEST_LINE, pickedQtyOf } from './shipment-progress';

/** 계약 `ShipmentLinePick` — required 3 · 프로퍼티 3. ⛔ `businessDate`·`occurredAt` 이 «없다». */
export interface ShipmentLinePick {
  lotId: number;
  pickedQty: number;
  uomId: number;
}

export interface ShipmentPickContext {
  /** ⚠ 저장하지 않는다 — 담을 칸이 두 표에 0개다(§7-4). */
  workerNo?: string;
  appUserId: number;
}

/**
 * ⭐⭐ 409 **네 사유가 전부 이 값**이다 — enum 다섯에 「가용 부족」도 「배정 초과」도 없다(§1-6).
 * ⇒ 화면이 분기할 축은 `message` 뿐이라 네 문구가 서로 다른 숫자·사유를 싣는다(§3-4 · R-18).
 * ⛔ 하나로 합치지 마라 — e2e 가 `code` 가 아니라 «문구»로 넷을 가른다.
 */
const INVALID_STATE = 'INVALID_STATE';
/** `RESERVATION_TYPE` 시드 3값 중 제품 출하 축(`seed.ts:694-701`). */
const RESERVATION_TYPE_SHIPMENT = 'SHIPMENT';
/** `x-no-code-key` 라 값 목록이 없다 — 넣는 값의 정본이다. */
const RESERVATION_REGISTERED = 'REGISTERED';
const INVENTORY_RESERVATION = 'INVENTORY_RESERVATION';
/** 400 의 `field` 경로. 코어의 `NEGATIVE_BALANCE`(둘째 그물)도 이 경로로 나간다. */
const QTY_FIELD = 'pickedQty';
/** `app.qty_t` = `numeric(20,6)`. 이 아래는 저장에서 접힌다. */
const QTY_SCALE = 6;
const ZERO = new Prisma.Decimal(0);
const DAY_MS = 86_400_000;

/** ④ 가 내리는 것 — 라인 축만이다(헤더 칸은 판정에 안 쓴다). */
interface LineRow {
  shipment_request_line_id: bigint;
  item_id: bigint;
  uom_id: bigint;
  allocated_qty: Prisma.Decimal;
  minimum_remaining_shelf_life_days: number | null;
}

interface LotRow {
  lot_id: bigint;
  item_id: bigint;
  status_code: string;
  expiry_date: Date | null;
}

/**
 * ⭐⭐ 제품 LOT 피킹 확정 — 예약 코어의 **둘째 사용처**.
 *
 * ⭐ **ⓒ안**(§6-2) — 예약을 «걸고 곧바로 푼다». 계약 원문이 「서버가 걸고 푼다」이고
 * `M-01-08` §5-5(04 가 「같은 규약」이라 이름을 대며 가리킨 절)가 「피킹하면 `picked_qty` 로
 * 옮겨 간다」라 적었다. ⇒ 순변화는 **`picked += Δ` 하나**, `reserved_qty` 는 올랐다 내려 **0**,
 * 예약은 `consumed = reserved` 로 닫혀 `?openOnly=true` 에 안 뜬다. ⛔ ⓐ안(「`reserved` 만
 * 올린다」)이면 집은 수량이 「배정분」이라는 틀린 이름으로 뜨고 자재 피킹 목록이 오염된다(R-2).
 *
 * ⚠⚠ **누적이다 — 대체가 아니다.** ⛔ **I-8 의 `:pick` 은 «대체»**라(`picking-pick.service.ts:89`)
 * 저쪽을 베끼면 두 번째 피킹이 첫 번째를 지운다.
 * ⛔ **상태도 `version_no` 도 안 옮긴다**(헤더·라인 둘 다 · If-Match 를 받는 쓰기가 0건이다) ·
 * ⛔ **`shipment_request_line.picked_qty` 를 만들지 않는다**(누적은 예약 롤업 · §1-4-1).
 */
@Injectable()
export class ShipmentPickService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly queries: ShipmentRequestQueryService,
  ) {}

  async pick(
    shipmentRequestId: number,
    shipmentRequestLineId: number,
    body: ShipmentLinePick,
    context: ShipmentPickContext,
  ): Promise<ShipmentRequestLineView> {
    // ① 가드가 헤더를 «안 본다»(`contract-validation.guard.ts:39`) — 서버가 유일한 그물이다.
    assertWorkerNoPresent(context.workerNo);
    // ③ ⭐ 04 는 `exclusiveMinimum` 이 «없다» — 01 과 달리 그물이 여기 하나뿐이다(R-6).
    const delta = assertPickedQty(body.pickedQty);
    // ⛔⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 한 요청이 커넥션을 둘 쥐고 풀이
    //    마르면 `P2024` 로 죽는다(409 가 정상 거부라 소진율이 높다 · 결번 허용 · I-2 R-2).
    //    ⛔ 기간 축은 **서버 UTC 날짜**다 — 본문에 날짜 칸이 0개라 클라이언트가 줄 값이 없다.
    //    ⑨ 의 「오늘」도 같은 `now` 에서 뽑아 자정을 넘긴 요청이 두 날짜로 안 갈린다.
    const now = new Date();
    const reservationNo = await this.numbering.next(INVENTORY_RESERVATION, null, utcDay(now));

    await this.prisma.$transaction(async (tx) => {
      // ④ 두 id 가 안 맞아도 404 다 — 남의 작업지시의 라인을 열지 않는다.
      const line = await lockLine(tx, shipmentRequestId, shipmentRequestLineId);
      if (line === undefined) throw new NotFoundException('없는 출하작업지시 라인입니다.');

      const lot = await assertLot(tx, body, line);
      await assertPickable(tx, lot);
      assertShelfLife(lot, line, now);

      const balance = await lockBalance(tx, line.item_id, lot.lot_id);
      assertAvailable(balance, delta);
      await assertWithinAllocation(tx, line, delta);

      await this.reserveAndPick(tx, line, balance, delta, reservationNo, context.appUserId);
    });

    // ⑭ 되읽기는 ③b 의 상세 뷰 그대로다 — 롤업이라 라인 한 줄로는 못 짓는다(§1-4-1).
    const detail = await this.queries.get(shipmentRequestId);
    const lines = detail.lines ?? [];
    return lines.find((row) => row.shipmentRequestLineId === shipmentRequestLineId) as ShipmentRequestLineView;
  }

  /**
   * ⑬ ⭐⭐ **ⓒ안** — `reserve()` 가 만든 예약 id 를 곧바로 `pick()` 에 넘긴다. `null` 로 두면
   * 예약이 «열린 채» 남고 `consumed_qty` 가 0 으로 굳는다.
   * ⛔ 차원 11칸은 **잠근 행에서 그대로** 옮긴다 — 예약은 그중 4칸만 담아 나중에 복원할 수
   * 없다(§6-3 · 통보 196). ⚠ 코어의 400 `NEGATIVE_BALANCE` 는 ⑪ 뒤의 둘째 그물이다.
   */
  private async reserveAndPick(
    tx: Prisma.TransactionClient,
    line: LineRow,
    balance: LockedBalanceRow,
    delta: Prisma.Decimal,
    reservationNo: string,
    appUserId: number,
  ): Promise<void> {
    const dimension = {
      legalEntityId: balance.legalEntityId,
      businessUnitId: balance.businessUnitId,
      plantId: balance.plantId,
      warehouseId: balance.warehouseId,
      locationId: balance.locationId,
      itemId: balance.itemId,
      // ⚠ `lotKey` 는 COALESCE 0 이라 「LOT 없음」과 못 가른다 — 실제 컬럼을 쓴다.
      lotId: balance.lotId,
      qualityStatusCode: balance.quality_status_code,
      inventoryStatusCode: balance.inventory_status_code,
      ownershipTypeCode: balance.ownership_type_code,
      ownerPartnerId: balance.owner_partner_id,
    };
    const [inventoryReservationId] = await this.posting.reserve(tx, [
      {
        dimension,
        qty: delta,
        reservationNo,
        reservationTypeCode: RESERVATION_TYPE_SHIPMENT,
        // ⚠ 계약 enum 은 `PRODUCTION_ORDER` 하나뿐인데 04 가 「가리킬 표가 늘면 계약을 고친다」라
        //   적었다(통보 190 · #409 인계). 값의 정본은 `shipment-progress.ts` 한 곳이다.
        sourceDocumentTypeCode: SHIPMENT_REQUEST_LINE,
        sourceDocumentId: line.shipment_request_line_id,
        uomId: line.uom_id,
        statusCode: RESERVATION_REGISTERED,
        createdBy: BigInt(appUserId),
        field: QTY_FIELD,
      },
    ]);
    await this.posting.pick(tx, [{ dimension, delta, inventoryReservationId, field: QTY_FIELD }]);
  }
}

/**
 * ③ ⭐ 계약에 `exclusiveMinimum` 도 `multipleOf` 도 없다 — 둘 다 **서버가 막는 자리**다.
 * ⛔ 스케일을 안 보면 `0 < Δ < 0.0000005` 가 **500** 으로 샌다: ⑪·⑫ 는 `Decimal` 로 정확히
 *   통과하고 잔액 UPDATE 도 지나가는데, 예약 INSERT 에서 `numeric(20,6)` 이 `0.000000` 으로
 *   접혀 `inventory_reservation_reserved_qty_check` 를 깬다(리뷰 실측).
 * ⭐ 선례 넷 — `handling-unit.service.ts:293` · `nonconformance-rules.ts:45` ·
 *   `lot-hold-rules.ts:123` · `result-write-input.ts:259`(「⛔ 조용한 반올림 금지」).
 */
function assertPickedQty(pickedQty: number): Prisma.Decimal {
  const delta = new Prisma.Decimal(pickedQty);
  if (!delta.greaterThan(ZERO)) throw one(field(QTY_FIELD, ERROR_CODE.RANGE, '피킹 수량은 0 보다 커야 합니다.'));
  if (delta.decimalPlaces() > QTY_SCALE) {
    throw one(field(QTY_FIELD, ERROR_CODE.RANGE, `수량은 소수점 ${QTY_SCALE}자리까지입니다.`));
  }
  return delta;
}

/**
 * ⭐⭐ **`OF l` 을 «반드시» 붙인다.** 헤더까지 잠그면 **같은 작업지시의 두 라인 피킹이 서로를
 * 막는데**, 여러 라인을 동시에 스캔하는 것이 `M-04-01` 의 **정상 흐름**이다(I-8 이
 * `picking-pick.service.ts:69` 에 같은 이유를 적었다). 헤더 JOIN 은 소유 대조일 뿐 잠금 대상이
 * 아니다 — HTTP 로는 안 갈려 서비스 spec 이 SQL 문장을 단언한다.
 */
async function lockLine(
  tx: Prisma.TransactionClient,
  shipmentRequestId: number,
  shipmentRequestLineId: number,
): Promise<LineRow | undefined> {
  const [line] = await tx.$queryRaw<LineRow[]>`
    SELECT l.shipment_request_line_id, l.item_id, l.uom_id, l.allocated_qty,
           l.minimum_remaining_shelf_life_days
      FROM logistics.shipment_request_line l
      JOIN logistics.shipment_request h ON h.shipment_request_id = l.shipment_request_id
     WHERE l.shipment_request_line_id = ${shipmentRequestLineId}
       AND l.shipment_request_id = ${shipmentRequestId}
       FOR UPDATE OF l`;
  return line;
}

/** ⑤ LOT 존재·품목 일치 → ⑥ 단위 일치. */
async function assertLot(
  tx: Prisma.TransactionClient,
  body: ShipmentLinePick,
  line: LineRow,
): Promise<LotRow> {
  const lot = await tx.lot.findUnique({
    where: { lot_id: body.lotId },
    select: { lot_id: true, item_id: true, status_code: true, expiry_date: true },
  });
  if (lot === null || lot.item_id !== line.item_id) {
    throw one(field('lotId', ERROR_CODE.INVALID, '이 라인의 품목이 아닌 LOT 입니다.'));
  }
  // ⑥ ⛔ 환산이 없다 — 다르면 거부한다.
  if (BigInt(body.uomId) !== line.uom_id) throw one(field('uomId', ERROR_CODE.INVALID, '라인의 단위와 다릅니다.'));
  return lot;
}

/**
 * ⑦ 미해제 `lot_hold`(**409 사유 ①**) · ⑧ `blocks_picking` — 축이 둘이다(I-8 §6-5). ⭐ ⑦ 은
 * `message` 에 **보류 사유를 반드시** 싣는다(`M-04-01` §6 을 실을 칸이 그것뿐이다 · R-18).
 * ⛔ `released_at IS NULL` 을 빼면 해제된 보류가 LOT 을 영구히 막는다.
 */
async function assertPickable(tx: Prisma.TransactionClient, lot: LotRow): Promise<void> {
  const hold = await tx.lot_hold.findFirst({
    where: { lot_id: lot.lot_id, released_at: null },
    select: { reason_code: true },
  });
  if (hold !== null) throw conflict(`보류 중인 LOT 입니다. (사유: ${hold.reason_code})`);
  // ⚠ 통제표가 오늘 0행이라 이 갈래는 픽스처를 심어야 돈다(e2e P-19).
  const blocked = await tx.judgment_type_control.findFirst({
    where: { blocks_picking: true, lot_status_code: lot.status_code },
    select: { code_value_id: true },
  });
  if (blocked !== null) throw conflict('피킹이 막힌 LOT 상태입니다.');
}

/**
 * ⑨ 잔여 유효기간 — ⭐ **400 `RANGE`** 다(R-4 로 409 에서 옮겼다). 「재로드로 풀린다」가 아니라
 * 시간이 갈수록 나빠지고 계약이 적은 409 사유 셋에도 없다. ⭐ 「한계와 «같은» 값」은 통과 ·
 * ⛔ `expiry_date` 널은 **통과시키지 않는다**(「모른다」는 「충분하다」가 아니다) · 하한이 널인
 * 라인은 아예 판정하지 않는다. ⛔ `plant.timezone_code` 로 풀지 않는다(라인에 공장 축이 0개다).
 */
function assertShelfLife(lot: LotRow, line: LineRow, now: Date): void {
  const min = line.minimum_remaining_shelf_life_days;
  if (min === null) return;
  const path = 'lotId';
  if (lot.expiry_date === null) throw one(field(path, ERROR_CODE.RANGE, `유효기간이 없는 LOT 입니다. (요구 ${min}일)`));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const actual = Math.floor((lot.expiry_date.getTime() - today) / DAY_MS);
  if (actual < min) {
    throw one(field(path, ERROR_CODE.RANGE, `잔여 유효기간이 모자랍니다. (요구 ${min}일 · 실제 ${actual}일)`));
  }
}

/**
 * ⑩ 행 수의 «뜻»을 여기서 정한다 — **0행 → 409**(재로드로 풀린다) · **2행+ → 400**
 * (`picking-pick.service.ts:132` 와 같은 문장). ⛔ 첫 행으로 조용히 고르지 마라 — 예약의
 * `warehouse_id` 가 NOT NULL 이라 «다른 창고»의 재고를 예약하게 된다(통보 196).
 */
async function lockBalance(
  tx: Prisma.TransactionClient,
  itemId: bigint,
  lotId: bigint,
): Promise<LockedBalanceRow> {
  const rows = await lockBalancesByItemLot(tx, itemId, lotId);
  if (rows.length === 0) throw conflict('그 LOT 의 재고가 없습니다.');
  if (rows.length > 1) {
    throw one(field('lotId', ERROR_CODE.INVALID, '재고 차원이 둘 이상이라 어느 것을 낼지 정할 수 없습니다.'));
  }
  return rows[0];
}

/**
 * ⑪ **409 사유 ②**. ⭐ **«잠근 행»의 `available_qty` 를 본다** — 잠금 밖에서 다시 SELECT 하면 그
 * 사이 남이 옮긴 값으로 판정한다(`issue-posting.ts:159` 선례). 「가용과 같은 양」은 통과.
 * ⚠ 생성 컬럼이라 타입만 nullable 이다 — 널을 0 으로 본다(§6-3 ⑷ · e2e 로 못 만드는 갈래라
 * 서비스 spec 이 유일한 그물이다).
 */
function assertAvailable(balance: LockedBalanceRow, delta: Prisma.Decimal): void {
  const available = balance.available_qty ?? ZERO;
  if (available.lessThan(delta)) throw conflict(`가용 재고가 모자랍니다. (가용 ${available.toString()})`);
}

/**
 * ⑫ **409 사유 ③** — `Σ(reserved − released) + Δ > allocated_qty`. ④ 의 라인 잠금 «안»이라 같은
 * 라인의 두 피킹이 직렬화된다. 「배정과 같은 합」은 통과. ⛔ 식은 ③a 의 `pickedQtyOf`
 * **하나뿐**이다 — 다시 적으면 응답의 `pickedQty` 와 갈린다.
 */
async function assertWithinAllocation(
  tx: Prisma.TransactionClient,
  line: LineRow,
  delta: Prisma.Decimal,
): Promise<void> {
  const rows = await tx.inventory_reservation.findMany({
    where: { source_document_type_code: SHIPMENT_REQUEST_LINE, source_document_id: line.shipment_request_line_id },
    select: { reserved_qty: true, released_qty: true },
  });
  const picked = pickedQtyOf(
    rows.map((row) => ({ reservedQty: row.reserved_qty, releasedQty: row.released_qty })),
  );
  if (picked.plus(delta).greaterThan(line.allocated_qty)) {
    throw conflict(`배정 수량을 넘습니다. (배정 ${line.allocated_qty.toString()} · 이미 피킹 ${picked.toString()})`);
  }
}

/** ⭐ `code` 는 계약 required 인데 공용 예외는 «선택»으로 둔다 — 네 자리가 모두 명시로 넘긴다. */
function conflict(message: string): ConflictException {
  return new ConflictException('user', message, { code: INVALID_STATE });
}

/** 서버 시각의 UTC 날짜. 컨테이너·DB TZ 가 UTC 고정이다(CLAUDE.md). */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}
