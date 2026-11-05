import { crossesMidnight, shiftTimeOf } from './shift-crossing';

describe('crossesMidnight — 시각으로 판정한다', () => {
  it.each([
    ['07:00:00', '19:00:00', false],
    ['19:00:00', '07:00:00', true],
    ['00:00:00', '00:00:00', true],
  ])('%s~%s → %s', (start, end, crosses) => {
    expect(crossesMidnight(start, end)).toBe(crosses);
  });

  it('`@db.Time` 값에서 HH:MM:SS 를 떼어 낸다', () => {
    expect(shiftTimeOf(new Date('1970-01-01T22:30:00.000Z'))).toBe('22:30:00');
  });
});
