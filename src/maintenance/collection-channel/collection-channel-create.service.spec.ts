import { Prisma } from "@prisma/client";

import { ConflictException } from "../../common/errors";
import { CollectionChannelCreateService } from "./collection-channel-create.service";
import { CollectionChannelProjection } from "./collection-channel-view";
import { CollectionChannelWriteContext } from "./collection-channel-write-context";

describe("CollectionChannelCreateService", () => {
  const findEquipment = jest.fn();
  const findUom = jest.fn();
  const findInspectionItem = jest.fn();
  const findItem = jest.fn();
  const findProcess = jest.fn();
  const findDuplicate = jest.fn();
  const create = jest.fn();
  const raw = jest.fn();
  const tx = {
    equipment: { findUnique: findEquipment },
    uom: { findUnique: findUom },
    inspection_item_spec: { findUnique: findInspectionItem },
    item: { findUnique: findItem },
    process: { findUnique: findProcess },
    collection_channel: { findFirst: findDuplicate, create },
    $queryRaw: raw,
  } as unknown as Prisma.TransactionClient;
  const context: CollectionChannelWriteContext = {
    key: "idem-1",
    fingerprint: "fingerprint",
    appUserId: 17,
    successStatus: 201,
  };
  const service = new CollectionChannelCreateService();

  beforeEach(() => {
    jest.clearAllMocks();
    findEquipment.mockResolvedValue({ equipment_id: 41n });
    findUom.mockResolvedValue({ uom_id: 71n });
    findInspectionItem.mockResolvedValue({ inspection_item_spec_id: 51n });
    findItem.mockResolvedValue({ item_id: 61n });
    findProcess.mockResolvedValue({ process_id: 81n });
    findDuplicate.mockResolvedValue(null);
    create.mockResolvedValue({ collection_channel_id: 31n });
    raw.mockResolvedValue([projection()]);
  });

  it("원문 키와 네 조건 및 감사 주체를 저장하고 최종 projection을 반환한다", async () => {
    await expect(service.createWithin(tx, completeInput(), context)).resolves.toMatchObject({
      collectionChannelId: 31,
      channelKey: "Prs41.Temp.01",
    });
    expect(findUom).toHaveBeenCalledWith({
      where: { uom_code: "CELSIUS" },
      select: { uom_id: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        equipment_id: 41n,
        channel_key: "Prs41.Temp.01",
        signal_name: "히터 온도",
        uom_id: 71n,
        inspection_item_id: 51n,
        item_id: 61n,
        process_id: 81n,
        created_by: 17n,
        updated_by: 17n,
      },
      select: { collection_channel_id: true },
    });
    expect((raw.mock.calls[0][0] as Prisma.Sql).values).toEqual([31n]);
  });

  it("단위·연결·품목·공정 생략은 null이며 선택 참조를 조회하지 않는다", async () => {
    await service.createWithin(tx, { equipmentId: 41, channelKey: "RAW" }, context);
    expect(findUom).not.toHaveBeenCalled();
    expect(findInspectionItem).not.toHaveBeenCalled();
    expect(findItem).not.toHaveBeenCalled();
    expect(findProcess).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data).toMatchObject({
      signal_name: null,
      uom_id: null,
      inspection_item_id: null,
      item_id: null,
      process_id: null,
    });
  });

  it("없는 참조는 모든 해당 입력 필드를 한 번에 400으로 알린다", async () => {
    findEquipment.mockResolvedValue(null);
    findUom.mockResolvedValue(null);
    findInspectionItem.mockResolvedValue(null);
    findItem.mockResolvedValue(null);
    findProcess.mockResolvedValue(null);

    await expect(service.createWithin(tx, completeInput(), context)).rejects.toMatchObject({
      status: 400,
      errors: [
        { field: "equipmentId", code: "INVALID" },
        { field: "unitCode", code: "INVALID" },
        { field: "inspectionItemId", code: "INVALID" },
        { field: "itemId", code: "INVALID" },
        { field: "processId", code: "INVALID" },
      ],
    });
    expect(findDuplicate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("비활성 여부와 검사항목은 유일 범위가 아니며 같은 네 축은 409다", async () => {
    findDuplicate.mockResolvedValue({ collection_channel_id: 30n });
    const error = await rejected(service.createWithin(tx, completeInput(), context));
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).conflict).toEqual({
      conflictCause: "user",
      message: "이 설비의 Prs41.Temp.01 채널에 품목·공정 조건이 같은 매핑이 이미 있습니다.",
    });
    expect(findDuplicate).toHaveBeenCalledWith({
      where: {
        equipment_id: 41n,
        channel_key: "Prs41.Temp.01",
        item_id: 61n,
        process_id: 81n,
      },
      select: { collection_channel_id: true },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("동시 등록의 식 unique P2002도 같은 409로 번역한다", async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "uq_collection_channel_mapping" },
      }),
    );
    const error = await rejected(service.createWithin(tx, completeInput(), context));
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect(raw).not.toHaveBeenCalled();
  });
});

function completeInput() {
  return {
    equipmentId: 41,
    channelKey: "Prs41.Temp.01",
    signalName: "히터 온도",
    unitCode: "CELSIUS",
    inspectionItemId: 51,
    itemId: 61,
    processId: 81,
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected rejection");
  } catch (error) {
    return error;
  }
}

function projection(): CollectionChannelProjection {
  return {
    collection_channel_id: 31n,
    equipment_id: 41n,
    equipment_code: "PRS-41",
    channel_key: "Prs41.Temp.01",
    signal_name: "히터 온도",
    uom_id: 71n,
    unit_code: "CELSIUS",
    inspection_item_id: 51n,
    item_id: 61n,
    item_code: "ITEM-61",
    process_id: 81n,
    process_code: "PROCESS-81",
    inspection_item_name: "사이클타임",
    inspection_item_code: "CYCLE_TIME",
    inspection_item_unit_code: "SECOND",
    inspection_plan_version_id: 91n,
    inspection_plan_version: 2,
    inspection_item_is_current_revision: false,
    is_active: true,
    version_no: 1,
  };
}
