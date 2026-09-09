import { Prisma } from "@prisma/client";

import { ToolUsageProjection, toolUsageView } from "./tool-usage-view";

describe("toolUsageView", () => {
  it("필수 일곱 칸과 DIRECT의 nullable 환산값을 정확히 반환한다", () => {
    expect(toolUsageView(projection())).toEqual({
      toolUsageId: 11,
      moldId: 12,
      moldCode: "MOLD-12",
      workOrderId: 13,
      shotCount: 1250,
      collectionMethodCode: "DIRECT",
      conversionBaseQty: null,
      conversionRatio: null,
      occurredAt: "2026-09-09T01:02:03.123456Z",
      recordedByWorkerNo: "3391",
    });
  });

  it("CONVERTED의 입력 당시 환산 근거를 반환한다", () => {
    expect(
      toolUsageView({
        ...projection(),
        collection_method_code: "CONVERTED",
        conversion_base_qty: new Prisma.Decimal("5000.000000"),
        conversion_ratio: new Prisma.Decimal("0.250000"),
      }),
    ).toMatchObject({ conversionBaseQty: 5000, conversionRatio: 0.25 });
  });

  it.each([
    ["work_order_id", null],
    ["shot_count", null],
    ["collection_method_code", null],
    ["occurred_epoch_microseconds", null],
    ["worker_no", null],
  ] as const)("과거 필수 결손 %s를 보간하지 않는다", (name, value) => {
    expect(() => toolUsageView({ ...projection(), [name]: value })).toThrow("required tool usage");
  });

  it("닫힌 수집 방식과 환산값 짝을 저장 오류로 구분한다", () => {
    expect(() =>
      toolUsageView({ ...projection(), collection_method_code: "OTHER" }),
    ).toThrow("collection method");
    expect(() =>
      toolUsageView({ ...projection(), conversion_base_qty: new Prisma.Decimal(1) }),
    ).toThrow("conversion pair");
  });

  it("안전 정수 밖 저장값을 반올림하지 않는다", () => {
    expect(() =>
      toolUsageView({
        ...projection(),
        shot_count: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    ).toThrow("safe range");
  });
});

function projection(): ToolUsageProjection {
  return {
    tool_usage_id: 11n,
    mold_id: 12n,
    mold_code: "MOLD-12",
    work_order_id: 13n,
    shot_count: 1250n,
    collection_method_code: "DIRECT",
    conversion_base_qty: null,
    conversion_ratio: null,
    occurred_epoch_microseconds: "1788915723123456",
    worker_no: "3391",
  };
}
