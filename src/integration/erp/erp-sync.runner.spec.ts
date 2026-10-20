import { InboundTable } from './inbound-cycle';
import {
  ErpSyncRunner,
  LEASE_RETRY_MS,
  Lane,
  REQUEST_POLL_MS,
  RETRY_BASE_MS,
  STARTUP_DELAY_MS,
} from './erp-sync.runner';
import { COMMON_CODE } from './relay-tables';

const INTERVAL_MS = 12 * 3_600_000;
const TABLE_A: InboundTable = {
  source: { ...COMMON_CODE, interfaceCode: 'IF-A', name: 'A' },
  apply: () => Promise.resolve(),
};
const TABLE_B: InboundTable = {
  source: { ...COMMON_CODE, interfaceCode: 'IF-B', name: 'B' },
  apply: () => Promise.resolve(),
};

type Run = (table: InboundTable, afterBatch: () => Promise<void>) => Promise<unknown>;

/** 요청 표(`erp_sync_state`)를 메모리로 — 실행기가 남기는 일을 순서대로 적는다. */
function fakeState(requests: Map<string, Date>, broken = false) {
  const log: string[] = [];
  const write = async (line: string): Promise<void> => {
    if (broken) throw new Error('PG 끊김');
    log.push(line);
  };
  return {
    log,
    requests,
    requested: jest.fn(async () => new Map(requests)),
    started: jest.fn((code: string) => write(`start ${code}`)),
    succeeded: jest.fn((code: string) => write(`ok ${code}`)),
    failed: jest.fn((code: string, message: string) => write(`fail ${code} ${message}`)),
    clearRequest: jest.fn(async (code: string, startedAt: Date) => {
      const at = requests.get(code);
      if (at !== undefined && at <= startedAt) requests.delete(code);
      await write(`clear ${code}`);
    }),
    scheduled: jest.fn((codes: readonly string[], at: Date) => write(`next ${codes.join(',')} +${at.getTime() - START}`)),
  };
}

let START = 0;

