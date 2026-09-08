/**
 * `GET /quality/concessions` · `…/{concessionId}` 의 SQL — 원시 SQL(선례 `disposition-query.ts`).
 * ⛔ 왜. `usable`(§4-3 · 통보 089 §2)이 `approved_qty − consumed_qty > 0` 을 요구해 «컬럼 대
 * 컬럼» 비교가 필요하다 — Prisma 관계 필터는 리터럴 값하고만 비교되고 다른 컬럼과는 못
 * 비교한다. `usableOnly` 는 페이지네이션 «전»에 걸러야 해서 같은 판정을 SQL 로 다시 적는다
 * (§2 계열 — `concession-view.ts` 의 `assertUsableInvariant` 가 그 갈림을 런타임에 잡는다).
 * ⛔ 식별자는 이 파일의 상수·리터럴에서만 온다 — 요청 값은 전부 파라미터로 묶는다.
 */

export interface ConcessionFilters {
  approvalRequestId?: number;
  lotId?: number;
  nonconformanceId?: number;
  statusCode?: string;
  usableOnly?: boolean;
  validOn?: string;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/** 통보 089 §2 — 새 코드 그룹을 세우지 않는다(writer 0 이라 임의 값이 들어올 길이 없다). */
const APPROVED = 'APPROVED';

const FROM = `
    FROM quality.concession c
    JOIN quality.nonconformance nc ON nc.nonconformance_id = c.nonconformance_id
    JOIN trace.lot l ON l.lot_id = c.lot_id`;

const SELECT_COLUMNS = `
      c.concession_id, c.concession_no, c.nonconformance_id, c.lot_id, c.approved_qty,
      c.consumed_qty, c.uom_id, c.valid_from, c.valid_to, c.allowed_work_order_id,
      c.allowed_process_id, c.allowed_customer_id, c.approval_request_id, c.status_code,
      c.remarks, nc.nonconformance_no, l.lot_no`;

/**
 * `usableOnly=true` 일 때만 4항을 건다(§4-3 · 통보 089 §2 — 계약 3항 + 우리가 더한
 * `valid_from <= onDate`). 그 밖은 «필터를 안 건다»(`usableOnly=false`/미지정 · I-20
 * `open=false` 교훈 — false 를 「쓸 수 없는 것만」으로 읽지 않는다). `onDate` 는 한 파라미터를
 * 두 절(`valid_from`·`valid_to`)에서 재사용한다.
 */
function conditionsOf(filters: ConcessionFilters, onDate: string): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    parts.push(sql.replace('?', `$${params.length}`));
  };

  if (filters.approvalRequestId !== undefined) add('c.approval_request_id = ?::bigint', filters.approvalRequestId);
  if (filters.lotId !== undefined) add('c.lot_id = ?::bigint', filters.lotId);
  if (filters.nonconformanceId !== undefined) add('c.nonconformance_id = ?::bigint', filters.nonconformanceId);
  if (filters.statusCode !== undefined) add('c.status_code = ?', filters.statusCode);
  if (filters.usableOnly === true) {
    const idx = params.push(onDate);
    parts.push(`c.status_code = '${APPROVED}'`);
    parts.push(`c.valid_from <= $${idx}::date`);
    parts.push(`(c.valid_to IS NULL OR c.valid_to >= $${idx}::date)`);
    parts.push('(c.approved_qty - c.consumed_qty) > 0');
  }

  return { where: parts.length === 0 ? 'TRUE' : parts.join('\n   AND '), params };
}

/** 기본 정렬 — 계약이 `sort` 를 안 줬다(§4-2). 2차 키로 동률을 깬다(I-20 R-10 계열). */
export function concessionRowsQuery(filters: ConcessionFilters, onDate: string, page: { skip: number; take: number }): BuiltQuery {
  const { where, params } = conditionsOf(filters, onDate);
  const limit = params.push(page.take);
  const offset = params.push(page.skip);
  const sql = `
    SELECT ${SELECT_COLUMNS}
      ${FROM}
     WHERE ${where}
     ORDER BY c.valid_from DESC, c.concession_id DESC
     LIMIT $${limit} OFFSET $${offset}`;
  return { sql, params };
}

/** `page.total` 은 필터 «전체» 기준이다 — 페이지 안에서 세지 않는다. */
export function concessionCountQuery(filters: ConcessionFilters, onDate: string): BuiltQuery {
  const { where, params } = conditionsOf(filters, onDate);
  return { sql: `SELECT count(*)::int AS total ${FROM} WHERE ${where}`, params };
}

export function concessionByIdQuery(concessionId: number): BuiltQuery {
  return { sql: `SELECT ${SELECT_COLUMNS} ${FROM} WHERE c.concession_id = $1::bigint`, params: [concessionId] };
}

/** §4-3 — `validOn` 이 오면 그 값, 없으면 서버 UTC 달력일. ⛔ 타임존 캐스팅 금지(CLAUDE.md). */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
