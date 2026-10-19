/** 시간 구간 [start, end) — epoch ms. 가동률의 분모·분자를 «합집합 길이»로 센다. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export function clip(span: Span, range: Span): Span | null {
  const start = Math.max(span.start, range.start);
  const end = Math.min(span.end, range.end);
  return start < end ? { start, end } : null;
}

export function union(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((span) => span.start < span.end).sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else merged.push(span);
  }
  return merged;
}

export function subtract(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  const blades = union(cuts);
  const result: Span[] = [];
  for (const span of union(spans)) {
    let start = span.start;
    for (const cut of blades) {
      if (cut.end <= start || cut.start >= span.end) continue;
      if (cut.start > start) result.push({ start, end: cut.start });
      start = Math.max(start, cut.end);
    }
    if (start < span.end) result.push({ start, end: span.end });
  }
  return result;
}

export function totalLength(spans: readonly Span[]): number {
  return union(spans).reduce((sum, span) => sum + (span.end - span.start), 0);
}

export interface SessionEventPoint {
  readonly eventTypeCode: string;
  readonly occurredAt: number;
}

/**
 * STOP 에서 다음 RESUME 까지가 중단 구간이다. RESUME 없이 끝난 STOP 은 세션 끝까지 멈춘 것으로 본다
 * (STOP 뒤 곧바로 END 가 올 수 있다 — `work_session_event` 상태기계).
 */
export function stoppedSpans(events: readonly SessionEventPoint[], sessionEnd: number): Span[] {
  const spans: Span[] = [];
  let stoppedAt: number | null = null;
  for (const event of [...events].sort((a, b) => a.occurredAt - b.occurredAt)) {
    if (event.eventTypeCode === 'STOP' && stoppedAt === null) stoppedAt = event.occurredAt;
    if (event.eventTypeCode === 'RESUME' && stoppedAt !== null) {
      spans.push({ start: stoppedAt, end: event.occurredAt });
      stoppedAt = null;
    }
  }
  if (stoppedAt !== null) spans.push({ start: stoppedAt, end: sessionEnd });
  return spans;
}
