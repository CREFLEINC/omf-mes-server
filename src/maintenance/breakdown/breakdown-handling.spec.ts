import { checkBreakdownHandling } from './breakdown-handling.service';

describe('breakdown handling', () => {
  it('원인 생략과 null을 구분한다', () => {
    expect(checkBreakdownHandling({})).toEqual({
      causePresent: false,
      notePresent: false,
    });
    expect(checkBreakdownHandling({ causeCode: null })).toEqual({
      causePresent: true,
      notePresent: false,
    });
    expect(checkBreakdownHandling({ handlingNote: null })).toEqual({
      causePresent: false,
      notePresent: true,
    });
  });

  it('원인 비null은 존재 검증 대상으로 표시한다', () => {
    expect(checkBreakdownHandling({ causeCode: 'HYD_LEAK' })).toEqual({
      causePresent: true,
      notePresent: false,
    });
  });
});
