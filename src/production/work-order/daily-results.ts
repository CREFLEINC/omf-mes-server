import { Prisma } from '@prisma/client';

import { localDate } from '../../planning/production-plan/plan-window';
import { localTimeOf, timeOf } from '../work-session/shift-resolver';

/** 실적 한 행에서 일자별 묶음에 쓰는 칸 — 잎(정정되지 않은 행)만 들어온다. */
export interface DailyResultRow {
  good_qty: Prisma.Decimal;
  defect_qty: Prisma.Decimal;
  hold_qty: Prisma.Decimal;
  scrap_qty: Prisma.Decimal;
  rework_qty: Prisma.Decimal;
  occurred_at: Date;
  corrects_production_result_id: bigint | null;
  shift: ResultShift | null;
}

export interface ResultShift {
  shift_id: bigint;
  shift_name: string;
  end_time: Date;
  crosses_midnight: boolean;
}

/**
 * 조회 화면의 일자 — 자정을 넘는 교대의 새벽 실적은 그 교대가 시작한 날로 묶는다. 교대가 없으면 공장 현지 날짜다.
 * ⛔ 재고 원장 `business_date`(클라이언트가 보내는 값 · server-architecture C-3) 도출이 아니다 — 쓰기 경로에서 날짜를 잡는 데 쓰지 않는다.
 */
export function workDateOf(occurredAt: Date, timezone: string, shift: ResultShift | null): string {
  const date = localDate(occurredAt, timezone);
  if (shift === null || !shift.crosses_midnight) return date;
  // 교대 경계는 반열림(시작 이상 · 끝 미만)이라 끝 시각 정각은 다음 교대 몫이다(`pickShift` 와 같다).
  if (localTimeOf(occurredAt, timezone) >= timeOf(shift.end_time)) return date;
  return previousDay(date);
}

function previousDay(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

interface Tally {
  good: Prisma.Decimal;
  defect: Prisma.Decimal;
  hold: Prisma.Decimal;
  scrap: Prisma.Decimal;
  rework: Prisma.Decimal;
  resultCount: number;
  correctedCount: number;
}

const emptyTally = (): Tally => {
  const zero = new Prisma.Decimal(0);
  return { good: zero, defect: zero, hold: zero, scrap: zero, rework: zero, resultCount: 0, correctedCount: 0 };
};

function add(tally: Tally, row: DailyResultRow): Tally {
  return {
    good: tally.good.plus(row.good_qty),
    defect: tally.defect.plus(row.defect_qty),
    hold: tally.hold.plus(row.hold_qty),
    scrap: tally.scrap.plus(row.scrap_qty),
    rework: tally.rework.plus(row.rework_qty),
    resultCount: tally.resultCount + 1,
    correctedCount: tally.correctedCount + (row.corrects_production_result_id === null ? 0 : 1),
  };
}

function quantities(tally: Tally) {
  return {
    goodQty: tally.good.toNumber(),
    defectQty: tally.defect.toNumber(),
    holdQty: tally.hold.toNumber(),
    scrapQty: tally.scrap.toNumber(),
    reworkQty: tally.rework.toNumber(),
    resultCount: tally.resultCount,
    correctedCount: tally.correctedCount,
  };
}

interface Day {
  tally: Tally;
  firstAt: Date;
  lastAt: Date;
  shifts: Map<string, { shift: ResultShift | null; tally: Tally }>;
}

/** 교대가 정해지지 않은 실적을 모은 줄의 이름 — 화면이 그대로 보인다. */
export const NO_SHIFT_NAME = '교대 없음';

/** 영업일 오름차순, 그 안의 교대는 교대 없음이 맨 뒤이고 나머지는 교대 id 순이다. */
export function dailyResultsOf(rows: readonly DailyResultRow[], timezone: string) {
  const days = new Map<string, Day>();
  let total = emptyTally();
  for (const row of rows) {
    total = add(total, row);
    const key = workDateOf(row.occurred_at, timezone, row.shift);
    const day = days.get(key) ?? { tally: emptyTally(), firstAt: row.occurred_at, lastAt: row.occurred_at, shifts: new Map() };
    day.tally = add(day.tally, row);
    if (row.occurred_at < day.firstAt) day.firstAt = row.occurred_at;
    if (row.occurred_at > day.lastAt) day.lastAt = row.occurred_at;
    const shiftKey = row.shift === null ? '' : String(row.shift.shift_id);
    const bucket = day.shifts.get(shiftKey) ?? { shift: row.shift, tally: emptyTally() };
    bucket.tally = add(bucket.tally, row);
    day.shifts.set(shiftKey, bucket);
    days.set(key, day);
  }
  const items = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workDate, day]) => ({
      workDate,
      ...quantities(day.tally),
      firstAt: day.firstAt.toISOString(),
      lastAt: day.lastAt.toISOString(),
      byShift: [...day.shifts.values()].sort(byShiftOrder).map(({ shift, tally }) => ({
        shiftId: shift === null ? null : Number(shift.shift_id),
        shiftName: shift === null ? NO_SHIFT_NAME : shift.shift_name,
        ...quantities(tally),
      })),
    }));
  return { items, totals: quantities(total) };
}

function byShiftOrder(a: { shift: ResultShift | null }, b: { shift: ResultShift | null }): number {
  if (a.shift === null || b.shift === null) return Number(a.shift === null) - Number(b.shift === null);
  return a.shift.shift_id < b.shift.shift_id ? -1 : a.shift.shift_id > b.shift.shift_id ? 1 : 0;
}
