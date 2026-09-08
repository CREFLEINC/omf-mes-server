import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { DowntimeQueryService } from "./downtime-query.service";
import { DowntimeRow } from "./downtime-view";

describe("DowntimeQueryService", () => {
  const raw = jest.fn();
  const tx = { $queryRaw: raw };
  const transaction = jest.fn(
    async (work: (client: typeof tx) => Promise<unknown>, _options?: object) =>
      work(tx),
  );
  const service = new DowntimeQueryService({
    $transaction: transaction,
  } as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it("openOnly 전건은 시간대를 읽지 않고 열린 구간·겹침·오름차순을 한 스냅샷에서 센다", async () => {
    raw.mockResolvedValueOnce([row()]).mockResolvedValueOnce([{ total: 1n }]);
    const result = await service.list({
      equipmentId: 7,
      reasonCode: "MOLD_CHANGE' --",
      openOnly: true,
      overlappingOnly: true,
    });
    const [items, count] = raw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    expect(items.sql).toContain("d.ended_at > d.started_at");
    expect(items.sql).toContain("x.equipment_id = d.equipment_id");
    expect(items.sql).toContain(
      "x.equipment_downtime_id <> d.equipment_downtime_id",
    );
    expect(items.sql).toContain(
      "COALESCE(x.ended_at, 'infinity'::timestamptz)",
    );
    expect(items.sql).toContain("ORDER BY d.started_at ASC");
    expect(items.sql).not.toContain("MOLD_CHANGE' --");
    expect(items.values).toContain("MOLD_CHANGE' --");
    expect(count.sql.slice(count.sql.indexOf("WHERE"))).toBe(
      items.sql.slice(items.sql.indexOf("WHERE")).split("ORDER BY")[0].trim(),
    );
    expect(result.totalCount).toBe(result.page.total);
    expect(transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "RepeatableRead",
    });
  });

  it("기간은 필터로 남은 공장별 로컬 날짜 경계를 적용하고 기본 내림차순이다", async () => {
    raw
      .mockResolvedValueOnce([
        { plant_id: 10n, timezone_code: "Asia/Ho_Chi_Minh" },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);
    await service.list({
      startedFrom: "2026-09-01",
      startedTo: "2026-09-01",
    });
    const [plants, items] = raw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    expect(plants.sql).toContain("SELECT DISTINCT p.plant_id");
    expect(items.sql).toContain("d.started_at >=");
    expect(items.sql).toContain("d.started_at <");
    expect(items.sql).toContain("ORDER BY d.started_at DESC");
    expect(items.values).toEqual(
      expect.arrayContaining([
        new Date("2026-08-31T17:00:00.000Z"),
        new Date("2026-09-01T17:00:00.000Z"),
      ]),
    );
  });

  it.each([
    [{}, ["startedFrom", "startedTo"]],
    [{ openOnly: false, startedFrom: "2026-09-01" }, ["startedTo"]],
    [{ openOnly: true, startedTo: "2026-09-01" }, ["startedFrom"]],
  ])("기간 조건 %o의 빠진 짝을 400으로 거절한다", async (query, fields) => {
    await expect(service.list(query)).rejects.toMatchObject({
      status: 400,
      errors: fields.map((field) => ({ field, code: "REQUIRED" })),
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("역전 기간은 DB·시간대를 읽기 전에 400 RANGE다", async () => {
    await expect(
      service.list({
        startedFrom: "2026-09-02",
        startedTo: "2026-09-01",
      }),
    ).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "startedTo", code: "RANGE" }],
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("상세는 같은 트랜잭션에서 본문과 숫자 ETag 원천을 분리한다", async () => {
    raw.mockResolvedValueOnce([row()]);
    const result = await service.get(5);
    expect(result.versionNo).toBe(3);
    expect(result.view).not.toHaveProperty("versionNo");
    expect(transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "RepeatableRead",
    });
  });

  it("없는 상세는 404이고 잘못된 version은 500으로 남긴다", async () => {
    raw.mockResolvedValueOnce([]);
    await expect(service.get(404)).rejects.toMatchObject({ status: 404 });
    raw.mockResolvedValueOnce([row({ version_no: 0 })]);
    await expect(service.get(5)).rejects.toThrow("version");
  });
});

function row(change: Partial<DowntimeRow> = {}): DowntimeRow {
  return {
    downtime_id: 5n,
    equipment_id: 7n,
    equipment_code: "PRESS-01",
    reason_code: "MOLD_CHANGE",
    reason_name: "금형 교체",
    started_epoch_us: "1788220800000000",
    ended_epoch_us: null,
    breakdown_id: null,
    recorded_by_worker_no: "W-1",
    remarks: null,
    version_no: 3,
    ...change,
  };
}
