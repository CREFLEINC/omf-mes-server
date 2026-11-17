import { dayWindow, shiftWindow } from '../production-plan/plan-window';
import { TimeContext, judgeTime, precedenceWarnings } from './plan-times';

const TZ = 'Asia/Ho_Chi_Minh';
const DATE = '2026-11-18';
const day = dayWindow(DATE, '07:00:00', TZ);
const night = shiftWindow(DATE, { startTime: '19:00:00', endTime: '07:00:00' }, TZ);
const context = (shift: typeof night | null = null): TimeContext => ({ system: shift ?? day, day, shift, planDate: DATE, timezone: TZ });
const at = (local: string): string => new Date(`${local}+07:00`).toISOString();
const codes = (items: { field?: string; code: string }[]) => items.map((item) => [item.field, item.code]);

describe('judgeTime — SYSTEM 은 계획일·교대로, USER 는 본문 그대로', () => {
  it('SYSTEM 은 교대 창이다 — 자정을 넘는 교대는 다음 날 끝난다. 본문 시각이 다르면 다시 계산했다고 알린다', () => {
    const judged = judgeTime('p', { plannedTimeSourceCode: 'SYSTEM', plannedStartAt: at('2026-11-18T07:00:00') }, context(night));
    expect([judged.window.plannedStartAt.toISOString(), judged.window.plannedEndAt.toISOString()]).toEqual([at('2026-11-18T19:00:00'), at('2026-11-19T07:00:00')]);
    expect(judged.errors).toEqual([]);
    expect(judged.corrections).toEqual([expect.objectContaining({ field: 'p.plannedStartAt', reasonCode: 'SYSTEM_TIME_RECALCULATED', to: at('2026-11-18T19:00:00') })]);
  });

  it('SYSTEM 이고 본문 시각이 같거나 없으면 보정이 없다', () => {
    expect(judgeTime('p', { plannedTimeSourceCode: 'SYSTEM', plannedStartAt: day.plannedStartAt.toISOString() }, context()).corrections).toEqual([]);
    expect(judgeTime('p', { plannedTimeSourceCode: 'SYSTEM' }, context()).corrections).toEqual([]);
  });

  it('USER 는 받은 시각을 그대로 쓴다 — 자정을 넘겨 끝나도 된다', () => {
    const judged = judgeTime('p', { plannedTimeSourceCode: 'USER', plannedStartAt: at('2026-11-18T22:00:00'), plannedEndAt: at('2026-11-19T03:00:00') }, context(night));
    expect(judged.window.plannedStartAt.toISOString()).toBe(at('2026-11-18T22:00:00'));
    expect([judged.errors, judged.warnings]).toEqual([[], []]);
  });

  it('USER 인데 시각이 비면 REQUIRED, 종료가 시작보다 이르면 RANGE, 시작이 근무일 밖이면 PLAN_TIME_OUTSIDE_PLAN_DATE', () => {
    expect(codes(judgeTime('p', { plannedTimeSourceCode: 'USER' }, context()).errors)).toEqual([['p.plannedStartAt', 'REQUIRED'], ['p.plannedEndAt', 'REQUIRED']]);
    expect(codes(judgeTime('p', { plannedTimeSourceCode: 'USER', plannedStartAt: at('2026-11-18T10:00:00'), plannedEndAt: at('2026-11-18T09:00:00') }, context()).errors))
      .toEqual([['p.plannedEndAt', 'RANGE']]);
    // 근무일 하루는 07:00 부터 다음 날 07:00 전까지 — 06:59 는 전날 근무일이다.
    expect(codes(judgeTime('p', { plannedTimeSourceCode: 'USER', plannedStartAt: at('2026-11-18T06:59:00'), plannedEndAt: at('2026-11-18T10:00:00') }, context()).errors))
      .toEqual([['p.plannedStartAt', 'PLAN_TIME_OUTSIDE_PLAN_DATE']]);
    expect(judgeTime('p', { plannedTimeSourceCode: 'USER', plannedStartAt: at('2026-11-19T06:00:00'), plannedEndAt: at('2026-11-19T08:00:00') }, context()).errors).toEqual([]);
  });

  it('고른 교대가 다음 근무일 시작을 넘겨 끝나면 그 교대 안의 시작은 근무일 밖이어도 받는다', () => {
    const late = shiftWindow(DATE, { startTime: '23:00:00', endTime: '07:30:00' }, TZ);
    const judged = judgeTime('p', { plannedTimeSourceCode: 'USER', plannedStartAt: at('2026-11-19T07:15:00'), plannedEndAt: at('2026-11-19T07:30:00') }, context(late));
    expect([judged.errors, judged.warnings]).toEqual([[], []]);
    // 교대를 고르지 않았으면 같은 시각이 근무일 밖이다.
    expect(codes(judgeTime('p', { plannedTimeSourceCode: 'USER', plannedStartAt: at('2026-11-19T07:15:00'), plannedEndAt: at('2026-11-19T07:30:00') }, context()).errors))
      .toEqual([['p.plannedStartAt', 'PLAN_TIME_OUTSIDE_PLAN_DATE']]);
  });

  it('USER 시각이 고른 교대 밖이면 WARN 이다 — 막지 않는다', () => {
    const judged = judgeTime('p', { plannedTimeSourceCode: 'USER', plannedStartAt: at('2026-11-18T13:00:00'), plannedEndAt: at('2026-11-18T21:00:00') }, context(night));
    expect(judged.errors).toEqual([]);
    expect(codes(judged.warnings)).toEqual([['p.plannedStartAt', 'PLAN_TIME_OUTSIDE_SHIFT']]);
  });
});

describe('precedenceWarnings — 선행 공정이 끝나기 전에 시작하면 WARN', () => {
  const window = (start: string, end: string) => ({ plannedStartAt: new Date(at(start)), plannedEndAt: new Date(at(end)) });
  const dependency = [{ predecessor_operation_id: 1n, successor_operation_id: 2n, dependency_type_code: 'FINISH_TO_START' }];

  it('하나라도 USER 면 본다', () => {
    const operations = [
      { path: 'a', routingOperationId: 1n, source: 'USER' as const, window: window('2026-11-18T08:00:00', '2026-11-18T12:00:00') },
      { path: 'b', routingOperationId: 2n, source: 'USER' as const, window: window('2026-11-18T11:00:00', '2026-11-18T15:00:00') },
    ];
    expect(codes(precedenceWarnings(operations, dependency, TZ))).toEqual([['b.plannedStartAt', 'PLAN_TIME_PRECEDENCE']]);
    operations[1].window = window('2026-11-18T12:00:00', '2026-11-18T15:00:00');
    expect(precedenceWarnings(operations, dependency, TZ)).toEqual([]);
  });

  it('둘 다 SYSTEM 이거나 동시 착수(START_TO_START)면 보지 않는다', () => {
    const operations = [
      { path: 'a', routingOperationId: 1n, source: 'SYSTEM' as const, window: day },
      { path: 'b', routingOperationId: 2n, source: 'SYSTEM' as const, window: day },
    ];
    expect(precedenceWarnings(operations, dependency, TZ)).toEqual([]);
    expect(precedenceWarnings([{ ...operations[0], source: 'USER' }, operations[1]], [{ ...dependency[0], dependency_type_code: 'START_TO_START' }], TZ)).toEqual([]);
  });
});
