import { issueWorkDate } from './issue-work-date';

describe('출고 작업일 — 생산일의 직전 근무일', () => {
  // 2026-11-16(월) ~ 22(일). 기대값은 quickstart 「출고 작업일 표」(2026-11-03 3차 개정) 그대로다.
  const table: [string, string, string, string][] = [
    ['월', '2026-11-16', '2026-11-13', '2026-11-14'],
    ['화', '2026-11-17', '2026-11-16', '2026-11-16'],
    ['수', '2026-11-18', '2026-11-17', '2026-11-17'],
    ['목', '2026-11-19', '2026-11-18', '2026-11-18'],
    ['금', '2026-11-20', '2026-11-19', '2026-11-19'],
    ['토', '2026-11-21', '2026-11-20', '2026-11-20'],
    ['일', '2026-11-22', '2026-11-20', '2026-11-21'],
  ];

  it.each(table)('SC-006 %s요일 생산(%s) → 주 5일제 %s · 주 6일제 %s', (_, production, fiveDays, sixDays) => {
    expect(issueWorkDate(production, 5)).toBe(fiveDays);
    expect(issueWorkDate(production, 6)).toBe(sixDays);
  });

  it('US7-4 주 6일제 공장의 월요일 생산은 전주 토요일이다', () => {
    expect(issueWorkDate('2026-11-16', 6)).toBe('2026-11-14');
  });

  it('US7-5 화요일(19일) 생산은 주 5일제·주 6일제 모두 월요일(18일)이다', () => {
    expect(issueWorkDate('2026-05-19', 5)).toBe('2026-05-18');
    expect(issueWorkDate('2026-05-19', 6)).toBe('2026-05-18');
  });

  it('US7-6 일요일(휴일) 생산은 주 6일제 토요일 · 주 5일제 금요일이다', () => {
    expect(issueWorkDate('2026-11-22', 6)).toBe('2026-11-21');
    expect(issueWorkDate('2026-11-22', 5)).toBe('2026-11-20');
  });

  it('생산일이 휴일이면 그 앞 근무일이다 — 토요일 생산을 주 5일제로 세면 금요일', () => {
    expect(issueWorkDate('2026-11-21', 5)).toBe('2026-11-20');
  });

  it('달·해를 넘어 거슬러 간다 — 2027-01-01(금)의 직전 근무일은 2026-12-31(목)', () => {
    expect(issueWorkDate('2027-01-01', 5)).toBe('2026-12-31');
    expect(issueWorkDate('2026-03-02', 5)).toBe('2026-02-27');
  });

  it('n 을 주면 근무일만 n 일 센다', () => {
    expect(issueWorkDate('2026-11-16', 5, 3)).toBe('2026-11-11');
    expect(issueWorkDate('2026-11-16', 6, 3)).toBe('2026-11-12');
  });

  it('YYYY-MM-DD 가 아니면 던진다', () => {
    expect(() => issueWorkDate('2026-11-16T00:00:00Z', 5)).toThrow();
  });
});
