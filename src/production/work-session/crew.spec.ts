import { participatedMinutes } from './crew';

const at = (hhmm: string) => new Date(`2026-09-07T${hhmm}:00.000Z`);

describe('crew — 참여 시간', () => {
  it('참여 분은 떠난 시각 → 세션 종료 → 지금 순으로 끝을 잡는다', () => {
    expect(participatedMinutes(at('01:00'), at('01:20'), at('02:00'), at('03:00'))).toBe(20);
    expect(participatedMinutes(at('01:00'), null, at('02:00'), at('03:00'))).toBe(60);
    expect(participatedMinutes(at('01:00'), null, null, at('03:00'))).toBe(120);
  });
});
