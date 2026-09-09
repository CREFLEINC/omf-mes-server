import { ERROR_CODE, field, one } from "../../common/errors";

export interface CollectionChannelCreate {
  equipmentId: number;
  channelKey: string;
  signalName?: string;
  unitCode?: string;
  inspectionItemId?: number | null;
  itemId?: number | null;
  processId?: number | null;
}

export interface CheckedCollectionChannelCreate {
  equipmentId: bigint;
  channelKey: string;
  signalName: string | null;
  unitCode: string | null;
  inspectionItemId: bigint | null;
  itemId: bigint | null;
  processId: bigint | null;
}

export function checkCollectionChannelCreate(
  input: CollectionChannelCreate,
): CheckedCollectionChannelCreate {
  checkLength("channelKey", input.channelKey, 100);
  checkLength("signalName", input.signalName, 200);
  checkLength("unitCode", input.unitCode, 50);
  if (input.unitCode === "") {
    throw one(field("unitCode", ERROR_CODE.INVALID, "빈 단위 코드는 사용할 수 없습니다."));
  }
  return {
    equipmentId: id("equipmentId", input.equipmentId),
    channelKey: input.channelKey,
    signalName: input.signalName ?? null,
    unitCode: input.unitCode ?? null,
    inspectionItemId: nullableId("inspectionItemId", input.inspectionItemId),
    itemId: nullableId("itemId", input.itemId),
    processId: nullableId("processId", input.processId),
  };
}

function nullableId(name: string, value: number | null | undefined): bigint | null {
  return value == null ? null : id(name, value);
}

function id(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value)) {
    throw one(field(name, ERROR_CODE.RANGE, "식별자 범위가 너무 큽니다."));
  }
  return BigInt(value);
}

function checkLength(name: string, value: string | null | undefined, max: number): void {
  if (value !== null && value !== undefined && value.length > max) {
    throw one(field(name, ERROR_CODE.RANGE, `${max}자 이하여야 합니다.`));
  }
}
