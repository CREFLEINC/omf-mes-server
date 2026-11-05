import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { CONFIRMED_PLAN_QTY_SQL } from '../production-plan/plan-quantity';

/**
 * 「작업지시 목록」(W-02-01) 칩의 판정 — 조회 때 «저장된» 계획·W/O 로 계산한다. 자동 계획 시도 기록은 보지 않는다.
 * BEFORE_PLAN 계획 전(저장된 계획 0건) · ACTION_REQUIRED 조치 필요 · RELEASE_PENDING 배포 대기 · RELEASED 배포 완료 · CANCELLED 취소.
 * ⛔ 두 벌이다 — 응답 칸은 순수 함수 `worklistStateOf`(센 값에서), 목록 필터는 SQL `worklistStateSql`. 같은 식으로 고친다 —
 * 갈리면 칩 건수와 행 표시가 다르다.
 */
export const WORKLIST_STATES = ['BEFORE_PLAN', 'ACTION_REQUIRED', 'RELEASE_PENDING', 'RELEASED', 'CANCELLED'] as const;
export type WorklistState = (typeof WORKLIST_STATES)[number];

/** 확정 계획량(W/O 가 취소되지 않은 확정 계획 수량 합)이 오더 수량 이상. 오더 별칭 `o`. 수량 정의는 `plan-quantity.ts` 한 곳이다. */
export const AUTO_PLAN_DONE_SQL = Prisma.sql`${CONFIRMED_PLAN_QTY_SQL} >= o.order_qty`;

/** 자동 계획 상태가 없는(`autoPlan` null) 미완료 오더 — 시도도 계획도 없다. `autoPlanStatus` 필터만 쓴다(대체 예정). */
export const AUTO_PLAN_UNTOUCHED_SQL = Prisma.sql`(o.auto_plan_attempted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM planning.production_plan p WHERE p.production_order_id = o.production_order_id))`;

const HAS_PLAN = Prisma.sql`EXISTS (SELECT 1 FROM planning.production_plan p WHERE p.production_order_id = o.production_order_id)`;
const HAS_DRAFT = Prisma.sql`EXISTS (SELECT 1 FROM planning.production_plan p WHERE p.production_order_id = o.production_order_id AND p.status_code <> 'CONFIRMED')`;

/** 이 오더의 계획에서 나온 W/O. */
const ORDER_WORK_ORDERS = Prisma.sql`production.work_order w
  JOIN planning.production_plan pp ON pp.production_plan_id = w.production_plan_id AND pp.production_order_id = o.production_order_id`;

const LIVE = Prisma.sql`w.status_code <> 'CANCELLED'`;

/** 배포 전 W/O — 아직 배포되지 않았고(W/O 목록 `released=false`) 배포 전이가 받는 상태(PLANNED·CONFIRMED)인 것. 취소는 빠진다. */
const PENDING = Prisma.sql`w.released_at IS NULL AND w.status_code IN ('PLANNED', 'CONFIRMED')`;

/**
 * 배포 전제 검사(`release-plan.ts` 의 기본 위치 검사·`lineErrors`)가 막는 것 — 셋 중 하나라도 걸린 배포 전 W/O 가 있으면 배포 대기가
 * 아니라 조치 필요다(배포가 400 이 난다). ⛔ 배포 전제 검사를 바꾸면 이 셋도 함께 고친다 — 갈리면 「배포 대기」를 눌러도 배포가 막힌다.
 */
const LINE_MISSING = Prisma.sql`w.production_line_id IS NULL`;
const LOCATION_MISSING = Prisma.sql`(w.default_wip_location_id IS NULL OR w.default_fg_location_id IS NULL OR w.default_scrap_location_id IS NULL)`;
const LINE_PLANT_MISMATCH = Prisma.sql`(w.production_line_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM mdm.production_line l WHERE l.production_line_id = w.production_line_id AND l.plant_id = o.plant_id))`;
const BLOCKED = Prisma.sql`(${LINE_MISSING} OR ${LOCATION_MISSING} OR ${LINE_PLANT_MISMATCH})`;

