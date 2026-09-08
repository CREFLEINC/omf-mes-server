import {
  DowntimeCalendarSlot,
  summarizePlannedDowntime,
} from "./downtime-summary-planned";

const HOUR = 3_600_000_000n;

function slot(input: Partial<DowntimeCalendarSlot> = {}): DowntimeCalendarSlot {
  return {
    equipmentId: "1",
    calendarDate: "2026-09-01",
    calendarActive: true,
    dayType: "HOLIDAY",
    shiftId: "1",
    shiftValid: true,
    shiftStartUs: 8n * HOUR,
    shiftEndUs: 12n * HOUR,
    partialValid: true,
    partialStartUs: null,
    partialEndUs: null,
    rangeStartUs: 0n,
    rangeEndUs: 24n * HOUR,
    ...input,
  };
}

describe("downtime summary planned", () => {
  it("겹치는 교대는 설비별 합집합이고 설비 사이는 합산한다", () => {
    expect(
      summarizePlannedDowntime([
        slot(),
        slot({
          shiftId: "2",
          shiftStartUs: 10n * HOUR,
          shiftEndUs: 14n * HOUR,
        }),
        slot({ equipmentId: "2" }),
      ]),
    ).toBe(10n * HOUR);
  });

  it("WORKING은 계획 비가동 0이다", () => {
    expect(summarizePlannedDowntime([slot({ dayType: "WORKING" })])).toBe(0n);
  });

  it("PARTIAL은 부분 가동창 밖만 세고 조회 범위에서 자른다", () => {
    expect(
      summarizePlannedDowntime([
        slot({
          dayType: "PARTIAL",
          shiftStartUs: 8n * HOUR,
          shiftEndUs: 16n * HOUR,
          partialStartUs: 9n * HOUR,
          partialEndUs: 13n * HOUR,
          rangeStartUs: 10n * HOUR,
          rangeEndUs: 15n * HOUR,
        }),
      ]),
    ).toBe(2n * HOUR);
  });

  it.each([
    { calendarActive: false },
    { dayType: null },
    { dayType: "UNKNOWN" },
    { shiftId: null },
    { shiftValid: false },
    { dayType: "PARTIAL", partialValid: false },
  ])("캘린더 재료가 불완전하면 값을 생략한다: %o", (input) => {
    expect(summarizePlannedDowntime([slot(input)])).toBeNull();
  });
});
