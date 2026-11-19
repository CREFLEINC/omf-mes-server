import { SHIPMENT_COMPLETION_LOOKBACK_DAYS, daysBefore } from './terminal-work-count.service';

describe('P-04-07 출하 완료 배지 범위(피처 010 검증 1회차)', () => {
  it('US4-4·Q10 찾기 「완료 대기만」과 같은 30일 전부터 센다 — 달·해를 넘긴다', () => {
    expect(SHIPMENT_COMPLETION_LOOKBACK_DAYS).toBe(30);
    expect(daysBefore('2026-11-19', 30)).toBe('2026-10-20');
    expect(daysBefore('2026-01-10', 30)).toBe('2025-12-11');
    expect(daysBefore('2024-03-01', 1)).toBe('2024-02-29');
  });
});
