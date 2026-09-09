import { CalibrationProjection, calibrationView } from "./calibration-view";

describe("calibrationView", () => {
  it("계약의 16칸을 원천값 그대로 투영하고 clearedAt 마이크로초를 보존한다", () => {
    expect(calibrationView(projection())).toEqual({
      calibrationId: 31,
      equipmentId: 41,
      equipmentCode: "GAU-0041",
      historyTypeCode: "CALIBRATION",
      performedOn: "2026-09-09",
      resultCode: "PASS",
      certificateNo: "CERT-31",
      agencyTypeCode: "EXTERNAL",
      agencyName: "한국계측인증",
      nextDueOn: "2027-09-09",
      toleranceNote: "±0.02 mm",
      recordedByUserId: 51,
      performedByUserId: null,
      remarks: "정기 검교정",
      blocksUse: true,
      clearedAt: "2026-09-09T01:02:03.123456Z",
    });
  });

  it("recordedByUserId는 원천이 없으면 추정하지 않고 생략한다", () => {
    const row = projection();
    row.recorded_by = null;
    row.cleared_epoch_microseconds = null;
    expect(calibrationView(row)).toMatchObject({ clearedAt: null });
    expect(calibrationView(row)).not.toHaveProperty("recordedByUserId");
  });

  it("과거 historyTypeCode 결손을 CALIBRATION으로 추정하지 않는다", () => {
    const row = projection();
    row.history_type_code = null;
    expect(() => calibrationView(row)).toThrow("Missing required calibration field");
  });
});

function projection(): CalibrationProjection {
  return {
    equipment_calibration_id: 31n,
    equipment_id: 41n,
    equipment_code: "GAU-0041",
    history_type_code: "CALIBRATION",
    performed_on: "2026-09-09",
    result_code: "PASS",
    certificate_no: "CERT-31",
    agency_type_code: "EXTERNAL",
    agency_name: "한국계측인증",
    next_due_on: "2027-09-09",
    tolerance_note: "±0.02 mm",
    recorded_by: 51n,
    calibrated_by: null,
    remarks: "정기 검교정",
    blocks_use: true,
    cleared_epoch_microseconds: "1788915723123456",
  };
}
