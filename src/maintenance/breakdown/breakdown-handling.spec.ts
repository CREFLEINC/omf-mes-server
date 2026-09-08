import { ERROR_CODE } from '../../common/errors';
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

  it.each(['HYD_LEAK', ''])(
    '원인 비null %p은 INVALID로 거절한다',
    (causeCode) => {
      expect(() => checkBreakdownHandling({ causeCode })).toThrow(
        expect.objectContaining({
          status: 400,
          errors: [
            expect.objectContaining({
              field: 'causeCode',
              code: ERROR_CODE.INVALID,
            }),
          ],
        }),
      );
    },
  );
});
