import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';
import { SourceCode } from './nonconformance-source';

/**
 * `GET /quality/disposition-candidates` 의 SQL — 원시 SQL(0단계 선례 `lot-status-query.ts`).
 * I-21 PR ③ — §4-1(R-4) 반영본. ⛔ 초판의 「불량창고를 가리는 칸이 0개」는 거짓 —
 * `mdm.warehouse.is_defect` 가 실재한다(`20260828000000`). 모집단 = **원천 둘(RETURN 입고 ·
 * OQC 확정 불합격)의 UNION × `inventory_balance JOIN mdm.warehouse WHERE is_defect` 잔액** —
 * `bal` 내부 조인이라 불량창고 잔액 0행인 LOT 은 자연히 빠진다(§9-1 #8-a). 창고가 둘이면
 * `ORDER BY sum DESC LIMIT 1` 로 가장 큰 하나를 싣는다 — 행을 없애지 않는다.
 * ⛔ 식별자는 이 파일의 상수·리터럴에서만 온다. 요청 값은 전부 파라미터로 묶는다.
 */

/** `overall_judgment_code`(계약 `InspectionResult`) · 회신 E-3 종결 — 3값 중 「불합격」. */
const REJECTED = 'REJECTED';
const CONFIRMED = 'CONFIRMED';
const OQC = 'OQC';
const RETURN = 'RETURN';

export interface DispositionCandidateFilters {
  sourceCode?: SourceCode;
  withoutNonconformanceOnly?: boolean;
  warehouseId?: number;
  itemId?: number;
  lotId?: number;
  receivedFrom?: string;
  receivedTo?: string;
  q?: string;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/** 모집단 — RETURN ∪ PRODUCT `lot_id`. `UNION`(ALL 아님)이 두 원천 겹침을 한 행으로 접는다. */
const CAND_CTE = `
  WITH cand AS (
    SELECT gl.lot_id
      FROM logistics.goods_receipt_line gl
      JOIN logistics.goods_receipt g ON g.goods_receipt_id = gl.goods_receipt_id
     WHERE g.receipt_type_code = '${RETURN}'
    UNION
    SELECT req.lot_id
      FROM quality.inspection_result r
      JOIN quality.inspection_request req ON req.inspection_request_id = r.inspection_request_id
     WHERE r.status_code = '${CONFIRMED}' AND req.inspection_type_code = '${OQC}'
       AND r.overall_judgment_code = '${REJECTED}' AND req.lot_id IS NOT NULL
  )`;

/** ⭐ `is_defect` 축의 불량창고 잔액만(내부 조인 — 0행이면 빠진다). `$1`=`warehouseId`(null 이면
 * 안 건다) — 사후 필터가 아니라 «재집계»(리뷰 Major-2, R-4 형 재발 방지 · 동률 2차 키 Minor-2). */
const BAL_LATERAL = `
    JOIN LATERAL (
      SELECT b.warehouse_id, b.uom_id,
             sum(b.on_hand_qty)         AS qty,
             max(b.last_transaction_at) AS received_at        -- ⭐ R-18 · 두 갈래 공통(§4-1)
        FROM inventory.inventory_balance b
        JOIN mdm.warehouse dw ON dw.warehouse_id = b.warehouse_id AND dw.is_defect = true
       WHERE b.lot_id = c.lot_id AND b.on_hand_qty <> 0        -- ⭐ I-20 R-22
         AND ($1::bigint IS NULL OR b.warehouse_id = $1::bigint)
       GROUP BY b.warehouse_id, b.uom_id
       ORDER BY sum(b.on_hand_qty) DESC, b.warehouse_id ASC
       LIMIT 1
    ) bal ON TRUE`;

/** 반품 갈래(입고번호·원 출하 거래처) — 가장 최근 반품 한 줄. PRODUCT 뿐이면 통째로 NULL. */
const RETURN_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT g.goods_receipt_id, g.goods_receipt_no, p.partner_name
        FROM logistics.goods_receipt_line gl
        JOIN logistics.goods_receipt g ON g.goods_receipt_id = gl.goods_receipt_id
        LEFT JOIN logistics.shipment_lot_allocation sla ON sla.shipment_lot_allocation_id = gl.original_shipment_lot_allocation_id
        LEFT JOIN logistics.shipment_line sl ON sl.shipment_line_id = sla.shipment_line_id
        LEFT JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
        LEFT JOIN logistics.shipment_request sr ON sr.shipment_request_id = s.shipment_request_id
        LEFT JOIN mdm.partner p ON p.partner_id = sr.customer_id
       WHERE gl.lot_id = c.lot_id AND g.receipt_type_code = '${RETURN}'
       ORDER BY g.receipt_datetime DESC, g.goods_receipt_id DESC
       LIMIT 1
    ) rt ON TRUE`;

/** count 도 이 축을 쓴다 — `sourceCode`·`q`·`warehouseId` 필터가 `bal`·`rt` 를 본다. */
const FROM_CORE = `
    FROM cand c
    JOIN trace.lot l ON l.lot_id = c.lot_id
    JOIN mdm.item i ON i.item_id = l.item_id
    ${BAL_LATERAL}
    JOIN mdm.warehouse w ON w.warehouse_id = bal.warehouse_id
    ${RETURN_LATERAL}`;

/** OQC 갈래 — `rt` 가 있으면(RETURN 이 이긴다) 응답에서 null 로 접는다(§1-4-0 · 계약 명시). */
const OQC_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT r.inspection_result_id
        FROM quality.inspection_result r
        JOIN quality.inspection_request req ON req.inspection_request_id = r.inspection_request_id
       WHERE req.lot_id = c.lot_id AND r.status_code = '${CONFIRMED}' AND req.inspection_type_code = '${OQC}'
         AND r.overall_judgment_code = '${REJECTED}'
       ORDER BY r.inspected_at DESC, r.inspection_result_id DESC
       LIMIT 1
    ) oqc ON TRUE`;

