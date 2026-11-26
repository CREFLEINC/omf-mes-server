import { Prisma } from '@prisma/client';
import type { PlanWindow } from './plan-window';

export function standardCycleTimeSeconds(value: Prisma.Decimal | null | undefined): number | null {
  return value?.isFinite() && value.gt(0) ? value.toNumber() : null;
}

export function cycleTimeEstimate(
  quantity: Prisma.Decimal | number,
  cycleTime: Prisma.Decimal | null | undefined,
) {
  const standardCycleTimeSec = standardCycleTimeSeconds(cycleTime);
  return {
    standardCycleTimeSec,
    expectedDurationSec: standardCycleTimeSec === null
      ? null
      : new Prisma.Decimal(quantity).mul(standardCycleTimeSec).toNumber(),
    cycleTimeSource: standardCycleTimeSec === null ? 'UNSET' as const : 'ROUTING_OPERATION' as const,
  };
}

export function cycleTimeWindow(available: PlanWindow, expectedDurationSec: number | null): PlanWindow {
  if (expectedDurationSec === null || expectedDurationSec <= 0) return available;
  const end = available.plannedStartAt.getTime() + Math.ceil(expectedDurationSec * 1000);
  return { plannedStartAt: available.plannedStartAt, plannedEndAt: new Date(end) };
}

export function cycleTimeCapacity(availableSeconds: number, cycleTimeSeconds: number, decimalScale: number): number {
  return new Prisma.Decimal(availableSeconds)
    .div(cycleTimeSeconds)
    .toDecimalPlaces(decimalScale, Prisma.Decimal.ROUND_DOWN)
    .toNumber();
}
