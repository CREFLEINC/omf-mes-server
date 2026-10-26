import { CONSUMED_RELATION } from '../../core/lot/lot-genealogy';
import { WORK_ORDER_LOT_SOURCE } from '../../core/lot/lot-source';
import { GENEALOGY_BASIS, WORK_ORDER_BASIS } from '../lot/lot-genealogy-query.service';

/**
 * LOT 추적 목록·사슬이 함께 쓰는 SQL 조각. 값은 모두 코드 상수라 그대로 끼운다(사용자 값은 호출 쪽이 bind 한다).
 * 계보 규칙은 `lot-genealogy-query.service.ts`·`lot-impact.service.ts` 와 같다 — 계보(`lot_relation`)가 한 줄이라도
 * 있는 W/O 는 계보로, 실적은 있는데 계보가 0줄인 W/O(#166 배포 전)는 W/O 단위로 잇는다.
 * ⭐ 실적 배분이 없는 생산 LOT 은 잇지 않는다 — 투입만 하고 실적이 없는 W/O 의 빈 선발행 LOT 이 영향 LOT 으로 보이면
 *   안 된다. 기존 `affected-production-lots` 는 이 조건이 없다(별도 건).
 */
export const RECEIPT_CANCELLED = `('CANCELLED', 'CANCEL_REQUESTED')`;
export const SHIPMENT_CANCELLED = `'CANCELLED'`;
const WO = `'${WORK_ORDER_LOT_SOURCE}'`;
const CONSUMED = `'${CONSUMED_RELATION}'`;

/** 계보가 한 줄이라도 있는 W/O 인가 — `tracedWorkOrders` 와 같은 판정. `workOrder` 는 W/O id 를 내는 SQL 식이다. */
export function tracedSql(workOrder: string): string {
  return `EXISTS (SELECT 1 FROM trace.lot_relation tr JOIN trace.lot tt ON tt.lot_id = tr.target_lot_id
                   WHERE tr.relation_type_code = ${CONSUMED} AND tt.source_type_code = ${WO} AND tt.source_id = ${workOrder})`;
}

const HAS_PRODUCTION = (lot: string) =>
  `EXISTS (SELECT 1 FROM production.production_result_lot_allocation pa WHERE pa.lot_id = ${lot})`;

/** `sources`(LOT id 를 내는 SQL)의 각 LOT 이 들어간 생산 LOT — (source_lot_id, target_lot_id, work_order_id, basis). */
export function forwardLinksSql(sources: string): string {
  return `
    SELECT r.source_lot_id, r.target_lot_id, t.source_id AS work_order_id, '${GENEALOGY_BASIS}' AS basis
      FROM trace.lot_relation r
      JOIN trace.lot t ON t.lot_id = r.target_lot_id
     WHERE r.relation_type_code = ${CONSUMED} AND r.source_lot_id IN (${sources})
    UNION
    SELECT DISTINCT mc.lot_id, pl.lot_id, mc.work_order_id, '${WORK_ORDER_BASIS}'
      FROM production.material_consumption mc
      JOIN trace.lot pl ON pl.source_type_code = ${WO} AND pl.source_id = mc.work_order_id
     WHERE mc.lot_id IN (${sources}) AND ${HAS_PRODUCTION('pl.lot_id')} AND NOT ${tracedSql('mc.work_order_id')}`;
}

/** 생산 LOT 하나에 들어간 자재 LOT 수 — 계보 W/O 는 계보로, 아니면 그 W/O 의 투입 LOT 전부. */
export function inputCountSql(lot: string, workOrder: string): string {
  return `CASE WHEN ${tracedSql(workOrder)}
            THEN (SELECT COUNT(DISTINCT ir.source_lot_id) FROM trace.lot_relation ir
                   WHERE ir.target_lot_id = ${lot} AND ir.relation_type_code = ${CONSUMED})
            ELSE (SELECT COUNT(DISTINCT im.lot_id) FROM production.material_consumption im WHERE im.work_order_id = ${workOrder})
          END`;
}

/** 생산 LOT 하나의 뒤 단계 — 생산입고 줄 수·수량, 포장(취급 단위) 수·수량, 출하 수·수량·마지막 출하 일시. */
export function downstreamLateralSql(lot: string): string {
  return `
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS received_count, COALESCE(SUM(dl.receipt_qty), 0) AS received_qty
        FROM logistics.goods_receipt_line dl
        JOIN logistics.goods_receipt dg ON dg.goods_receipt_id = dl.goods_receipt_id
       WHERE dl.lot_id = ${lot} AND dg.receipt_type_code = 'PRODUCT' AND dg.status_code NOT IN ${RECEIPT_CANCELLED}
    ) dr ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT hc.handling_unit_id) AS hu_count, COALESCE(SUM(hc.qty), 0) AS packed_qty
        FROM inventory.handling_unit_content hc WHERE hc.lot_id = ${lot}
    ) dp ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT ds.shipment_id) AS shipment_count, COALESCE(SUM(da.allocated_qty), 0) AS shipped_qty,
             MAX(ds.shipped_at) AS last_shipped_at
        FROM logistics.shipment_lot_allocation da
        JOIN logistics.shipment_line dsl ON dsl.shipment_line_id = da.shipment_line_id
        JOIN logistics.shipment ds ON ds.shipment_id = dsl.shipment_id
       WHERE da.lot_id = ${lot} AND ds.status_code <> ${SHIPMENT_CANCELLED}
    ) dsh ON true`;
}
