import { ContractException } from '../../common/errors';
import { WORKLIST_STATES, assertWorklistState } from './production-order-worklist';

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
