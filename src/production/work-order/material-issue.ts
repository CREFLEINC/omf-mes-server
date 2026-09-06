import { Prisma } from '@prisma/client';

/**
 * 확정·배포가 곁들여 발행하는 자재 출고요청(§4-3). `src/logistics/material-issue-request/`
 * 는 아직 없어(I-8 몫) production 이 표에 **직접** INSERT 한다 — 선례는 shipment 가
 * `goods_issue` 행을 스스로 만드는 자리이고, 도메인끼리 나누는 것은 타입뿐이다.
 * I-8 은 여기 적은 칸·상수를 그대로 승계하고 규약을 새로 짜지 않는다.
 */

/** ⛔ 긴급 W/O 만 자동 발행에서 빠진다 — 판정은 서버가 유형으로 한다(계약 G-4). */
const EMERGENCY_TYPE = 'EMERGENCY';

/**
 * ⛔ **판정에 쓰지 않는다** — `MATERIAL_ISSUE_REQUEST_STATUS` 코드 그룹이 시드에 없고
 * 컬럼이 NOT NULL 이라 넣을 뿐이다(`lot-registry.service.ts` 의 `HOLD_STATUS` 와 같은 자리).
 */
export const ISSUE_REQUESTED = 'REQUESTED';

/** 소요 계산이 보는 `bom_component` 의 칸만. */
export interface BomComponentRow {
  bom_component_id: bigint;
  component_item_id: bigint;
  uom_id: bigint;
  required_qty: Prisma.Decimal;
}

/** `material_issue_request_line` 한 줄 — 헤더 id 는 INSERT 때 붙는다. */
export interface MaterialIssueLine {
  line_no: number;
  bom_component_id: bigint;
  item_id: bigint;
  requested_qty: Prisma.Decimal;
  uom_id: bigint;
}

/**
 * 자동 발행 제외. ⛔ `REWORK` 는 대상이 **아니다** — 계약이 `EMERGENCY` 만 적었고
 * 「재작업도 비슷하니까」는 우리가 지어내는 뜻이다.
 */
export function skipsMaterialIssue(workOrderTypeCode: string): boolean {
  return workOrderTypeCode === EMERGENCY_TYPE;
}

/**
 * BOM 소요 = `required_qty × orderQty ÷ base_qty`.
 *
 * ⛔ **`scrap_rate` 를 곱하지 않는다** — 어느 설계 자료에도 그 산식이 없다(문의 037).
 *   I-8 의 `shortage` 도 같은 규약이라 037 의 답이 바꾸면 양쪽을 같이 바꾼다(R-18).
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
