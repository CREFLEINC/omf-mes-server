import { ContractException } from '../../common/errors';
import { WORKLIST_STATES, assertWorklistState, worklistReasonsOf } from './production-order-worklist';

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

describe('worklistReasonsOf — 자동 계획 DONE 뒤의 조치 필요 까닭', () => {
  const counts = { done: true, live: 3, line_missing: 0, location_missing: 0, plant_mismatch: 0 };

  it('살아 있는 W/O 가 없으면 NO_LIVE_WORK_ORDER 하나만', () => {
    expect(worklistReasonsOf('ACTION_REQUIRED', { ...counts, live: 0 })).toEqual([{ code: 'NO_LIVE_WORK_ORDER', workOrderCount: 0 }]);
  });

  it('걸린 까닭만 W/O 수와 함께 낸다', () => {
    expect(worklistReasonsOf('ACTION_REQUIRED', { ...counts, line_missing: 1, plant_mismatch: 2 })).toEqual([
      { code: 'WORK_ORDER_LINE_MISSING', workOrderCount: 1 },
      { code: 'LINE_PLANT_MISMATCH', workOrderCount: 2 },
    ]);
  });

  it('자동 계획 확인 필요(DONE 아님)는 autoPlan.reasons 몫이라 내지 않는다', () => {
    expect(worklistReasonsOf('ACTION_REQUIRED', { ...counts, done: false, live: 0 })).toBeUndefined();
  });

  it('조치 필요가 아니면 내지 않는다', () => {
    expect(worklistReasonsOf('RELEASE_PENDING', { ...counts, line_missing: 1 })).toBeUndefined();
  });
});
