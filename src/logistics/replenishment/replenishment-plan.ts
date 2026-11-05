import { Prisma } from '@prisma/client';

/**
 * 자동 보충의 판단(피처 004 · research R-10 · FR-030~035) — 순수 함수. 러너가 잔액·예정·진행 중 보충을 읽어 넘긴다.
 */

export type RunLineResult = 'CREATED' | 'SHORTAGE' | 'IN_PROGRESS' | 'NO_SOURCE_STOCK' | 'SOURCE_INACTIVE';

export interface ManagedItemState {
  itemId: bigint;
  reorderPointQty: Prisma.Decimal;
  targetQty: Prisma.Decimal;
  /** 쓸 수 있는 양 = 가용 − 출고 예정(음수일 수 있다). */
  usableQty: Prisma.Decimal;
  /** 같은 생산 창고·품목의 진행 중 창고 보충 요청 수. */
  inProgressRequestCount: number;
  sourceActive: boolean;
}

export type ItemDecision =
  /** 보충 시점 이상 — 실행 기록에 행을 남기지 않는다(머리의 검토 수로만 센다). */
  | { kind: 'ABOVE' }
  | { kind: 'SKIP'; result: 'IN_PROGRESS' | 'SOURCE_INACTIVE' }
  /** 유지량까지 — 쓸 수 있는 양이 음수면 유지량보다 많이 요청한다. */
  | { kind: 'REQUEST'; qty: Prisma.Decimal };

/** 쓸 수 있는 양이 보충 시점 «미만»일 때만 보충한다(정확히 같으면 하지 않는다 — US5-3). */
export function decide(item: ManagedItemState): ItemDecision {
  if (item.usableQty.gte(item.reorderPointQty)) return { kind: 'ABOVE' };
  if (item.inProgressRequestCount > 0) return { kind: 'SKIP', result: 'IN_PROGRESS' };
  if (!item.sourceActive) return { kind: 'SKIP', result: 'SOURCE_INACTIVE' };
  return { kind: 'REQUEST', qty: item.targetQty.minus(item.usableQty) };
}

/** 만든 줄의 결과 — 쓸 수 있는 양이 모자라 줄였으면 부족, 0 이라 못 만들었으면 재고 없음. */
export function createdResult(requested: Prisma.Decimal, shortage: Prisma.Decimal): RunLineResult {
  if (requested.lte(0)) return 'NO_SOURCE_STOCK';
  return shortage.gt(0) ? 'SHORTAGE' : 'CREATED';
}

/** 공장 현지 벽시계 `HH:MM`. */
export function localClock(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
}

/** 실행 대상 — 오늘 기록이 없고 현지 시각이 실행 시각 이후(같은 분 포함). `HH:MM` 은 글자 비교가 곧 시각 비교다. */
export function isDue(clock: string, runTime: string, ranToday: boolean): boolean {
  return !ranToday && clock >= runTime;
}
