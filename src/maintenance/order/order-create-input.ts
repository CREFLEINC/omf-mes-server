import { ERROR_CODE, field, one } from "../../common/errors";
import { day } from "../../common/master";

export type MaintenanceTargetType = "EQUIPMENT" | "MOLD";
export type MaintenanceTriggerType = "BREAKDOWN" | "INSPECTION_NG" | "PM_DUE";

export interface MaintenanceOrderItemInput {
  inspectionItemId?: number | null;
  itemName?: string | null;
  sequenceNo: number;
}

export interface MaintenanceOrderTriggerInput {
  triggerTypeCode: MaintenanceTriggerType;
  sourceId?: number | null;
  snapshotNote?: string | null;
  pmDueAxisCode?: "SHOT" | "DATE" | null;
  shotCountAtDue?: number | null;
  guaranteedShotCountAtDue?: number | null;
}

export interface MaintenanceOrderCreate {
  targetTypeCode: MaintenanceTargetType;
  targetId: number;
  plannedDate: string;
  assigneeUserId: number;
  itemNames?: string[];
  items?: MaintenanceOrderItemInput[];
  triggers?: MaintenanceOrderTriggerInput[];
  baseDate?: string | null;
  orderNote?: string | null;
}

/** 계약 배열 우선순위와 DB에 닿기 전 판별 가능한 입력 경계를 고정한다. */
export function checkMaintenanceOrderCreate(input: MaintenanceOrderCreate) {
  const targetId = positiveId("targetId", input.targetId);
  const assigneeUserId = positiveId("assigneeUserId", input.assigneeUserId);
  const plannedDate = day("plannedDate", input.plannedDate);
  const items = checkItems(input);
  const triggers = checkTriggers(input);
  const maintenanceTypeCode = triggers.some(
    ({ triggerTypeCode }) => triggerTypeCode === "BREAKDOWN",
  )
    ? "CORRECTIVE"
    : "PREVENTIVE";
  const baseDate = checkBaseDate(input.baseDate, maintenanceTypeCode);

  return {
    targetTypeCode: input.targetTypeCode,
    targetId,
    plannedDate,
    assigneeUserId,
    items,
    triggers,
    maintenanceTypeCode,
    baseDate,
    orderNote: input.orderNote ?? null,
  };
}

function checkItems(input: MaintenanceOrderCreate) {
  const selected: MaintenanceOrderItemInput[] | undefined =
    input.items !== undefined
      ? input.items
      : input.itemNames?.map((itemName, index) => ({
          sequenceNo: index + 1,
          itemName,
        }));
  if (!selected?.length)
    throw one(
      field("items", ERROR_CODE.REQUIRED, "보전 항목이 한 건 이상 필요합니다."),
    );
  if (input.items === undefined && input.targetTypeCode !== "MOLD")
    throw one(
      field(
        "itemNames",
        ERROR_CODE.INVALID,
        "설비 보전 항목은 부여된 점검·보전 항목 ID로 보내야 합니다.",
      ),
    );

  const sequences = new Set<number>();
  const items = selected.map((item, index) => {
    const at = `items[${index}]`;
    if (
      !Number.isInteger(item.sequenceNo) ||
      item.sequenceNo <= 0 ||
      item.sequenceNo > 2_147_483_647
    ) {
      fail(
        `${at}.sequenceNo`,
        ERROR_CODE.RANGE,
        "표시 순서는 양의 int32 범위여야 합니다.",
      );
    } else if (sequences.has(item.sequenceNo)) {
      fail(
        `${at}.sequenceNo`,
        ERROR_CODE.UNIQUE_VIOLATION,
        "같은 표시 순서를 두 번 보낼 수 없습니다.",
      );
    }
    sequences.add(item.sequenceNo);

    if (input.targetTypeCode === "EQUIPMENT") {
      if (item.inspectionItemId == null)
        fail(
          `${at}.inspectionItemId`,
          ERROR_CODE.REQUIRED,
          "설비 보전 항목 ID가 필요합니다.",
        );
      return {
        sequenceNo: item.sequenceNo,
        inspectionItemId:
          item.inspectionItemId == null
            ? null
            : checkedId(`${at}.inspectionItemId`, item.inspectionItemId),
        itemName: null,
      };
    }

    if (item.inspectionItemId != null)
      fail(
        `${at}.inspectionItemId`,
        ERROR_CODE.INVALID,
        "금형 보전 항목은 자유 입력 이름을 사용합니다.",
      );
    if (!item.itemName?.trim())
      fail(
        `${at}.itemName`,
        ERROR_CODE.REQUIRED,
        "보전 항목 이름이 필요합니다.",
      );
    else if (Array.from(item.itemName).length > 200)
      fail(
        `${at}.itemName`,
        ERROR_CODE.RANGE,
        "보전 항목 이름은 200자 이하여야 합니다.",
      );
    return {
      sequenceNo: item.sequenceNo,
      inspectionItemId: null,
      itemName: item.itemName ?? null,
    };
  });
  return items;
}

