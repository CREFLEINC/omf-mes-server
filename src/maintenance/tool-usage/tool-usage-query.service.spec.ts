import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { ToolUsageQueryService } from "./tool-usage-query.service";
import { ToolUsageProjection } from "./tool-usage-view";

describe("ToolUsageQueryService", () => {
  const raw = jest.fn();
  const tx = { $queryRaw: raw };
  const transaction = jest.fn(
    async (
      work: (client: typeof tx) => Promise<unknown>,
      _options?: { isolationLevel: string },
    ) => work(tx),
  );
  const service = new ToolUsageQueryService({
    $queryRaw: raw,
    $transaction: transaction,
  } as unknown as PrismaService);

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

  it("목록의 정렬·count·page·projection을 한 스냅샷에서 읽는다", async () => {
    raw
      .mockResolvedValueOnce([{ tool_usage_id: 11n }])
      .mockResolvedValueOnce([{ total: 1n }])
      .mockResolvedValueOnce([projection()]);
    await expect(service.list({ moldId: 12, page: 2, size: 1 })).resolves.toMatchObject({
      items: [{ toolUsageId: 11 }],
      totalCount: 1,
      page: { page: 2, size: 1, total: 1 },
    });
    const [ids, count, projected] = raw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    expect(ids.sql).toContain("ORDER BY u.occurred_at DESC NULLS LAST");
    expect(ids.values.slice(0, -2)).toEqual(count.values);
    expect(projected.values).toEqual([11n]);
    expect(transaction.mock.calls[0][1]).toEqual({ isolationLevel: "RepeatableRead" });
  });

  it("공장 달력일 경계와 필수 시각 결손 검사를 날짜 WHERE보다 먼저 만든다", async () => {
    raw
      .mockResolvedValueOnce([
        { plant_id: 7n, timezone_code: "Asia/Ho_Chi_Minh", has_missing_time: false },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);
    await service.list({ occurredFrom: "2026-09-09", occurredTo: "2026-09-09" });
    const [metadata, ids, count] = raw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    expect(metadata.sql).toContain("bool_or(u.occurred_at IS NULL)");
    expect(ids.values.slice(0, -2)).toEqual(count.values);
    expect(count.values).toEqual([
      7n,
      new Date("2026-09-08T17:00:00.000Z"),
      new Date("2026-09-09T17:00:00.000Z"),
    ]);
  });

  it("역전 기간과 안전 범위 밖 질의는 DB 전에 끝낸다", async () => {
    await expect(
      service.list({ occurredFrom: "2026-09-10", occurredTo: "2026-09-09" }),
    ).resolves.toMatchObject({ items: [], totalCount: 0 });
    await expect(service.list({ moldId: Number.MAX_SAFE_INTEGER + 1 })).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "moldId", code: "RANGE" }],
    });
    expect(transaction).not.toHaveBeenCalled();
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
