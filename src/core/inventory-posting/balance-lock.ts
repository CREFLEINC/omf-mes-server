import { Prisma } from '@prisma/client';

/** 잔액 행을 겨냥하는 7칸 — `uq_inventory_balance_dim` 11칸의 앞쪽이다(`lot_id` 는 COALESCE 0). */
export interface BalanceLockKey {
  legalEntityId: bigint;
  businessUnitId: bigint;
  plantId: bigint;
  warehouseId: bigint;
  locationId: bigint;
  itemId: bigint;
  lotKey: bigint;
}

/** 잠근 행. 하한 판정은 11칸 단위라 나머지 4칸과 `available_qty` 를 함께 싣는다(I-5 R-4). */
export interface LockedBalanceRow extends BalanceLockKey {
  quality_status_code: string;
  inventory_status_code: string;
  ownership_type_code: string;
  owner_partner_id: bigint | null;
  available_qty: Prisma.Decimal | null;
}

/**
 * 잔액 행을 `inventory_balance_id` 오름차순으로 **한 문장에** 잠근다.
 *
 * ⭐ 7칸 행생성자 한 문장인 이유 — `(plant,warehouse,location,item) = ANY(…) AND
 * COALESCE(lot_id,0) = ANY(…)` 로 쓰면 라인 1 의 위치와 라인 2 의 LOT 이 짝지어져 교차곱이
 * 된다(I-4 R-1 ①). `from` 과 `to` 를 «같은» 문장에 넣는 것도 같은 처방이다 — 밖에 두면
 * `move()` 가 순서 밖에서 잡아 A→B·B→A 동시 처리가 교착한다(I-4 R-1 ②).
 *
 * ⭐ `post()` 도 부른다 — `:cancel` 은 id 오름차순으로 잡고 `POST /goods-receipts` 는 라인
 * 순서로 잡아, 안 맞추면 둘이 같은 두 행을 반대 순서로 잡는 교착 창이 열린다(I-5 R-5).
 *
 * ⛔ 행을 «잠글 뿐 판정하지 않는다» — 하한 판정은 `reverse()`(11칸 합산)와 출고 도메인의
 * 몫이다. 없는 행은 0행으로 돌아오고 `move()` ①이 만든다.
 *
 * ⛔ 없는 행을 미리 만들어 두지 않는다 — 「재고가 없다」가 「0 이 있다」로 바뀐다.
 */
export async function lockBalancesInOrder(
  tx: Prisma.TransactionClient,
  keys: BalanceLockKey[],
): Promise<LockedBalanceRow[]> {
  if (keys.length === 0) return [];
  const values = keys.map(
    (k) =>
      Prisma.sql`(${k.legalEntityId}::bigint, ${k.businessUnitId}::bigint, ${k.plantId}::bigint, ${k.warehouseId}::bigint, ${k.locationId}::bigint, ${k.itemId}::bigint, ${k.lotKey}::bigint)`,
  );
  return tx.$queryRaw<LockedBalanceRow[]>`
    SELECT legal_entity_id AS "legalEntityId", business_unit_id AS "businessUnitId",
           plant_id AS "plantId", warehouse_id AS "warehouseId", location_id AS "locationId",
           item_id AS "itemId", COALESCE(lot_id, 0) AS "lotKey",
           quality_status_code, inventory_status_code, ownership_type_code, owner_partner_id,
           available_qty
      FROM inventory.inventory_balance
     WHERE (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id,
            COALESCE(lot_id, 0))
           IN (VALUES ${Prisma.join(values)})
     ORDER BY inventory_balance_id
       FOR UPDATE`;
}
