import { ContractException } from "../../common/errors";
import {
  MaintenanceOrderCreate,
  checkMaintenanceOrderCreate,
} from "./order-create-input";

const mold = (
  override: Partial<MaintenanceOrderCreate> = {},
): MaintenanceOrderCreate => ({
  targetTypeCode: "MOLD",
  targetId: 1,
  plannedDate: "2026-09-09",
  assigneeUserId: 2,
  itemNames: [" 분해 청소 "],
  triggers: [{ triggerTypeCode: "PM_DUE" }],
  baseDate: "2026-09-01",
  ...override,
});

function errorsOf(run: () => unknown) {
  try {
    run();
    throw new Error("Expected input rejection");
  } catch (error) {
    if (!(error instanceof ContractException)) throw error;
    return error.errors;
  }
}

describe("maintenance order create input", () => {
  it("itemNames 호환 입력은 금형 자유 항목으로 바꾸고 원문을 보존한다", () => {
    expect(checkMaintenanceOrderCreate(mold())).toMatchObject({
      targetTypeCode: "MOLD",
      targetId: 1n,
      assigneeUserId: 2n,
      maintenanceTypeCode: "PREVENTIVE",
      items: [
        { sequenceNo: 1, inspectionItemId: null, itemName: " 분해 청소 " },
      ],
      triggers: [{ triggerTypeCode: "PM_DUE", sourceId: null }],
    });
  });

  it("items가 존재하면 빈 배열도 itemNames보다 우선해 거부한다", () => {
    expect(
      errorsOf(() => checkMaintenanceOrderCreate(mold({ items: [] }))),
    ).toContainEqual(
      expect.objectContaining({ field: "items", code: "REQUIRED" }),
    );
  });

  it("설비는 실제 항목 ID를 요구하고 자유 이름 호환 입력을 받지 않는다", () => {
    const base = mold({
      targetTypeCode: "EQUIPMENT",
      triggers: [{ triggerTypeCode: "PM_DUE" }],
    });
    expect(errorsOf(() => checkMaintenanceOrderCreate(base))).toContainEqual(
      expect.objectContaining({ field: "itemNames", code: "INVALID" }),
    );
    expect(
      checkMaintenanceOrderCreate({
        ...base,
        itemNames: undefined,
        items: [{ sequenceNo: 1, inspectionItemId: 10, itemName: "ignored" }],
      }).items,
    ).toEqual([{ sequenceNo: 1, inspectionItemId: 10n, itemName: null }]);
  });

  it("금형은 inspectionItemId를 거부하고 비공백 200자 이름을 요구한다", () => {
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(
          mold({
            items: [{ sequenceNo: 1, inspectionItemId: 10, itemName: "청소" }],
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        field: "items[0].inspectionItemId",
        code: "INVALID",
      }),
    );
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(
          mold({ items: [{ sequenceNo: 1, itemName: " " }] }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        field: "items[0].itemName",
        code: "REQUIRED",
      }),
    );
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(mold({ itemNames: ["가".repeat(201)] })),
      ),
    ).toContainEqual(expect.objectContaining({ code: "RANGE" }));
  });

  it.each([0, 2_147_483_648, 1.5])(
    "순서 %s는 int32 양수 범위 밖이다",
    (sequenceNo) => {
      expect(
        errorsOf(() =>
          checkMaintenanceOrderCreate(
            mold({ items: [{ sequenceNo, itemName: "청소" }] }),
          ),
        ),
      ).toContainEqual(
        expect.objectContaining({
          field: "items[0].sequenceNo",
          code: "RANGE",
        }),
      );
    },
  );

  it("항목 순서와 같은 촉발 원천의 요청 내 중복을 거부한다", () => {
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(
          mold({
            items: [
              { sequenceNo: 1, itemName: "청소" },
              { sequenceNo: 1, itemName: "급유" },
            ],
          }),
        ),
      ),
    ).toContainEqual(expect.objectContaining({ code: "UNIQUE_VIOLATION" }));
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(
          mold({
            triggers: [
              { triggerTypeCode: "PM_DUE" },
              { triggerTypeCode: "PM_DUE" },
            ],
          }),
        ),
      ),
    ).toContainEqual(expect.objectContaining({ code: "UNIQUE_VIOLATION" }));
  });

  it("고장·불합격은 sourceId가 필요하고 PM_DUE는 sourceId를 비운다", () => {
    const equipment = (triggers: MaintenanceOrderCreate["triggers"]) => ({
      ...mold(),
      targetTypeCode: "EQUIPMENT" as const,
      itemNames: undefined,
      items: [{ sequenceNo: 1, inspectionItemId: 10 }],
      triggers,
      baseDate: null,
    });
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(
          equipment([{ triggerTypeCode: "BREAKDOWN" }]),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        field: "triggers[0].sourceId",
        code: "REQUIRED",
      }),
    );
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(
          equipment([{ triggerTypeCode: "INSPECTION_NG", sourceId: 0 }]),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({ field: "triggers[0].sourceId", code: "RANGE" }),
    );
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(
          equipment([{ triggerTypeCode: "PM_DUE", sourceId: 3 }]),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        field: "triggers[0].sourceId",
        code: "INVALID",
      }),
    );
  });

  it("고장이 하나라도 있으면 사후 보전이며 baseDate를 거부한다", () => {
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate({
          ...mold(),
          targetTypeCode: "EQUIPMENT",
          itemNames: undefined,
          items: [{ sequenceNo: 1, inspectionItemId: 10 }],
          triggers: [
            { triggerTypeCode: "PM_DUE" },
            { triggerTypeCode: "BREAKDOWN", sourceId: 3 },
          ],
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({ field: "baseDate", code: "INVALID" }),
    );
  });

  it("예방 보전은 baseDate를 요구하고 과거 plannedDate는 허용한다", () => {
    expect(
      errorsOf(() => checkMaintenanceOrderCreate(mold({ baseDate: null }))),
    ).toContainEqual(
      expect.objectContaining({ field: "baseDate", code: "REQUIRED" }),
    );
    expect(
      checkMaintenanceOrderCreate(mold({ plannedDate: "2000-01-01" }))
        .plannedDate,
    ).toEqual(new Date("2000-01-01T00:00:00.000Z"));
  });

  it("대상·담당·항목·원천·스냅샷 ID는 반올림되는 정수를 거부한다", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(
      errorsOf(() => checkMaintenanceOrderCreate(mold({ targetId: unsafe }))),
    ).toContainEqual(
      expect.objectContaining({ field: "targetId", code: "RANGE" }),
    );
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(
          mold({
            triggers: [{ triggerTypeCode: "PM_DUE", shotCountAtDue: unsafe }],
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        field: "triggers[0].shotCountAtDue",
        code: "RANGE",
      }),
    );
  });

  it("금형에는 설비 고장·점검 원천을 연결할 수 없다", () => {
    expect(
      errorsOf(() =>
        checkMaintenanceOrderCreate(
          mold({
            triggers: [{ triggerTypeCode: "BREAKDOWN", sourceId: 1 }],
            baseDate: null,
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        field: "triggers[0].triggerTypeCode",
        code: "INVALID",
      }),
    );
  });
});
