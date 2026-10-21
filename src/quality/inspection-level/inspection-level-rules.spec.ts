import { LevelState, nextInspectionLevel } from './inspection-level-rules';

const at = (level: LevelState['level'], consecutiveAcceptCount = 0): LevelState => ({ level, consecutiveAcceptCount });

describe('nextInspectionLevel — IQC 검사 수준 셈 규칙(#64)', () => {
  it('보통에서 합격이면 연속 수만 오른다', () => {
    expect(nextInspectionLevel(at('NORMAL', 3), 'ACCEPTED')).toEqual({ level: 'NORMAL', consecutiveAcceptCount: 4, switched: false });
  });

  it('보통에서 15 번째 연속 합격이면 수월로 바뀌고 연속 수는 0 이다', () => {
    expect(nextInspectionLevel(at('NORMAL', 14), 'ACCEPTED')).toEqual({
      level: 'REDUCED',
      consecutiveAcceptCount: 0,
      switched: true,
      acceptStreak: 15,
    });
  });

  it('엄격에서 5 번째 연속 합격이면 보통으로 바뀐다', () => {
    expect(nextInspectionLevel(at('TIGHTENED', 4), 'ACCEPTED')).toEqual({
      level: 'NORMAL',
      consecutiveAcceptCount: 0,
      switched: true,
      acceptStreak: 5,
    });
  });

  it('엄격에서 4 번째 연속 합격은 엄격 그대로다', () => {
    expect(nextInspectionLevel(at('TIGHTENED', 3), 'ACCEPTED')).toEqual({ level: 'TIGHTENED', consecutiveAcceptCount: 4, switched: false });
  });

  it('수월은 합격이 이어져도 수월이다', () => {
    expect(nextInspectionLevel(at('REDUCED', 30), 'ACCEPTED')).toEqual({ level: 'REDUCED', consecutiveAcceptCount: 31, switched: false });
  });

  it.each(['REDUCED', 'NORMAL'] as const)('%s 에서 불합격이면 엄격으로 바뀐다', (level) => {
    expect(nextInspectionLevel(at(level, 7), 'REJECTED')).toEqual({ level: 'TIGHTENED', consecutiveAcceptCount: 0, switched: true });
  });

  it('엄격에서 불합격이면 수준은 그대로, 연속 수만 0 이다 — 전환이 아니다', () => {
    expect(nextInspectionLevel(at('TIGHTENED', 3), 'REJECTED')).toEqual({ level: 'TIGHTENED', consecutiveAcceptCount: 0, switched: false });
  });

  it('보류는 연속 수를 바꾸지 않는다', () => {
    expect(nextInspectionLevel(at('NORMAL', 9), 'HELD')).toEqual({ level: 'NORMAL', consecutiveAcceptCount: 9, switched: false });
  });

  it.each(['ACCEPTED', 'REJECTED'])('무검사는 %s 로 바뀌지 않는다 — 자동 전환 대상이 아니다', (judgment) => {
    expect(nextInspectionLevel(at('NONE', 0), judgment)).toEqual({ level: 'NONE', consecutiveAcceptCount: 0, switched: false });
  });
});
