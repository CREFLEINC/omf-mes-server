import { Prisma } from '@prisma/client';

import { PICKABLE_BALANCE, StockCandidate } from '../../core/picking';

type Db = Prisma.TransactionClient;

const LOT_NORMAL = 'NORMAL';

export interface IssuableStockQuery {
  warehouseId: bigint;
  /** 없으면 그 창고의 품목 전부. */
  itemIds?: bigint[];
  /** 뺄 때는 잠근 뒤에 읽는다 — 읽기만 하는 조회는 잠그지 않는다. */
  lock: boolean;
  /** 시리얼이 달린 LOT 을 뺀다 — 수량만으로 빼면 재고는 줄고 시리얼은 남는다(사용자 2026-11-17). */
  withoutSerials: boolean;
}

/**
 * 연동이 뺄 수 있는 LOT 재고 — 자재 차감·수량 출고·재고 조회가 같은 조건을 쓴다. 맨 아래 위치의 정상 품질·가용·보류 없음·LOT 정상.
 * LOT 이 없는 재고는 출고 라인에 실을 수 없어 빠진다. 같은 위치·LOT 에 보유가 있는 상태가 둘 이상이면 출고 전기가 어느 것을 낼지 몰라
 * 거절하므로 그 재고도 빠진다.
 */
export async function issuableStock(db: Db, query: IssuableStockQuery): Promise<StockCandidate[]> {
  if (query.itemIds?.length === 0) return [];
  const itemFilter = query.itemIds === undefined ? Prisma.empty : Prisma.sql`AND item_id IN (${Prisma.join(query.itemIds)})`;
  const balances = await db.$queryRaw<{ location_id: bigint; item_id: bigint; lot_id: bigint | null; on_hand_qty: Prisma.Decimal }[]>`
    SELECT location_id, item_id, lot_id, on_hand_qty
      FROM inventory.inventory_balance
     WHERE warehouse_id = ${query.warehouseId} ${itemFilter}
     ORDER BY inventory_balance_id
     ${query.lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`;
  const held = new Map<string, number>();
  for (const row of balances) {
    if (row.on_hand_qty.isZero()) continue;
    const key = `${row.location_id}:${row.item_id}:${row.lot_id}`;
    held.set(key, (held.get(key) ?? 0) + 1);
  }
  const rows = await db.inventory_balance.findMany({
    where: {
      AND: [PICKABLE_BALANCE, {
        warehouse_id: query.warehouseId, ...(query.itemIds === undefined ? {} : { item_id: { in: query.itemIds } }),
        lot: { is: { status_code: LOT_NORMAL, ...(query.withoutSerials ? { serial_number: { none: {} } } : {}) } },
        location: { is_active: true, child_locations: { none: { is_active: true } } },
      }],
    },
    select: { location_id: true, lot_id: true, item_id: true, uom_id: true, available_qty: true, lot: { select: { created_at: true } } },
  });
  return rows.flatMap((row) =>
    row.lot_id === null || row.lot === null || row.available_qty === null || (held.get(`${row.location_id}:${row.item_id}:${row.lot_id}`) ?? 0) > 1
      ? []
      : [{
          warehouseId: query.warehouseId, locationId: row.location_id, lotId: row.lot_id, itemId: row.item_id, uomId: row.uom_id,
          availableQty: row.available_qty, expiryDate: null, lotCreatedAt: row.lot.created_at,
        }],
  );
}
