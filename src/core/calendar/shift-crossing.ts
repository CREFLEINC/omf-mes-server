/**
 * 교대가 자정을 넘는가 — 종료가 시작보다 이르거나 같으면 넘는다(같으면 24시간 교대).
 * ⛔ `shift.crosses_midnight` 플래그를 믿지 않는다 — DB 가 시각과의 일치를 강제하지 않아, 어긋난 행에서 창이 거꾸로 서거나
 * 24시간을 넘는다. 계획 창(`plan-window.ts`)·교대 판정(`shift-resolver.ts`)·ERP 생산 실적 근무조(`production-receipt.send.ts`)가
 * 이 한 판정을 쓴다.
 */
export function crossesMidnight(startTime: string, endTime: string): boolean {
  return endTime <= startTime;
}

/** `@db.Time(6)` 은 Prisma 가 1970-01-01 UTC 의 `Date` 로 준다 — `HH:MM:SS` 만 떼어 낸다. */
export function shiftTimeOf(column: Date): string {
  return column.toISOString().slice(11, 19);
}
