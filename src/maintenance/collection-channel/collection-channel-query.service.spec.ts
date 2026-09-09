import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { CollectionChannelQueryService } from "./collection-channel-query.service";
import { CollectionChannelProjection } from "./collection-channel-view";

describe("CollectionChannelQueryService", () => {
  const raw = jest.fn();
  const tx = { $queryRaw: raw };
  const transaction = jest.fn(
    async (
      work: (client: typeof tx) => Promise<unknown>,
      _options?: { isolationLevel: string },
    ) => work(tx),
  );
  const service = new CollectionChannelQueryService({
    $queryRaw: raw,
    $transaction: transaction,
  } as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it("상세는 연관 표시값과 상태 무관 최대 Rev를 한 SQL로 읽고 version을 분리한다", async () => {
    raw.mockResolvedValue([projection()]);
    await expect(service.get(31)).resolves.toMatchObject({
      view: { collectionChannelId: 31, inspectionItemIsCurrentRevision: true },
      versionNo: 3,
    });
    const sql = raw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain("max(plan_version) AS latest_version");
    expect(sql.sql).not.toContain("status_code");
    expect(sql.values).toEqual([31n]);
  });

  it("없는 채널은 404다", async () => {
    raw.mockResolvedValue([]);
    await expect(service.get(404)).rejects.toMatchObject({ status: 404 });
  });

  it("안전 범위 밖 ID는 DB 전에 400이다", async () => {
    await expect(service.get(Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "collectionChannelId", code: "RANGE" }],
    });
    expect(raw).not.toHaveBeenCalled();
  });

  it("목록은 필터·정렬·count·page·projection을 한 스냅샷에서 읽는다", async () => {
    raw
      .mockResolvedValueOnce([{ has_missing_key: false }])
      .mockResolvedValueOnce([{ collection_channel_id: 31n }])
      .mockResolvedValueOnce([{ total: 1n }])
      .mockResolvedValueOnce([projection()]);

    await expect(
      service.list({ equipmentId: 41, isActive: false, page: 2, size: 1 }),
    ).resolves.toMatchObject({
      items: [{ collectionChannelId: 31 }],
      totalCount: 1,
      page: { page: 2, size: 1, total: 1 },
    });
    const [missing, ids, count, projected] = raw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    expect(missing.sql).toContain("bool_or(c.channel_key IS NULL)");
    expect(missing.values).toEqual([41]);
    expect(ids.sql).toContain(
      "ORDER BY c.equipment_id ASC, c.channel_key ASC NULLS LAST,\n                     c.collection_channel_id ASC",
    );
    expect(ids.values.slice(0, -2)).toEqual(count.values);
    expect(count.values).toEqual([41, false]);
    expect(projected.values).toEqual([31n]);
    expect(transaction.mock.calls[0][1]).toEqual({ isolationLevel: "RepeatableRead" });
  });

  it("isActive 미지정은 활성·비활성을 모두 읽고 과거 NULL 키를 먼저 드러낸다", async () => {
    raw.mockResolvedValueOnce([{ has_missing_key: true }]);
    await expect(service.list({ equipmentId: 41 })).rejects.toThrow(
      "Missing required collection channel key",
    );
    const sql = raw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).not.toContain("c.is_active =");
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("목록의 안전 범위 밖 설비와 page는 DB 전에 400이다", async () => {
    await expect(
      service.list({ equipmentId: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toMatchObject({ status: 400, errors: [{ field: "equipmentId", code: "RANGE" }] });
    await expect(service.list({ page: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "page", code: "RANGE" }],
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("관측은 등록 여부와 활성 검사연결 여부를 다른 술어로 계산한다", async () => {
    raw.mockResolvedValueOnce([
      {
        channel_key: "PRS41.RAW.01",
        last_value: "182.4",
        observed_epoch_microseconds: "1788925323123456",
        already_mapped: true,
        total_count: 1n,
      },
    ]);

    await expect(
      service.observations({ equipmentId: 41, unmappedOnly: true }),
    ).resolves.toEqual({
      items: [
        {
          channelKey: "PRS41.RAW.01",
          lastValue: "182.4",
          observedAt: "2026-09-09T03:42:03.123456Z",
          alreadyMapped: true,
        },
      ],
      totalCount: 1,
    });
    const sql = raw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain("linked.is_active");
    expect(sql.sql).toContain("linked.inspection_item_id IS NOT NULL");
    expect(sql.sql).toContain("registered.equipment_id = o.equipment_id");
    expect(sql.sql).toContain("count(*) OVER ()");
    expect(sql.sql).toContain(
      "ORDER BY o.observed_at DESC, o.equipment_id ASC, o.channel_key ASC",
    );
    expect(sql.values).toEqual([41]);
  });

  it("unmappedOnly false·생략은 필터를 만들지 않고 안전 범위 밖 설비는 거절한다", async () => {
    raw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(service.observations({ unmappedOnly: false })).resolves.toEqual({
      items: [],
      totalCount: 0,
    });
    await expect(service.observations({})).resolves.toEqual({ items: [], totalCount: 0 });
    const sqls = raw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    expect(sqls.every((sql) => !sql.sql.includes("linked.is_active"))).toBe(true);
    await expect(
      service.observations({ equipmentId: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toMatchObject({ status: 400, errors: [{ field: "equipmentId", code: "RANGE" }] });
    expect(raw).toHaveBeenCalledTimes(2);
  });
});

function projection(): CollectionChannelProjection {
  return {
    collection_channel_id: 31n,
    equipment_id: 41n,
    equipment_code: "PRS-41",
    channel_key: "PRS41.TEMP.01",
    signal_name: null,
    uom_id: null,
    unit_code: null,
    inspection_item_id: 51n,
    item_id: null,
    item_code: null,
    process_id: null,
    process_code: null,
    inspection_item_name: "사이클타임",
    inspection_item_code: "CYCLE_TIME",
    inspection_item_unit_code: null,
    inspection_plan_version_id: 81n,
    inspection_plan_version: 2,
    inspection_item_is_current_revision: true,
    is_active: true,
    version_no: 3,
  };
}
