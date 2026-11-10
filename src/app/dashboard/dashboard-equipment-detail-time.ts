import { Span, clip, subtract, totalLength, union } from './dashboard-intervals';

export interface DetailSession {
  readonly sessionId: bigint;
  readonly startedAt: number;
  /** 끝나지 않았으면 null — 집계 시각까지 본다. */
  readonly endedAt: number | null;
}

export interface DetailEvent {
  readonly sessionId: bigint;
  readonly eventTypeCode: string;
  readonly occurredAt: number;
  readonly reasonCode: string | null;
}

export interface SessionTimes {
  /** 작업 세션 시간(겹친 세션은 한 번) = 가동 + 작업 중 정지. */
  readonly sessionMs: number;
  readonly runningMs: number;
  readonly stoppedMs: number;
  /** 세션마다 가동 시간 — 표준 C/T 기준 생산량을 세션의 C/T 로 낸다. */
  readonly runningBySession: ReadonlyMap<bigint, number>;
  /** STOP 의 사유별 정지 시간. 사유 없는 STOP 은 null 키. */
  readonly stoppedByReason: ReadonlyMap<string | null, number>;
}

/**
 * 설비 상세의 시간 — 가동률(`DashboardAvailabilityService.actual`)과 같은 원천이다: 세션 시작~끝(진행 중이면 집계 시각)에서
 * STOP~다음 RESUME 을 뺀다. RESUME 없는 STOP 은 세션 끝까지 멈춘 것으로 본다(`stoppedSpans` 와 같다). 모두 `measured` 로 자른다.
 */
export function sessionTimes(
  sessions: readonly DetailSession[],
  events: readonly DetailEvent[],
  measured: Span,
  asOf: number,
): SessionTimes {
  const runningBySession = new Map<bigint, number>();
  const stoppedByReason = new Map<string | null, number>();
  const sessionSpans: Span[] = [];
  const runningSpans: Span[] = [];
  for (const session of sessions) {
    const span = clip({ start: session.startedAt, end: session.endedAt ?? asOf }, measured);
    if (span === null) continue;
    const stops = reasonSpans(
      events.filter((event) => event.sessionId === session.sessionId),
      session.endedAt ?? asOf,
    ).flatMap((stop) => {
      const cut = clip(stop, span);
      return cut === null ? [] : [{ ...cut, reasonCode: stop.reasonCode }];
    });
    const running = subtract([span], stops);
    sessionSpans.push(span);
    runningSpans.push(...running);
    runningBySession.set(session.sessionId, totalLength(running));
    for (const stop of stops) {
      stoppedByReason.set(stop.reasonCode, (stoppedByReason.get(stop.reasonCode) ?? 0) + (stop.end - stop.start));
    }
  }
  const sessionMs = totalLength(union(sessionSpans));
  const runningMs = Math.min(sessionMs, totalLength(union(runningSpans)));
  return { sessionMs, runningMs, stoppedMs: sessionMs - runningMs, runningBySession, stoppedByReason };
}

function reasonSpans(events: readonly DetailEvent[], sessionEnd: number): (Span & { reasonCode: string | null })[] {
  const spans: (Span & { reasonCode: string | null })[] = [];
  let open: { start: number; reasonCode: string | null } | null = null;
  for (const event of [...events].sort((a, b) => a.occurredAt - b.occurredAt)) {
    if (event.eventTypeCode === 'STOP' && open === null) open = { start: event.occurredAt, reasonCode: event.reasonCode };
    if (event.eventTypeCode === 'RESUME' && open !== null) {
      spans.push({ start: open.start, end: event.occurredAt, reasonCode: open.reasonCode });
      open = null;
    }
  }
  if (open !== null) spans.push({ start: open.start, end: sessionEnd, reasonCode: open.reasonCode });
  return spans;
}
