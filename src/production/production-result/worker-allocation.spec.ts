import { Prisma } from '@prisma/client';

import { allocateBySession, allocateLikeOriginal } from './worker-allocation';

type Row = Record<string, unknown>;
const D = (value: number | string) => new Prisma.Decimal(value);
const at = (hhmm: string) => new Date(`2026-09-07T${hhmm}:00.000Z`);

function result(overrides: Row = {}) {
  return {
    production_result_id: 50n,
    work_session_id: 7n,
    occurred_at: at('04:00'),
    good_qty: D(9),
    defect_qty: D(0),
    hold_qty: D(0),
    scrap_qty: D(0),
    rework_qty: D(0),
    ...overrides,
  } as unknown as Prisma.production_resultGetPayload<object>;
}

function txOf(options: { previous?: Date; sameTime?: bigint; participants?: Row[]; original?: Row[]; decimalScale?: number } = {}) {
  const written: Row[] = [];
  const tx = {
    // 실적 단위의 소수 자리 — 0 이면 개수 단위라 정수로 나눈다. 기본은 소수 단위(kg 같은 3자리).
    uom: { findUnique: () => Promise.resolve({ decimal_scale: options.decimalScale ?? 3 }) },
    work_session: { findUniqueOrThrow: () => Promise.resolve({ started_at: at('01:00') }) },
    production_result: {
      // 같은 시각 조회는 `occurred_at` 이 날짜 그대로, 직전 실적 조회는 `{ lt }` 다.
      findFirst: ({ where }: { where: { occurred_at: unknown } }) =>
        Promise.resolve(
          where.occurred_at instanceof Date
            ? (options.sameTime === undefined ? null : { production_result_id: options.sameTime })
            : (options.previous ? { occurred_at: options.previous } : null),
        ),
    },
    work_session_worker: { findMany: () => Promise.resolve(options.participants ?? []) },
    production_result_worker_allocation: {
      findMany: () => Promise.resolve(options.original ?? []),
      createMany: ({ data }: { data: Row[] }) => {
        written.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, written };
}

describe('worker-allocation — 실적의 작업자별 배분 저장', () => {
  const main = { worker_id: 1n, worker_role_code: 'MAIN', joined_at: at('01:00'), left_at: null };
  const sub = { worker_id: 2n, worker_role_code: 'SUB', joined_at: at('03:00'), left_at: null };

  it('세션이 없거나 참여자가 없으면 나누지 않는다', async () => {
    const lone = txOf({ participants: [main] });
    await allocateBySession(lone.tx, result({ work_session_id: null }), 5);
    const empty = txOf();
    await allocateBySession(empty.tx, result(), 5);
    expect([...lone.written, ...empty.written]).toEqual([]);
  });

  it('직전 실적이 있으면 그 뒤 구간만 잰다', async () => {
    // 03:00~04:00 — 두 사람 다 60분이라 반씩.
    const it0 = txOf({ previous: at('03:00'), participants: [sub, main] });
    await allocateBySession(it0.tx, result(), 5);
    expect(it0.written.map((row) => [row.worker_id, row.worker_role_code, row.participated_minutes, (row.good_qty as Prisma.Decimal).toString()])).toEqual([
      [1n, 'MAIN', 60, '4.5'],
      [2n, 'SUB', 60, '4.5'],
    ]);
  });

  it('같은 시각의 실적이 이미 있으면 다시 재지 않고 그 비율을 쓴다', async () => {
    const it0 = txOf({
      sameTime: 49n,
      participants: [main, sub],
      original: [
        { worker_id: 1n, worker_role_code: 'MAIN', participated_minutes: D(60), share_ratio: D('0.5') },
        { worker_id: 2n, worker_role_code: 'SUB', participated_minutes: D(60), share_ratio: D('0.5') },
      ],
    });
    await allocateBySession(it0.tx, result({ good_qty: D(2) }), 5);
    expect(it0.written.map((row) => [row.worker_id, (row.good_qty as Prisma.Decimal).toString()])).toEqual([[1n, '1'], [2n, '1']]);
  });

  it('정정은 원 배분의 비율을 쓰고 끝전을 몫이 가장 큰 주작업자에게 준다', async () => {
    const it0 = txOf({
      original: [
        { worker_id: 2n, worker_role_code: 'SUB', participated_minutes: D(20), share_ratio: D('0.3333333333') },
        { worker_id: 1n, worker_role_code: 'MAIN', participated_minutes: D(40), share_ratio: D('0.6666666667') },
      ],
    });
    await allocateLikeOriginal(it0.tx, result({ good_qty: D(1) }), 40n, 5);
    expect(it0.written.map((row) => [row.worker_id, (row.good_qty as Prisma.Decimal).toString()])).toEqual([
      [1n, '0.666667'],
      [2n, '0.333333'],
    ]);
  });

  it('개수 단위(소수 자리 0) 실적은 정수로 나눈다 — 정정 재사용도 같다', async () => {
    const it0 = txOf({
      decimalScale: 0,
      original: [
        { worker_id: 1n, worker_role_code: 'MAIN', participated_minutes: D(40), share_ratio: D('0.6666666667') },
        { worker_id: 2n, worker_role_code: 'SUB', participated_minutes: D(20), share_ratio: D('0.3333333333') },
      ],
    });
    await allocateLikeOriginal(it0.tx, result({ good_qty: D(10) }), 40n, 5);
    expect(it0.written.map((row) => [row.worker_id, (row.good_qty as Prisma.Decimal).toString()])).toEqual([
      [1n, '7'],
      [2n, '3'],
    ]);
  });
});
