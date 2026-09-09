import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';

/**
 * 잔액의 `reserved_qty`·`picked_qty` 와 예약의 `consumed_qty` 를 옮기고 `inventory_reservation` 행을
 * **만드는** 유일한 길(`balance-write-guard.spec.ts` 가 두 표 다 단언한다).
 *
 * 파일이 따로인 이유는 코어를 가르는 선례 `reversal.ts`(125줄) 와 같다 — 원장 축과 수량 축이
 * 서로를 안 부른다. `field` 를 호출자에게서 받는 이유: 400 의 field 경로가 호출자마다 다르다
 * (`:pick` 은 `lines[n].pickedQty` · 출고는 라인 칸) — `reversal.ts:70` 의 `scope:'screen'` 과
 * 갈리는 자리다. ⛔ 여기서 행을 **잠그지 않는다** — 호출자가 `lockBalancesInOrder()` 로 이미
 * 잠근 행을 UPDATE 한다(두 곳에서 잠그면 순서가 갈려 교착 창이 열린다).
 */

/** 잔액 행을 겨냥하는 11칸 — `uq_inventory_balance_dim` 과 같은 축. `lotKey` 가 아니라 실제 `lot_id` 다. */
export interface BalanceDimension {
  legalEntityId: bigint;
  businessUnitId: bigint;
  plantId: bigint;
  warehouseId: bigint;
  locationId: bigint;
  itemId: bigint;
  lotId: bigint | null;
  qualityStatusCode: string;
  inventoryStatusCode: string;
  ownershipTypeCode: string;
  ownerPartnerId: bigint | null;
}

export interface ReserveMove {
  /** 11칸 — `pick()`·`consume()` 과 같은 축. 호출자가 잠근 행에서 그대로 옮겨 담는다. */
  dimension: BalanceDimension;
  /** > 0. 0 이면 아무것도 하지 않으므로 돌려주는 배열에서 그 자리가 **빠진다**. */
  qty: Prisma.Decimal;
  /** ⛔ 채번은 트랜잭션 «밖»에서 호출자가 뽑는다(`numbering.service.ts` 머리 주석 — 결번 허용). */
  reservationNo: string;
  reservationTypeCode: string;
  sourceDocumentTypeCode: string;
  sourceDocumentId: bigint;
  uomId: bigint;
  statusCode: string;
  createdBy: bigint;
  /** 400 의 field 경로. */
  field: string;
}

export interface PickMove {
  dimension: BalanceDimension;
  /** 대체 규약의 «차이»다 — 음수면 피킹을 되돌린다. */
  delta: Prisma.Decimal;
  /** 예약을 물고 있으면 그 행에서 옮긴다. null 이면 가용에서 올린다. */
  inventoryReservationId: bigint | null;
  /** 400 의 field 경로(`lines[0].pickedQty` 등). */
  field: string;
}

export interface ConsumeMove {
  dimension: BalanceDimension;
  qty: Prisma.Decimal;
  field: string;
}

const negativeBalance = (path: string, message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [
    field(path, ERROR_CODE.NEGATIVE_BALANCE, message),
  ]);

/** `move()` 와 같은 11칸 WHERE — 차원 유일 인덱스가 `COALESCE(lot_id, 0)` 표현식이다. */
function dimensionWhere(d: BalanceDimension): Prisma.Sql {
  return Prisma.sql`legal_entity_id = ${d.legalEntityId}
         AND business_unit_id = ${d.businessUnitId}
         AND plant_id = ${d.plantId}
         AND warehouse_id = ${d.warehouseId}
         AND location_id = ${d.locationId}
         AND item_id = ${d.itemId}
         AND COALESCE(lot_id, 0::bigint) = COALESCE(${d.lotId}::bigint, 0::bigint)
         AND quality_status_code = ${d.qualityStatusCode}
         AND inventory_status_code = ${d.inventoryStatusCode}
         AND ownership_type_code = ${d.ownershipTypeCode}
         AND COALESCE(owner_partner_id, 0::bigint) = COALESCE(${d.ownerPartnerId}::bigint, 0::bigint)`;
}