/** 오더 별칭 `o` 의 판정 식 — 목록 필터(`WHERE … = 값`)가 쓴다. `worklistStateOf` 와 같은 순서다. */
export function worklistStateSql(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN o.status_code = 'CANCELLED' THEN 'CANCELLED'
    WHEN NOT ${HAS_PLAN} THEN 'BEFORE_PLAN'
    WHEN ${HAS_DRAFT} THEN 'ACTION_REQUIRED'
    WHEN NOT (${AUTO_PLAN_DONE_SQL}) THEN 'ACTION_REQUIRED'
    WHEN NOT EXISTS (SELECT 1 FROM ${ORDER_WORK_ORDERS} WHERE ${LIVE}) THEN 'ACTION_REQUIRED'
    WHEN EXISTS (SELECT 1 FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING} AND ${BLOCKED}) THEN 'ACTION_REQUIRED'
    WHEN EXISTS (SELECT 1 FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING}) THEN 'RELEASE_PENDING'
    ELSE 'RELEASED'
  END`;
}

/** 계약 enum 밖 값은 400 — 질의는 계약 검증이 enum 을 보지만, 계약 사본을 당기기 전에도 같은 그물을 둔다. */
export function assertWorklistState(value: string | undefined): WorklistState | undefined {
  if (value === undefined) return undefined;
  if ((WORKLIST_STATES as readonly string[]).includes(value)) return value as WorklistState;
  throw new ContractException(HttpStatus.BAD_REQUEST, [{
    scope: 'field', field: 'worklistState', code: ERROR_CODE.INVALID,
    message: `작업지시 목록 칩 값이 아닙니다(${value}) — ${WORKLIST_STATES.join('·')} 중 하나로 다시 조회하세요.`,
  }]);
}

/** 조치 필요의 까닭 — 응답은 이 순서로 낸다. */
export const WORKLIST_REASON_CODES = [
  'DRAFT_PLAN_PENDING',
  'PLAN_QTY_REMAINING',
  'NO_LIVE_WORK_ORDER',
  'WORK_ORDER_LINE_MISSING',
  'WORK_ORDER_LOCATION_MISSING',
  'LINE_PLANT_MISMATCH',
] as const;
export type WorklistReasonCode = (typeof WORKLIST_REASON_CODES)[number];
export interface WorklistReason { code: WorklistReasonCode; workOrderCount: number }

/** 판정(`worklistStateSql`)과 같은 조각으로 센다 — 칩·까닭·W/O 수가 갈리지 않는다. */
export function worklistReasonCountsSql(): Prisma.Sql {
  return Prisma.sql`(o.status_code = 'CANCELLED') AS cancelled,
    ${HAS_PLAN} AS has_plan,
    ${HAS_DRAFT} AS has_draft,
    (${AUTO_PLAN_DONE_SQL}) AS done,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE ${LIVE})::int AS live,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING})::int AS pending,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING} AND ${LINE_MISSING})::int AS line_missing,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING} AND ${LOCATION_MISSING})::int AS location_missing,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING} AND ${LINE_PLANT_MISMATCH})::int AS plant_mismatch,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING} AND ${BLOCKED})::int AS blocked`;
}

export interface WorklistReasonCounts {
  cancelled: boolean;
  has_plan: boolean;
  has_draft: boolean;
  done: boolean;
  live: number;
  pending: number;
  line_missing: number;
  location_missing: number;
  plant_mismatch: number;
  /** 셋 중 하나라도 걸린 배포 전 W/O 수 — 한 W/O 가 여러 까닭에 세일 수 있어 셋의 합이 아니다. */
  blocked: number;
}

/** `worklistStateSql` 과 같은 식을 센 값으로 — 응답 칸이 쓴다. */
export function worklistStateOf(counts: WorklistReasonCounts): WorklistState {
  if (counts.cancelled) return 'CANCELLED';
  if (!counts.has_plan) return 'BEFORE_PLAN';
  if (counts.has_draft || !counts.done || counts.live === 0 || counts.blocked > 0) return 'ACTION_REQUIRED';
  return counts.pending > 0 ? 'RELEASE_PENDING' : 'RELEASED';
}

/** 조치 필요일 때만 낸다. W/O 하나가 여러 까닭에 함께 세일 수 있다. 살아 있는 W/O 가 없다는 까닭은 확정 계획량을 채웠을 때만 — 모자라면 잔량이 먼저다. */
export function worklistReasonsOf(state: WorklistState, counts: WorklistReasonCounts): WorklistReason[] | undefined {
  if (state !== 'ACTION_REQUIRED') return undefined;
  const reasons: WorklistReason[] = [];
  if (counts.has_draft) reasons.push({ code: 'DRAFT_PLAN_PENDING', workOrderCount: 0 });
  if (!counts.done) reasons.push({ code: 'PLAN_QTY_REMAINING', workOrderCount: 0 });
  if (counts.done && counts.live === 0) reasons.push({ code: 'NO_LIVE_WORK_ORDER', workOrderCount: 0 });
  if (counts.line_missing > 0) reasons.push({ code: 'WORK_ORDER_LINE_MISSING', workOrderCount: counts.line_missing });
  if (counts.location_missing > 0) reasons.push({ code: 'WORK_ORDER_LOCATION_MISSING', workOrderCount: counts.location_missing });
  if (counts.plant_mismatch > 0) reasons.push({ code: 'LINE_PLANT_MISMATCH', workOrderCount: counts.plant_mismatch });
  return reasons;
}
