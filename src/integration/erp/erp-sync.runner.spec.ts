import { InboundTable } from './inbound-cycle';
import {
  ErpSyncRunner,
  LEASE_RETRY_MS,
  Lane,
  RETRY_BASE_MS,
  STARTUP_DELAY_MS,
} from './erp-sync.runner';
import { COMMON_CODE } from './relay-tables';

const INTERVAL_MS = 12 * 3_600_000;
const TABLE_A: InboundTable = {
  source: { ...COMMON_CODE, name: 'A' },
  apply: () => Promise.resolve(),
};
const TABLE_B: InboundTable = {
  source: { ...COMMON_CODE, name: 'B' },
  apply: () => Promise.resolve(),
};

type Run = (table: InboundTable, afterBatch: () => Promise<void>) => Promise<unknown>;

function fake(seed: { enabled?: boolean; run?: Run; lease?: () => boolean } = {}) {
  const runs: { table: string; at: number }[] = [];
  const events: string[] = [];
  const start = Date.now();
  const cycle = {
    run: jest.fn(async (table: InboundTable, afterBatch?: () => Promise<void>) => {
      runs.push({ table: table.source.name, at: Date.now() - start });
      return (seed.run ?? (async () => ({})))(table, afterBatch ?? (() => Promise.resolve()));
    }),
  };
  const lease = {
    acquire: jest.fn(async () => (seed.lease ?? (() => true))()),
    release: jest.fn(async () => void events.push('release')),
  };
  const relay = { close: jest.fn(async () => void events.push('close')) };
  const lane: Lane = { name: '기준정보', tables: [TABLE_A, TABLE_B], intervalMs: INTERVAL_MS };
  const runner = new ErpSyncRunner(seed.enabled ?? true, [lane], cycle as never, lease, relay);
  return { runner, runs, events, lease, cycle };
}

describe('ErpSyncRunner', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('꺼져 있으면 회차를 잡지 않고, 끌 때 리스·연결도 건드리지 않는다', async () => {
    const f = fake({ enabled: false });

    f.runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(2 * INTERVAL_MS);
    await f.runner.onApplicationShutdown();

    expect(f.runs).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it('부팅 10초 뒤 표를 적힌 순서로 돌고, 끝나면 주기만큼 뒤에 다시 돈다', async () => {
    const f = fake();

    f.runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
    expect(f.runs).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(f.runs).toEqual([
      { table: 'A', at: STARTUP_DELAY_MS },
      { table: 'B', at: STARTUP_DELAY_MS },
      { table: 'A', at: STARTUP_DELAY_MS + INTERVAL_MS },
      { table: 'B', at: STARTUP_DELAY_MS + INTERVAL_MS },
    ]);
  });

  it('회차가 끝나야 다음 회차를 잡는다', async () => {
    let finish: () => void = () => undefined;
    const f = fake({
      run: (table) =>
        table.source.name === 'A' && f.runs.length === 1
          ? new Promise<void>((resolve) => (finish = resolve))
          : Promise.resolve(),
    });

    f.runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 3 * INTERVAL_MS);
    expect(f.runs).toHaveLength(1);

    finish();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(f.runs.map((r) => r.at)).toEqual([
      STARTUP_DELAY_MS,
      STARTUP_DELAY_MS + 3 * INTERVAL_MS,
      STARTUP_DELAY_MS + 4 * INTERVAL_MS,
      STARTUP_DELAY_MS + 4 * INTERVAL_MS,
    ]);
  });

  it('리스를 남이 쥐고 있으면 회차를 건너뛰고 1분 뒤 다시 본다', async () => {
    let free = false;
    const f = fake({ lease: () => free });

    f.runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(f.runs).toEqual([]);
    free = true;
    await jest.advanceTimersByTimeAsync(LEASE_RETRY_MS);

    expect(f.runs.map((r) => r.at)).toEqual([
      STARTUP_DELAY_MS + LEASE_RETRY_MS,
      STARTUP_DELAY_MS + LEASE_RETRY_MS,
    ]);
  });

  it('중계 DB 에 못 닿으면 1분부터 배로 늘려 다시 시도한다', async () => {
    const f = fake({
      run: () => Promise.reject(new Error('Failed to connect to 192.168.1.2:1433')),
    });

    f.runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 7 * RETRY_BASE_MS);

    expect(f.runs.map((r) => r.at - STARTUP_DELAY_MS)).toEqual([
      0,
      RETRY_BASE_MS,
      3 * RETRY_BASE_MS,
      7 * RETRY_BASE_MS,
    ]);
  });

  it('종료 신호를 받으면 다음 묶음 경계에서 멈추고 리스를 놓은 뒤 연결을 닫는다', async () => {
    let batches = 0;
    const f = fake({
      run: async (_, afterBatch) => {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          batches += 1;
          await afterBatch();
        }
      },
    });
    f.runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 2_500);

    const shutdown = f.runner.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(1_000);
    await shutdown;
    await jest.advanceTimersByTimeAsync(2 * INTERVAL_MS);

    expect(batches).toBe(3);
    expect(f.runs.map((r) => r.table)).toEqual(['A']);
    expect(f.events).toEqual(['release', 'close']);
  });

  it('묶음 사이에 리스를 잃으면 남은 표를 돌지 않고 1분 뒤 다시 본다', async () => {
    let acquired = 0;
    const f = fake({
      lease: () => (acquired += 1) !== 2,
      run: async (_, afterBatch) => afterBatch(),
    });

    f.runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(f.runs.map((r) => r.table)).toEqual(['A']);
    await jest.advanceTimersByTimeAsync(LEASE_RETRY_MS);

    expect(f.runs.map((r) => [r.table, r.at - STARTUP_DELAY_MS])).toEqual([
      ['A', 0],
      ['A', LEASE_RETRY_MS],
      ['B', LEASE_RETRY_MS],
    ]);
  });
});
