import { Prisma } from '@prisma/client';

/**
 * BOM 소요식 — 사용처가 둘이라 코어로 올렸다(I-8.md §7-3 · R-19). `:release` 의 자동
 * 발행(`src/production/work-order/`)과 `shortage`(`src/logistics/material-issue-request/`)
 * 가 **한 함수**를 쓴다. 도메인 간 import 를 만들지 않으려는 것이 이관의 이유다.
 *
 * ⛔ 순수한 것만 산다 — 어느 `bom_component` 를 담을지(`where`)는 도메인 규칙이라
 * `release-plan.ts` 와 `shortage.service.ts` 가 각자 갖는다.
 */

/** 소요 계산이 보는 `bom_component` 의 칸만. */
export interface BomComponentRow {
  bom_component_id: bigint;
  component_item_id: bigint;
  uom_id: bigint;
  required_qty: Prisma.Decimal;
}

/** `BomComponentRow` 를 그대로 내는 `select` — 두 호출자가 같은 칸만 읽는다. */
export const BOM_COMPONENT_SELECT = {
  bom_component_id: true,
  component_item_id: true,
  uom_id: true,
  required_qty: true,
} satisfies Prisma.bom_componentSelect;

/** `material_issue_request_line` 한 줄 — 헤더 id 는 INSERT 때 붙는다. */
export interface MaterialIssueLine {
  line_no: number;
  bom_component_id: bigint;
  item_id: bigint;
  requested_qty: Prisma.Decimal;
  uom_id: bigint;
}

/**
 * BOM 소요 = `required_qty × orderQty ÷ base_qty`.
 *
 * ⛔ **`scrap_rate` 를 곱하지 않는다** — 어느 설계 자료에도 그 산식이 없다(문의 037).
 *   `shortage` 도 같은 규약이라 037 의 답이 바꾸면 이 한 함수만 바꾼다(I-6 R-18).
 * ⛔ Decimal 로만 센다 — 부동소수로 세면 소수 소요가 어긋난다.
 */
export function materialRequirements(
  components: BomComponentRow[],
  orderQty: Prisma.Decimal,
  baseQty: Prisma.Decimal,
): MaterialIssueLine[] {
  return components.map((component, index) => ({
    line_no: index + 1,
    bom_component_id: component.bom_component_id,
    item_id: component.component_item_id,
    requested_qty: component.required_qty.times(orderQty).dividedBy(baseQty),
    uom_id: component.uom_id,
  }));
}
