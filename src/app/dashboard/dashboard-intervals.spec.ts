import { clip, intersect, stoppedSpans, subtract, totalLength, union } from './dashboard-intervals';

describe('dashboard intervals', () => {
  it('clip 은 범위 밖을 자르고 겹치지 않으면 null 이다', () => {
    expect(clip({ start: 0, end: 10 }, { start: 5, end: 20 })).toEqual({ start: 5, end: 10 });
    expect(clip({ start: 0, end: 5 }, { start: 5, end: 20 })).toBeNull();
  });

  it('union 은 겹치거나 맞닿은 구간을 하나로 합친다', () => {
    expect(union([{ start: 5, end: 8 }, { start: 0, end: 5 }, { start: 10, end: 12 }])).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 12 },
    ]);
  });

  it('subtract 는 겹친 빼기 구간을 한 번만 뺀다', () => {
    const spans = subtract([{ start: 0, end: 100 }], [
      { start: 10, end: 30 },
      { start: 20, end: 40 },
      { start: 90, end: 120 },
    ]);
    expect(spans).toEqual([
      { start: 0, end: 10 },
      { start: 40, end: 90 },
    ]);
    expect(totalLength(spans)).toBe(60);
  });

  it('STOP~RESUME 이 중단 구간이고, 닫히지 않은 STOP 은 세션 끝까지 간다', () => {
    const events = [
      { eventTypeCode: 'STOP', occurredAt: 10 },
      { eventTypeCode: 'RESUME', occurredAt: 20 },
      { eventTypeCode: 'STOP', occurredAt: 50 },
    ];
    expect(stoppedSpans(events, 80)).toEqual([
      { start: 10, end: 20 },
      { start: 50, end: 80 },
    ]);
  });

  it('짝 없는 RESUME 과 연달은 STOP 은 첫 STOP 만 연다', () => {
    const events = [
      { eventTypeCode: 'RESUME', occurredAt: 5 },
      { eventTypeCode: 'STOP', occurredAt: 10 },
      { eventTypeCode: 'STOP', occurredAt: 15 },
      { eventTypeCode: 'RESUME', occurredAt: 30 },
    ];
    expect(stoppedSpans(events, 100)).toEqual([{ start: 10, end: 30 }]);
  });

  it('intersect 는 겹친 부분만 남긴다 — 근무 구간 밖 가동은 빠진다', () => {
    const running = [{ start: 0, end: 100 }];
    const shifts = [{ start: 20, end: 50 }, { start: 60, end: 80 }, { start: 90, end: 140 }];
    expect(intersect(running, shifts)).toEqual([
      { start: 20, end: 50 },
      { start: 60, end: 80 },
      { start: 90, end: 100 },
    ]);
    expect(intersect(running, [])).toEqual([]);
  });
});
