import { omitEmpty } from '../../common/http/omit-empty';
import { BuiltQuery } from '../lot-status/lot-status-query';

/**
 * `GET /quality/lot-hold-events` 의 SQL — `SELECT … UNION ALL SELECT …` **한 문장**(브리프 §4-3).
 * ⭐⭐ 한 `lot_hold` 행이 최대 두 사건(HELD·RELEASED)으로 펴진다 — 계약이 직접 적었다(`:1555`
 * 「보류 «문서» 목록으로는 이 표를 만들 수 없다 — «기간 전에 등록되고 기간 안에 해제된 보류»를
 * 기간으로 집을 수 없다」). ⭐⭐ `eventTypeCode` 는 `branchesOf()` 가 **가지를 SQL 텍스트에서
 * 넣고 뺀다** — WHERE 절 필터로 걸면 `RELEASED` 없는 행의 `released_at IS NULL` 이 3값 논리로
 * UNKNOWN 이 돼 행이 통째로 사라진다(I-19 ⑤b 선례). ⛔ 두 가지를 앱에서 합쳐 정렬하지 않는다 —
 * 바깥의 `ORDER BY`·`LIMIT/OFFSET` 하나가 전체를 본다. ⛔ 식별자는 이 파일의 상수·리터럴에서만.
 */

export const SORTS = ['occurredAsc', 'occurredDesc'] as const;
export type LotHoldEventSort = (typeof SORTS)[number];
export const EVENT_TYPES = ['HELD', 'RELEASED'] as const;
export type LotHoldEventType = (typeof EVENT_TYPES)[number];

export interface LotHoldEventFilters {
  occurredFrom: string;
  occurredTo: string;
  eventTypeCode?: LotHoldEventType;
  actorId?: number;
  lotNo?: string;
  lotId?: number;
  itemId?: number;
  reasonCode?: string;
  lotTypeCode?: string;
}

/** 파라미터를 모으며 번호(`$n`)를 붙인다 — 두 가지가 같은 카운터를 공유한다. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** 두 가지가 «똑같이» 보는 조건. ⚠ `reasonCode` 는 해제 가지도 `h.reason_code`(등록 사유)를 본다 — 해제 사건에 별도 사유 칸이 없다(§1-4). */
function commonConditions(p: Params, filters: LotHoldEventFilters): string[] {
  const parts: string[] = [];
  if (filters.lotId !== undefined) parts.push(`h.lot_id = ${p.add(filters.lotId)}::bigint`);
  if (filters.lotNo !== undefined) parts.push(`l.lot_no = ${p.add(filters.lotNo)}`);
  if (filters.itemId !== undefined) parts.push(`l.item_id = ${p.add(filters.itemId)}::bigint`);
  if (filters.lotTypeCode !== undefined) parts.push(`l.lot_type_code = ${p.add(filters.lotTypeCode)}`);
  if (filters.reasonCode !== undefined) parts.push(`h.reason_code = ${p.add(filters.reasonCode)}`);
  return parts;
}

/** 한 가지의 고정 축 — HELD·RELEASED 가 다른 것은 여기 셋뿐이다(그 밖 SELECT 칸·조인은 똑같다). */
interface BranchAxis {
  eventType: LotHoldEventType;
  occurredColumn: 'held_at' | 'released_at';
  actorColumn: 'held_by' | 'released_by';
  /** RELEASED 만 실제 칸 · HELD 는 SQL 리터럴 NULL(§1-4 — 등록 사건엔 해제 사유가 없다). */
  releaseReasonExpr: string;
  targetStatusExpr: string;
}

const HELD_AXIS: BranchAxis = {
  eventType: 'HELD',
  occurredColumn: 'held_at',
  actorColumn: 'held_by',
  releaseReasonExpr: 'NULL::varchar(50)',
  targetStatusExpr: 'h.target_lot_status_code',
};
const RELEASED_AXIS: BranchAxis = {
  eventType: 'RELEASED',
  occurredColumn: 'released_at',
  actorColumn: 'released_by',
  releaseReasonExpr: 'h.release_reason_code',
  targetStatusExpr: 'h.release_target_lot_status_code',
};

// ⛔ RELEASED 가지에 `released_at IS NOT NULL` 존재 조건을 따로 두지 않는다 — 이미
// `h.released_at >= $occurredFrom::timestamptz` 가 걸려 있어 NULL 이면 3값 논리로 자연히
// 빠진다(중복 절이었다 — 리뷰 Minor-1). ⛔ 끝 경계는 «미만»(공유계약 L-3-1).
function branch(p: Params, filters: LotHoldEventFilters, axis: BranchAxis): string {
  const parts = [
    `h.${axis.occurredColumn} >= ${p.add(filters.occurredFrom)}::timestamptz`,
    `h.${axis.occurredColumn} < ${p.add(filters.occurredTo)}::timestamptz`,
    ...commonConditions(p, filters),
  ];
  if (filters.actorId !== undefined) parts.push(`h.${axis.actorColumn} = ${p.add(filters.actorId)}::bigint`);
  return `
    SELECT h.lot_hold_id, '${axis.eventType}'::varchar(10) AS event_type_code, h.${axis.occurredColumn} AS occurred_at,
           h.lot_id, l.lot_no, l.item_id, h.${axis.actorColumn} AS actor_id, au.user_name AS actor_name,
           h.reason_code, h.hold_qty, h.uom_id, h.release_condition,
           ${axis.releaseReasonExpr} AS release_reason_code, ${axis.targetStatusExpr} AS target_lot_status_code
      FROM trace.lot_hold h
      JOIN trace.lot l ON l.lot_id = h.lot_id
      LEFT JOIN app.app_user au ON au.app_user_id = h.${axis.actorColumn}
     WHERE ${parts.join('\n       AND ')}`;
}

