import { ERROR_CODE, ErrorItem } from '../../common/errors';
import { PlanWindow } from '../production-plan/plan-window';
import type { RevalidationWarning } from './proposal-warnings';

/**
 * 공정 W/O 의 계획 시각 — SYSTEM 이면 계획일과 교대로 정한 창(`plan-window.ts`), USER 면 사람이 정한 시각을 그대로 둔다.
 * 재검증과 확정이 이 한 판정을 쓴다. 사람이 정한 시각은 계획일·교대를 바꿔도 다시 계산하지 않는다 — 맞지 않으면 오류·경고로 알린다.
 */

export type TimeSource = 'SYSTEM' | 'USER';

export const PLAN_TIME_OUTSIDE_PLAN_DATE = 'PLAN_TIME_OUTSIDE_PLAN_DATE';
export const PLAN_TIME_OUTSIDE_SHIFT = 'PLAN_TIME_OUTSIDE_SHIFT';
export const PLAN_TIME_PRECEDENCE = 'PLAN_TIME_PRECEDENCE';
export const SYSTEM_TIME_RECALCULATED = 'SYSTEM_TIME_RECALCULATED';

export interface TimeBody {
  plannedTimeSourceCode: TimeSource;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
}

/** 서버가 시스템 값을 다시 계산해 본문(화면이 보던 값)과 달라진 칸. */
export interface TimeCorrection {
  field: string;
  reasonCode: typeof SYSTEM_TIME_RECALCULATED;
  from: string | null;
  to: string;
  message: string;
}

export interface TimeJudgment {
  window: PlanWindow;
  errors: ErrorItem[];
  warnings: RevalidationWarning[];
  corrections: TimeCorrection[];
}

export interface TimeContext {
  /** 계획일과 교대로 정한 창 — SYSTEM 의 값. */
  system: PlanWindow;
  /** 계획일의 근무일 하루 — USER 시작 시각이 들어야 하는 범위. */
  day: PlanWindow;
  /** 교대를 정했으면 그 교대 창. */
  shift: PlanWindow | null;
  planDate: string;
  timezone: string;
}

/** `path` 는 공정 W/O 의 본문 경로(`plans[0].workOrders[1]`). */
export function judgeTime(path: string, body: TimeBody, context: TimeContext): TimeJudgment {
  const field = (name: string): string => `${path}.${name}`;
  const errors: ErrorItem[] = [];
  const error = (name: string, code: string, message: string): void => {
    errors.push({ scope: 'field', field: field(name), code, message });
  };
  if (body.plannedTimeSourceCode === 'SYSTEM') {
    const corrections = (['plannedStartAt', 'plannedEndAt'] as const).flatMap((name): TimeCorrection[] => {
      const sent = body[name];
      const to = name === 'plannedStartAt' ? context.system.plannedStartAt : context.system.plannedEndAt;
      if (sent === undefined || sent === null || new Date(sent).getTime() === to.getTime()) return [];
      return [{ field: field(name), reasonCode: SYSTEM_TIME_RECALCULATED, from: sent, to: to.toISOString(), message: `계획일·교대에 맞춰 계획 시각을 다시 계산했습니다(${clock(to, context.timezone)}).` }];
    });
    return { window: context.system, errors, warnings: [], corrections };
  }

  if (body.plannedStartAt === undefined || body.plannedStartAt === null) error('plannedStartAt', ERROR_CODE.REQUIRED, '직접 정한 계획 시각은 시작 시각이 필요합니다.');
  if (body.plannedEndAt === undefined || body.plannedEndAt === null) error('plannedEndAt', ERROR_CODE.REQUIRED, '직접 정한 계획 시각은 종료 시각이 필요합니다.');
  if (errors.length > 0) return { window: context.system, errors, warnings: [], corrections: [] };
  const window = { plannedStartAt: new Date(body.plannedStartAt as string), plannedEndAt: new Date(body.plannedEndAt as string) };
  if (window.plannedStartAt >= window.plannedEndAt) error('plannedEndAt', ERROR_CODE.RANGE, '계획 종료 시각은 시작 시각보다 늦어야 합니다.');
  if (window.plannedStartAt < context.day.plannedStartAt || window.plannedStartAt >= context.day.plannedEndAt) {
    error('plannedStartAt', PLAN_TIME_OUTSIDE_PLAN_DATE,
      `계획 시작 시각이 계획일(${context.planDate})의 근무일(${clock(context.day.plannedStartAt, context.timezone)} ~ 다음 날 ${clock(context.day.plannedEndAt, context.timezone)}) 밖입니다. 시각이나 계획일을 고치세요.`);
  }
  const warnings: RevalidationWarning[] = [];
  const shift = context.shift;
  if (shift !== null && (window.plannedStartAt < shift.plannedStartAt || window.plannedEndAt > shift.plannedEndAt)) {
    warnings.push({ code: PLAN_TIME_OUTSIDE_SHIFT, field: field('plannedStartAt'), message: `계획 시각이 고른 교대(${clock(shift.plannedStartAt, context.timezone)} ~ ${clock(shift.plannedEndAt, context.timezone)}) 밖입니다.` });
  }
  return { window, errors, warnings, corrections: [] };
}

export interface TimedOperation {
  path: string;
  routingOperationId: bigint;
  source: TimeSource;
  window: PlanWindow;
}

/**
 * 선행 공정(FINISH_TO_START)이 끝나기 전에 시작하는 후행 공정 — 확정을 막지 않는 경고다.
 * 둘 다 SYSTEM 이면 보지 않는다 — 교대를 고르지 않은 공정은 모두 근무일 하루라 늘 겹친다.
 */
export function precedenceWarnings(
  operations: readonly TimedOperation[],
  dependencies: readonly { predecessor_operation_id: bigint; successor_operation_id: bigint; dependency_type_code: string }[],
  timezone: string,
): RevalidationWarning[] {
  const byOperation = new Map(operations.map((operation) => [operation.routingOperationId, operation]));
  return dependencies.flatMap((dependency): RevalidationWarning[] => {
    const before = byOperation.get(dependency.predecessor_operation_id);
    const after = byOperation.get(dependency.successor_operation_id);
    if (dependency.dependency_type_code !== 'FINISH_TO_START' || before === undefined || after === undefined) return [];
    if (before.source === 'SYSTEM' && after.source === 'SYSTEM') return [];
    if (after.window.plannedStartAt >= before.window.plannedEndAt) return [];
    return [{
      code: PLAN_TIME_PRECEDENCE,
      field: `${after.path}.plannedStartAt`,
      message: `선행 공정이 끝나기(${clock(before.window.plannedEndAt, timezone)}) 전에 시작합니다.`,
    }];
  });
}

/** 공장 현지 벽시계 `MM-DD HH:mm`. */
function clock(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}
