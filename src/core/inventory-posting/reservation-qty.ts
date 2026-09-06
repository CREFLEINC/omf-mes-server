import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';

/**
 * 잔액의 `reserved_qty`·`picked_qty` 와 예약의 `consumed_qty` 를 옮기는 **유일한 길**.
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
