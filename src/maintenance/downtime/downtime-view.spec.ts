import { DowntimeRow, downtimeView } from "./downtime-view";

describe("downtimeView", () => {
  it("12개 계약 필드·마이크로초·정수 분·nullable 연결을 보존한다", () => {
    expect(downtimeView(row())).toEqual({
      downtimeId: 5,
      equipmentId: 7,
      equipmentCode: "PRESS-01",
      reasonCode: "MOLD_CHANGE",
      reasonName: "금형 교체",
      startedAt: "2026-09-01T00:00:00.123456Z",
      endedAt: "2026-09-01T00:01:00.123456Z",
      durationMinutes: 1,
      breakdownId: 9,
      workSessionId: null,
      recordedByWorkerNo: "W-1",
      remarks: "교체",
    });
  });

  it.each([
    [null, null],
    ["1788220800123456", 0],
    ["1788220801123456", null],
  ])("종료 epoch %s의 durationMinutes가 %s다", (ended, minutes) => {
    expect(downtimeView(row({ ended_epoch_us: ended })).durationMinutes).toBe(
      minutes,
    );
  });

  it("비활성·없는 사유 이름은 코드만 보존하고 name을 생략한다", () => {
    const view = downtimeView(row({ reason_name: null, breakdown_id: null }));
    expect(view.reasonCode).toBe("MOLD_CHANGE");
    expect(view.breakdownId).toBeNull();
    expect(view).not.toHaveProperty("reasonName");
  });

  it.each([
    [{ downtime_id: 9_007_199_254_740_993n }, "downtime id"],
    [{ reason_code: " " }, "reason code"],
    [{ recorded_by_worker_no: null }, "worker number"],
    [{ ended_epoch_us: "1788220800123455" }, "range"],
    [{ started_epoch_us: "not-an-epoch" }, "epoch"],
  ])("결손·범위 밖 저장값 %o을 조용히 보완하지 않는다", (change, message) => {
    expect(() => downtimeView(row(change))).toThrow(message);
  });
});

function row(change: Partial<DowntimeRow> = {}): DowntimeRow {
  return {
    downtime_id: 5n,
    equipment_id: 7n,
    equipment_code: "PRESS-01",
    reason_code: "MOLD_CHANGE",
    reason_name: "금형 교체",
    started_epoch_us: "1788220800123456",
    ended_epoch_us: "1788220860123456",
    breakdown_id: 9n,
    recorded_by_worker_no: "W-1",
    remarks: "교체",
    version_no: 3,
    ...change,
  };
}
