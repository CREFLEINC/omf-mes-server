import type { Prisma } from '@prisma/client';

import { WORK_ORDER_LOT_SOURCE } from './lot-source';

/** 생산 뿌리 — 원천이 W/O 인 LOT 과 그 W/O. */
export interface ProductionRoot {
  rootLotId: bigint;
  workOrderId: bigint;
}

/**
 * 각 LOT 의 생산 뿌리(피처 013 R-5) — `parent_lot_id` 사슬을 타고 올라가 원천이 W/O 인 가장 가까운 LOT.
 * 제품 분리 자식(`-S1`·`-S1-S1`)의 W/O·생산일·투입 자재를 원래 LOT 에서 읽으려고 쓴다. 원천 W/O LOT 은 자기 자신이다.
 * W/O 뿌리가 없으면(자재 LOT·008 분할) `null` 이다. LOT 이 몇 개든 쿼리 한 번이다.
 * ⛔ 자식 LOT 의 원천을 W/O 로 복사하지 않는 이유: W/O 마감·취소·선발행 슬롯·생산입고 송신이 자식을 세게 된다.
 */
export async function productionRootOf(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  lotIds: readonly bigint[],
): Promise<Map<bigint, ProductionRoot | null>> {
  const ids = [...new Set(lotIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<{ base_lot_id: bigint; root_lot_id: bigint; work_order_id: bigint }[]>`
    WITH RECURSIVE up AS (
      SELECT l.lot_id AS base_lot_id, l.lot_id, l.parent_lot_id, l.source_type_code, l.source_id, 0 AS depth
        FROM trace.lot l WHERE l.lot_id = ANY(${ids}::bigint[])
      UNION ALL
      SELECT up.base_lot_id, p.lot_id, p.parent_lot_id, p.source_type_code, p.source_id, up.depth + 1
        FROM up JOIN trace.lot p ON p.lot_id = up.parent_lot_id
       WHERE up.source_type_code <> ${WORK_ORDER_LOT_SOURCE} AND up.depth < 64
    )
    SELECT DISTINCT ON (base_lot_id) base_lot_id, lot_id AS root_lot_id, source_id AS work_order_id
      FROM up WHERE source_type_code = ${WORK_ORDER_LOT_SOURCE}
     ORDER BY base_lot_id, depth`;
  const roots = new Map<bigint, ProductionRoot | null>(ids.map((id) => [id, null]));
  for (const row of rows) roots.set(row.base_lot_id, { rootLotId: row.root_lot_id, workOrderId: row.work_order_id });
  return roots;
}
