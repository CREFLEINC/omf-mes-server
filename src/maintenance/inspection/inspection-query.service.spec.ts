import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { InspectionQueryService } from "./inspection-query.service";
import { InspectionRow } from "./inspection-view";

describe("InspectionQueryService", () => {
  const raw = jest.fn();
  const findMany = jest.fn();
  const findUnique = jest.fn();
  const tx = { $queryRaw: raw, equipment_inspection: { findMany, findUnique } };
  const transaction = jest.fn(
    async (
      work: (client: typeof tx) => Promise<unknown>,
      _options?: { isolationLevel: string },
    ) => work(tx),
  );
  const service = new InspectionQueryService({
    $transaction: transaction,
    equipment_inspection: { findUnique },
  } as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it("query count와 page가 같은 WHERE를 사용하고 공장 metadata도 선행 필터를 공유한다", async () => {
    raw
      .mockResolvedValueOnce([
        {
          plant_id: 10n,
          timezone_code: "Asia/Ho_Chi_Minh",
          has_missing_time: false,
        },
        { plant_id: 20n, timezone_code: "Asia/Seoul", has_missing_time: false },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 4n }]);
    findMany.mockResolvedValue([]);
    const result = await service.list({
      equipmentId: 5,
      inspectionTypeCode: "CUSTOM' --",
      overallResultCode: "FAIL",
      withoutMaintenanceOrder: true,
      inspectedFrom: "2026-09-01",
      inspectedTo: "2026-09-01",
      sort: "inspectedAtAsc",
      page: 2,
      size: 1,
    });
    const [metadata, page, count] = raw.mock.calls.map(
      ([sql]) => sql as Prisma.Sql,
    );
    const whereOf = (sql: Prisma.Sql): string =>
      sql.sql.slice(sql.sql.indexOf("WHERE ")).split("ORDER BY")[0].trim();
    expect(whereOf(page)).toBe(whereOf(count));
    expect(page.values.slice(0, -2)).toEqual(count.values);
    expect(count.values.slice(0, metadata.values.length)).toEqual(
      metadata.values,
    );
    expect(metadata.values).toEqual([5, "CUSTOM' --", "FAIL"]);
    expect(metadata.sql).not.toContain("CUSTOM' --");
    expect(metadata.sql).toContain("t.trigger_type_code = 'INSPECTION_NG'");
    expect(metadata.sql).toContain("bool_or(i.inspected_at IS NULL)");
    expect(metadata.sql).toContain("GROUP BY p.plant_id, p.timezone_code");
    expect(count.values).toEqual([
      5,
      "CUSTOM' --",
      "FAIL",
      10n,
      new Date("2026-08-31T17:00:00Z"),
      new Date("2026-09-01T17:00:00Z"),
      20n,
      new Date("2026-08-31T15:00:00Z"),
      new Date("2026-09-01T15:00:00Z"),
    ]);
    expect(page.sql).toMatch(
      /ORDER BY i.inspected_at ASC NULLS LAST, i.equipment_inspection_id ASC/,
    );
    expect(transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "RepeatableRead",
    });
    expect(result).toEqual({
      items: [],
      totalCount: 4,
      page: { page: 2, size: 1, total: 4 },
    });
  });

  it("기간 후보의 시각 결손은 날짜 WHERE로 숨기지 않고 page/count 전에 실패한다", async () => {
    // 설계 미정 — 문의 091: 시각 없는 행을 특정 기간에 포함/제외했다고 꾸미지 않는다.
    raw.mockResolvedValueOnce([
      {
        plant_id: 10n,
        timezone_code: "Asia/Ho_Chi_Minh",
        has_missing_time: true,
      },
    ]);
    await expect(
      service.list({
        inspectedFrom: "2026-09-01",
        inspectedTo: "2026-09-01",
        size: 1,
      }),
    ).rejects.toThrow("Missing required inspection time");
    expect(raw).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("페이지 재조회가 행을 잃으면 조용한 빈 목록으로 바꾸지 않는다", async () => {
    raw
      .mockResolvedValueOnce([{ equipment_inspection_id: 7n }])
      .mockResolvedValueOnce([{ total: 1n }]);
    findMany.mockResolvedValue([]);
    await expect(
      service.list({ withoutMaintenanceOrder: true }),
    ).rejects.toThrow("read snapshot");
  });

  it("기간 없는 미발행은 시간대 metadata를 조회하지 않는다", async () => {
    raw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0n }]);
    findMany.mockResolvedValue([]);
    await service.list({ withoutMaintenanceOrder: true });
    expect(raw).toHaveBeenCalledTimes(2);
    expect((raw.mock.calls[0][0] as Prisma.Sql).sql).toContain(
      "DESC NULLS LAST",
    );
  });

  it("역전은 시간대 평가나 DB 조회 없이 빈 집합이다", async () => {
    const result = await service.list({
      inspectedFrom: "2026-09-02",
      inspectedTo: "2026-09-01",
    });
    expect(result.totalCount).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("필수 기간 두 칸의 오류를 함께 낸다", async () => {
    await expect(
      service.list({ equipmentId: 1, size: 1 }),
    ).rejects.toMatchObject({
      errors: [
        { field: "inspectedFrom", code: "REQUIRED" },
        { field: "inspectedTo", code: "REQUIRED" },
      ],
    });
  });

  it("없는 상세는 404이고 존재하는 결손행은 내부 불변식 실패다", async () => {
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({} as InspectionRow);
    await expect(service.get(1)).rejects.toMatchObject({ status: 404 });
    await expect(service.get(1)).rejects.toThrow(
      "Missing required inspection field",
    );
  });
});