function checkTriggers(input: MaintenanceOrderCreate) {
  if (!input.triggers?.length)
    throw one(
      field("triggers", ERROR_CODE.REQUIRED, "지시 촉발 원인이 필요합니다."),
    );
  const seen = new Set<string>();
  const triggers = input.triggers.map((trigger, index) => {
    const at = `triggers[${index}]`;
    const type = trigger.triggerTypeCode;
    if (!(["BREAKDOWN", "INSPECTION_NG", "PM_DUE"] as string[]).includes(type))
      fail(
        `${at}.triggerTypeCode`,
        ERROR_CODE.INVALID,
        "없는 촉발 유형입니다.",
      );
    if (input.targetTypeCode === "MOLD" && type !== "PM_DUE")
      fail(
        `${at}.triggerTypeCode`,
        ERROR_CODE.INVALID,
        "금형에는 설비 고장·점검 원천을 연결할 수 없습니다.",
      );

    const sourceId =
      trigger.sourceId == null
        ? null
        : checkedId(`${at}.sourceId`, trigger.sourceId);
    if (type === "PM_DUE" && sourceId !== null)
      fail(
        `${at}.sourceId`,
        ERROR_CODE.INVALID,
        "주기 도래 원천 ID는 비워야 합니다.",
      );
    if (type !== "PM_DUE" && sourceId === null)
      fail(`${at}.sourceId`, ERROR_CODE.REQUIRED, "촉발 원천 ID가 필요합니다.");

    const key = `${type}:${sourceId?.toString() ?? "null"}`;
    if (seen.has(key))
      fail(
        `${at}.triggerTypeCode`,
        ERROR_CODE.UNIQUE_VIOLATION,
        "같은 촉발 원천을 두 번 보낼 수 없습니다.",
      );
    seen.add(key);
    return {
      triggerTypeCode: type,
      sourceId,
      snapshotNote: trigger.snapshotNote ?? null,
      pmDueAxisCode: trigger.pmDueAxisCode,
      shotCountAtDue: snapshotCount(
        `${at}.shotCountAtDue`,
        trigger.shotCountAtDue,
      ),
      guaranteedShotCountAtDue: snapshotCount(
        `${at}.guaranteedShotCountAtDue`,
        trigger.guaranteedShotCountAtDue,
      ),
    };
  });
  return triggers;
}

function checkBaseDate(
  value: string | null | undefined,
  type: "CORRECTIVE" | "PREVENTIVE",
): Date | null {
  if (type === "PREVENTIVE") {
    if (value == null)
      throw one(
        field(
          "baseDate",
          ERROR_CODE.REQUIRED,
          "예방 보전 기준일이 필요합니다.",
        ),
      );
    return day("baseDate", value);
  }
  if (value != null)
    throw one(
      field(
        "baseDate",
        ERROR_CODE.INVALID,
        "사후 보전에는 기준일을 둘 수 없습니다.",
      ),
    );
  return null;
}

function positiveId(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw one(field(name, ERROR_CODE.RANGE, "안전한 양의 정수 ID여야 합니다."));
  return BigInt(value);
}

function checkedId(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0)
    fail(name, ERROR_CODE.RANGE, "안전한 양의 정수 ID여야 합니다.");
  return BigInt(value);
}

function snapshotCount(
  name: string,
  value: number | null | undefined,
): bigint | null | undefined {
  if (value == null) return value;
  if (!Number.isSafeInteger(value) || value < 0)
    fail(name, ERROR_CODE.RANGE, "스냅샷은 안전한 0 이상 정수여야 합니다.");
  return BigInt(value);
}

function fail(name: string, code: string, message: string): never {
  throw one(field(name, code, message));
}
