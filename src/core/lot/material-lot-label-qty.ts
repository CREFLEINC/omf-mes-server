import { Prisma } from '@prisma/client';

/**
 * 자재 LOT 라벨 수량(피처 019 · omf-all-around#367 · 2026-11-28 사용자 결정) — LOT `l` 에 거는 SQL 식.
 *
 * 반납 줄이 없는 LOT 은 지금처럼 `initial_qty`(분할 LOT 이면 분할 수량)다. 반납 줄이 있는 LOT 은 «실물»을 찍는다 —
 * 지금 재고(그 LOT 의 재고 잔액 위치 합 on_hand) > 0 이면 그 값, 없으면 가장 최근 반납 줄의 반납 수량이다.
 * 그렇지 않으면 반납 입고 뒤 「나중에」 찍거나 PDA 로 받은 반납 LOT 이 처음 출고 양(예 300)으로 찍힌다(실물 40).
 *
 * P-01-02 분할 LOT 라벨 목록의 `qty`(클라가 라벨 수량으로 그대로 쓴다)와 서버 자재 LOT 라벨 렌디션이 같은 식을 쓴다.
 */
export function materialLotLabelQtySql(lotAlias: string): Prisma.Sql {
  const l = Prisma.raw(lotAlias);
  return Prisma.sql`(
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM production.material_return_line mrl WHERE mrl.lot_id = ${l}.lot_id) THEN ${l}.initial_qty
      WHEN COALESCE((SELECT SUM(b.on_hand_qty) FROM inventory.inventory_balance b WHERE b.lot_id = ${l}.lot_id), 0) > 0
        THEN (SELECT SUM(b.on_hand_qty) FROM inventory.inventory_balance b WHERE b.lot_id = ${l}.lot_id)
      ELSE (SELECT mrl.return_qty FROM production.material_return_line mrl WHERE mrl.lot_id = ${l}.lot_id
             ORDER BY mrl.created_at DESC, mrl.material_return_line_id DESC LIMIT 1)
    END)`;
}

/** LOT 별 라벨 수량 — 없는 LOT 은 빠진다. */
export async function materialLotLabelQty(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>, lotIds: readonly bigint[],
): Promise<Map<bigint, Prisma.Decimal>> {
  if (lotIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ lot_id: bigint; qty: Prisma.Decimal }[]>`
    SELECT l.lot_id, ${materialLotLabelQtySql('l')} AS qty FROM trace.lot l WHERE l.lot_id = ANY(${[...new Set(lotIds)]}::bigint[])`;
  return new Map(rows.map((row) => [row.lot_id, new Prisma.Decimal(row.qty)]));
}
