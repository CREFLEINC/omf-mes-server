import { Prisma } from "@prisma/client";

import {
  checkToolUsageCreate,
  ToolUsageCreate,
} from "./tool-usage-write-input";

describe("checkToolUsageCreate", () => {
  it("DIRECT는 양의 안전 정수와 단말 발생시각을 보존한다", () => {
    expect(checkToolUsageCreate(create())).toEqual({
      moldId: 11n,
      workOrderId: 21n,
      shotCount: 7n,
      collectionMethodCode: "DIRECT",
      conversionBaseQty: null,
      conversionRatio: null,
      occurredAt: expect.objectContaining({
        epochMicroseconds: 1788663600123456n,
        utcIso: "2026-09-06T03:00:00.123456Z",
      }),
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "타발수 %p는 RANGE다",
    (shotCount) => {
      expect(() => checkToolUsageCreate(create({ shotCount }))).toThrow(
        expect.objectContaining({
          errors: [
            expect.objectContaining({ field: "shotCount", code: "RANGE" }),
          ],
        }),
      );
    },
  );

  it("CONVERTED는 제출 타발수를 다시 계산하지 않고 환산 근거를 보존한다", () => {
    const checked = checkToolUsageCreate(
      create({
        shotCount: 1,
        collectionMethodCode: "CONVERTED",
        conversionBaseQty: 1,
        conversionRatio: 1.234567,
      }),
    );
    expect(checked.shotCount).toBe(1n);
    expect(checked.conversionBaseQty).toEqual(new Prisma.Decimal(1));
    expect(checked.conversionRatio).toEqual(new Prisma.Decimal("1.234567"));
  });

  it.each([
    [{ collectionMethodCode: "CONVERTED" }, "conversionBaseQty", "REQUIRED"],
    [
      { collectionMethodCode: "CONVERTED", conversionBaseQty: 1 },
      "conversionRatio",
      "PAIR",
    ],
    [
      {
        collectionMethodCode: "CONVERTED",
        conversionBaseQty: 0,
        conversionRatio: 1,
      },
      "conversionBaseQty",
      "RANGE",
    ],
    [
      {
        collectionMethodCode: "CONVERTED",
        conversionBaseQty: 1,
        conversionRatio: 0.0000001,
      },
      "conversionRatio",
      "RANGE",
    ],
    [
      {
        collectionMethodCode: "CONVERTED",
        conversionBaseQty: 100000000000000,
        conversionRatio: 1,
      },
      "conversionBaseQty",
      "RANGE",
    ],
  ] as const)("환산 입력 %p는 %s %s다", (overrides, name, code) => {
    expect(() =>
      checkToolUsageCreate(create(overrides as Partial<ToolUsageCreate>)),
    ).toThrow(
      expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({ field: name, code }),
        ]),
      }),
    );
  });

  it("DIRECT에 숫자 환산 근거가 있으면 버리지 않고 거부한다", () => {
    expect(() => checkToolUsageCreate(create({ conversionRatio: 1 }))).toThrow(
      expect.objectContaining({
        errors: [
          expect.objectContaining({
            field: "conversionRatio",
            code: "INVALID",
          }),
        ],
      }),
    );
  });

  it("ID 안전 범위와 발생시각 µs 범위를 검사한다", () => {
    expect(() =>
      checkToolUsageCreate(create({ moldId: Number.MAX_SAFE_INTEGER + 1 })),
    ).toThrow(
      expect.objectContaining({
        errors: [expect.objectContaining({ field: "moldId" })],
      }),
    );
    expect(() =>
      checkToolUsageCreate(
        create({ occurredAt: "2026-09-06T03:00:00.1234561Z" }),
      ),
    ).toThrow(
      expect.objectContaining({
        errors: [
          expect.objectContaining({ field: "occurredAt", code: "RANGE" }),
        ],
      }),
    );
  });
});

function create(overrides: Partial<ToolUsageCreate> = {}): ToolUsageCreate {
  return {
    moldId: 11,
    workOrderId: 21,
    shotCount: 7,
    collectionMethodCode: "DIRECT",
    occurredAt: "2026-09-06T10:00:00.123456+07:00",
    ...overrides,
  };
}
