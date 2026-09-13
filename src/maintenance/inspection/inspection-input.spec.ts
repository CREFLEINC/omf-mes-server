import { ContractException, ERROR_CODE } from "../../common/errors";
import { checkInspectionInput, InspectionCreate } from "./inspection-input";

const input = (
  overrides: Partial<InspectionCreate> = {},
): InspectionCreate => ({
  equipmentId: 1,
  inspectionTypeCode: "DAILY",
  inspectedAt: "2026-09-08T10:00:00+07:00",
  lines: [{ inspectionItemId: 11, resultCode: "PASS" }],
  ...overrides,
});

function caught(body: InspectionCreate): ContractException {
  try {
    checkInspectionInput(body);
  } catch (error) {
    if (error instanceof ContractException) return error;
    throw error;
  }
  throw new Error("Expected inspection input error");
}

describe("inspection input", () => {
  it("빈 lines는 422 LINE_REQUIRED다", () => {
    const error = caught(input({ lines: [] }));
    expect(error.getStatus()).toBe(422);
    expect(error.errors).toEqual([
      expect.objectContaining({
        field: "lines",
        code: ERROR_CODE.LINE_REQUIRED,
      }),
    ]);
  });

  it("중복 항목은 두 번째 위치의 INVALID다", () => {
    const line = { inspectionItemId: 11, resultCode: "PASS" as const };
    const error = caught(input({ lines: [line, line] }));
    expect(error.getStatus()).toBe(400);
    expect(error.errors[0]).toMatchObject({
      field: "lines[1].inspectionItemId",
      code: ERROR_CODE.INVALID,
    });
  });

  it("PASS/FAIL 합성은 입력 순서와 무관하다", () => {
    const lines = [
      { inspectionItemId: 11, resultCode: "PASS" as const },
      { inspectionItemId: 12, resultCode: "FAIL" as const },
    ];
    expect(
      checkInspectionInput(input({ remarks: "누유", lines })).overallResultCode,
    ).toBe("FAIL");
    expect(
      checkInspectionInput(
        input({ remarks: "누유", lines: [...lines].reverse() }),
      ).overallResultCode,
    ).toBe("FAIL");
    expect(checkInspectionInput(input()).overallResultCode).toBe("PASS");
  });

  it("모바일 OK/NG를 저장 판정 PASS/FAIL로 정규화한다", () => {
    const checked = checkInspectionInput(
      input({
        remarks: "이상",
        lines: [
          { inspectionItemId: 11, resultCode: "OK" },
          { inspectionItemId: 12, resultCode: "NG" },
        ],
      }),
    );
    expect(checked.overallResultCode).toBe("FAIL");
    expect(checked.lines.map((line) => line.resultCode)).toEqual(["PASS", "FAIL"]);
  });

  it("모바일 NG도 불합격 비고를 요구한다", () => {
    const error = caught(input({ lines: [{ inspectionItemId: 11, resultCode: "NG" }] }));
    expect(error.getStatus()).toBe(422);
    expect(error.errors[0]).toMatchObject({ field: "remarks", code: ERROR_CODE.REQUIRED });
  });

  it.each([undefined, null, "", "   "])(
    "FAIL인데 헤더 비고가 %p이면 422 REQUIRED다",
    (remarks) => {
      const error = caught(
        input({
          remarks,
          lines: [{ inspectionItemId: 11, resultCode: "FAIL" }],
        }),
      );
      expect(error.getStatus()).toBe(422);
      expect(error.errors[0]).toMatchObject({
        field: "remarks",
        code: ERROR_CODE.REQUIRED,
      });
    },
  );

  it("표현 가능한 측정값과 null을 무손실 Decimal로 보존한다", () => {
    const checked = checkInspectionInput(
      input({
        lines: [
          {
            inspectionItemId: 11,
            resultCode: "PASS",
            measuredValue: 12.345678,
          },
          { inspectionItemId: 12, resultCode: "PASS", measuredValue: null },
        ],
      }),
    );
    expect(checked.lines[0].numericValue?.toString()).toBe("12.345678");
    expect(checked.lines[1].numericValue).toBeNull();
  });

  it.each([0.0000001, 100000000000000, -100000000000000])(
    "Decimal(20,6)에 무손실 저장할 수 없는 %p는 RANGE다",
    (measuredValue) => {
      const error = caught(
        input({
          lines: [{ inspectionItemId: 11, resultCode: "PASS", measuredValue }],
        }),
      );
      expect(error.errors[0]).toMatchObject({
        field: "lines[0].measuredValue",
        code: ERROR_CODE.RANGE,
      });
    },
  );
});
