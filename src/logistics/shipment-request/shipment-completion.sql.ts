/**
 * 목록 `completionReadyOnly` 의 SQL(피처 010 · POP 찾기 「완료 대기만」) — `completionBlockers()` 가 빈 지시서를 페이지 «전»에 거른다.
 * ⚠ OQC 판정을 SQL 로 다시 적는다(`oqcLotStatuses` 의 둘째 벌) — 갈리면 「완료 대기」로 걸러진 지시서가 409 가 된다.
 *   e2e(US4-4)가 완료 대기·미검사·불합격·완료된 지시서를 함께 세워 두 벌을 대조한다.
 * 바깥 별칭은 `sr` 이다(`FROM_SQL`).
 */

/** 그 피킹 LOT 의 마지막 매칭 결과 판정 — 옛 확정 결과(매칭 행 없음)는 전부 매칭. 다른 지시서의 결과는 보지 않는다. */
const LAST_JUDGMENT_SQL = `(SELECT r.overall_judgment_code
         FROM quality.inspection_result r
         JOIN quality.inspection_request q ON q.inspection_request_id = r.inspection_request_id
        WHERE q.inspection_type_code = 'OQC' AND q.target_type_code = 'SHIPMENT_REQUEST' AND q.lot_id IS NULL
          AND q.target_id = sr.shipment_request_id AND q.item_id = l.item_id AND q.status_code <> 'CANCELLED'
          AND (EXISTS (SELECT 1 FROM quality.inspection_result_lot m WHERE m.inspection_result_id = r.inspection_result_id AND m.lot_id = x.lot_id)
               OR (r.status_code = 'CONFIRMED'
                   AND NOT EXISTS (SELECT 1 FROM quality.inspection_result_lot m2 WHERE m2.inspection_result_id = r.inspection_result_id)))
        ORDER BY q.inspection_request_id DESC, r.inspection_round DESC
        LIMIT 1)`;

const SKIPPED_SQL = `EXISTS (SELECT 1 FROM quality.inspection_request q
                    WHERE q.inspection_type_code = 'OQC' AND q.target_type_code = 'SHIPMENT_REQUEST' AND q.lot_id IS NULL
                      AND q.target_id = sr.shipment_request_id AND q.item_id = l.item_id AND q.status_code = 'SKIPPED')`;

export const COMPLETION_READY_SQL = `(
      NOT EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                   WHERE l.shipment_request_id = sr.shipment_request_id AND l.allocated_qty > 0
                     AND (SELECT coalesce(sum(res.reserved_qty - res.released_qty), 0)
                            FROM inventory.inventory_reservation res
                           WHERE res.source_document_type_code = 'SHIPMENT_REQUEST_LINE'
                             AND res.source_document_id = l.shipment_request_line_id) < l.allocated_qty)
  AND EXISTS (SELECT 1 FROM logistics.shipment_request_lot x
                JOIN logistics.shipment_request_line l ON l.shipment_request_line_id = x.shipment_request_line_id
               WHERE l.shipment_request_id = sr.shipment_request_id AND x.status_code = 'PICKED')
  AND NOT EXISTS (SELECT 1 FROM logistics.shipment s
                   WHERE s.shipment_request_id = sr.shipment_request_id AND s.completed_terminal_id IS NOT NULL
                     AND s.status_code <> 'CANCELLED')
  AND NOT EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    JOIN logistics.sales_order_line so ON so.sales_order_line_id = l.sales_order_line_id
                   WHERE l.shipment_request_id = sr.shipment_request_id AND so.cancelled_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM logistics.shipment_request_lot x
                    JOIN logistics.shipment_request_line l ON l.shipment_request_line_id = x.shipment_request_line_id
                   WHERE l.shipment_request_id = sr.shipment_request_id AND x.status_code = 'PICKED'
                     AND l.shipping_inspection_required
                     AND NOT ${SKIPPED_SQL}
                     AND coalesce(${LAST_JUDGMENT_SQL}, 'NONE') <> 'ACCEPTED'))`;

/** 목록 `q` — 지시서 번호·고객(코드·이름)·품목(코드·이름) 부분 일치. `$n` 하나를 넷이 함께 쓴다. */
export function keywordSql(param: string): string {
  return `(sr.shipment_request_no ILIKE ${param}
      OR EXISTS (SELECT 1 FROM mdm.partner p WHERE p.partner_id = sr.customer_id
                   AND (p.partner_code ILIKE ${param} OR p.partner_name ILIKE ${param}))
      OR EXISTS (SELECT 1 FROM logistics.shipment_request_line l JOIN mdm.item i ON i.item_id = l.item_id
                  WHERE l.shipment_request_id = sr.shipment_request_id
                    AND (i.item_code ILIKE ${param} OR i.item_name ILIKE ${param})))`;
}
