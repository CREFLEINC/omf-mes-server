import { Prisma } from "@prisma/client";

import {
  ResultLineProjection,
  ResultPartProjection,
  ResultProjection,
  maintenanceResultViews,
} from "./result-view";

describe("maintenanceResultViews", () => {
  it("E-Q02 header·line·part 전 필드와 false·µs6를 보존한다", () => {
    const views = maintenanceResultViews([result()], [line()], [part()]);
    expect(views).toEqual([
      {
        maintenanceResultId: 11,
        maintenanceOrderId: 12,
        breakdownId: 13,
        targetTypeCode: "EQUIPMENT",
        targetId: 14,
        startedAt: "2026-09-01T01:02:03.123456Z",
        finishedAt: "2026-09-01T02:03:04.654321Z",
        resultNote: "실적 원문",
        performedByUserId: 15,
        isOutsourced: false,
        outsourceVendorName: null,
        resetCounter: false,
        shotCountBeforeReset: null,
        shotCountAfterReset: 0,
        closed: false,
        lines: [
          {
            orderItemId: 21,
            partName: null,
            resultCode: "CUSTOM_RESULT",
            remarks: "라인 원문",
          },
        ],
        parts: [
          {
            sparePartId: 31,
            partName: "교체품 원문",
            usedQty: 2.5,
            goodsIssueId: 32,
            goodsIssueNo: "GI-32",
            issuedAt: "2026-08-14T02:12:00.111222Z",
            uomCode: "EA",
          },
        ],
      },
    ]);
  });

  it("구 unknown boolean은 생략하고 nullable·빈 자식은 그대로 둔다", () => {
    const view = maintenanceResultViews(
      [
        result({
          target_type_code: "MOLD",
          equipment_id: null,
          mold_id: 44n,
          maintenance_order_id: null,
          breakdown_id: null,
          performed_by_user_id: null,
          is_outsourced: null,
          reset_counter: null,
          closed: null,
          finished_epoch_microseconds: null,
        }),
      ],
      [],
      [],
    )[0];
    expect(view).toMatchObject({
      targetTypeCode: "MOLD",
      targetId: 44,
      maintenanceOrderId: null,
      breakdownId: null,
      performedByUserId: null,
      finishedAt: null,
      lines: [],
      parts: [],
    });
    expect(view).not.toHaveProperty("isOutsourced");
    expect(view).not.toHaveProperty("resetCounter");
    expect(view).not.toHaveProperty("closed");
  });

  it("partName 미제공은 master명으로 꾸미지 않고 키를 생략한다", () => {
    const row = part({
      part_name: null,
      goods_issue_id: null,
      goods_issue_no: null,
      issued_epoch_microseconds: null,
    });
    const item = maintenanceResultViews([result()], [], [row])[0].parts[0];
    expect(item).not.toHaveProperty("partName");
    expect(item).toMatchObject({
      goodsIssueId: null,
      goodsIssueNo: null,
      issuedAt: null,
    });
  });

  it.each([
    { result_note: null },
    { target_type_code: "LEGACY" },
    { target_type_code: "EQUIPMENT", equipment_id: null },
  ])("E-Q08 required 구행은 응답으로 보정하지 않는다: %j", (change) => {
    expect(() => maintenanceResultViews([result(change)], [], [])).toThrow();
  });

  it("식별자·누계의 안전범위를 넘으면 반올림하지 않는다", () => {
    const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() =>
      maintenanceResultViews(
        [result({ maintenance_result_id: unsafe })],
        [],
        [],
      ),
    ).toThrow("safe range");
    expect(() =>
      maintenanceResultViews(
        [result({ shot_count_before_reset: unsafe })],
        [],
        [],
      ),
    ).toThrow("safe range");
  });

  it("negative epoch와 ISO year 0000을 공통 µs projection으로 반환한다", () => {
    const [negative, yearZero] = maintenanceResultViews(
      [
        result({
          maintenance_result_id: 101n,
          started_epoch_microseconds: "-1",
        }),
        result({
          maintenance_result_id: 102n,
          started_epoch_microseconds: "-62167219200000000",
        }),
      ],
      [],
      [],
    );
    expect(negative.startedAt).toBe("1969-12-31T23:59:59.999999Z");
    expect(yearZero.startedAt).toBe("0000-01-01T00:00:00.000000Z");
  });
});

function result(change: Partial<ResultProjection> = {}): ResultProjection {
  return {
    maintenance_result_id: 11n,
    maintenance_order_id: 12n,
    breakdown_id: 13n,
    target_type_code: "EQUIPMENT",
    equipment_id: 14n,
    mold_id: null,
    started_epoch_microseconds: epoch("2026-09-01T01:02:03.123Z", 456),
    finished_epoch_microseconds: epoch("2026-09-01T02:03:04.654Z", 321),
    result_note: "실적 원문",
    performed_by_user_id: 15n,
    is_outsourced: false,
    outsource_vendor_name: null,
    reset_counter: false,
    shot_count_before_reset: null,
    shot_count_after_reset: 0n,
    closed: false,
    version_no: 7,
    ...change,
  };
}

function line(
  change: Partial<ResultLineProjection> = {},
): ResultLineProjection {
  return {
    maintenance_result_id: 11n,
    sequence_no: 1,
    maintenance_order_item_id: 21n,
    part_name: null,
    result_code: "CUSTOM_RESULT",
    remarks: "라인 원문",
    ...change,
  };
}

function part(
  change: Partial<ResultPartProjection> = {},
): ResultPartProjection {
  return {
    maintenance_result_id: 11n,
    sequence_no: 1,
    spare_part_id: 31n,
    part_name: "교체품 원문",
    used_qty: new Prisma.Decimal("2.500000"),
    goods_issue_id: 32n,
    goods_issue_no: "GI-32",
    issued_epoch_microseconds: epoch("2026-08-14T02:12:00.111Z", 222),
    uom_code: "EA",
    ...change,
  };
}

function epoch(millisIso: string, remainingMicroseconds: number): string {
  return (
    BigInt(Date.parse(millisIso)) * 1000n +
    BigInt(remainingMicroseconds)
  ).toString();
}
