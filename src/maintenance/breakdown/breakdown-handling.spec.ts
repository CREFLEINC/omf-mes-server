import {
  assertBreakdownCompletionWindow,
  checkBreakdownHandling,
} from './breakdown-handling.service';

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

  it('완료 시각과 같은 밀리초 안의 미래 마이크로초도 RANGE다', () => {
    const completedAt = new Date(1_000);
    expect(() =>
      assertBreakdownCompletionWindow('1000001', completedAt),
    ).toThrow(expect.objectContaining({ status: 422 }));
    expect(() =>
      assertBreakdownCompletionWindow('1000000', completedAt),
    ).not.toThrow();
    expect(() =>
      assertBreakdownCompletionWindow(null, completedAt),
    ).not.toThrow();
  });
});
