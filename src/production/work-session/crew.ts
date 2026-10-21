/**
 * 세션 참여자(공동 작업자) 규칙 — 시작한 사람이 주작업자 1명, 나머지는 부작업자다.
 * 역할 값은 공통코드 `WORK_SESSION_WORKER_ROLE` 의 둘이다.
 */
export const WORKER_ROLE = { MAIN: 'MAIN', SUB: 'SUB' } as const;

/**
 * 세션에 들 수 있는 사람 — 재직자. 재직 판정의 정본은 `is_active` 다(`status_code` 로 판정하지 않는다 — 계약의 사용자 결정 2026-09-02).
 * 재직이 아닌 사람이 참여하면 공수·실적 배분을 받는다.
 */
export const EMPLOYED_WORKER = { is_active: true } as const;
export const NOT_EMPLOYED_MESSAGE = '재직 중인 작업자가 아닙니다.';

/** 한 세션에 동시에 참여할 수 있는 사람 수(주작업자 포함) — 설비 한 대 곁에 서는 인원의 현장 상한. */
export const MAX_OPEN_WORKERS = 4;

const MINUTE_MS = 60_000;

/** 참여 한 구간의 분 — 떠나지 않았으면 세션 종료까지, 세션도 열려 있으면 지금까지. 소수 둘째 자리. */
export function participatedMinutes(joinedAt: Date, leftAt: Date | null, sessionEndedAt: Date | null, now: Date): number {
  const end = leftAt ?? sessionEndedAt ?? now;
  return toMinutes(Math.max(0, end.getTime() - joinedAt.getTime()));
}

const toMinutes = (ms: number): number => Math.round((ms / MINUTE_MS) * 100) / 100;
