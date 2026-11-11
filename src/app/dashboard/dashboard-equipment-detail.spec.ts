import { sessionTimes } from './dashboard-equipment-detail-time';
import { standardOutput } from './dashboard-equipment-detail.service';

const H = 3_600_000;
const day = { start: 0, end: 24 * H };

describe('설비 상세 — 시간(sessionTimes)', () => {
  it('가동 + 작업 중 정지 = 작업 세션 시간이고, 정지는 STOP 의 사유별로 센다', () => {
    const times = sessionTimes(
      [{ sessionId: 1n, startedAt: 8 * H, endedAt: 16 * H }],
      [
        { sessionId: 1n, eventTypeCode: 'STOP', occurredAt: 10 * H, reasonCode: 'MOLD_FAULT' },
        { sessionId: 1n, eventTypeCode: 'RESUME', occurredAt: 11 * H, reasonCode: null },
        { sessionId: 1n, eventTypeCode: 'STOP', occurredAt: 13 * H, reasonCode: null },
        { sessionId: 1n, eventTypeCode: 'RESUME', occurredAt: 13.5 * H, reasonCode: null },
      ],
      day,
      20 * H,
    );
    expect(times).toMatchObject({ sessionMs: 8 * H, runningMs: 6.5 * H, stoppedMs: 1.5 * H });
    expect([...times.stoppedByReason]).toEqual([
      ['MOLD_FAULT', H],
      [null, 0.5 * H],
    ]);
    expect(times.runningBySession.get(1n)).toBe(6.5 * H);
  });

  it('진행 중 세션은 집계 시각까지, RESUME 없는 STOP 은 그때까지 정지다 — 오늘 밖은 자른다', () => {
    const times = sessionTimes(
      [{ sessionId: 2n, startedAt: -2 * H, endedAt: null }],
      [{ sessionId: 2n, eventTypeCode: 'STOP', occurredAt: 3 * H, reasonCode: 'WAIT' }],
      day,
      5 * H,
    );
    expect(times).toMatchObject({ sessionMs: 5 * H, runningMs: 3 * H, stoppedMs: 2 * H });
    expect(times.stoppedByReason.get('WAIT')).toBe(2 * H);
  });

  it('겹친 세션 — 한 세션이 멈춘 동안 다른 세션이 돌았으면 그 시간은 정지 사유에 넣지 않는다(정지 사유 합 = 작업 중 정지)', () => {
    const times = sessionTimes(
      [
        { sessionId: 1n, startedAt: 8 * H, endedAt: 12 * H },
        { sessionId: 2n, startedAt: 10 * H, endedAt: 14 * H },
      ],
      [
        { sessionId: 1n, eventTypeCode: 'STOP', occurredAt: 9 * H, reasonCode: 'A' },
        { sessionId: 1n, eventTypeCode: 'RESUME', occurredAt: 11 * H, reasonCode: null },
      ],
      day,
      20 * H,
    );
    // 9~10 시만 진짜 정지(10~11 시는 세션 2 가 돌았다)
    expect(times).toMatchObject({ sessionMs: 6 * H, runningMs: 5 * H, stoppedMs: H });
    expect([...times.stoppedByReason]).toEqual([['A', H]]);
    expect(times.sessionSpans).toEqual([{ start: 8 * H, end: 14 * H }]);
  });

  it('겹친 세션은 한 번만 센다', () => {
    const times = sessionTimes(
      [
        { sessionId: 1n, startedAt: 8 * H, endedAt: 12 * H },
        { sessionId: 2n, startedAt: 10 * H, endedAt: 14 * H },
      ],
      [],
      day,
      20 * H,
    );
    expect(times).toMatchObject({ sessionMs: 6 * H, runningMs: 6 * H, stoppedMs: 0 });
  });
});

describe('설비 상세 — 표준 C/T 기준 생산량(standardOutput)', () => {
  const session = (id: bigint, cycle: string | null, cavity: number | null, rework = false) => ({
    work_session_id: id,
    rework,
    cycle_sec: cycle,
    cavity_count: cavity,
  });

  it('세션마다 자기 C/T·캐비티로 내서 더하고(내림), 차이 = 실적 − 기준', () => {
    const running = new Map([
      [1n, H],
      [2n, H],
    ]);
    // 3600 ÷ 28 × 4 = 514.28… · 3600 ÷ 30 × 1 = 120
    expect(standardOutput([session(1n, '28', 4), session(2n, '30', null)], running, 600)).toEqual({
      expectedQty: 634,
      differenceQty: -34,
      excludedSessionCount: 0,
    });
  });

  it('표준 C/T 없는 세션은 빼고 세며, 재작업 W/O 세션은 넣지도 세지도 않는다 — 셀 세션이 없으면 null', () => {
    const running = new Map([
      [1n, H],
      [2n, H],
    ]);
    expect(standardOutput([session(1n, null, 2), session(2n, '10', 1, true)], running, 100)).toEqual({
      expectedQty: null,
      differenceQty: null,
      excludedSessionCount: 1,
    });
  });
});
