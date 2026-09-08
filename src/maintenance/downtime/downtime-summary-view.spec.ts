import type { DowntimeMinorThresholds } from "./downtime-summary-minor.service";
import type { DowntimeSummaryMaintenanceCounts } from "./downtime-summary-maintenance.service";
import type { DowntimeSummarySource } from "./downtime-summary-source.types";
import { downtimeSummaryView } from "./downtime-summary-view";

const MINUTE = 60_000_000n;
const START = BigInt(Date.UTC(2026, 8, 1)) * 1000n;
const END = START + 24n * 60n * MINUTE;
const maintenance: DowntimeSummaryMaintenanceCounts = {
  correctiveMaintenanceCount: 2,
  preventiveMaintenanceCount: 1,
  breakdownsClosedWithoutOrderCount: 3,
};
const thresholds: DowntimeMinorThresholds = {
  byPlant: new Map([["1", 5n * MINUTE]]),
  minorStopThresholdMinutes: 5,
};

function source(): DowntimeSummarySource {
  return {
    plants: [
      {
        plantId: "1",
        businessUnitId: "1",
        timezone: "UTC",
        rangeStartUs: START,
        rangeEndUs: END,
      },
    ],
    equipment: [
      {
        equipmentId: "10",
        equipmentCode: "EQ-10",
        equipmentName: "설비 10",
        plantId: "1",
        productionLineId: null,
      },
    ],
    sessions: [
      {
        sessionId: "1",
        plantId: "1",
        equipmentId: "10",
        startedAtUs: START - MINUTE,
        endedAtUs: START + 10n * MINUTE,
        rangeStartUs: START,
        rangeEndUs: END,
      },
      {
        sessionId: "2",
        plantId: "1",
        equipmentId: null,
        startedAtUs: START + 5n * MINUTE,
        endedAtUs: START + 20n * MINUTE,
        rangeStartUs: START,
        rangeEndUs: END,
      },
    ],
    downtimes: [
      {
        downtimeId: "1",
        plantId: "1",
        equipmentId: "10",
        reasonCode: "FAILURE",
        reasonName: "고장",
        startedAtUs: START,
        endedAtUs: START + 4n * MINUTE,
        rangeStartUs: START,
        rangeEndUs: END,
      },
      {
        downtimeId: "2",
        plantId: "1",
        equipmentId: "10",
        reasonCode: "FAILURE",
        reasonName: "고장",
        startedAtUs: START + 2n * MINUTE,
        endedAtUs: START + 8n * MINUTE,
        rangeStartUs: START,
        rangeEndUs: END,
      },
    ],
    openIntervalCount: 4,
  };
}

describe("downtime summary view", () => {
  it("세션 합·장비별 비가동 합집합·경미정지·가동률을 조립한다", () => {
    const view = downtimeSummaryView(
      source(),
      thresholds,
      2n * MINUTE,
      maintenance,
      {
        startedFrom: "2026-09-01",
        startedTo: "2026-09-01",
      },
    );

    expect(view).toMatchObject({
      operatingMinutes: 25,
      plannedDowntimeMinutes: 2,
      actualDowntimeMinutes: 8,
      availabilityPercent: 68,
      openIntervalCount: 4,
      overlappingIntervalCount: 2,
      minorStopCount: 1,
      minorStopMinutes: 4,
      minorStopThresholdMinutes: 5,
      sessionsWithoutEquipmentCount: 1,
      ...maintenance,
    });
    expect(view.byReason).toEqual([
      {
        reasonCode: "FAILURE",
        reasonName: "고장",
        count: 2,
        totalMinutes: 10,
        sharePercent: 125,
        averageMinutes: 5,
      },
    ]);
    expect(view).not.toHaveProperty("byEquipment");
    expect(view).not.toHaveProperty("byPeriod");
  });

  it("EQUIPMENT 탭 하나만 장비 식별자와 함께 낸다", () => {
    const view = downtimeSummaryView(source(), thresholds, 0n, maintenance, {
      groupBy: "EQUIPMENT",
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });
    expect(view.byEquipment).toEqual([
      {
        equipmentId: 10,
        equipmentCode: "EQ-10",
        equipmentName: "설비 10",
        count: 2,
        totalMinutes: 8,
        sharePercent: 100,
        averageMinutes: 4,
      },
    ]);
    expect(view).not.toHaveProperty("byReason");
  });

  it("PERIOD 탭은 공장 로컬 버킷에서 원본 count와 합집합 시간을 낸다", () => {
    const view = downtimeSummaryView(source(), thresholds, 0n, maintenance, {
      groupBy: "PERIOD",
      bucket: "DAY",
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });
    expect(view.byPeriod).toEqual([
      { periodStart: "2026-09-01", count: 2, totalMinutes: 8 },
    ]);
  });

  it("조업 0은 가동률 null이고 계획 원천 null은 필드를 생략한다", () => {
    const empty = { ...source(), sessions: [], downtimes: [] };
    const view = downtimeSummaryView(empty, thresholds, null, maintenance, {
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });
    expect(view.availabilityPercent).toBeNull();
    expect(view).not.toHaveProperty("plannedDowntimeMinutes");
  });

  it("실제 비가동이 조업보다 커도 가동률을 0으로 clamp하지 않는다", () => {
    const original = source();
    const input = {
      ...original,
      sessions: [
        {
          ...original.sessions[0],
          startedAtUs: START,
          endedAtUs: START + MINUTE,
        },
      ],
    };
    const view = downtimeSummaryView(input, thresholds, 0n, maintenance, {
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });
    expect(view.availabilityPercent).toBe(-700);
  });
});
