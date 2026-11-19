import { Prisma } from '@prisma/client';

import { BOM_COMPONENT_SELECT, MaterialIssueLine, materialRequirements } from './requirement';

/** PL13 ERP BOM 은 9단까지 내려간다(2026-11-17) — 이보다 깊으면 BOM 이 돌고 있다. */
const MAX_BOM_LEVELS = 20;
/** 재고·소요 칸이 소수 6자리다 — 더 잘게 남기면 미차감이 0 으로 저장된다. */
const QTY_SCALE = 6;

/**
 * BOM 끝 자재의 소요 — 그 공장 기본 BOM 이 있는 구성품은 그 BOM 으로 다시 풀고, 맨 끝 자재를 품목·단위마다 더한다.
 * 추적 시스템 연동의 자재 차감과 자동 W/O 출고요청이 «한 함수»를 쓴다 — 갈리면 옮겨 둔 자재와 빼는 자재가 어긋난다.
 * 공정 표시(`routing_operation_id`)는 보지 않는다. 줄의 구성품은 그 품목·단위를 처음 낸 구성품이다.
 */
export async function leafRequirements(
  db: Pick<Prisma.TransactionClient, 'bom'>,
  input: { bomId: bigint; qty: Prisma.Decimal; plantId: bigint },
): Promise<MaterialIssueLine[]> {
  const leaves = new Map<string, MaterialIssueLine>();
  let level = [{ bomId: input.bomId, qty: input.qty }];
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth === MAX_BOM_LEVELS) throw new Error(`BOM 이 ${MAX_BOM_LEVELS}단을 넘는다 — 돌고 있는지 확인: bom ${input.bomId}`);
    const boms = await db.bom.findMany({
      where: { bom_id: { in: level.map((entry) => entry.bomId) } },
      select: { bom_id: true, base_qty: true, bom_component: { select: BOM_COMPONENT_SELECT } },
    });
    const bomOf = new Map(boms.map((bom) => [bom.bom_id, bom]));
    const needs = level.flatMap(({ bomId, qty }) => {
      const bom = bomOf.get(bomId) as (typeof boms)[number];
      return materialRequirements(bom.bom_component, qty, bom.base_qty);
    });
    const subs = await db.bom.findMany({
      where: { parent_item_id: { in: [...new Set(needs.map((need) => need.item_id))] }, plant_id: input.plantId, is_default: true },
      select: { bom_id: true, parent_item_id: true, base_uom_id: true },
    });
    const subOf = new Map(subs.map((bom) => [bom.parent_item_id, bom]));
    level = [];
    for (const need of needs) {
      const sub = subOf.get(need.item_id);
      // 단위가 다르면 환산 규칙이 없어 풀지 않는다 — 그 품목 그대로 담는다.
      if (sub !== undefined && sub.base_uom_id === need.uom_id) {
        level.push({ bomId: sub.bom_id, qty: need.requested_qty });
        continue;
      }
      const key = `${need.item_id}:${need.uom_id}`;
      const seen = leaves.get(key);
      leaves.set(key, seen === undefined ? need : { ...seen, requested_qty: seen.requested_qty.plus(need.requested_qty) });
    }
  }
  // 소수 6자리로 맞추면 0 이 되는 줄은 뺄 것도 옮길 것도 없다 — 출고요청 줄은 `requested_qty > 0` 이다.
  return [...leaves.values()]
    .map((line) => ({ ...line, requested_qty: line.requested_qty.toDecimalPlaces(QTY_SCALE) }))
    .filter((line) => line.requested_qty.gt(0))
    .map((line, index) => ({ ...line, line_no: index + 1 }));
}
