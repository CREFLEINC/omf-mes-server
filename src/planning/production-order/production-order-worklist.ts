import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';

/**
 * 「작업지시 목록」(W-02-01) 칩의 판정 — 조회 때 W/O 상태로 계산한다(장부 P-142).
 * BEFORE_PLAN 계획 전 · ACTION_REQUIRED 조치 필요 · RELEASE_PENDING 배포 대기 · RELEASED 배포 완료 · CANCELLED 취소.
 */
export const WORKLIST_STATES = ['BEFORE_PLAN', 'ACTION_REQUIRED', 'RELEASE_PENDING', 'RELEASED', 'CANCELLED'] as const;
export type WorklistState = (typeof WORKLIST_STATES)[number];

/** 자동 계획 DONE 과 같은 판정 — 확정 계획 수량 합이 오더 수량 이상(`autoPlanStatusSql`·`AutoPlanService.viewsOf`). */
const DONE = Prisma.sql`COALESCE((SELECT sum(p.planned_qty) FROM planning.production_plan p
   WHERE p.production_order_id = o.production_order_id AND p.status_code = 'CONFIRMED'), 0) >= o.order_qty`;

/** 이 오더의 계획에서 나온 W/O. */
const ORDER_WORK_ORDERS = Prisma.sql`production.work_order w
  JOIN planning.production_plan pp ON pp.production_plan_id = w.production_plan_id AND pp.production_order_id = o.production_order_id`;

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

/**
 * 오더 별칭 `o` 의 판정 식. 목록 필터(`WHERE … = 값`)와 응답 칸이 같은 식을 쓴다 — 두 벌이면 칩 건수와 행 표시가 갈린다.
 * ⚠ DONE 인데 살아 있는 W/O 가 없으면(전개 전·전부 취소) 조치 필요다 — W/O 를 전개해야 배포할 수 있다.
 */
export function worklistStateSql(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN o.status_code = 'CANCELLED' THEN 'CANCELLED'
    WHEN NOT (${DONE}) AND o.auto_plan_attempted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM planning.production_plan p WHERE p.production_order_id = o.production_order_id) THEN 'BEFORE_PLAN'
    WHEN NOT (${DONE}) THEN 'ACTION_REQUIRED'
    WHEN NOT EXISTS (SELECT 1 FROM ${ORDER_WORK_ORDERS} WHERE w.status_code <> 'CANCELLED') THEN 'ACTION_REQUIRED'
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

/** 자동 계획은 끝났는데(DONE) 조치 필요인 까닭. 자동 계획 확인 필요의 까닭은 `autoPlan.reasons` 가 맡는다. */
export const WORKLIST_REASON_CODES = ['NO_LIVE_WORK_ORDER', 'WORK_ORDER_LINE_MISSING', 'WORK_ORDER_LOCATION_MISSING', 'LINE_PLANT_MISMATCH'] as const;
export type WorklistReasonCode = (typeof WORKLIST_REASON_CODES)[number];
export interface WorklistReason { code: WorklistReasonCode; workOrderCount: number }

/** 판정(`worklistStateSql`)과 같은 조각으로 센다 — 칩과 까닭이 갈리지 않는다. */
export function worklistReasonCountsSql(): Prisma.Sql {
  return Prisma.sql`(${DONE}) AS done,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE w.status_code <> 'CANCELLED')::int AS live,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING} AND ${LINE_MISSING})::int AS line_missing,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING} AND ${LOCATION_MISSING})::int AS location_missing,
    (SELECT count(*) FROM ${ORDER_WORK_ORDERS} WHERE ${PENDING} AND ${LINE_PLANT_MISMATCH})::int AS plant_mismatch`;
}

export interface WorklistReasonCounts { done: boolean; live: number; line_missing: number; location_missing: number; plant_mismatch: number }

/** 조치 필요이고 자동 계획이 DONE 일 때만 낸다. W/O 하나가 여러 까닭에 함께 세일 수 있다. */
export function worklistReasonsOf(state: WorklistState, counts: WorklistReasonCounts): WorklistReason[] | undefined {
  if (state !== 'ACTION_REQUIRED' || !counts.done) return undefined;
  if (counts.live === 0) return [{ code: 'NO_LIVE_WORK_ORDER', workOrderCount: 0 }];
  const reasons: WorklistReason[] = [
    { code: 'WORK_ORDER_LINE_MISSING', workOrderCount: counts.line_missing },
    { code: 'WORK_ORDER_LOCATION_MISSING', workOrderCount: counts.location_missing },
    { code: 'LINE_PLANT_MISMATCH', workOrderCount: counts.plant_mismatch },
  ];
  return reasons.filter((reason) => reason.workOrderCount > 0);
}