/**
 * 예약 걸기 — 잔액의 `reserved_qty` 를 올리고 `inventory_reservation` 행을 만든다.
 * 만든 예약 id 를 **준 순서대로** 돌려준다(호출자가 곧바로 `pick()` 의 `inventoryReservationId` 로 넘긴다).
 *
 * ⛔ 한 문장 `UPDATE … WHERE available_qty >= Δ RETURNING` 이다 — 먼저 SELECT 해서 비교하면 잠금 «밖»의
 * 값으로 판정하게 된다. 0행이 곧 400 `NEGATIVE_BALANCE` 다(`pickBalances` 와 같은 모양).
 * ⛔ 없는 잔액 행을 만들지 않는다 — 「재고가 없다」가 「0 이 있다」로 바뀐다.
 * ⛔ 잔액 먼저·예약 나중이다 — 순서를 뒤집으면 `pick()` 이 잡는 순서와 갈린다(I-22 §6-4).
 *
 * ⚠ **Δ ≤ 0 은 «의도된 500» 이다** — `qty > 0` 은 호출자가 이미 거른 계약이라(`ReserveMove.qty`)
 * 여기서 다시 세지 않는다(`consumeBalances` 도 같다). 뚫고 들어오면 `available_qty >= 음수` 가 늘 참이라
 * 잔액 UPDATE 는 «지나가고» 뒤이은 INSERT 가 `app.qty_t`(Δ<0)·`…_reserved_qty_check`(Δ=0) 로 죽는다.
 * ⇒ 호출자 트랜잭션이 통째 롤백되어 **잔액은 어긋나지 않는다.** 400 으로 낮추지 않는 이유: 그 입력은
 * 도메인이 이미 400 `RANGE` 로 거부한 뒤라, 여기 닿았다면 «우리 버그»이고 조용해지면 안 된다.
 *
 * ✅ `check_balance_qty()`(baseline:2835-2852)는 어느 갈래로도 못 걸린다 —
 * `available = on_hand − reserved − picked − blocked ≥ Δ > 0` 이면 ⓐ `on_hand > 0` 이라 음수 갈래
 * (「음수재고 상태에서는 예약·피킹·차단 수량을 가질 수 없습니다」)에 못 가고 ⓑ 그 부등식이 곧
 * `on_hand ≥ (reserved + Δ) + picked + blocked` 라 양수 갈래도 지난다.
 *
 * ⚠⚠ **예약은 잔액 차원 11칸 중 «4칸»만 담는다**(결정 — 통보 196) — `item_id`·`lot_id?`·`warehouse_id`·
 * `location_id?` 뿐이고 법인·사업부·공장·품질상태·재고상태·소유구분·소유처 **일곱이 없다**.
 * ⇒ **예약 행만으로는 어느 잔액 행에서 왔는지 복원할 수 없다.** 푸는 쪽은 (품목·LOT)로 다시 잠가야 하고,
 * 그 사이 보류(I-20)나 처분(I-21)이 상태 칸을 바꾸면 **그 예약은 영영 못 푼다.**
 * ⇒ 그래서 호출자는 «건 트랜잭션 안에서» 잠근 행을 그대로 `pick()` 에 넘겨 곧바로 푼다(I-22 §6-2 ⓒ안).
 * 예약을 열어 둔 채 트랜잭션을 닫는 호출자는 그 위험을 자기가 진다.
 */
export async function reserveBalances(
  tx: Prisma.TransactionClient,
  moves: ReserveMove[],
): Promise<bigint[]> {
  const ids: bigint[] = [];
  for (const move of moves) {
    // Δ=0 에 `version_no` 를 올리면 화면의 If-Match 만 낡고, `reserved_qty` 가 0 인 빈 예약이 남는다.
    if (move.qty.isZero()) continue;
    const d = move.dimension;
    const balance = await tx.$queryRaw<{ inventory_balance_id: bigint }[]>`
      UPDATE inventory.inventory_balance
         SET reserved_qty = reserved_qty + ${move.qty}::numeric,
             version_no = version_no + 1
       WHERE ${dimensionWhere(d)}
         AND available_qty >= ${move.qty}::numeric
      RETURNING inventory_balance_id`;
    if (balance.length === 0) throw negativeBalance(move.field, '예약할 가용 재고가 모자랍니다.');
    // ⛔ `reservation_no` 유일 위반을 삼키지 않는다 — 같은 번호가 둘이면 채번이 깨진 것이라 500 이 맞다.
    const reservation = await tx.$queryRaw<{ inventory_reservation_id: bigint }[]>`
      INSERT INTO inventory.inventory_reservation
             (reservation_no, reservation_type_code, source_document_type_code, source_document_id,
              item_id, lot_id, warehouse_id, location_id, reserved_qty, uom_id, status_code, created_by)
      VALUES (${move.reservationNo}, ${move.reservationTypeCode}, ${move.sourceDocumentTypeCode},
              ${move.sourceDocumentId}::bigint, ${d.itemId}::bigint, ${d.lotId}::bigint,
              ${d.warehouseId}::bigint, ${d.locationId}::bigint, ${move.qty}::numeric,
              ${move.uomId}::bigint, ${move.statusCode}, ${move.createdBy}::bigint)
      RETURNING inventory_reservation_id`;
    ids.push(reservation[0].inventory_reservation_id);
  }
  return ids;
}

