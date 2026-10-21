import { Prisma } from '@prisma/client';

/**
 * 세션 참여자(공동 작업자) 규칙 — 시작한 사람이 주작업자 1명, 나머지는 부작업자다. 공수와 실적 배분이 이 규칙을 쓴다.
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
 * 몫이 0 인 사람은 빼고 낸다 — 그 구간에 일하지 않은 사람에게 배분 행을 남기지 않는다.
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
  const shares = ordered.map((item, index) => ({
    workerId: item.workerId,
    roleCode: item.roleCode,
    participatedMinutes: toMinutes(item.ms),
    ratio:
      total === 0
        ? new Prisma.Decimal(index === 0 ? 1 : 0)
        : new Prisma.Decimal(item.ms).dividedBy(total).toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP),
  }));
  return shares.filter((share) => share.ratio.gt(0));
}

/**
 * 수량을 몫대로 나눈다 — 합은 늘 원래 수량과 같다. `shares` 는 `workerShares` 순서(주작업자 먼저)여야 한다.
 * - 소수 단위: 각자 소수 여섯째 자리 반올림, 끝전은 몫이 가장 큰 사람(동률이면 앞 사람 — 주작업자)에게.
 *   ⛔ 몫이 작은 사람에게 주면 반올림이 넘친 만큼 음수가 되어 수량 도메인(`qty_t`)이 거부한다.
 * - 개수 단위(`integer`): 각자 내림하고, 남은 개수를 소수 부분이 큰 사람부터 하나씩 준다(동률이면 몫이 큰 사람, 그다음 앞 사람).
 *   수량 자체에 소수가 있으면 그 소수는 몫이 가장 큰 사람에게 간다.
 */
export function splitQuantities<K extends string>(
  quantities: Readonly<Record<K, Prisma.Decimal>>,
  shares: readonly Pick<WorkerShare, 'ratio'>[],
  integer = false,
): Record<K, Prisma.Decimal>[] {
  const result = shares.map(() => ({}) as Record<K, Prisma.Decimal>);
  if (shares.length === 0) return result;
  const anchor = shares.reduce((best, share, index) => (share.ratio.gt(shares[best].ratio) ? index : best), 0);
  for (const key of Object.keys(quantities) as K[]) {
    const total = quantities[key];
    const raw = shares.map((share) => total.times(share.ratio));
    const parts = raw.map((value) => (integer ? value.floor() : value.toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)));
    let left = total.minus(parts.reduce((sum, part) => sum.plus(part), new Prisma.Decimal(0)));
    if (integer) {
      const order = shares
        .map((share, index) => ({ index, fraction: raw[index].minus(parts[index]), ratio: share.ratio }))
        .sort((a, b) => b.fraction.comparedTo(a.fraction) || b.ratio.comparedTo(a.ratio) || a.index - b.index);
      for (const { index } of order) {
        if (left.lt(1)) break;
        parts[index] = parts[index].plus(1);
        left = left.minus(1);
      }
    }
    parts[anchor] = parts[anchor].plus(left);
    parts.forEach((part, index) => {
      result[index][key] = part;
    });
  }
  return result;
}

const toMinutes = (ms: number): number => Math.round((ms / MINUTE_MS) * 100) / 100;
