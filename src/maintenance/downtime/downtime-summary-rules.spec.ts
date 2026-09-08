import { SummaryInterval, summarizeIntervals } from "./downtime-summary-rules";

const MINUTE_US = 60_000_000n;
const at = (minute: number): bigint => BigInt(minute) * MINUTE_US;

function interval(
  intervalId: string,
  equipmentId: string,
  started: number,
  ended: number,
  overrides: Partial<SummaryInterval> = {},
): SummaryInterval {
  return {
    intervalId,
    equipmentId,
    reasonCode: "FAILURE",
    startedAtUs: at(started),
    endedAtUs: at(ended),
    rangeStartUs: at(0),
    rangeEndUs: at(300),
    minorThresholdUs: at(5),
    ...overrides,
  };
}

describe("downtime summary interval rules", () => {
  it("큰 구간 안의 작은 구간들을 이전 최대 종료시각으로 합친다", () => {
    const result = summarizeIntervals([
      interval("outer", "1", 0, 60),
      interval("inner-1", "1", 10, 20),
      interval("inner-2", "1", 30, 40),
    ]);

    expect(result.actualDowntimeMinutes).toBe(60);
    expect(result.actualDowntimeUs).toBe(at(60));
    expect(result.overlappingIntervalCount).toBe(3);
    expect(result.byEquipment.get("1")).toEqual({
      count: 3,
      totalMinutes: 60,
      sharePercent: 100,
      averageMinutes: 20,
    });
  });

  it("다른 설비는 각각 더하고 맞닿은 구간은 겹침으로 세지 않는다", () => {
    const result = summarizeIntervals([
      interval("a", "1", 0, 60),
      interval("touch", "1", 60, 90),
      interval("other", "2", 0, 60),
    ]);

    expect(result.actualDowntimeMinutes).toBe(150);
    expect(result.overlappingIntervalCount).toBe(0);
  });

  it("1970년 이전의 첫 구간을 겹침으로 오판하지 않는다", () => {
    const result = summarizeIntervals([
      interval("past", "1", -120, -60, {
        rangeStartUs: at(-180),
        rangeEndUs: at(0),
      }),
    ]);

    expect(result.actualDowntimeMinutes).toBe(60);
    expect(result.overlappingIntervalCount).toBe(0);
  });

  it("사유별 원본 합은 합집합보다 커질 수 있고 임의 배분하지 않는다", () => {
    const result = summarizeIntervals([
      interval("a", "1", 0, 60, { reasonCode: "A" }),
      interval("b", "1", 30, 90, { reasonCode: "B" }),
    ]);

    expect(result.actualDowntimeMinutes).toBe(90);
    expect(result.byReason.get("A")).toEqual({
      count: 1,
      totalMinutes: 60,
      sharePercent: 66.7,
      averageMinutes: 60,
    });
    expect(result.byReason.get("B")?.sharePercent).toBe(66.7);
  });

  it("기간 경계에서 자른 후 전체에서 한 번만 분을 내림한다", () => {
    const result = summarizeIntervals([
      interval("a", "1", -1, 1, {
        rangeStartUs: 1n,
        rangeEndUs: at(1),
      }),
      interval("b", "1", 1, 2, {
        startedAtUs: at(1) + 1n,
        endedAtUs: at(2),
        rangeStartUs: 1n,
        rangeEndUs: at(3),
      }),
    ]);

    expect(result.actualDowntimeMinutes).toBe(1);
  });

  it("경미 정지는 원본 길이로 분류하고 기간 안 원본 합을 낸다", () => {
    const result = summarizeIntervals([
      interval("minor", "1", -2, 2, { rangeStartUs: at(0) }),
      interval("exact", "1", 10, 15),
    ]);

    expect(result.minorStopCount).toBe(1);
    expect(result.minorStopMinutes).toBe(2);
    expect(result.actualDowntimeMinutes).toBe(7);
  });

  it("기간 안 0초 행은 발생 건수만 보존한다", () => {
    const result = summarizeIntervals([interval("zero", "1", 10, 10)]);

    expect(result.actualDowntimeMinutes).toBe(0);
    expect(result.overlappingIntervalCount).toBe(0);
    expect(result.minorStopCount).toBe(1);
    expect(result.byReason.get("FAILURE")?.count).toBe(1);
  });

  it("잘못된 원본 구간을 조용히 보정하지 않는다", () => {
    expect(() => summarizeIntervals([interval("bad", "1", 2, 1)])).toThrow(
      "Invalid downtime summary interval",
    );
    expect(() =>
      summarizeIntervals([
        interval("bad-threshold", "1", 1, 2, { minorThresholdUs: -1n }),
      ]),
    ).toThrow("Invalid downtime summary interval");
  });
});
