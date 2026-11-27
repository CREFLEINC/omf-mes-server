import { Prisma } from '@prisma/client';

/** 반제품 LOT 하나의 실적·투입 합(피처 016 R-3). */
export interface WipQuantity {
  /** 그 LOT 에 배분된 실적 양품 합 — LOT 진척(`:complete`·`withProgress`)과 같은 셈이다. */
  produced: Prisma.Decimal;
  /** 그 LOT 의 투입 합 — 정정된 원 투입은 빼고 정정 투입을 넣는다(계보의 투입 구간과 같은 셈). */
  consumed: Prisma.Decimal;
}

/**
 * 다음 공정에 더 넣을 수 있는 양 — 실적 − 투입, 0 아래로 내려가지 않는다(FR-011).
 * ⛔ `initial_qty` 가 아니다 — 슬롯 계획 수량이라 실적과 다르다. 반제품은 원장을 지나지 않아 이 둘로만 센다.
 */
export function wipRemaining(quantity: WipQuantity): Prisma.Decimal {
  const remaining = quantity.produced.minus(quantity.consumed);
  return remaining.isNegative() ? new Prisma.Decimal(0) : remaining;
}

/** LOT 들의 실적·투입 합을 한 번에 — 투입 등록(잠금 안 재계산)과 LOT 조회가 같은 셈을 쓴다. 없는 LOT 은 키가 없다. */
export async function wipQuantities(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  lotIds: readonly bigint[],
): Promise<Map<bigint, WipQuantity>> {
  const ids = [...new Set(lotIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<{ lot_id: bigint; produced: Prisma.Decimal; consumed: Prisma.Decimal }[]>`
    SELECT l.lot_id,
           COALESCE((SELECT SUM(a.allocated_qty) FROM production.production_result_lot_allocation a WHERE a.lot_id = l.lot_id), 0) AS produced,
           COALESCE((SELECT SUM(mc.input_qty) FROM production.material_consumption mc
                      WHERE mc.lot_id = l.lot_id
                        AND NOT EXISTS (SELECT 1 FROM production.material_consumption cx
                                         WHERE cx.corrects_consumption_id = mc.material_consumption_id)), 0) AS consumed
      FROM trace.lot l WHERE l.lot_id = ANY(${ids}::bigint[])`;
  return new Map(rows.map((row) => [row.lot_id, {
    produced: new Prisma.Decimal(row.produced), consumed: new Prisma.Decimal(row.consumed),
  }]));
}
