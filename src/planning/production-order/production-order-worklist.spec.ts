import { ContractException } from '../../common/errors';
import { WORKLIST_STATES, WorklistReasonCounts, assertWorklistState, worklistReasonsOf, worklistStateOf } from './production-order-worklist';

describe('assertWorklistState — 작업지시 목록 칩 값', () => {
  it('값이 없으면 거르지 않는다', () => {
    expect(assertWorklistState(undefined)).toBeUndefined();
  });

  it.each(WORKLIST_STATES)('%s 는 그대로 받는다', (state) => {
    expect(assertWorklistState(state)).toBe(state);
  });

  it('칩 값이 아니면 400 이고 고를 수 있는 값을 알린다', () => {
    let error: unknown;
    try {
      assertWorklistState('DONE');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ContractException);
    const body = JSON.stringify((error as ContractException).getResponse());
    expect(body).toContain('"field":"worklistState"');
    expect(body).toContain('RELEASE_PENDING');
  });
});

const counts: WorklistReasonCounts = {
  cancelled: false, has_plan: true, has_draft: false, done: true,
  live: 3, pending: 2, line_missing: 0, location_missing: 0, plant_mismatch: 0, blocked: 0,
};

describe('worklistStateOf — 저장된 계획·W/O 로 판정한다(SQL `worklistStateSql` 과 같은 순서)', () => {
  it.each<[string, Partial<WorklistReasonCounts>, string]>([
    ['취소된 ERP W/O 는 계획이 있어도 CANCELLED', { cancelled: true }, 'CANCELLED'],
    ['저장된 계획이 없으면 계획 전', { has_plan: false, done: false, live: 0, pending: 0 }, 'BEFORE_PLAN'],
    ['작성중 계획이 있으면 수량을 채웠어도 조치 필요', { has_draft: true }, 'ACTION_REQUIRED'],
    ['확정 계획량이 모자라면 조치 필요', { done: false }, 'ACTION_REQUIRED'],
    ['살아 있는 W/O 가 없으면 조치 필요', { live: 0, pending: 0 }, 'ACTION_REQUIRED'],
    ['배포가 막힌 W/O 가 있으면 조치 필요', { blocked: 1, line_missing: 1 }, 'ACTION_REQUIRED'],
    ['배포 전 W/O 가 모두 배포 가능하면 배포 대기', {}, 'RELEASE_PENDING'],
    ['배포 전 W/O 가 없으면 배포 완료', { pending: 0 }, 'RELEASED'],
  ])('%s', (_, override, state) => {
    expect(worklistStateOf({ ...counts, ...override })).toBe(state);
  });
});

describe('worklistReasonsOf — 조치 필요의 까닭', () => {
  it('작성중 계획·잔량은 W/O 수 0 으로 낸다 — 확정 계획량이 모자라면 W/O 없음은 내지 않는다', () => {
    expect(worklistReasonsOf('ACTION_REQUIRED', { ...counts, has_draft: true, done: false, live: 0, pending: 0 })).toEqual([
      { code: 'DRAFT_PLAN_PENDING', workOrderCount: 0 },
      { code: 'PLAN_QTY_REMAINING', workOrderCount: 0 },
    ]);
  });

  it('확정 계획량을 채웠는데 살아 있는 W/O 가 없으면 NO_LIVE_WORK_ORDER 하나만', () => {
    expect(worklistReasonsOf('ACTION_REQUIRED', { ...counts, live: 0, pending: 0 })).toEqual([{ code: 'NO_LIVE_WORK_ORDER', workOrderCount: 0 }]);
  });

  it('걸린 W/O 까닭만 W/O 수와 함께 낸다', () => {
    expect(worklistReasonsOf('ACTION_REQUIRED', { ...counts, line_missing: 1, plant_mismatch: 2, blocked: 2 })).toEqual([
      { code: 'WORK_ORDER_LINE_MISSING', workOrderCount: 1 },
      { code: 'LINE_PLANT_MISMATCH', workOrderCount: 2 },
    ]);
  });

  it('조치 필요가 아니면 내지 않는다', () => {
    expect(worklistReasonsOf('RELEASE_PENDING', { ...counts, line_missing: 1 })).toBeUndefined();
    expect(worklistReasonsOf('BEFORE_PLAN', { ...counts, has_plan: false })).toBeUndefined();
  });
});
