import { maintenanceDateRange } from "../maintenance-calendar";
import {
  SummaryPeriodBucket,
  SummaryPeriodInterval,
  downtimeSummaryBuckets,
  summarizePeriods,
} from "./downtime-summary-period";

const MINUTE_US = 60_000_000n;
const at = (minute: number): bigint => BigInt(minute) * MINUTE_US;

function interval(
  intervalId: string,
  equipmentId: string,
  plantId: string,
  startedAtUs: bigint,
  endedAtUs: bigint,
): SummaryPeriodInterval {
  return {
    intervalId,
    equipmentId,
    plantId,
    reasonCode: "FAILURE",
    startedAtUs,
    endedAtUs,
    rangeStartUs: -9_000_000_000_000_000n,
    rangeEndUs: 9_000_000_000_000_000n,
    minorThresholdUs: at(5),
  };
}

function bucket(
  plantId: string,
  periodStart: string,
  started: number,
  ended: number,
): SummaryPeriodBucket {
  return {
    plantId,
    periodStart,
    startedAtUs: at(started),
    endedAtUs: at(ended),
  };
}

describe("downtime summary period rules", () => {
  it("DAY는 공장 로컬 날짜별 반열린 경계를 만든다", () => {
    const buckets = downtimeSummaryBuckets(
      [{ plantId: "1", timezone: "Asia/Seoul" }],
      "2026-09-01",
      "2026-09-02",
      "DAY",
    );

    expect(buckets.map((item) => item.periodStart)).toEqual([
      "2026-09-01",
      "2026-09-02",
    ]);
    const first = maintenanceDateRange(
      "2026-09-01",
      "2026-09-01",
      "Asia/Seoul",
    );
    if (!first.gte || !first.lt)
      throw new Error("expected complete date range");
    expect(buckets[0].startedAtUs).toBe(BigInt(first.gte.getTime()) * 1000n);
    expect(buckets[0].endedAtUs).toBe(BigInt(first.lt.getTime()) * 1000n);
  });

  it("WEEK는 ISO 월요일, MONTH는 달력 1일을 periodStart로 쓴다", () => {
    const plant = [{ plantId: "1", timezone: "UTC" }];
    expect(
      downtimeSummaryBuckets(plant, "2026-09-02", "2026-09-10", "WEEK").map(
        (item) => item.periodStart,
      ),
    ).toEqual(["2026-08-31", "2026-09-07"]);
    expect(
      downtimeSummaryBuckets(plant, "2026-08-31", "2026-09-02", "MONTH").map(
        (item) => item.periodStart,
      ),
    ).toEqual(["2026-08-01", "2026-09-01"]);
  });

  it("DST 전환일의 로컬 DAY를 24시간으로 고정하지 않는다", () => {
    const [bucket] = downtimeSummaryBuckets(
      [{ plantId: "1", timezone: "America/New_York" }],
      "2026-03-08",
      "2026-03-08",
      "DAY",
    );

    expect(bucket.endedAtUs - bucket.startedAtUs).toBe(at(23 * 60));
  });

  it("원본 구간을 각 칸에서 자르고 교차한 행을 칸마다 세는다", () => {
    const result = summarizePeriods(
      [
        interval("a", "1", "1", at(30), at(90)),
        interval("b", "1", "1", at(45), at(75)),
      ],
      [bucket("1", "2026-09-01", 0, 60), bucket("1", "2026-09-02", 60, 120)],
    );

    expect(result).toEqual([
      { periodStart: "2026-09-01", count: 2, totalMinutes: 30 },
      { periodStart: "2026-09-02", count: 2, totalMinutes: 30 },
    ]);
  });

  it("같은 periodStart의 공장별 소수 분과 다른 장비를 먼저 더한다", () => {
    const subMinute = 30_000_001n;
    const result = summarizePeriods(
      [
        interval("a", "1", "1", 0n, subMinute),
        interval("b", "2", "2", 0n, subMinute),
      ],
      [bucket("1", "2026-09-01", 0, 1), bucket("2", "2026-09-01", 0, 1)],
    );

    expect(result).toEqual([
      { periodStart: "2026-09-01", count: 2, totalMinutes: 1 },
    ]);
  });

  it("빈 칸도 0건·0분으로 내린다", () => {
    expect(summarizePeriods([], [bucket("1", "2026-09-01", 0, 60)])).toEqual([
      { periodStart: "2026-09-01", count: 0, totalMinutes: 0 },
    ]);
  });

  it("잘못된 날짜·기간·버킷을 조용히 보정하지 않는다", () => {
    expect(() =>
      downtimeSummaryBuckets(
        [{ plantId: "1", timezone: "UTC" }],
        "2026-09-02",
        "2026-09-01",
        "DAY",
      ),
    ).toThrow("Invalid downtime summary date range");
    expect(() =>
      summarizePeriods([], [bucket("1", "2026-09-01", 1, 1)]),
    ).toThrow("Invalid downtime summary bucket");
  });
});
