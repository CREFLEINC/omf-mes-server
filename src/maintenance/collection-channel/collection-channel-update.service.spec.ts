import { Prisma } from "@prisma/client";

import { ConflictException } from "../../common/errors";
import { CollectionChannelProjection } from "./collection-channel-view";
import { CollectionChannelWriteContext } from "./collection-channel-write-context";
import { CollectionChannelUpdateService } from "./collection-channel-update.service";

describe("CollectionChannelUpdateService", () => {
  const raw = jest.fn();
  const findUom = jest.fn();
  const findInspectionItem = jest.fn();
  const findItem = jest.fn();
  const findProcess = jest.fn();
  const findDuplicate = jest.fn();
  const updateMany = jest.fn();
  const tx = {
    $queryRaw: raw,
    uom: { findUnique: findUom },
    inspection_item_spec: { findUnique: findInspectionItem },
    item: { findUnique: findItem },
    process: { findUnique: findProcess },
    collection_channel: { findFirst: findDuplicate, updateMany },
  } as unknown as Prisma.TransactionClient;
  const context: CollectionChannelWriteContext = {
    key: "idem-1",
    fingerprint: "fingerprint",
    appUserId: 17,
    successStatus: 200,
  };
  const service = new CollectionChannelUpdateService();

  beforeEach(() => {
    jest.clearAllMocks();
    raw.mockImplementation((sql: Prisma.Sql) =>
      sql.sql.includes("FOR UPDATE") ? [locked()] : [projection()],
    );
    findUom.mockResolvedValue({ uom_id: 71n });
    findInspectionItem.mockResolvedValue({ inspection_item_spec_id: 51n });
    findItem.mockResolvedValue({ item_id: 61n });
    findProcess.mockResolvedValue({ process_id: 81n });
    findDuplicate.mockResolvedValue(null);
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("명시한 여섯 칸만 적용하고 FK null은 해제한다", async () => {
    await expect(
      service.updateWithin(
        tx,
        31,
        3,
        {
          signalName: "",
          unitCode: "CELSIUS",
          inspectionItemId: null,
          itemId: null,
          processId: null,
          isActive: false,
        },
        context,
      ),
    ).resolves.toMatchObject({ collectionChannelId: 31 });
    expect(findInspectionItem).not.toHaveBeenCalled();
    expect(findItem).not.toHaveBeenCalled();
    expect(findProcess).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { collection_channel_id: 31n, version_no: 3 },
      data: {
        signal_name: "",
        uom_id: 71n,
        inspection_item_id: null,
        item_id: null,
        process_id: null,
        is_active: false,
        updated_by: 17n,
        version_no: { increment: 1 },
      },
    });
  });

  it("빈 PUT도 정상이며 version만 한 번 올린다", async () => {
    await service.updateWithin(tx, 31, 3, {}, context);
    expect(findUom).not.toHaveBeenCalled();
    expect(findInspectionItem).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { collection_channel_id: 31n, version_no: 3 },
      data: { updated_by: 17n, version_no: { increment: 1 } },
    });
  });

  it("없는 행은 404이고 오래된 If-Match는 참조 조회 전에 409다", async () => {
    raw.mockResolvedValueOnce([]);
    await expect(service.updateWithin(tx, 404, 1, {}, context)).rejects.toMatchObject({ status: 404 });

    raw.mockResolvedValueOnce([locked({ version_no: 4 })]);
    const error = await rejected(
      service.updateWithin(tx, 31, 3, { unitCode: "CELSIUS" }, context),
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect(findUom).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("명시한 참조가 없으면 모든 해당 필드를 400으로 알린다", async () => {
    findUom.mockResolvedValue(null);
    findInspectionItem.mockResolvedValue(null);
    findItem.mockResolvedValue(null);
    findProcess.mockResolvedValue(null);
    await expect(
      service.updateWithin(
        tx,
        31,
        3,
        { unitCode: "NONE", inspectionItemId: 51, itemId: 61, processId: 81 },
        context,
      ),
    ).rejects.toMatchObject({
      status: 400,
      errors: [
        { field: "unitCode", code: "INVALID" },
        { field: "inspectionItemId", code: "INVALID" },
        { field: "itemId", code: "INVALID" },
        { field: "processId", code: "INVALID" },
      ],
    });
    expect(findDuplicate).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("최종 품목·공정 범위가 다른 행과 같으면 409다", async () => {
    findDuplicate.mockResolvedValue({ collection_channel_id: 32n });
    const error = await rejected(
      service.updateWithin(tx, 31, 3, { itemId: null, processId: 81 }, context),
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect(findDuplicate).toHaveBeenCalledWith({
      where: {
        equipment_id: 41n,
        channel_key: "PRS41.TEMP.01",
        item_id: null,
        process_id: 81n,
        collection_channel_id: { not: 31n },
      },
      select: { collection_channel_id: true },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected rejection");
  } catch (error) {
    return error;
  }
}

function locked(overrides: Partial<ReturnType<typeof lockedBase>> = {}) {
  return { ...lockedBase(), ...overrides };
}

function lockedBase() {
  return {
    collection_channel_id: 31n,
    equipment_id: 41n,
    channel_key: "PRS41.TEMP.01",
    uom_id: null,
    inspection_item_id: 51n,
    item_id: 61n,
    process_id: 81n,
    version_no: 3,
  };
}

function projection(): CollectionChannelProjection {
  return {
    collection_channel_id: 31n, equipment_id: 41n, equipment_code: "PRS-41",
    channel_key: "PRS41.TEMP.01", signal_name: null, uom_id: null, unit_code: null,
    inspection_item_id: 51n, item_id: 61n, item_code: "ITEM-61", process_id: 81n,
    process_code: "PROCESS-81", inspection_item_name: "사이클타임",
    inspection_item_code: "CYCLE_TIME", inspection_item_unit_code: "SECOND",
    inspection_plan_version_id: 91n, inspection_plan_version: 2,
    inspection_item_is_current_revision: true, is_active: true, version_no: 4,
  };
}
