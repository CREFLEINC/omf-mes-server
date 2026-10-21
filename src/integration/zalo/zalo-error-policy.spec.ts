import { classifyZaloError, nextSiteMorning } from './zalo-error-policy';

describe('classifyZaloError', () => {
  it.each([
    ['NETWORK', 'RETRY'],
    ['HTTP_500', 'RETRY'],
    ['HTTP_503', 'RETRY'],
    ['-100', 'RETRY'],
    ['-124', 'TOKEN'],
    ['-133', 'DEFER_0700'],
    ['-144', 'DEFER_0700'],
    ['-147', 'DEFER_0700'],
    ...['-108', '-118', '-139', '-140', '-141'].map((code) => [code, 'FAIL_RECIPIENT']),
    ...['-101', '-103', '-104', '-109', '-117', '-131', '-111', '-1121', '-1122', '-1124', '-132', '-115', '-136', '-137', '-120', '-135', '-138'].map(
      (code) => [code, 'FAIL_CONFIG'],
    ),
    ['-999', 'RETRY'],
    ['HTTP_404', 'FAIL_CONFIG'],
  ])('%s → %s (research R-3)', (code, expected) => {
    expect(classifyZaloError(code)).toBe(expected);
  });
});

describe('nextSiteMorning', () => {
  it('하노이 22:30 이면 다음 날 07:00(UTC 00:00)', () => {
    expect(nextSiteMorning(new Date('2026-10-21T15:30:00.000Z')).toISOString()).toBe('2026-10-22T00:00:00.000Z');
  });

  it('하노이 03:00 이면 같은 날 07:00', () => {
    expect(nextSiteMorning(new Date('2026-10-21T20:00:00.000Z')).toISOString()).toBe('2026-10-22T00:00:00.000Z');
  });

  it('하노이 07:00 정각 이후면 다음 날', () => {
    expect(nextSiteMorning(new Date('2026-10-22T00:00:00.000Z')).toISOString()).toBe('2026-10-23T00:00:00.000Z');
  });
});
