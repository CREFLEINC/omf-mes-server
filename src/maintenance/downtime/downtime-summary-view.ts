import type { DowntimeMinorThresholds } from "./downtime-summary-minor.service";
import {
  downtimeSummaryBuckets,
  SummaryBucketSize,
  summarizePeriods,
} from "./downtime-summary-period";
import {
  SummaryGroup,
  SummaryInterval,
  summarizeIntervals,
} from "./downtime-summary-rules";
import type {
  DowntimeSummarySource,
  SummarySessionSource,
} from "./downtime-summary-source.types";
import type { DowntimeSummaryMaintenanceCounts } from "./downtime-summary-maintenance.service";

const MINUTE_US = 60_000_000n;
export type SummaryGroupBy = "REASON" | "EQUIPMENT" | "PERIOD";
export interface DowntimeSummaryQuery {
  readonly plantId?: number;
  readonly equipmentGroupId?: number;
  readonly equipmentId?: number;
  readonly groupBy?: SummaryGroupBy;
  readonly startedFrom: string;
  readonly startedTo: string;
  readonly bucket?: SummaryBucketSize;
}

type GroupFields = SummaryGroup;
export interface DowntimeSummaryView extends DowntimeSummaryMaintenanceCounts {
  operatingMinutes: number;
  plannedDowntimeMinutes?: number;
  actualDowntimeMinutes: number;
  availabilityPercent: number | null;
  openIntervalCount: number;
  overlappingIntervalCount: number;
  minorStopCount: number;
  minorStopMinutes: number;
  minorStopThresholdMinutes: number | null;
  byReason?: (GroupFields & { reasonCode: string; reasonName?: string })[];
  byEquipment?: (GroupFields & {
    equipmentId: number;
    equipmentCode: string;
    equipmentName: string;
  })[];
  byPeriod?: { periodStart: string; count: number; totalMinutes: number }[];
  sessionsWithoutEquipmentCount: number;
}

function minutes(value: bigint): number {
  if (value < 0n) throw new Error("Invalid downtime summary duration");
  const converted = Number(value / MINUTE_US);
  if (!Number.isSafeInteger(converted))
    throw new Error("Downtime summary minutes exceed safe range");
  return converted;
}

function oneDecimal(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new Error("Invalid downtime summary ratio");
  const scaled = numerator * 10n;
  const rounded =
    scaled < 0n
      ? -((-scaled + denominator / 2n) / denominator)
      : (scaled + denominator / 2n) / denominator;
  const converted = Number(rounded);
  if (!Number.isSafeInteger(converted))
    throw new Error("Downtime summary ratio exceeds safe range");
  return converted / 10;
}

function operatingUs(rows: readonly SummarySessionSource[]): bigint {
  return rows.reduce((total, row) => {
    if (row.endedAtUs < row.startedAtUs || row.rangeEndUs <= row.rangeStartUs)
      throw new Error("Invalid downtime summary session");
    const start =
      row.startedAtUs > row.rangeStartUs ? row.startedAtUs : row.rangeStartUs;
    const end = row.endedAtUs < row.rangeEndUs ? row.endedAtUs : row.rangeEndUs;
    return total + (end > start ? end - start : 0n);
  }, 0n);
}

function id(value: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted <= 0)
    throw new Error("Invalid downtime summary equipment id");
  return converted;
}

/** 결정 — 통보 111·112: 원천 합계와 탭 하나만 계약 응답으로 조립한다. */
export function downtimeSummaryView(
  source: DowntimeSummarySource,
  thresholds: DowntimeMinorThresholds,
  plannedUs: bigint | null,
  maintenance: DowntimeSummaryMaintenanceCounts,
  query: DowntimeSummaryQuery,
): DowntimeSummaryView {
  const intervals: (SummaryInterval & { plantId: string })[] =
    source.downtimes.map((row) => {
      const threshold = thresholds.byPlant.get(row.plantId);
      if (threshold === undefined)
        throw new Error("Missing minor stop threshold");
      return {
        ...row,
        intervalId: row.downtimeId,
        minorThresholdUs: threshold,
      };
    });
  const actual = summarizeIntervals(intervals);
  const operating = operatingUs(source.sessions);
  const base: DowntimeSummaryView = {
    operatingMinutes: minutes(operating),
    ...(plannedUs === null
      ? {}
      : { plannedDowntimeMinutes: minutes(plannedUs) }),
    actualDowntimeMinutes: actual.actualDowntimeMinutes,
    availabilityPercent:
      operating === 0n
        ? null
        : oneDecimal((operating - actual.actualDowntimeUs) * 100n, operating),
    openIntervalCount: source.openIntervalCount,
    overlappingIntervalCount: actual.overlappingIntervalCount,
    minorStopCount: actual.minorStopCount,
    minorStopMinutes: actual.minorStopMinutes,
    minorStopThresholdMinutes: thresholds.minorStopThresholdMinutes,
    sessionsWithoutEquipmentCount: source.sessions.filter(
      (row) => row.equipmentId === null,
    ).length,
    ...maintenance,
  };
  const groupBy = query.groupBy ?? "REASON";
  if (groupBy === "PERIOD")
    return {
      ...base,
      byPeriod: summarizePeriods(
        intervals,
        downtimeSummaryBuckets(
          source.plants,
          query.startedFrom,
          query.startedTo,
          query.bucket ?? "DAY",
        ),
      ),
    };
  if (groupBy === "EQUIPMENT") {
    const equipment = new Map(
      source.equipment.map((row) => [row.equipmentId, row]),
    );
    return {
      ...base,
      byEquipment: [...actual.byEquipment]
        .sort(([left], [right]) => id(left) - id(right))
        .map(([equipmentId, group]) => {
          const item = equipment.get(equipmentId);
          if (!item) throw new Error("Missing downtime summary equipment");
          return {
            equipmentId: id(equipmentId),
            equipmentCode: item.equipmentCode,
            equipmentName: item.equipmentName,
            ...group,
          };
        }),
    };
  }
  return {
    ...base,
    byReason: [...actual.byReason]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([reasonCode, group]) => {
        if (reasonCode === null)
          throw new Error("Missing downtime summary reason");
        const reasonName = source.downtimes.find(
          (row) => row.reasonCode === reasonCode && row.reasonName !== null,
        )?.reasonName;
        return {
          reasonCode,
          ...(reasonName === undefined || reasonName === null
            ? {}
            : { reasonName }),
          ...group,
        };
      }),
  };
}
