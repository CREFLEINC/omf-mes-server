import { ContractException } from "../../common/errors";
import {
  MaintenanceResultCreate,
  checkMaintenanceResultCreate,
  checkMaintenanceResultUpdate,
} from "./result-write-input";

const base = (): MaintenanceResultCreate => ({
  targetTypeCode: "EQUIPMENT",
  targetId: 11,
  breakdownId: 12,
  startedAt: "2026-09-01T00:00:00.123456Z",
  resultNote: "조치 기록",
  performedByUserId: 13,
});

describe("checkMaintenanceResultUpdate", () => {
  it("빈 PUT은 빈 변경으로 두고 명시 null·빈 배열은 보존한다", () => {
    expect(checkMaintenanceResultUpdate({}, 1_000_000n)).toEqual({});
    expect(
      checkMaintenanceResultUpdate(
        { finishedAt: null, lines: [], parts: [] },
        1_000_000n,
      ),
    ).toEqual({ finishedAt: null, lines: [], parts: [] });
  });

  it("마감과 시작 전 종료시각을 명시 거부한다", () => {
    for (const [body, status, name] of [
      [{ closed: true }, 422, "closed"],
      [{ finishedAt: "1970-01-01T00:00:00.999999Z" }, 400, "finishedAt"],
      [{ resultNote: " " }, 400, "resultNote"],
    ] as const) {
      try {
        checkMaintenanceResultUpdate(body, 1_000_000n);
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(ContractException);
        expect((error as ContractException).getStatus()).toBe(status);
        expect((error as ContractException).errors[0].field).toBe(name);
      }
    }
  });
});

describe("checkMaintenanceResultCreate", () => {
  it("µs 시각·빈 배열·내부 수행자를 손실 없이 준비한다", () => {
    const checked = checkMaintenanceResultCreate(base());
    expect(checked.startedAt.utcIso).toBe("2026-09-01T00:00:00.123456Z");
    expect(checked.finishedAt).toBeNull();
    expect(checked.lines).toEqual([]);
    expect(checked.parts).toEqual([]);
    expect(checked.performedByUserId).toBe(13n);
  });

  it.each([
    [{ resetCounter: true }, 422, "resetCounter"],
    [{ closed: true }, 422, "closed"],
    [{ shotCountAfterReset: 0 }, 400, "shotCountAfterReset"],
    [{ finishedAt: "2026-08-31T23:59:59Z" }, 400, "finishedAt"],
    [{ resultNote: "  " }, 400, "resultNote"],
  ])("미정 옵션·역전·빈 노트를 명시 거부한다", (change, status, name) => {
    expectFailure({ ...base(), ...change }, status, name);
  });

  it.each([
    [{ performedByUserId: null }, "performedByUserId"],
    [{ outsourceVendorName: "외주사" }, "outsourceVendorName"],
    [
      {
        isOutsourced: true,
        performedByUserId: 13,
        outsourceVendorName: "외주사",
      },
      "performedByUserId",
    ],
    [
      { isOutsourced: true, performedByUserId: null, outsourceVendorName: " " },
      "outsourceVendorName",
    ],
  ])("내부·외주 수행자 짝을 검증한다", (change, name) => {
    expectFailure({ ...base(), ...change }, 400, name);
  });

  it("중복 지시 항목을 거부하고 자유 입력 part 이름은 보존한다", () => {
    expectFailure(
      {
        ...base(),
        lines: [
          { orderItemId: 21, resultCode: "OK" },
          { orderItemId: 21, resultCode: "NG" },
        ],
      },
      400,
      "lines[1].orderItemId",
    );
    const checked = checkMaintenanceResultCreate({
      ...base(),
      parts: [{ sparePartId: 31, partName: "원문", usedQty: 1.123456 }],
    });
    expect(checked.parts[0].partName).toBe("원문");
    expect(checked.parts[0].usedQty.toFixed(6)).toBe("1.123456");
  });

  it.each([0, -1, 0.0000001, 100000000000000, Number.POSITIVE_INFINITY])(
    "numeric(20,6)에 무손실 저장할 수 없는 수량 %p을 거부한다",
    (usedQty) => {
      expectFailure(
        { ...base(), parts: [{ sparePartId: 31, usedQty }] },
        400,
        "parts[0].usedQty",
      );
    },
  );
});

function expectFailure(
  input: MaintenanceResultCreate,
  status: number,
  field: string,
): void {
  try {
    checkMaintenanceResultCreate(input);
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(status);
    expect((error as ContractException).errors[0].field).toBe(field);
  }
}
