import { PrismaService } from '../../prisma/prisma.service';
import {
  MaterialIssueReleaseRunner,
  STARTUP_DELAY_MS,
  TICK_MS,
  holdZaloUntil,
} from './material-issue-release.runner';

const HANOI = 'Asia/Ho_Chi_Minh';
const SEOUL = 'Asia/Seoul';

/** 공장 표·대기 요청 질의·트랜잭션·실패 기록을 메모리로. `due` 는 공장마다 고를 요청 id. */
function fake(
  seed: { enabled?: boolean; lease?: () => boolean; plants?: [bigint, string][]; due?: Record<string, bigint[]>; fail?: bigint[]; onRelease?: () => void; locked?: bigint[] } = {},
) {
  const asked: { plantId: bigint; today: string }[] = [];
  const recorded: { id: bigint; message: string }[] = [];
  const released: bigint[] = [];
  const prisma = {
    plant: { findMany: jest.fn(async (_args?: { where: { is_active: boolean } }) => (seed.plants ?? []).map(([plant_id, timezone_code]) => ({ plant_id, timezone_code }))) },
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, plantId: bigint, today: string, _retry: Date, tried: bigint[]) => {
      asked.push({ plantId, today });
      return (seed.due?.[String(plantId)] ?? []).filter((id) => !released.includes(id) && !tried.includes(id)).map((id) => ({ id }));
    }),
    $transaction: jest.fn(async (work: (tx: unknown) => Promise<boolean>) =>
      work({ $queryRaw: async (_s: TemplateStringsArray, id: bigint) => (seed.locked?.includes(id) ? [] : [{ id }]) }),
    ),
    material_issue_request: {
      updateMany: jest.fn(async ({ where, data }: { where: { material_issue_request_id: bigint }; data: { release_error_text: string } }) => {
        recorded.push({ id: where.material_issue_request_id, message: data.release_error_text });
        return { count: 1 };
      }),
    },
  } as unknown as PrismaService;
  const lease = { acquire: jest.fn(async () => (seed.lease ?? (() => true))()), release: jest.fn(async () => undefined) };
  const releaser = {
    release: jest.fn(async (_tx: unknown, id: bigint) => {
      seed.onRelease?.();
      if (seed.fail?.includes(id)) throw new Error('출발 창고가 사용 중지되어 배포할 수 없습니다.');
      released.push(id);
      return true;
    }),
  };
  const numbering = { next: jest.fn(async () => 'PK-20261113-0001') };
  const runner = new MaterialIssueReleaseRunner(seed.enabled ?? true, prisma, lease, releaser, numbering);
  return { runner, asked, recorded, released, lease, releaser, numbering, prisma };
}