/** 이 LOT 에 «이미 만들어진» 부적합 — 여럿이면 가장 최근 것 하나(단수 · §1-4-1). */
const NC_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT nc.nonconformance_id, nc.nonconformance_no, nc.status_code
        FROM quality.nonconformance_lot nl
        JOIN quality.nonconformance nc ON nc.nonconformance_id = nl.nonconformance_id
       WHERE nl.lot_id = c.lot_id
       ORDER BY nc.opened_at DESC, nc.nonconformance_id DESC
       LIMIT 1
    ) nc ON TRUE`;

const FROM = `${FROM_CORE}${OQC_LATERAL}${NC_LATERAL}`;

const SELECT_COLUMNS = `
      c.lot_id, l.lot_no, l.item_id, i.item_code, i.item_name,
      bal.qty, bal.uom_id, bal.warehouse_id, w.warehouse_name, bal.received_at,
      CASE WHEN rt.goods_receipt_id IS NOT NULL THEN '${RETURN}' ELSE 'PRODUCT' END AS source_code,
      rt.goods_receipt_id, rt.goods_receipt_no, rt.partner_name,
      CASE WHEN rt.goods_receipt_id IS NULL THEN oqc.inspection_result_id END AS inspection_result_id,
      nc.nonconformance_id, nc.nonconformance_no, nc.status_code AS nonconformance_status_code`;

/** `sourceCode` 는 `rt` 유무로 건다(응답 CASE 와 같은 축). `withoutNonconformanceOnly` 는
 * «열린» 부적합만 `NOT EXISTS` 로 — nullable 관계에 `NOT (...)` 금지(I-20 §0 #5). `$1` 은 항상
 * `warehouseId ?? null`(`BAL_LATERAL` 이 재집계로 쓴다 · 리뷰 Major-2 — 사후 필터 금지). */
function conditionsOf(filters: DispositionCandidateFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [filters.warehouseId ?? null];
  const parts: string[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    parts.push(sql.replace('?', `$${params.length}`));
  };

  if (filters.sourceCode === 'RETURN') parts.push('rt.goods_receipt_id IS NOT NULL');
  if (filters.sourceCode === 'PRODUCT') parts.push('rt.goods_receipt_id IS NULL');
  if (filters.withoutNonconformanceOnly === true) {
    parts.push(
      'NOT EXISTS (SELECT 1 FROM quality.nonconformance_lot wnl JOIN quality.nonconformance wnc ON wnc.nonconformance_id = wnl.nonconformance_id WHERE wnl.lot_id = c.lot_id AND wnc.closed_at IS NULL)',
    );
  }
  if (filters.itemId !== undefined) add('l.item_id = ?::bigint', filters.itemId);
  if (filters.lotId !== undefined) add('c.lot_id = ?::bigint', filters.lotId);
  // ⭐ 갈래 C(§1-2) — 양끝 포함, date 축. NULL 인 received_at 은 지우지 않는다(리뷰 Major-1 ·
  // §9-1 #8-b · 통보 182). `receivedAt` 도 `::date` 로 접은 값이라 같은 캐스팅으로 비교한다.
  if (filters.receivedFrom !== undefined) add('(bal.received_at IS NULL OR bal.received_at::date >= ?::date)', filters.receivedFrom);
  if (filters.receivedTo !== undefined) add('(bal.received_at IS NULL OR bal.received_at::date <= ?::date)', filters.receivedTo);
  if (filters.q !== undefined) {
    const q = params.push(`%${filters.q}%`);
    parts.push(`(l.lot_no ILIKE $${q} OR rt.goods_receipt_no ILIKE $${q} OR i.item_code ILIKE $${q} OR i.item_name ILIKE $${q})`);
  }

  return { where: parts.length === 0 ? 'TRUE' : parts.join('\n   AND '), params };
}

/** 기본 정렬 — 계약이 `sort` 를 안 줬다(§4-2). ⛔ `NULLS LAST` 안 씀(R-18). 2차 키 `lot_id DESC`. */
export function dispositionCandidateRowsQuery(filters: DispositionCandidateFilters, page: { skip: number; take: number }): BuiltQuery {
  const { where, params } = conditionsOf(filters);
  const limit = params.push(page.take);
  const offset = params.push(page.skip);
  const sql = `${CAND_CTE}
    SELECT ${SELECT_COLUMNS}
      ${FROM}
     WHERE ${where}
     ORDER BY bal.received_at DESC, c.lot_id DESC
     LIMIT $${limit} OFFSET $${offset}`;
  return { sql, params };
}

/** `page.total` 은 필터 «전체» 기준이다 — 페이지 안에서 세지 않는다. */
export function dispositionCandidateCountQuery(filters: DispositionCandidateFilters): BuiltQuery {
  const { where, params } = conditionsOf(filters);
  return { sql: `${CAND_CTE} SELECT count(*)::int AS total ${FROM_CORE} WHERE ${where}`, params };
}

/** `SELECT_COLUMNS` 가 내는 원시 행. */
export interface DispositionCandidateRow {
  lot_id: bigint | number;
  lot_no: string;
  item_id: bigint | number;
  item_code: string;
  item_name: string;
  qty: unknown;
  uom_id: bigint | number;
  warehouse_id: bigint | number;
  warehouse_name: string;
  received_at: Date | null;
  source_code: SourceCode;
  goods_receipt_id: bigint | number | null;
  goods_receipt_no: string | null;
  partner_name: string | null;
  inspection_result_id: bigint | number | null;
  nonconformance_id: bigint | number | null;
  nonconformance_no: string | null;
  nonconformance_status_code: string | null;
}

/** 계약 `DispositionCandidate` 와 동형(required 7 / 프로퍼티 18). */
export interface DispositionCandidateView {
  lotId: number;
  lotNo: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  quantity: number;
  uomId: number;
  warehouseId: number;
  warehouseName: string;
  sourceCode: SourceCode;
  goodsReceiptId: number | null;
  receiptNo: string | null;
  receivedAt: string | null;
  partnerName: string | null;
  inspectionResultId: number | null;
  nonconformanceId: number | null;
  nonconformanceNo: string | null;
  nonconformanceStatusCode: string | null;
}

/** ⭐⭐ R-13 — 계약이 널을 «허용»한 유일한 스키마(8칸) — 명시로 `null` 을 싣는다(키 생략이
 * 아니다 · PRODUCT 갈래가 본길). ⛔ `numeric(20,6)` 은 `Prisma.Decimal` 로 접고 마지막에 `.toNumber()`. */
export function dispositionCandidateView(row: DispositionCandidateRow): DispositionCandidateView {
  return {
    lotId: Number(row.lot_id),
    lotNo: row.lot_no,
    itemId: Number(row.item_id),
    itemCode: row.item_code,
    itemName: row.item_name,
    quantity: new Prisma.Decimal(String(row.qty)).toNumber(),
    uomId: Number(row.uom_id),
    warehouseId: Number(row.warehouse_id),
    warehouseName: row.warehouse_name,
    sourceCode: row.source_code,
    goodsReceiptId: row.goods_receipt_id === null ? null : Number(row.goods_receipt_id),
    receiptNo: row.goods_receipt_no,
    receivedAt: toDateString(row.received_at),
    partnerName: row.partner_name,
    inspectionResultId: row.inspection_result_id === null ? null : Number(row.inspection_result_id),
    nonconformanceId: row.nonconformance_id === null ? null : Number(row.nonconformance_id),
    nonconformanceNo: row.nonconformance_no,
    nonconformanceStatusCode: row.nonconformance_status_code,
  };
}
