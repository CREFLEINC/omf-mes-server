import { Prisma } from '@prisma/client';

import { ShiftWindow, localTimeOf, pickShift, resolveShiftId, timeOf } from './shift-resolver';

/** `@db.Time(6)` 이 오는 모양 그대로 — 1970-01-01 UTC 의 `Date`. */
const time = (hhmmss: string): Date => new Date(`1970-01-01T${hhmmss}.000Z`);

const shift = (
  shiftId: number,
  start: string,
  end: string,
  crossesMidnight = false,
): ShiftWindow => ({
  shift_id: BigInt(shiftId),
  start_time: time(start),
  end_time: time(end),
  crosses_midnight: crossesMidnight,
});

/** 주간 06:00~14:00 · 오후 14:00~22:00 · 야간 22:00~06:00(자정 건넘). */
const DAY = shift(1, '06:00:00', '14:00:00');
const SWING = shift(2, '14:00:00', '22:00:00');
const NIGHT = shift(3, '22:00:00', '06:00:00', true);

describe('shift-resolver', () => {
  it('crosses_midnight 가 false 면 start 이상 end 미만이다', () => {
    expect(pickShift([DAY, SWING, NIGHT], '06:00:01')).toBe(1n);
    expect(pickShift([DAY, SWING, NIGHT], '13:59:59')).toBe(1n);
    expect(pickShift([DAY, SWING, NIGHT], '14:00:01')).toBe(2n);
  });

  it('crosses_midnight 가 true 면 자정을 건너 판정한다', () => {
    expect(pickShift([DAY, SWING, NIGHT], '23:30:00')).toBe(3n);
    expect(pickShift([DAY, SWING, NIGHT], '00:00:00')).toBe(3n);
    expect(pickShift([DAY, SWING, NIGHT], '05:59:59')).toBe(3n);
  });

  it('start_time 정각은 든다', () => {
    expect(pickShift([DAY], '06:00:00')).toBe(1n);
    expect(pickShift([NIGHT], '22:00:00')).toBe(3n);
  });

  it('end_time 정각은 안 든다', () => {
    expect(pickShift([DAY], '14:00:00')).toBeNull();
    expect(pickShift([NIGHT], '06:00:00')).toBeNull();
  });

  it('어느 교대에도 안 들면 null 을 낸다', () => {
    expect(pickShift([DAY], '05:00:00')).toBeNull();
    expect(pickShift([], '10:00:00')).toBeNull();
  });

  it('교대가 겹치면 start_time 이 앞선 것을 쓴다', () => {
    const early = shift(10, '06:00:00', '15:00:00');
    const late = shift(11, '14:00:00', '22:00:00');

    expect(pickShift([late, early], '14:30:00')).toBe(10n);
  });

  it('Time 칸은 UTC 로 읽는다', () => {
    // 서버 TZ 와 무관해야 한다 — `getHours()` 였다면 로컬로 밀린다.
    expect(timeOf(new Date('1970-01-01T08:00:00.000Z'))).toBe('08:00:00');
    expect(timeOf(new Date('1970-01-01T22:30:15.000Z'))).toBe('22:30:15');
  });

  it('공장 로컬 시각으로 판정한다 — UTC 로 보면 갈리는 시각을 검증한다', async () => {
    // UTC 23:30 은 하노이(UTC+7) 로컬 06:30 이라 야간이 아니라 주간이다.
    const startedAt = new Date('2026-09-07T23:30:00.000Z');

    expect(localTimeOf(startedAt, 'Asia/Ho_Chi_Minh')).toBe('06:30:00');
    expect(pickShift([DAY, SWING, NIGHT], localTimeOf(startedAt, 'Asia/Ho_Chi_Minh'))).toBe(1n);

    const tx = {
      plant: { findUnique: jest.fn().mockResolvedValue({ timezone_code: 'Asia/Ho_Chi_Minh' }) },
      shift: { findMany: jest.fn().mockResolvedValue([DAY, SWING, NIGHT]) },
    } as unknown as Prisma.TransactionClient;

    await expect(resolveShiftId(tx, 7n, startedAt)).resolves.toBe(1n);
  });

  it('공장이 없거나 활성 교대가 0행이면 null 이다 — 세션을 막지 않는다', async () => {
    const noPlant = {
      plant: { findUnique: jest.fn().mockResolvedValue(null) },
      shift: { findMany: jest.fn() },
    } as unknown as Prisma.TransactionClient;
    await expect(resolveShiftId(noPlant, 7n, new Date())).resolves.toBeNull();

    const noShift = {
      plant: { findUnique: jest.fn().mockResolvedValue({ timezone_code: 'Asia/Ho_Chi_Minh' }) },
      shift: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as Prisma.TransactionClient;
    await expect(resolveShiftId(noShift, 7n, new Date())).resolves.toBeNull();
  });
});
