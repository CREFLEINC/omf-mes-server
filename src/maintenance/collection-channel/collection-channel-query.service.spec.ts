import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { CollectionChannelQueryService } from "./collection-channel-query.service";
import { CollectionChannelProjection } from "./collection-channel-view";

describe("CollectionChannelQueryService", () => {
  const raw = jest.fn();
  const service = new CollectionChannelQueryService({ $queryRaw: raw } as unknown as PrismaService);

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
