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
  /** `lotKey` 는 COALESCE 0 이라 「LOT 없음」과 「lot_id=0」을 못 가른다 — `BalanceDimension.lotId` 에 실을 값은 이쪽이다. */
  lotId: bigint | null;
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
           item_id AS "itemId", COALESCE(lot_id, 0) AS "lotKey", lot_id AS "lotId",
           quality_status_code, inventory_status_code, ownership_type_code, owner_partner_id,
           available_qty
      FROM inventory.inventory_balance
     WHERE (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id,
            COALESCE(lot_id, 0))
           IN (VALUES ${Prisma.join(values)})
     ORDER BY inventory_balance_id
       FOR UPDATE`;
}

/**
 * (품목·LOT)의 잔액 행 **전부**를 `inventory_balance_id` 오름차순으로 잠근다.
 *
 * ⭐ 04 제품 피킹에는 **창고 축이 «0개»** 다 — `logistics.shipment_request` 에 `warehouse_id` 가 없고
 * `ShipmentLinePick` 본문은 `lotId`·`pickedQty`·`uomId` 셋뿐이라 11칸 중 둘로만 겨냥할 수 있다
 * (`lockBalancesInOrder` 는 7칸을 받는다).
 *
 * ⛔ **잠글 뿐 판정하지 않는다** — 행 수의 «뜻»은 호출자가 정한다: 0행 → 409(재고가 없다 · 재로드로
 * 풀린다) · 2행+ → 400 `INVALID`(어느 것을 낼지 정할 수 없다 · `picking-pick.service.ts:132` 와 같은 문장).
 * ⚠ **2행+ 가 400 인 것은 방어가 아니라 «운영 결론»이다**(결정 — 통보 196) — `inventory_reservation.warehouse_id`
 * 가 NOT NULL 이라 창고를 하나로 골라야 예약이 서는데 계약에 창고를 지정할 칸이 없다.
 * ⇒ **같은 제품 LOT 이 창고 둘에 서면 그 LOT 은 어떤 화면으로도 피킹할 수 없다.**
 *
 * ⚠ 잠금 «폭»이 넓다 — 그 LOT 의 **모든** 법인·사업부·공장·창고·위치 행을 잡는다. 제품 LOT 은 오늘
 * 한 창고에만 서지만, I-23·I-16 이 그대로 재사용하면 넓은 잠금이 퍼진다.
 *
 * ⛔ 순서가 형제와 «같아야» 한다 — `lockBalancesInOrder` 와 갈리면 두 경로가 같은 두 행을 반대로 잡는
 * 교착 창이 열린다(I-4 R-1 ② · I-5 R-5). ⛔ 없는 행을 미리 만들지 않는다.
 */
export async function lockBalancesByItemLot(
  tx: Prisma.TransactionClient,
  itemId: bigint,
  lotId: bigint,
): Promise<LockedBalanceRow[]> {
  // `lot_id` 를 COALESCE 없이 그대로 건다 — 제품 피킹은 LOT 이 required 라 「LOT 없음」 행을
  // 집을 일이 없고, COALESCE 를 걸면 그 행까지 잠가 폭이 더 넓어진다.
  return tx.$queryRaw<LockedBalanceRow[]>`
    SELECT legal_entity_id AS "legalEntityId", business_unit_id AS "businessUnitId",
           plant_id AS "plantId", warehouse_id AS "warehouseId", location_id AS "locationId",
           item_id AS "itemId", COALESCE(lot_id, 0) AS "lotKey", lot_id AS "lotId",
           quality_status_code, inventory_status_code, ownership_type_code, owner_partner_id,
           available_qty
      FROM inventory.inventory_balance
     WHERE item_id = ${itemId}
       AND lot_id = ${lotId}
     ORDER BY inventory_balance_id
       FOR UPDATE`;
}
