import { SummaryInterval, summarizeIntervals } from "./downtime-summary-rules";

export interface DowntimeCalendarSlot {
  readonly equipmentId: string;
  readonly calendarDate: string;
  readonly calendarActive: boolean | null;
  readonly dayType: string | null;
  readonly shiftId: string | null;
  readonly shiftValid: boolean | null;
  readonly shiftStartUs: bigint | null;
  readonly shiftEndUs: bigint | null;
  readonly partialValid: boolean | null;
  readonly partialStartUs: bigint | null;
  readonly partialEndUs: bigint | null;
  readonly rangeStartUs: bigint;
  readonly rangeEndUs: bigint;
}

type Span = { readonly startUs: bigint; readonly endUs: bigint };
const DAY_TYPES = new Set(["WORKING", "HOLIDAY", "PARTIAL"]);

function plannedSpans(row: DowntimeCalendarSlot): Span[] | null {
  if (
    row.calendarActive !== true ||
    !row.dayType ||
    !DAY_TYPES.has(row.dayType) ||
    row.shiftId === null ||
    row.shiftValid !== true ||
    row.shiftStartUs === null ||
    row.shiftEndUs === null
  )
    return null;
  if (row.dayType === "WORKING") return [];
  if (row.dayType === "HOLIDAY")
    return [{ startUs: row.shiftStartUs, endUs: row.shiftEndUs }];
  if (
    row.partialValid !== true ||
    row.partialStartUs === null ||
    row.partialEndUs === null
  )
    return null;
  return [
    {
      startUs: row.shiftStartUs,
      endUs:
        row.partialStartUs < row.shiftEndUs
          ? row.partialStartUs
          : row.shiftEndUs,
    },
    {
      startUs:
        row.partialEndUs > row.shiftStartUs
          ? row.partialEndUs
          : row.shiftStartUs,
      endUs: row.shiftEndUs,
    },
  ].filter((span) => span.startUs < span.endUs);
}

/** 결정 — 통보 111·112: 활성 교대 합집합에서 캘린더 휴무창을 설비-시간으로 센다. */
export function summarizePlannedDowntime(
  rows: readonly DowntimeCalendarSlot[],
): bigint | null {
  if (!rows.length) return null;
  const intervals: SummaryInterval[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.rangeEndUs <= row.rangeStartUs)
      throw new Error("Invalid planned downtime range");
    const spans = plannedSpans(row);
    if (spans === null) return null;
    for (const [part, span] of spans.entries())
      intervals.push({
        intervalId: `${row.equipmentId}:${row.calendarDate}:${row.shiftId}:${index}:${part}`,
        equipmentId: row.equipmentId,
        reasonCode: null,
        startedAtUs: span.startUs,
        endedAtUs: span.endUs,
        rangeStartUs: row.rangeStartUs,
        rangeEndUs: row.rangeEndUs,
        minorThresholdUs: 0n,
      });
  }
  return summarizeIntervals(intervals).actualDowntimeUs;
}