/**
 * 피킹 — 예약이 있으면 `reserved → picked`, 없으면 `available → picked` 로 옮긴다.
 * 어느 쪽이든 `reserved + picked` 합이 변하지 않아 `check_balance_qty()` 가 문장마다 참이다.
 *
 * ⛔ 한 문장 `UPDATE … WHERE <하한> RETURNING` 이다 — 먼저 SELECT 해서 비교하면 잠금 «밖»의
 * 값으로 판정하게 된다. 0행이 곧 400 `NEGATIVE_BALANCE` 다.
 */
export async function pickBalances(tx: Prisma.TransactionClient, moves: PickMove[]): Promise<void> {
  for (const move of moves) {
    // Δ=0 에 `version_no` 를 올리면 화면의 If-Match 만 낡는다.
    if (move.delta.isZero()) continue;
    const delta = move.delta;
    const reserved = move.inventoryReservationId !== null;
    const guard = !delta.greaterThan(0)
      ? Prisma.sql`picked_qty >= ${delta.negated()}::numeric`
      : reserved
        ? Prisma.sql`reserved_qty >= ${delta}::numeric`
        : // 트리거 갈래 1 을 앞당긴다 — `on_hand` 만 보면 예약분을 잠식해 500 이 된다.
          Prisma.sql`available_qty >= ${delta}::numeric`;
    const rows = await tx.$queryRaw<{ inventory_balance_id: bigint }[]>`
      UPDATE inventory.inventory_balance
         SET ${reserved ? Prisma.sql`reserved_qty = reserved_qty - ${delta}::numeric,` : Prisma.empty}
             picked_qty = picked_qty + ${delta}::numeric,
             version_no = version_no + 1
       WHERE ${dimensionWhere(move.dimension)}
         AND ${guard}
      RETURNING inventory_balance_id`;
    if (rows.length === 0) throw negativeBalance(move.field, '피킹할 재고가 모자랍니다.');
    if (move.inventoryReservationId !== null) {
      await consumeReservation(tx, move.inventoryReservationId, move.dimension.itemId, delta, move.field);
    }
  }
}

/** Δ<0 의 하한 `consumed_qty >= −Δ` 가 빠지면 `app.qty_t`(CHECK ≥ 0) 로 500 이 된다. */
async function consumeReservation(
  tx: Prisma.TransactionClient,
  reservationId: bigint,
  itemId: bigint,
  delta: Prisma.Decimal,
  path: string,
): Promise<void> {
  const guard = delta.greaterThan(0)
    ? // `ck_reservation_qty`(released + consumed ≤ reserved) 를 앞당긴다.
      Prisma.sql`reserved_qty - released_qty - consumed_qty >= ${delta}::numeric`
    : Prisma.sql`consumed_qty >= ${delta.negated()}::numeric`;
  // `item_id` 까지 겨냥해 차원과 예약의 짝이 어긋난 호출을 0행 → 400 으로 드러낸다.
  const rows = await tx.$queryRaw<{ inventory_reservation_id: bigint }[]>`
    UPDATE inventory.inventory_reservation
       SET consumed_qty = consumed_qty + ${delta}::numeric,
           version_no = version_no + 1
     WHERE inventory_reservation_id = ${reservationId}
       AND item_id = ${itemId}::bigint
       AND ${guard}
    RETURNING inventory_reservation_id`;
  if (rows.length === 0) throw negativeBalance(path, '피킹에 쓸 예약 수량이 모자랍니다.');
}

/**
 * 소진 — 출고가 원장에서 `on_hand` 를 내리기 «전»에 `picked` 를 같은 양 내린다.
 * ⛔ 예약은 건드리지 않는다 — 예약은 피킹에서 이미 소진됐다.
 */
export async function consumeBalances(
  tx: Prisma.TransactionClient,
  moves: ConsumeMove[],
): Promise<void> {
  for (const move of moves) {
    if (move.qty.isZero()) continue;
    // 피킹이 올린 행과 출고가 내리는 행이 다르면 0행이라 400 이다 — 다른 위치의 피킹분을
    // 여기서 소진할 수는 없다.
    const rows = await tx.$queryRaw<{ inventory_balance_id: bigint }[]>`
      UPDATE inventory.inventory_balance
         SET picked_qty = picked_qty - ${move.qty}::numeric,
             version_no = version_no + 1
       WHERE ${dimensionWhere(move.dimension)}
         AND picked_qty >= ${move.qty}::numeric
      RETURNING inventory_balance_id`;
    if (rows.length === 0) throw negativeBalance(move.field, '소진할 피킹분이 모자랍니다.');
  }
}