describe('00:00 출고 요청 배포 러너', () => {
  afterEach(() => jest.useRealTimers());

  it('SC-001 주기는 60초, 부팅 뒤 10초에 첫 회차', () => {
    expect(TICK_MS).toBe(60_000);
    expect(STARTUP_DELAY_MS).toBe(10_000);
  });

  it('꺼져 있으면 회차를 걸지 않는다', async () => {
    jest.useFakeTimers();
    const { runner, lease } = fake({ enabled: false });
    runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS + TICK_MS * 3);
    expect(lease.acquire).not.toHaveBeenCalled();
    await runner.onApplicationShutdown();
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('켜져 있으면 10초 뒤 첫 회차, 그 뒤 60초마다 · 종료 때 리스를 놓는다', async () => {
    jest.useFakeTimers();
    const { runner, lease } = fake({ plants: [] });
    runner.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(TICK_MS);
    expect(lease.acquire).toHaveBeenCalledTimes(2);
    await runner.onApplicationShutdown();
    expect(lease.release).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(lease.acquire).toHaveBeenCalledTimes(2);
  });

  it('리스를 못 잡으면 아무것도 읽지 않는다', async () => {
    const { runner, prisma } = fake({ lease: () => false, plants: [[1n, HANOI]] });
    expect(await runner.tick(new Date())).toBe(0);
    expect((prisma.plant.findMany as jest.Mock)).not.toHaveBeenCalled();
  });

  it('US3-2 공장 현지 날짜는 공장 시간대로 — 23:59:59 와 00:00:00 경계, 시간대 둘', async () => {
    // 2026-11-12 16:59:59Z = 하노이 23:59:59(12일) · 서울 01:59:59(13일)
    const before = fake({ plants: [[1n, HANOI], [2n, SEOUL]] });
    await before.runner.tick(new Date('2026-11-12T16:59:59Z'));
    expect(before.asked).toEqual([
      { plantId: 1n, today: '2026-11-12' },
      { plantId: 2n, today: '2026-11-13' },
    ]);
    const after = fake({ plants: [[1n, HANOI]] });
    await after.runner.tick(new Date('2026-11-12T17:00:00Z'));
    expect(after.asked).toEqual([{ plantId: 1n, today: '2026-11-13' }]);
  });

  it('FR-022 한 건이 실패해도 나머지는 배포하고, 실패는 원인과 함께 따로 남긴다', async () => {
    const { runner, released, recorded } = fake({ plants: [[1n, HANOI]], due: { '1': [11n, 12n, 13n] }, fail: [12n] });
    expect(await runner.tick(new Date('2026-11-12T17:00:30Z'))).toBe(2);
    expect(released).toEqual([11n, 13n]);
    expect(recorded).toEqual([{ id: 12n, message: '출발 창고가 사용 중지되어 배포할 수 없습니다.' }]);
  });

  it('30초마다 리스를 늘리고, 회차 중에 잃으면 그 회차를 접는다', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const { runner, released, lease } = fake({
      lease: () => ++calls <= 2,
      plants: [[1n, HANOI]],
      due: { '1': [11n, 12n, 13n] },
      // 배포 한 건이 31초 걸린다 — 다음 건 전에 리스를 늘려야 한다.
      onRelease: () => jest.setSystemTime(Date.now() + 31_000),
    });
    await runner.tick(new Date('2026-11-12T17:00:30Z'));
    expect(released).toEqual([11n, 12n]);
    expect(lease.acquire).toHaveBeenCalledTimes(3);
  });

  it('리스 연장은 건마다가 아니다 — 빠른 묶음은 회차 첫 획득 한 번', async () => {
    const { runner, released, lease } = fake({ plants: [[1n, HANOI]], due: { '1': [11n, 12n, 13n] } });
    await runner.tick(new Date('2026-11-12T17:00:30Z'));
    expect(released).toEqual([11n, 12n, 13n]);
    expect(lease.acquire).toHaveBeenCalledTimes(1);
  });

  it('실패를 기록하지 못해도 같은 요청을 다시 고르지 않고 다음 요청으로 간다', async () => {
    const { runner, released, prisma } = fake({ plants: [[1n, HANOI]], due: { '1': [11n, 12n] }, fail: [11n] });
    (prisma.material_issue_request.updateMany as jest.Mock).mockRejectedValue(new Error('PG 끊김'));
    expect(await runner.tick(new Date('2026-11-12T17:00:30Z'))).toBe(1);
    expect(released).toEqual([12n]);
  });

  it('US3-6 현장 07:00 전 배포는 그날 07:00 까지 Zalo 를 미루고, 07:00 이후면 바로', () => {
    expect(holdZaloUntil(new Date('2026-11-12T17:00:30Z'))?.toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(holdZaloUntil(new Date('2026-11-13T00:00:01Z'))).toBeUndefined();
    expect(holdZaloUntil(new Date('2026-11-13T16:59:00Z'))).toBeUndefined();
  });

  it('남이 쥔 요청은 기다리지 않고 건너뛴다(SKIP LOCKED) · 활성 공장만 돈다', async () => {
    const { runner, released, releaser, prisma } = fake({ plants: [[1n, HANOI]], due: { '1': [11n, 12n] }, locked: [11n] });
    expect(await runner.tick(new Date('2026-11-12T17:00:30Z'))).toBe(1);
    expect(released).toEqual([12n]);
    expect(releaser.release).toHaveBeenCalledTimes(1);
    expect((prisma.plant.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({ where: { is_active: true } });
  });
});
