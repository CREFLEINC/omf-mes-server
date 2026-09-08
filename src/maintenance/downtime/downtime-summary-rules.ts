const MINUTE_US = 60_000_000n;

export interface SummaryInterval {
  readonly intervalId: string;
  readonly equipmentId: string;
  readonly reasonCode: string | null;
  readonly startedAtUs: bigint;
  readonly endedAtUs: bigint;
  readonly rangeStartUs: bigint;
  readonly rangeEndUs: bigint;
  readonly minorThresholdUs: bigint;
}

export interface SummaryGroup {
  readonly count: number;
  readonly totalMinutes: number;
  readonly sharePercent?: number;
  readonly averageMinutes?: number;
}

export interface SummaryIntervalResult {
  readonly actualDowntimeUs: bigint;
  readonly actualDowntimeMinutes: number;
  readonly overlappingIntervalCount: number;
  readonly minorStopCount: number;
  readonly minorStopMinutes: number;
  readonly byReason: ReadonlyMap<string | null, SummaryGroup>;
  readonly byEquipment: ReadonlyMap<string, SummaryGroup>;
}

type ClippedInterval = SummaryInterval & {
  readonly clippedStartUs: bigint;
  readonly clippedEndUs: bigint;
};
type Span = { readonly startUs: bigint; readonly endUs: bigint };

function clipped(intervals: readonly SummaryInterval[]): ClippedInterval[] {
  return intervals.flatMap((interval) => {
    if (
      interval.endedAtUs < interval.startedAtUs ||
      interval.rangeEndUs <= interval.rangeStartUs ||
      interval.minorThresholdUs < 0n
    )
      throw new Error("Invalid downtime summary interval");
    const clippedStartUs =
      interval.startedAtUs > interval.rangeStartUs
        ? interval.startedAtUs
        : interval.rangeStartUs;
    const clippedEndUs =
      interval.endedAtUs < interval.rangeEndUs
        ? interval.endedAtUs
        : interval.rangeEndUs;
    const zeroInsideRange =
      interval.startedAtUs === interval.endedAtUs &&
      interval.startedAtUs >= interval.rangeStartUs &&
      interval.startedAtUs < interval.rangeEndUs;
    return clippedStartUs < clippedEndUs || zeroInsideRange
      ? [{ ...interval, clippedStartUs, clippedEndUs }]
      : [];
  });
}

function merge(intervals: readonly Span[]): Span[] {
  const sorted = [...intervals].sort((left, right) =>
    left.startUs < right.startUs
      ? -1
      : left.startUs > right.startUs
        ? 1
        : left.endUs < right.endUs
          ? -1
          : left.endUs > right.endUs
            ? 1
            : 0,
  );
  const merged: Span[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || previous.endUs < interval.startUs) {
      merged.push({ startUs: interval.startUs, endUs: interval.endUs });
    } else if (interval.endUs > previous.endUs) {
      merged[merged.length - 1] = {
        startUs: previous.startUs,
        endUs: interval.endUs,
      };
    }
  }
  return merged;
}

function totalUs(intervals: readonly Span[]): bigint {
  return intervals.reduce(
    (total, interval) => total + interval.endUs - interval.startUs,
    0n,
  );
}

function minutes(valueUs: bigint): number {
  const value = valueUs / MINUTE_US;
  const converted = Number(value);
  if (!Number.isSafeInteger(converted))
    throw new Error("Downtime summary minutes exceed safe range");
  return converted;
}

function oneDecimal(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new Error("Invalid downtime summary ratio");
  const rounded = (numerator * 10n + denominator / 2n) / denominator;
  const converted = Number(rounded);
  if (!Number.isSafeInteger(converted))
    throw new Error("Downtime summary ratio exceeds safe range");
  return converted / 10;
}

function group(
  intervals: readonly ClippedInterval[],
  unionUs: bigint,
): SummaryGroup {
  const rawUs = totalUs(
    intervals.map((interval) => ({
      startUs: interval.clippedStartUs,
      endUs: interval.clippedEndUs,
    })),
  );
  return {
    count: intervals.length,
    totalMinutes: minutes(rawUs),
    ...(unionUs === 0n
      ? {}
      : { sharePercent: oneDecimal(rawUs * 100n, unionUs) }),
    ...(intervals.length === 0
      ? {}
      : {
          averageMinutes: oneDecimal(
            rawUs,
            BigInt(intervals.length) * MINUTE_US,
          ),
        }),
  };
}

