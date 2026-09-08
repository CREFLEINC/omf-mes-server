import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { MaintenanceResultQueryService } from "./result-query.service";
import { ResultProjection } from "./result-view";

describe("MaintenanceResultQueryService", () => {
  const raw = jest.fn();
  const tx = { $queryRaw: raw };
  const transaction = jest.fn(
    async (
      work: (client: typeof tx) => Promise<unknown>,
      _options?: { isolationLevel: string },
    ) => work(tx),
  );
  const service = new MaintenanceResultQueryService({
    $transaction: transaction,
  } as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it("공장별 달력·count/page WHERE를 공유하고 자식·GI 단위를 batch projection한다", async () => {
    raw
      .mockResolvedValueOnce([
        {
          plant_id: 10n,
          timezone_code: "Asia/Ho_Chi_Minh",
          has_invalid_target: false,
        },
        {
          plant_id: 20n,
          timezone_code: "Asia/Seoul",
          has_invalid_target: false,
        },
      ])
      .mockResolvedValueOnce([{ maintenance_result_id: 11n }])
      .mockResolvedValueOnce([{ total: 1n }])
      .mockResolvedValueOnce([projection()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const result = await service.list({
      maintenanceOrderId: 5,
      targetTypeCode: "MOLD",
      targetId: 7,
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
      page: 2,
      size: 1,
    });
    const calls = raw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    const [metadata, ids, count, headers, lines, parts] = calls;
    const whereOf = (sql: Prisma.Sql): string =>
      sql.sql.slice(sql.sql.indexOf("WHERE ")).split("ORDER BY")[0].trim();
    expect(whereOf(ids)).toBe(whereOf(count));
    expect(ids.values.slice(0, -2)).toEqual(count.values);
    expect(metadata.values).toEqual([5, "MOLD", 7]);
    expect(count.values).toEqual([
      5,
      "MOLD",
      7,
      10n,
      new Date("2026-08-31T17:00:00Z"),
      new Date("2026-09-01T17:00:00Z"),
      20n,
      new Date("2026-08-31T15:00:00Z"),
      new Date("2026-09-01T15:00:00Z"),
    ]);
    expect(ids.sql).toContain(
      "ORDER BY r.started_at DESC, r.maintenance_result_id DESC",
    );
    expect(headers.sql).toContain("extract(epoch FROM r.started_at)");
    expect(lines.sql).toContain("ORDER BY maintenance_result_id, sequence_no");
    expect(parts.sql).toContain("count(DISTINCT line.uom_id)");
    expect(parts.sql).toContain("THEN base_uom.uom_code");
    expect(transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "RepeatableRead",
    });
    expect(result).toMatchObject({
      totalCount: 1,
      page: { page: 2, size: 1, total: 1 },
      items: [{ maintenanceResultId: 11 }],
    });
  });

  it("날짜와 결과가 없으면 metadata·projection query를 생략한다", async () => {
    raw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0n }]);
    const result = await service.list({ targetId: 7 });
    expect(raw).toHaveBeenCalledTimes(2);
    expect((raw.mock.calls[0][0] as Prisma.Sql).sql).toContain(
      "r.equipment_id = ? OR r.mold_id = ?",
    );
    expect(result.items).toEqual([]);
  });

  it("관련 후보의 target·공장 결손을 날짜 WHERE로 숨기지 않는다", async () => {
    raw.mockResolvedValueOnce([
      { plant_id: null, timezone_code: null, has_invalid_target: true },
    ]);
    await expect(service.list({ startedFrom: "2026-09-01" })).rejects.toThrow(
      "required maintenance result target",
    );
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ startedFrom: "2026-09-02", startedTo: "2026-09-01" }, "startedTo"],
    [{ page: Number.MAX_SAFE_INTEGER, size: 200 }, "page"],
    [{ maintenanceOrderId: Number.MAX_SAFE_INTEGER + 1 }, "maintenanceOrderId"],
    [{ targetId: Number.MAX_SAFE_INTEGER + 1 }, "targetId"],
  ])("역전·안전범위 초과는 DB 전에 400 RANGE다", async (query, name) => {
    await expect(service.list(query)).rejects.toMatchObject({
      status: 400,
      errors: [{ field: name, code: "RANGE" }],
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("상세은 version과 view를 반환하고 없는 ID는 404다", async () => {
    raw
      .mockResolvedValueOnce([projection()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(service.get(11)).resolves.toMatchObject({
      versionNo: 7,
      view: { maintenanceResultId: 11 },
    });
    raw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(service.get(99)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.get(Number.MAX_SAFE_INTEGER + 1),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

function projection(): ResultProjection {
  return {
    maintenance_result_id: 11n,
    maintenance_order_id: null,
    breakdown_id: null,
    target_type_code: "EQUIPMENT",
    equipment_id: 12n,
    mold_id: null,
    started_epoch_microseconds: "1788224523123456",
    finished_epoch_microseconds: null,
    result_note: "원문",
    performed_by_user_id: null,
    is_outsourced: false,
    outsource_vendor_name: null,
    reset_counter: false,
    shot_count_before_reset: null,
    shot_count_after_reset: null,
    closed: false,
    version_no: 7,
  };
}
