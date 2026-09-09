import {
  CollectionChannelCreate,
  checkCollectionChannelCreate,
  checkCollectionChannelUpdate,
} from "./collection-channel-write-input";

describe("checkCollectionChannelCreate", () => {
  it("품목·공정·검사항목의 생략과 null을 독립적인 전체 조건으로 만든다", () => {
    expect(checkCollectionChannelCreate({ equipmentId: 41, channelKey: "PRS41.TEMP.01" })).toEqual({
      equipmentId: 41n,
      channelKey: "PRS41.TEMP.01",
      signalName: null,
      unitCode: null,
      inspectionItemId: null,
      itemId: null,
      processId: null,
    });
    expect(
      checkCollectionChannelCreate({
        equipmentId: 41,
        channelKey: "Prs41.Temp.01",
        signalName: "",
        inspectionItemId: 51,
        itemId: null,
        processId: 61,
      }),
    ).toMatchObject({
      channelKey: "Prs41.Temp.01",
      signalName: "",
      inspectionItemId: 51n,
      itemId: null,
      processId: 61n,
    });
  });

  it("키·신호명·단위의 물리 길이와 모든 ID 안전 범위를 검사한다", () => {
    for (const [fieldName, input] of [
      ["channelKey", create({ channelKey: "K".repeat(101) })],
      ["signalName", create({ signalName: "S".repeat(201) })],
      ["unitCode", create({ unitCode: "U".repeat(51) })],
      ["equipmentId", create({ equipmentId: Number.MAX_SAFE_INTEGER + 1 })],
      ["inspectionItemId", create({ inspectionItemId: Number.MAX_SAFE_INTEGER + 1 })],
      ["itemId", create({ itemId: Number.MAX_SAFE_INTEGER + 1 })],
      ["processId", create({ processId: Number.MAX_SAFE_INTEGER + 1 })],
    ] as const) {
      expect(() => checkCollectionChannelCreate(input)).toThrow(
        expect.objectContaining({ errors: [expect.objectContaining({ field: fieldName })] }),
      );
    }
  });

  it("빈 단위만 명시 오류이며 키 대소문자·빈 신호명은 바꾸지 않는다", () => {
    expect(() => checkCollectionChannelCreate(create({ unitCode: "" }))).toThrow(
      expect.objectContaining({ errors: [{ field: "unitCode", code: "INVALID", scope: "field", message: expect.any(String) }] }),
    );
    expect(checkCollectionChannelCreate(create({ channelKey: "MiXeD", signalName: "" }))).toMatchObject({
      channelKey: "MiXeD",
      signalName: "",
      unitCode: null,
    });
  });
});

describe("checkCollectionChannelUpdate", () => {
  it("생략은 유지하고 FK null은 해제로 보존한다", () => {
    expect(checkCollectionChannelUpdate({})).toEqual({});
    expect(
      checkCollectionChannelUpdate({
        signalName: "",
        inspectionItemId: null,
        itemId: 61,
        processId: null,
        isActive: false,
      }),
    ).toEqual({
      signalName: "",
      inspectionItemId: null,
      itemId: 61n,
      processId: null,
      isActive: false,
    });
  });

  it("단위 생략은 기존 없음도 유지하지만 빈 단위는 명시 오류다", () => {
    expect(checkCollectionChannelUpdate({ inspectionItemId: 51 })).toEqual({
      inspectionItemId: 51n,
    });
    expect(() => checkCollectionChannelUpdate({ unitCode: "" })).toThrow(
      expect.objectContaining({
        errors: [expect.objectContaining({ field: "unitCode", code: "INVALID" })],
      }),
    );
  });

  it("수정 문자열 길이와 FK 안전 범위를 검사한다", () => {
    for (const [fieldName, input] of [
      ["signalName", { signalName: "S".repeat(201) }],
      ["unitCode", { unitCode: "U".repeat(51) }],
      ["inspectionItemId", { inspectionItemId: Number.MAX_SAFE_INTEGER + 1 }],
      ["itemId", { itemId: Number.MAX_SAFE_INTEGER + 1 }],
      ["processId", { processId: Number.MAX_SAFE_INTEGER + 1 }],
    ] as const) {
      expect(() => checkCollectionChannelUpdate(input)).toThrow(
        expect.objectContaining({ errors: [expect.objectContaining({ field: fieldName })] }),
      );
    }
  });
});

function create(overrides: Partial<CollectionChannelCreate> = {}): CollectionChannelCreate {
  return { equipmentId: 41, channelKey: "PRS41.TEMP.01", ...overrides };
}
