import { NORMAL, POSTED, SCRAP } from './disposition-rollup';

/**
 * `GET /quality/disposition-decisions` 의 SQL — 원시 SQL 이다(0단계 선례 `lot-status-query.ts`).
 * ⛔ **왜.** `lotId`·`lotNo` 는 `nonconformance_lot` 이 «하나»일 때만 싣는다(§1-4-1 접기 — Prisma
 * 관계로는 못 그린다). `followUpPending`·`reinstatable` 은 페이지네이션 «전»에 걸러야 하는데
 * `dispositionFollowUp()` 은 행 «하나」를 받는 순수 함수라 그 자리에서 못 부른다 — §2 가 지시한
 * 대로 같은 판정을 SQL 로 다시 적는다. ⭐⭐ `SCRAP`·`NORMAL`·`POSTED` 는 그 파일이 export 해 둔
 * 상수를 «그대로」 쓴다 — 새 문자열을 쓰면 두 판정이 말없이 갈릴 수 있다(`disposition-view.ts`
 * 의 `assertFollowUpInvariant` 가 그 갈림을 런타임에 잡는다). 식별자는 이 파일의 상수·리터럴
 * 에서만 온다 — 요청 값은 전부 파라미터로 묶는다.
 */

export interface DispositionFilters {
  dispositionTypeCode?: string;
  nonconformanceId?: number;
  lotId?: number;
  itemId?: number;
  decidedFrom?: string;
  decidedTo?: string;
  warehouseId?: number;
  reinstatable?: boolean;
  followUpPending?: boolean;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/** `fu` — 이 결정을 원천으로 하는 «전기된» 폐기 출고 합(§0 #3 · R-3 ⓑ `POSTED` 만 센다). count 도 이 축으로 거른다. */
const FROM_CORE = `
    FROM quality.disposition_decision d
    JOIN quality.nonconformance nc ON nc.nonconformance_id = d.nonconformance_id
    JOIN mdm.item i ON i.item_id = nc.item_id
    JOIN app.app_user u ON u.app_user_id = d.decided_by
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(gil.issue_qty), 0) AS posted_qty
        FROM logistics.goods_issue gi
        JOIN logistics.goods_issue_line gil ON gil.goods_issue_id = gi.goods_issue_id
       WHERE gi.source_document_type_code = 'DISPOSITION_DECISION'
         AND gi.source_document_id = d.disposition_decision_id
         AND gi.status_code = '${POSTED}'
    ) fu ON TRUE`;

// `lotinfo` — 하나일 때만 값(§1-4-1). 응답 전용(WHERE 가 안 본다) — count 는 `FROM_CORE` 만 쓴다(Nit-3).
const FROM = `${FROM_CORE}
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*) = 1 THEN min(nl.lot_id) END AS lot_id,
             CASE WHEN count(*) = 1 THEN min(l.lot_no) END AS lot_no
        FROM quality.nonconformance_lot nl
        JOIN trace.lot l ON l.lot_id = nl.lot_id
       WHERE nl.nonconformance_id = d.nonconformance_id
    ) lotinfo ON TRUE`;

const SELECT_COLUMNS = `
      d.disposition_decision_id, d.nonconformance_id, d.disposition_type_code, d.decision_qty,
      d.uom_id, d.reason, d.decided_by, d.decided_at, d.approval_request_id,
      nc.nonconformance_no, nc.item_id, i.item_code, i.item_name, u.user_name AS decided_by_name,
      lotinfo.lot_id, lotinfo.lot_no, fu.posted_qty`;

/**
 * ⭐⭐ `reinstatable`(= `dispositionTypeCode = NORMAL`)과 `followUpPending`(= `SCRAP` 이고
 * «전기된 폐기 출고 합 < decisionQty»)은 `dispositionFollowUp()` 의 판정과 «한 글자도」 달라선
 * 안 된다(§2). `numeric(20,6)` 비교는 PostgreSQL 이 정확히 하므로(부동소수 함정은 TS 의
 * `Number()` 산술에만 있다 · ①a Major-2) 여기서는 그대로 비교해도 된다.
 */
function conditionsOf(filters: DispositionFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    parts.push(sql.replace('?', `$${params.length}`));
  };

  if (filters.dispositionTypeCode !== undefined) add('d.disposition_type_code = ?', filters.dispositionTypeCode);
  if (filters.nonconformanceId !== undefined) add('d.nonconformance_id = ?::bigint', filters.nonconformanceId);
  if (filters.itemId !== undefined) add('nc.item_id = ?::bigint', filters.itemId);
  // ⭐ nullable 관계를 «등치」가 아니라 EXISTS 로 건다(I-20 R-23 계열).
  if (filters.lotId !== undefined) {
    add('EXISTS (SELECT 1 FROM quality.nonconformance_lot fl WHERE fl.nonconformance_id = d.nonconformance_id AND fl.lot_id = ?::bigint)', filters.lotId);
  }
  if (filters.warehouseId !== undefined) {
    add(
      'EXISTS (SELECT 1 FROM quality.nonconformance_lot wl JOIN inventory.inventory_balance wb ON wb.lot_id = wl.lot_id WHERE wl.nonconformance_id = d.nonconformance_id AND wb.warehouse_id = ?::bigint)',
      filters.warehouseId,
    );
  }
  // ⛔ 「미만」 반열림(공유계약 L-3-1) — decidedTo 와 같은 시각의 행은 뺀다.
  if (filters.decidedFrom !== undefined) add('d.decided_at >= ?::timestamptz', filters.decidedFrom);
  if (filters.decidedTo !== undefined) add('d.decided_at < ?::timestamptz', filters.decidedTo);
  if (filters.reinstatable !== undefined) add(filters.reinstatable ? 'd.disposition_type_code = ?' : 'd.disposition_type_code <> ?', NORMAL);
  if (filters.followUpPending !== undefined) {
    add(
      filters.followUpPending ? 'd.disposition_type_code = ? AND fu.posted_qty < d.decision_qty' : '(d.disposition_type_code <> ? OR fu.posted_qty >= d.decision_qty)',
      SCRAP,
    );
  }

  return { where: parts.length === 0 ? 'TRUE' : parts.join('\n   AND '), params };
}

/** 기본 정렬 — 계약이 `sort` 질의를 안 줬다(§4-2). 2차 키로 동률을 깬다(I-20 R-10 계열). */
export function dispositionRowsQuery(filters: DispositionFilters, page: { skip: number; take: number }): BuiltQuery {
  const { where, params } = conditionsOf(filters);
  const limit = params.push(page.take);
  const offset = params.push(page.skip);
  const sql = `
    SELECT ${SELECT_COLUMNS}
      ${FROM}
     WHERE ${where}
     ORDER BY d.decided_at DESC, d.disposition_decision_id DESC
     LIMIT $${limit} OFFSET $${offset}`;
  return { sql, params };
}

/** `page.total` 은 필터 «전체» 기준이다 — 페이지 안에서 세지 않는다. */
export function dispositionCountQuery(filters: DispositionFilters): BuiltQuery {
  const { where, params } = conditionsOf(filters);
  return { sql: `SELECT count(*)::int AS total ${FROM_CORE} WHERE ${where}`, params };
}

export function dispositionByIdQuery(dispositionDecisionId: number): BuiltQuery {
  return { sql: `SELECT ${SELECT_COLUMNS} ${FROM} WHERE d.disposition_decision_id = $1::bigint`, params: [dispositionDecisionId] };
}
