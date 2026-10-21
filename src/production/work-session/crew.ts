import { Prisma } from '@prisma/client';

/**
 * 세션 참여자(공동 작업자) 규칙 — 시작한 사람이 주작업자 1명, 나머지는 부작업자다. 공수와 실적 배분이 이 규칙을 쓴다.
 * 역할 값은 공통코드 `WORK_SESSION_WORKER_ROLE` 의 둘이다.
 */
export const WORKER_ROLE = { MAIN: 'MAIN', SUB: 'SUB' } as const;

/** 한 세션에 동시에 참여할 수 있는 사람 수(주작업자 포함) — 설비 한 대 곁에 서는 인원의 현장 상한. */
export const MAX_OPEN_WORKERS = 4;

const MINUTE_MS = 60_000;

/** `[joinedAt, leftAt)` 와 `[from, to)` 가 겹치는 ms. `leftAt` 이 없으면 아직 참여 중이다. */
export function overlapMs(joinedAt: Date, leftAt: Date | null, from: Date, to: Date): number {
  const start = Math.max(joinedAt.getTime(), from.getTime());
  const end = Math.min(leftAt?.getTime() ?? Number.POSITIVE_INFINITY, to.getTime());
  return Math.max(0, end - start);
}

/** 참여 한 구간의 분 — 떠나지 않았으면 세션 종료까지, 세션도 열려 있으면 지금까지. 소수 둘째 자리. */
export function participatedMinutes(joinedAt: Date, leftAt: Date | null, sessionEndedAt: Date | null, now: Date): number {
  const end = leftAt ?? sessionEndedAt ?? now;
  return toMinutes(Math.max(0, end.getTime() - joinedAt.getTime()));
}

export interface Participation {
  workerId: bigint;
  roleCode: string;
  joinedAt: Date;
  leftAt: Date | null;
}

export interface WorkerShare {
  workerId: bigint;
  roleCode: string;
  participatedMinutes: number;
  ratio: Prisma.Decimal;
}

/**
 * 실적 구간 `[from, to)` 의 작업자별 몫 — 참여 시간 비율이다. 같은 사람이 나갔다 다시 들어온 구간은 합친다.
 * 참여 시간이 모두 0 이면 주작업자가 전부다(주작업자가 없으면 먼저 들어온 사람). 주작업자를 맨 앞에 둔다.
 */
export function workerShares(rows: readonly Participation[], from: Date, to: Date): WorkerShare[] {
  const byWorker = new Map<bigint, { roleCode: string; ms: number; firstJoined: number }>();
  for (const row of rows) {
    const found = byWorker.get(row.workerId);
    const ms = overlapMs(row.joinedAt, row.leftAt, from, to);
    if (found === undefined) {
      byWorker.set(row.workerId, { roleCode: row.roleCode, ms, firstJoined: row.joinedAt.getTime() });
      continue;
    }
    found.ms += ms;
    found.firstJoined = Math.min(found.firstJoined, row.joinedAt.getTime());
    if (row.roleCode === WORKER_ROLE.MAIN) found.roleCode = WORKER_ROLE.MAIN;
  }
  const ordered = [...byWorker.entries()]
    .map(([workerId, value]) => ({ workerId, ...value }))
    .sort((a, b) => Number(b.roleCode === WORKER_ROLE.MAIN) - Number(a.roleCode === WORKER_ROLE.MAIN) || a.firstJoined - b.firstJoined);
  const total = ordered.reduce((sum, item) => sum + item.ms, 0);
  return ordered.map((item, index) => ({
    workerId: item.workerId,
    roleCode: item.roleCode,
    participatedMinutes: toMinutes(item.ms),
    ratio:
      total === 0
        ? new Prisma.Decimal(index === 0 ? 1 : 0)
        : new Prisma.Decimal(item.ms).dividedBy(total).toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP),
  }));
}

/**
 * 수량을 몫대로 나눈다 — 각자 소수 여섯째 자리 반올림, 나머지 끝전은 맨 앞(주작업자)에게 얹어 합이 원래 수량과 같다.
 * `shares` 는 `workerShares` 순서(주작업자 먼저)여야 한다.
 */
export function splitQuantities<K extends string>(
  quantities: Readonly<Record<K, Prisma.Decimal>>,
  shares: readonly Pick<WorkerShare, 'ratio'>[],
): Record<K, Prisma.Decimal>[] {
  const result = shares.map(() => ({}) as Record<K, Prisma.Decimal>);
  for (const key of Object.keys(quantities) as K[]) {
    const total = quantities[key];
    let assigned = new Prisma.Decimal(0);
    shares.forEach((share, index) => {
      const part = total.times(share.ratio).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
      result[index][key] = part;
      assigned = assigned.plus(part);
    });
    if (shares.length > 0) result[0][key] = result[0][key].plus(total.minus(assigned));
  }
  return result;
}

const toMinutes = (ms: number): number => Math.round((ms / MINUTE_MS) * 100) / 100;
