import { Prisma } from "@prisma/client";

import { ConflictException, ContractException } from "../../common/errors";
import { checkMaintenanceResultCreate } from "./result-write-input";
import { resolveMaintenanceResultCreateReferences } from "./result-write-references";

describe("resolveMaintenanceResultCreateReferences", () => {
  it("대상→지시→수행자→지시항목→코드 순으로 현재 참조를 확정한다", async () => {
    const { tx, queries } = fake([
      [{ target_id: 11n, plant_id: 1n, version_no: 3 }],
      [order()],
      [{ app_user_id: 13n }],
      [{ maintenance_order_item_id: 21n }],
      [{ code: "DONE_CUSTOM" }],
    ]);
    await resolveMaintenanceResultCreateReferences(tx, checked(), undefined);
    expect(queries).toHaveBeenCalledTimes(5);
  });

  it("금형에는 지시가 필요하고 설비에 보낸 If-Match는 명시 거부한다", async () => {
    const mold = checkMaintenanceResultCreate({
      ...body(),
      targetTypeCode: "MOLD",
      maintenanceOrderId: null,
      breakdownId: null,
      lines: [],
    });
    await expectFailure(
      resolveMaintenanceResultCreateReferences(
        fake([[{ target_id: 11n, plant_id: 1n, version_no: 3 }]]).tx,
        mold,
        undefined,
      ),
      ContractException,
      400,
    );
    await expectFailure(
      resolveMaintenanceResultCreateReferences(
        fake([[{ target_id: 11n, plant_id: 1n, version_no: 3 }]]).tx,
        checked(),
        3,
      ),
      ContractException,
      400,
    );
  });

  it("금형 ETag가 바뀌면 저장 충돌로 거부한다", async () => {
    const input = checkMaintenanceResultCreate({
      ...body(),
      targetTypeCode: "MOLD",
      breakdownId: null,
      lines: [],
    });
    await expectFailure(
      resolveMaintenanceResultCreateReferences(
        fake([[{ target_id: 11n, plant_id: 1n, version_no: 4 }]]).tx,
        input,
        3,
      ),
      ConflictException,
      409,
    );
  });

  it("다른 지시 항목과 비활성 결과코드를 거부한다", async () => {
    const { tx } = fake([
      [{ target_id: 11n, plant_id: 1n, version_no: 3 }],
      [order()],
      [{ app_user_id: 13n }],
      [],
    ]);
    await expectFailure(
      resolveMaintenanceResultCreateReferences(tx, checked(), undefined),
      ContractException,
      400,
    );

    const second = fake([
      [{ target_id: 11n, plant_id: 1n, version_no: 3 }],
      [order()],
      [{ app_user_id: 13n }],
      [{ maintenance_order_item_id: 21n }],
      [],
    ]);
    await expectFailure(
      resolveMaintenanceResultCreateReferences(second.tx, checked(), undefined),
      ContractException,
      400,
    );
  });

  it("예비품은 현재 설비 매핑과 POSTED 출고의 실제 spare line을 요구한다", async () => {
    const input = checkMaintenanceResultCreate({
      ...body(),
      parts: [{ sparePartId: 31, usedQty: 2, goodsIssueId: 41 }],
    });
    const success = fake(
      [
        [{ target_id: 11n, plant_id: 1n, version_no: 3 }],
        [order()],
        [{ app_user_id: 13n }],
        [{ maintenance_order_item_id: 21n }],
        [{ code: "DONE_CUSTOM" }],
        [{ spare_part_id: 31n, plant_id: 1n, is_active: true }],
        [{ goods_issue_id: 41n, plant_id: 1n, status_code: "POSTED" }],
      ],
      [{ spare_part_id: 31n }],
      [{ goods_issue_id: 41n, spare_part_id: 31n }],
    );
    await resolveMaintenanceResultCreateReferences(
      success.tx,
      input,
      undefined,
    );

    const missingLine = fake(
      [
        [{ target_id: 11n, plant_id: 1n, version_no: 3 }],
        [order()],
        [{ app_user_id: 13n }],
        [{ maintenance_order_item_id: 21n }],
        [{ code: "DONE_CUSTOM" }],
        [{ spare_part_id: 31n, plant_id: 1n, is_active: true }],
        [{ goods_issue_id: 41n, plant_id: 1n, status_code: "POSTED" }],
      ],
      [{ spare_part_id: 31n }],
      [],
    );
    await expectFailure(
      resolveMaintenanceResultCreateReferences(
        missingLine.tx,
        input,
        undefined,
      ),
      ContractException,
      400,
    );
  });
});

function body() {
  return {
    targetTypeCode: "EQUIPMENT" as const,
    targetId: 11,
    maintenanceOrderId: 12,
    startedAt: "2026-09-01T00:00:00Z",
    resultNote: "조치",
    performedByUserId: 13,
    lines: [{ orderItemId: 21, resultCode: "DONE_CUSTOM" }],
  };
}

function checked() {
  return checkMaintenanceResultCreate(body());
}

function order() {
  return {
    maintenance_order_id: 12n,
    target_type_code: "EQUIPMENT",
    equipment_id: 11n,
    mold_id: null,
    breakdown_id: null,
    order_type_code: "CORRECTIVE",
    status_code: "ISSUED",
  };
}

function fake(
  queryResults: unknown[][],
  mappings: { spare_part_id: bigint }[] = [],
  issueLines: { goods_issue_id: bigint; spare_part_id: bigint }[] = [],
) {
  const queries = jest.fn();
  queryResults.forEach((result) => queries.mockResolvedValueOnce(result));
  const tx = {
    $queryRaw: queries,
    maintenance_order_trigger: { count: jest.fn().mockResolvedValue(0) },
    spare_part_equipment: { findMany: jest.fn().mockResolvedValue(mappings) },
    goods_issue_spare_line: {
      findMany: jest.fn().mockResolvedValue(issueLines),
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, queries };
}

async function expectFailure(
  promise: Promise<unknown>,
  type: typeof ContractException | typeof ConflictException,
  status: number,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(type);
    expect((error as ContractException).getStatus()).toBe(status);
  }
}
