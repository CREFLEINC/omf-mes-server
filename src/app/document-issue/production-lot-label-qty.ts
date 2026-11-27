import { Prisma } from '@prisma/client';

import { PRODUCT_LOT_SPLIT_SOURCE, SPLIT_RELATION } from '../../core/lot';

/**
 * 생산 LOT 라벨 수량 = LOT 수량(배분 누계, 없으면 `initial_qty`) − 제품 분리로 떼어 낸 직속 자식 수량(피처 013 R-4).
 * 위치별이 아니라 LOT 하나의 값이다. 재고 합을 쓰지 않는다 — 출하·이동마다 라벨 숫자가 흔들린다.
 * ⛔ 008 부분 출고 자식(`GOODS_ISSUE_SPLIT`)은 빼지 않는다 — 원천이 `PRODUCT_LOT_SPLIT` 인 자식만.
 */
export async function productionLotLabelQty(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  lotIds: readonly bigint[],
): Promise<Map<bigint, Prisma.Decimal>> {
  const ids = [...new Set(lotIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<{ lot_id: bigint; qty: Prisma.Decimal }[]>`
    SELECT l.lot_id,
           COALESCE((SELECT SUM(a.allocated_qty) FROM production.production_result_lot_allocation a WHERE a.lot_id = l.lot_id), l.initial_qty)
           - COALESCE((SELECT SUM(r.relation_qty) FROM trace.lot_relation r JOIN trace.lot c ON c.lot_id = r.target_lot_id
                        WHERE r.source_lot_id = l.lot_id AND r.relation_type_code = ${SPLIT_RELATION}
                          AND c.source_type_code = ${PRODUCT_LOT_SPLIT_SOURCE}), 0) AS qty
      FROM trace.lot l WHERE l.lot_id = ANY(${ids}::bigint[])`;
  return new Map(rows.map((row) => [row.lot_id, new Prisma.Decimal(row.qty)]));
}
