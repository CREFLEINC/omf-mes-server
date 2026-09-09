import {
  CalibrationCreate,
  calibrationMasterEffect,
  checkCalibrationCreate,
} from "./calibration-write-input";

describe("검교정 등록 입력", () => {
  it("필수 네 칸만으로 정상이며 blocksUse와 nullable을 기본화한다", () => {
    expect(checkCalibrationCreate(base())).toEqual({
      equipmentId: 41n,
      historyTypeCode: "CHECK",
      performedOn: "2026-09-09",
      resultCode: "NORMAL",
      certificateNo: null,
      agencyTypeCode: null,
      agencyName: null,
      nextDueOn: null,
      toleranceNote: null,
      performedByUserId: null,
      remarks: null,
      blocksUse: false,
    });
  });

  it.each(["PASS", "ADJUSTED"])("CALIBRATION %s만 설비 날짜 갱신 대상이다", (result) => {
    const checked = checkCalibrationCreate({
      ...base(),
      historyTypeCode: "CALIBRATION",
      resultCode: result,
    });
    expect(calibrationMasterEffect(checked)).toBe("UPDATE_MASTER");
  });

  it("FAIL과 비검교정 확장 결과는 이력만 남긴다", () => {
    const failed = checkCalibrationCreate({
      ...base(),
      historyTypeCode: "CALIBRATION",
      resultCode: "FAIL",
    });
    expect(calibrationMasterEffect(failed)).toBe("HISTORY_ONLY");
    expect(calibrationMasterEffect(checkCalibrationCreate(base()))).toBe("HISTORY_ONLY");
  });

  it("CALIBRATION의 활성 확장 결과는 의미 미정 422다", () => {
    const checked = checkCalibrationCreate({
      ...base(),
      historyTypeCode: "CALIBRATION",
      resultCode: "CUSTOM",
    });
    expect(caught(() => calibrationMasterEffect(checked))).toMatchObject({
      status: 422,
      errors: [{ field: "resultCode", code: "STATE_LOCKED" }],
    });
  });

  it("외부 기관은 이름이 필요하고 내부 수행자를 함께 받지 않는다", () => {
    expect(caught(() =>
      checkCalibrationCreate({
        ...base(),
        historyTypeCode: "CALIBRATION",
        agencyTypeCode: "EXTERNAL",
      }),
    )).toMatchObject({ errors: [{ field: "agencyName", code: "REQUIRED" }] });
    expect(caught(() =>
      checkCalibrationCreate({
        ...base(),
        historyTypeCode: "CALIBRATION",
        agencyTypeCode: "EXTERNAL",
        agencyName: "외부기관",
        performedByUserId: 51,
      }),
    )).toMatchObject({ errors: [{ field: "performedByUserId", code: "PAIR" }] });
  });

  it("비검교정 기관 구분과 역전 기한을 거절하고 같은 날 기한은 허용한다", () => {
    expect(caught(() => checkCalibrationCreate({ ...base(), agencyTypeCode: "INTERNAL" }))).toMatchObject({
      errors: [{ field: "agencyTypeCode", code: "INVALID" }],
    });
    expect(caught(() => checkCalibrationCreate({ ...base(), nextDueOn: "2026-09-08" }))).toMatchObject({
      errors: [{ field: "nextDueOn", code: "RANGE" }],
    });
    expect(checkCalibrationCreate({ ...base(), nextDueOn: "2026-09-09" }).nextDueOn).toBe(
      "2026-09-09",
    );
  });

  it("식별자 안전 범위와 물리 문자열 길이를 쓰기 전에 검사한다", () => {
    expect(caught(() => checkCalibrationCreate({ ...base(), equipmentId: Number.MAX_SAFE_INTEGER + 1 }))).toMatchObject({
      errors: [{ field: "equipmentId", code: "RANGE" }],
    });
    expect(caught(() => checkCalibrationCreate({ ...base(), certificateNo: "x".repeat(101) }))).toMatchObject({
      errors: [{ field: "certificateNo", code: "RANGE" }],
    });
  });
});

function base(): CalibrationCreate {
  return {
    equipmentId: 41,
    historyTypeCode: "CHECK",
    performedOn: "2026-09-09",
    resultCode: "NORMAL",
  };
}

function caught(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("Expected work to throw");
}