function fake(
  seed: { enabled?: boolean; run?: Run; lease?: () => boolean; requests?: Map<string, Date>; brokenState?: boolean } = {},
) {
  const runs: { table: string; at: number }[] = [];
  const events: string[] = [];
  const start = Date.now();
  START = start;
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
  const lane: Lane = { code: 'MASTER', name: '기준정보', tables: [TABLE_A, TABLE_B], intervalMs: INTERVAL_MS };
  const state = fakeState(seed.requests ?? new Map(), seed.brokenState);
  const runner = new ErpSyncRunner(seed.enabled ?? true, [lane], cycle as never, lease, relay, state);
  /** 지금 시각에 「지금 읽기」를 누른다. */
  const press = (code: string): void => void state.requests.set(code, new Date());
  return { runner, runs, events, lease, cycle, state, press };
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

  describe('「지금 읽기」(장부 P-81)', () => {
    it('누른 표만 다음 주기를 기다리지 않고 10초 안에 돌고, 요청을 지운다', async () => {
      const f = fake();
      f.runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
      await jest.advanceTimersByTimeAsync(3_600_000);
      f.press('IF-B');
      await jest.advanceTimersByTimeAsync(REQUEST_POLL_MS);

      expect(f.runs.map((r) => r.table)).toEqual(['A', 'B', 'B']);
      expect(f.runs[2].at).toBeLessThanOrEqual(STARTUP_DELAY_MS + 3_600_000 + REQUEST_POLL_MS);
      expect(f.state.requests.size).toBe(0);
      // 주기는 그대로다 — 12시간 회차는 처음 회차에서 센다.
      await jest.advanceTimersByTimeAsync(INTERVAL_MS - 3_600_000 - REQUEST_POLL_MS);
      expect(f.runs.map((r) => [r.table, r.at])).toEqual([
        ['A', STARTUP_DELAY_MS],
        ['B', STARTUP_DELAY_MS],
        ['B', f.runs[2].at],
        ['A', STARTUP_DELAY_MS + INTERVAL_MS],
        ['B', STARTUP_DELAY_MS + INTERVAL_MS],
      ]);
    });

    it('여럿을 누르면 누른 순서가 아니라 묶음에 적힌 순서로 돈다 — 참조되는 쪽이 앞이다', async () => {
      const f = fake();
      f.runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
      f.press('IF-B');
      await jest.advanceTimersByTimeAsync(1);
      f.press('IF-A');
      await jest.advanceTimersByTimeAsync(REQUEST_POLL_MS);

      expect(f.runs.map((r) => r.table)).toEqual(['A', 'B', 'A', 'B']);
    });

    it('도는 사이에 또 누르면 그 요청은 남아 한 번 더 돈다', async () => {
      let pressed = false;
      const f = fake({
        run: async (table) => {
          if (table.source.name === 'B' && !pressed && f.runs.length > 2) {
            pressed = true;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            f.press('IF-B');
          }
        },
      });
      f.runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
      f.press('IF-B');
      await jest.advanceTimersByTimeAsync(3 * REQUEST_POLL_MS);

      expect(f.runs.map((r) => r.table)).toEqual(['A', 'B', 'B', 'B']);
      expect(f.state.requests.size).toBe(0);
    });

    it('누른 회차가 실패해도 요청은 지우고 실패를 남긴다 — 다시 누르면 다시 돈다', async () => {
      const f = fake({
        run: (table) =>
          table.source.name === 'B' && f.runs.length > 2 ? Promise.reject(new Error('끊김')) : Promise.resolve({}),
      });
      f.runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
      f.press('IF-B');
      await jest.advanceTimersByTimeAsync(3 * REQUEST_POLL_MS);

      expect(f.runs.map((r) => r.table)).toEqual(['A', 'B', 'B']);
      expect(f.state.log).toContain('fail IF-B 끊김');
      expect(f.state.requests.size).toBe(0);
    });

    it('주기 회차는 표마다 시작·결과를 남기고, 묶음이 끝나면 다음 예정 시각을 적는다', async () => {
      const f = fake();
      f.runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

      expect(f.state.log).toEqual([
        'start IF-A',
        'ok IF-A',
        'start IF-B',
        'ok IF-B',
        `next IF-A,IF-B +${STARTUP_DELAY_MS + INTERVAL_MS}`,
      ]);
    });

    it('회차가 실패하면 실패를 남기고, 다음 예정은 재시도 시각이다', async () => {
      const f = fake({ run: () => Promise.reject(new Error('Failed to connect')) });
      f.runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

      expect(f.state.log).toEqual([
        'start IF-A',
        'fail IF-A Failed to connect',
        `next IF-A,IF-B +${STARTUP_DELAY_MS + RETRY_BASE_MS}`,
      ]);
    });

    it('⛔ 상태를 못 남겨도 받기는 이어 간다 — 상태는 곁가지다', async () => {
      const f = fake({ brokenState: true });
      f.runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

      expect(f.runs.map((r) => r.table)).toEqual(['A', 'B']);
    });

    it('꺼져 있으면 요청도 보지 않는다', async () => {
      const f = fake({ enabled: false, requests: new Map([['IF-A', new Date()]]) });
      f.runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS + REQUEST_POLL_MS);

      expect(f.state.requested).not.toHaveBeenCalled();
      expect(f.runs).toEqual([]);
    });

    it('쉬는 동안에는 요청만 보고 리스는 잡지 않는다', async () => {
      const f = fake();
      f.runner.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
      const acquired = f.lease.acquire.mock.calls.length;
      await jest.advanceTimersByTimeAsync(10 * REQUEST_POLL_MS);

      expect(f.lease.acquire.mock.calls.length).toBe(acquired);
      expect(f.state.requested.mock.calls.length).toBeGreaterThanOrEqual(10);
    });
  });
});
