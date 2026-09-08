import { maintenanceDateRange } from "../maintenance-calendar";
import { SummaryInterval, summarizeIntervals } from "./downtime-summary-rules";

const DAY_MS = 86_400_000;
const MINUTE_US = 60_000_000n;

export type SummaryBucketSize = "DAY" | "WEEK" | "MONTH";
export interface SummaryPeriodPlant {
  readonly plantId: string;
  readonly timezone: string;
}
export interface SummaryPeriodBucket {
  readonly plantId: string;
  readonly periodStart: string;
  readonly startedAtUs: bigint;
  readonly endedAtUs: bigint;
}
export interface SummaryPeriodInterval extends SummaryInterval {
  readonly plantId: string;
}
export interface SummaryPeriodGroup {
  readonly periodStart: string;
  readonly count: number;
  readonly totalMinutes: number;
}

function calendarDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`Invalid downtime summary date: ${value}`);
  const date = new Date(0);
  date.setUTCFullYear(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
  );
  date.setUTCHours(0, 0, 0, 0);
  if (
    !Number.isFinite(date.getTime()) ||
    calendarDate(date.getTime()) !== value
  )
    throw new Error(`Invalid downtime summary date: ${value}`);
  return date.getTime();
}

function calendarDate(day: number): string {
  const date = new Date(day);
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999)
    throw new Error("Downtime summary date exceeds contract range");
  return `${year.toString().padStart(4, "0")}-${String(
    date.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function periodStart(day: number, size: SummaryBucketSize): string {
  if (size === "DAY") return calendarDate(day);
  if (size === "MONTH") return `${calendarDate(day).slice(0, 7)}-01`;
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
  return monday < calendarDay("0000-01-01")
    ? "0000-01-01"
    : calendarDate(monday);
}

function epochUs(value: Date | undefined): bigint {
  if (!value) throw new Error("Missing downtime summary bucket boundary");
  return BigInt(value.getTime()) * 1000n;
}

function minutes(valueUs: bigint): number {
  const value = Number(valueUs / MINUTE_US);
  if (!Number.isSafeInteger(value))
    throw new Error("Downtime summary minutes exceed safe range");
  return value;
}

/** 결정 — 통보 111·112: 버킷은 각 공장의 로컬 날짜 경계를 쓴다. */
export function downtimeSummaryBuckets(
  plants: readonly SummaryPeriodPlant[],
  startedFrom: string,
  startedTo: string,
  size: SummaryBucketSize,
): SummaryPeriodBucket[] {
  const from = calendarDay(startedFrom);
  const to = calendarDay(startedTo);
  if (from > to) throw new Error("Invalid downtime summary date range");
  const buckets: SummaryPeriodBucket[] = [];
  for (const plant of plants) {
    let first = from;
    let key = periodStart(from, size);
    for (let day = from; ; day += DAY_MS) {
      const isLast = day === to;
      const nextKey = isLast ? undefined : periodStart(day + DAY_MS, size);
      if (isLast || nextKey !== key) {
        const range = maintenanceDateRange(
          calendarDate(first),
          calendarDate(day),
          plant.timezone,
        );
        buckets.push({
          plantId: plant.plantId,
          periodStart: key,
          startedAtUs: epochUs(range.gte),
          endedAtUs: epochUs(range.lt),
        });
        if (isLast) break;
        if (!nextKey) throw new Error("Missing downtime summary period key");
        first = day + DAY_MS;
        key = nextKey;
      }
    }
  }
  return buckets;
}

/** 결정 — 통보 111·112: 칸별 시간은 장비 합집합, count는 교차한 원본 행이다. */
export function summarizePeriods(
  intervals: readonly SummaryPeriodInterval[],
  buckets: readonly SummaryPeriodBucket[],
): SummaryPeriodGroup[] {
  const totals = new Map<string, { count: number; totalUs: bigint }>();
  for (const bucket of buckets) {
    if (bucket.endedAtUs <= bucket.startedAtUs)
      throw new Error("Invalid downtime summary bucket");
    const result = summarizeIntervals(
      intervals
        .filter((row) => row.plantId === bucket.plantId)
        .map((row) => ({
          ...row,
          rangeStartUs:
            row.rangeStartUs > bucket.startedAtUs
              ? row.rangeStartUs
              : bucket.startedAtUs,
          rangeEndUs:
            row.rangeEndUs < bucket.endedAtUs
              ? row.rangeEndUs
              : bucket.endedAtUs,
        }))
        .filter((row) => row.rangeStartUs < row.rangeEndUs),
    );
    const previous = totals.get(bucket.periodStart);
    totals.set(bucket.periodStart, {
      count:
        (previous?.count ?? 0) +
        [...result.byEquipment.values()].reduce(
          (count, group) => count + group.count,
          0,
        ),
      totalUs: (previous?.totalUs ?? 0n) + result.actualDowntimeUs,
    });
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      periodStart: key,
      count: value.count,
      totalMinutes: minutes(value.totalUs),
    }));
}
