import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { ToolUsageQueryService } from "./tool-usage-query.service";
import { ToolUsageProjection } from "./tool-usage-view";

describe("ToolUsageQueryService", () => {
  const raw = jest.fn();
  const service = new ToolUsageQueryService({ $queryRaw: raw } as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it("상세를 한 번 읽고 마이크로초 projection을 사용한다", async () => {
    raw.mockResolvedValueOnce([projection()]);
    await expect(service.get(11)).resolves.toMatchObject({ toolUsageId: 11 });
    const sql = raw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain("extract(epoch FROM u.occurred_at)");
    expect(sql.values).toEqual([11n]);
  });

  it("없는 행은 404, 안전 범위 밖 ID는 DB 전에 400이다", async () => {
    raw.mockResolvedValueOnce([]);
    await expect(service.get(99)).rejects.toMatchObject({ status: 404 });
    await expect(service.get(Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "toolUsageId", code: "RANGE" }],
    });
    expect(raw).toHaveBeenCalledTimes(1);
  });
});

function projection(): ToolUsageProjection {
  return {
    tool_usage_id: 11n,
    mold_id: 12n,
    mold_code: "MOLD-12",
    work_order_id: 13n,
    shot_count: 1n,
    collection_method_code: "DIRECT",
    conversion_base_qty: null,
    conversion_ratio: null,
    occurred_epoch_microseconds: "1788915723123456",
    worker_no: "3391",
  };
}