/** ⭐⭐ `eventTypeCode` — 가지를 SQL 텍스트에서 «넣고 뺀다»(WHERE 절 필터가 «아니다»). */
function branchesOf(p: Params, filters: LotHoldEventFilters): string[] {
  if (filters.eventTypeCode === 'HELD') return [branch(p, filters, HELD_AXIS)];
  if (filters.eventTypeCode === 'RELEASED') return [branch(p, filters, RELEASED_AXIS)];
  return [branch(p, filters, HELD_AXIS), branch(p, filters, RELEASED_AXIS)];
}

/** ⭐ 동률 깨기 — `lot_hold_id`·`event_type_code` 를 2·3차 키로 둔다(같은 시각 사건이 여럿이면 페이지 경계가 흔들린다). */
const ORDER_BY: Record<LotHoldEventSort, string> = {
  occurredAsc: 'occurred_at ASC, lot_hold_id ASC, event_type_code ASC',
  occurredDesc: 'occurred_at DESC, lot_hold_id DESC, event_type_code DESC',
};

export function lotHoldEventRowsQuery(
  filters: LotHoldEventFilters,
  sort: LotHoldEventSort,
  page: { skip: number; take: number },
): BuiltQuery {
  const p = new Params();
  const union = branchesOf(p, filters).join('\n    UNION ALL\n');
  const orderBy = ORDER_BY[sort] ?? ORDER_BY.occurredDesc;
  const limit = p.add(page.take);
  const offset = p.add(page.skip);
  const sql = `SELECT * FROM (${union}\n    ) e\n     ORDER BY ${orderBy}\n     LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params: p.values };
}

/** `page.total` 은 필터 «전체»(가지 선택 포함) 기준이다 — 페이지 안에서 세지 않는다. */
export function lotHoldEventCountQuery(filters: LotHoldEventFilters): BuiltQuery {
  const p = new Params();
  const union = branchesOf(p, filters).join('\n    UNION ALL\n');
  return { sql: `SELECT count(*)::int AS total FROM (${union}\n    ) e`, params: p.values };
}

/** `$queryRawUnsafe` 원시 행 — 칸 이름 그대로, 타입 강제 없음(선례 `lot-status-view.ts`). */
export interface LotHoldEventRow {
  lot_hold_id: bigint | number;
  event_type_code: string;
  occurred_at: Date;
  lot_id: bigint | number;
  lot_no: string;
  item_id: bigint | number;
  actor_id: bigint | number | null;
  actor_name: string | null;
  reason_code: string;
  hold_qty: unknown;
  uom_id: bigint | number | null;
  release_condition: string | null;
  release_reason_code: string | null;
  target_lot_status_code: string | null;
}

/** 계약 `LotHoldEvent` 와 동형(required 6: lotHoldId·eventTypeCode·occurredAt·lotId·lotNo·actorId · 프로퍼티 14). */
export interface LotHoldEventView {
  lotHoldId: number;
  eventTypeCode: string;
  occurredAt: string;
  lotId: number;
  lotNo: string;
  itemId: number;
  actorId?: number;
  actorName?: string;
  reasonCode: string;
  holdQty?: number;
  uomId?: number;
  releaseCondition?: string;
  releaseReasonCode?: string;
  targetLotStatusCode?: string;
}

/**
 * `actorId` 가 계약 required 인데 물리(`held_by`/`released_by`)는 nullable 이다. 우리 쓰기
 * 셋은 언제나 채우지만 옛 행은 빌 수 있다 ⇒ **키를 생략**한다(0단계 선례: I-19 §12-1 ⓐ
 * `QualityConflictResponse.code`). `actorName` 도 함께 비운다(LEFT JOIN 이 NULL 을 낸다).
 * // 결정 — 통보 072: `docs/design-inquiries/072-actorId-required인데-held_by-released_by가-nullable이다.md`
 */
export function lotHoldEventView(row: LotHoldEventRow): LotHoldEventView {
  return omitEmpty({
    lotHoldId: Number(row.lot_hold_id),
    eventTypeCode: row.event_type_code,
    occurredAt: row.occurred_at.toISOString(),
    lotId: Number(row.lot_id),
    lotNo: row.lot_no,
    itemId: Number(row.item_id),
    actorId: id(row.actor_id),
    actorName: row.actor_name ?? undefined,
    reasonCode: row.reason_code,
    holdQty: row.hold_qty === null ? undefined : Number(row.hold_qty),
    uomId: id(row.uom_id),
    releaseCondition: row.release_condition ?? undefined,
    releaseReasonCode: row.release_reason_code ?? undefined,
    targetLotStatusCode: row.target_lot_status_code ?? undefined,
  });
}

function id(value: bigint | number | null): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