function mapGroups<K>(
  intervals: readonly ClippedInterval[],
  keyOf: (interval: ClippedInterval) => K,
  unionUs: bigint,
): ReadonlyMap<K, SummaryGroup> {
  const grouped = new Map<K, ClippedInterval[]>();
  for (const interval of intervals) {
    const key = keyOf(interval);
    const rows = grouped.get(key);
    if (rows) rows.push(interval);
    else grouped.set(key, [interval]);
  }
  return new Map(
    [...grouped].map(([key, rows]) => [key, group(rows, unionUs)]),
  );
}

/** 결정 — 통보 111·112: 원본은 보존하고 장비별 합집합·원본 묶음을 분리한다. */
export function summarizeIntervals(
  source: readonly SummaryInterval[],
): SummaryIntervalResult {
  const intervals = clipped(source);
  const byEquipmentRows = new Map<string, ClippedInterval[]>();
  for (const interval of intervals) {
    const rows = byEquipmentRows.get(interval.equipmentId);
    if (rows) rows.push(interval);
    else byEquipmentRows.set(interval.equipmentId, [interval]);
  }

  const equipmentUnions = new Map<string, Span[]>();
  for (const [equipmentId, rows] of byEquipmentRows)
    equipmentUnions.set(
      equipmentId,
      merge(
        rows.map((row) => ({
          startUs: row.clippedStartUs,
          endUs: row.clippedEndUs,
        })),
      ),
    );
  const unionUs = [...equipmentUnions.values()].reduce(
    (total, rows) => total + totalUs(rows),
    0n,
  );

  const overlaps = new Set<string>();
  for (const rows of byEquipmentRows.values()) {
    const ordered = rows
      .filter((row) => row.clippedStartUs < row.clippedEndUs)
      .sort((a, b) =>
        a.clippedStartUs < b.clippedStartUs
          ? -1
          : a.clippedStartUs > b.clippedStartUs
            ? 1
            : a.clippedEndUs < b.clippedEndUs
              ? -1
              : a.clippedEndUs > b.clippedEndUs
                ? 1
                : 0,
      );
    let furthestEnd: bigint | undefined;
    let furthestId: string | undefined;
    for (const row of ordered) {
      if (furthestEnd !== undefined && row.clippedStartUs < furthestEnd) {
        overlaps.add(row.intervalId);
        if (furthestId) overlaps.add(furthestId);
      }
      if (furthestEnd === undefined || row.clippedEndUs > furthestEnd) {
        furthestEnd = row.clippedEndUs;
        furthestId = row.intervalId;
      }
    }
  }

  const minor = intervals.filter(
    (row) => row.endedAtUs - row.startedAtUs < row.minorThresholdUs,
  );
  const byReason = mapGroups(intervals, (row) => row.reasonCode, unionUs);
  const byEquipment = new Map<string, SummaryGroup>();
  for (const [equipmentId, rows] of byEquipmentRows) {
    const equipmentUs = totalUs(equipmentUnions.get(equipmentId) ?? []);
    byEquipment.set(equipmentId, {
      count: rows.length,
      totalMinutes: minutes(equipmentUs),
      ...(unionUs === 0n
        ? {}
        : { sharePercent: oneDecimal(equipmentUs * 100n, unionUs) }),
      averageMinutes: oneDecimal(equipmentUs, BigInt(rows.length) * MINUTE_US),
    });
  }

  return {
    actualDowntimeUs: unionUs,
    actualDowntimeMinutes: minutes(unionUs),
    overlappingIntervalCount: overlaps.size,
    minorStopCount: minor.length,
    minorStopMinutes: minutes(
      totalUs(
        minor.map((row) => ({
          startUs: row.clippedStartUs,
          endUs: row.clippedEndUs,
        })),
      ),
    ),
    byReason,
    byEquipment,
  };
}
