import { Prisma } from '@prisma/client';
import { cycleTimeCapacity, cycleTimeEstimate, cycleTimeWindow } from './standard-cycle-time';
import { shiftWindow, workingSeconds } from './plan-window';

describe('standard cycle time in production planning', () => {
  const night = shiftWindow('2026-11-25', { startTime: '22:00:00', endTime: '06:00:00' }, 'Asia/Seoul');

  it('uses precise decimal quantity and a cycle-time duration across midnight', () => {
    const estimate = cycleTimeEstimate(new Prisma.Decimal('120.5'), new Prisma.Decimal('120'));
    expect(estimate.expectedDurationSec).toBe(14460);
    expect(cycleTimeWindow(night, estimate.expectedDurationSec)).toEqual({
      plannedStartAt: new Date('2026-11-25T13:00:00.000Z'),
      plannedEndAt: new Date('2026-11-25T17:01:00.000Z'),
    });
  });

  it('retains the full available window for unset or zero C/T', () => {
    for (const value of [null, new Prisma.Decimal(0)]) {
      const estimate = cycleTimeEstimate(100, value);
      expect(estimate).toMatchObject({ expectedDurationSec: null, cycleTimeSource: 'UNSET' });
      expect(cycleTimeWindow(night, estimate.expectedDurationSec)).toBe(night);
    }
  });

  it('counts overlapping shifts once, including overnight carryover', () => {
    expect(workingSeconds('2026-11-25', 'Asia/Seoul', [
      { startTime: '07:00:00', endTime: '08:00:00' },
      { startTime: '23:00:00', endTime: '10:00:00' },
    ])).toBe(11 * 3600);
    expect(workingSeconds('2026-11-25', 'Asia/Seoul', [])).toBe(24 * 3600);
  });

  it('rounds the maximum quantity down at the quantity unit precision', () => {
    expect(cycleTimeCapacity(61, 12, 0)).toBe(5);
    expect(cycleTimeCapacity(61, 12, 2)).toBe(5.08);
    expect(cycleTimeCapacity(60, 12, 0)).toBe(5);
  });
});
