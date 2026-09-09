import { Prisma } from "@prisma/client";

import { ToolUsageCreateService } from "./tool-usage-create.service";
import { ToolUsageWriteContext } from "./tool-usage-write-context";
import { ToolUsageCreate } from "./tool-usage-write-input";

describe("ToolUsageCreateService", () => {
  const service = new ToolUsageCreateService();

  it("같은 tx에서 NO KEY UPDATE 잠금·이력·누계와 version을 반영한다", async () => {
    const tx = transaction();
    const response = await service.createWithin(
      tx as never,
      input(),
      context(),
    );

    expect(response).toEqual({
      toolUsageId: 31,
      moldId: 11,
      moldCode: "M-11",
      workOrderId: 21,
      shotCount: 7,
      collectionMethodCode: "DIRECT",
      conversionBaseQty: null,
      conversionRatio: null,
      occurredAt: "2026-09-06T03:00:00.123456Z",
      recordedByWorkerNo: "W-017",
      cumulativeShotCount: 97,
      cumulativeAsOf: "2026-09-06T03:00:01.654321Z",
    });
    const sql = tx.$queryRaw.mock.calls
      .map(([query]) => text(query))
      .join("\n");
    expect(sql).toContain("FOR NO KEY UPDATE");
    expect(sql).toContain("INSERT INTO maintenance.tool_usage");
    expect(sql).toContain("current_shot_count = current_shot_count +");
    expect(sql).toContain("version_no = version_no + 1");
  });

  it.each([
    ["worker", null, "X-Worker-No"],
    ["work_order", null, "workOrderId"],
  ] as const)(
    "없는 %s 참조는 쓰기 전 INVALID다",
    async (target, value, field) => {
      const tx = transaction();
      tx[target].findUnique.mockResolvedValue(value);
      await expect(
        service.createWithin(tx as never, input(), context()),
      ).rejects.toMatchObject({
        status: 400,
        errors: [expect.objectContaining({ field, code: "INVALID" })],
      });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it("폐기 툴은 422이고 이력과 누계를 쓰지 않는다", async () => {
    const tx = transaction({ status_code: "DISPOSED" });
    await expect(
      service.createWithin(tx as never, input(), context()),
    ).rejects.toMatchObject({
      status: 422,
      errors: [
        expect.objectContaining({ field: "moldId", code: "STATE_LOCKED" }),
      ],
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("요청 가산으로 안전 범위를 넘으면 shotCount RANGE다", async () => {
    const tx = transaction({
      current_shot_count: BigInt(Number.MAX_SAFE_INTEGER),
    });
    await expect(
      service.createWithin(tx as never, input(), context()),
    ).rejects.toMatchObject({
      status: 400,
      errors: [expect.objectContaining({ field: "shotCount", code: "RANGE" })],
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])(
    "저장 누계 %s의 손상은 입력 오류로 바꾸지 않는다",
    async (current_shot_count) => {
      const tx = transaction({ current_shot_count });
      await expect(
        service.createWithin(tx as never, input(), context()),
      ).rejects.toThrow("Stored mold shot count exceeds safe range");
    },
  );
});

function transaction(mold: Partial<MoldRow> = {}) {
  const projection = {
    tool_usage_id: 31n,
    mold_id: 11n,
    mold_code: "M-11",
    work_order_id: 21n,
    shot_count: 7n,
    collection_method_code: "DIRECT",
    conversion_base_qty: null,
    conversion_ratio: null,
    occurred_epoch_microseconds: "1788663600123456",
    worker_no: "W-017",
  };
  return {
    worker: { findUnique: jest.fn().mockResolvedValue({ worker_id: 17n }) },
    work_order: {
      findUnique: jest.fn().mockResolvedValue({ work_order_id: 21n }),
    },
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([
        {
          mold_id: 11n,
          current_shot_count: 90n,
          status_code: "IN_USE",
          ...mold,
        },
      ])
      .mockResolvedValueOnce([{ tool_usage_id: 31n }])
      .mockResolvedValueOnce([
        {
          current_shot_count: 97n,
          updated_epoch_microseconds: "1788663601654321",
        },
      ])
      .mockResolvedValueOnce([projection]),
  };
}

type MoldRow = {
  mold_id: bigint;
  current_shot_count: bigint;
  status_code: string;
};

function input(): ToolUsageCreate {
  return {
    moldId: 11,
    workOrderId: 21,
    shotCount: 7,
    collectionMethodCode: "DIRECT",
    occurredAt: "2026-09-06T10:00:00.123456+07:00",
  };
}

function context(): ToolUsageWriteContext {
  return {
    key: "idem-1",
    fingerprint: "fingerprint",
    appUserId: 9,
    workerNo: "W-017",
    successStatus: 201,
  };
}

function text(query: Prisma.Sql): string {
  return query.strings.join("?");
}
