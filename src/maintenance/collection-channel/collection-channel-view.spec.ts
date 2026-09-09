import {
  CollectionChannelProjection,
  collectionChannelView,
} from "./collection-channel-view";

describe("collectionChannelView", () => {
  it("계약 18칸과 최신 Rev 판정을 원천값 그대로 투영한다", () => {
    expect(collectionChannelView(projection())).toEqual({
      collectionChannelId: 31,
      equipmentId: 41,
      equipmentCode: "PRS-41",
      channelKey: "PRS41.TEMP.01",
      signalName: "히터 온도",
      unitCode: "CELSIUS",
      inspectionItemId: 51,
      itemId: 61,
      itemCode: "ITEM-61",
      processId: 71,
      processCode: "PROC-71",
      inspectionItemName: "사이클타임",
      inspectionItemCode: "CYCLE_TIME",
      inspectionItemUnitCode: "SECOND",
      inspectionPlanVersionId: 81,
      inspectionPlanVersion: 2,
      inspectionItemIsCurrentRevision: false,
      isActive: true,
    });
  });

  it("미매핑 nullable은 null로 내고 없는 signalName·unitCode만 생략한다", () => {
    const row = projection();
    row.signal_name = null;
    row.uom_id = null;
    row.unit_code = null;
    row.inspection_item_id = null;
    row.inspection_item_name = null;
    row.inspection_item_code = null;
    row.inspection_item_unit_code = null;
    row.inspection_plan_version_id = null;
    row.inspection_plan_version = null;
    row.inspection_item_is_current_revision = null;
    const view = collectionChannelView(row);
    expect(view).toMatchObject({ inspectionItemId: null, inspectionItemIsCurrentRevision: null });
    expect(view).not.toHaveProperty("signalName");
    expect(view).not.toHaveProperty("unitCode");
  });

  it("과거 channelKey 결손을 옛 channelCode로 추정하지 않는다", () => {
    const row = projection();
    row.channel_key = null;
    expect(() => collectionChannelView(row)).toThrow("Missing required collection channel field");
  });
});

function projection(): CollectionChannelProjection {
  return {
    collection_channel_id: 31n,
    equipment_id: 41n,
    equipment_code: "PRS-41",
    channel_key: "PRS41.TEMP.01",
    signal_name: "히터 온도",
    uom_id: 91n,
    unit_code: "CELSIUS",
    inspection_item_id: 51n,
    item_id: 61n,
    item_code: "ITEM-61",
    process_id: 71n,
    process_code: "PROC-71",
    inspection_item_name: "사이클타임",
    inspection_item_code: "CYCLE_TIME",
    inspection_item_unit_code: "SECOND",
    inspection_plan_version_id: 81n,
    inspection_plan_version: 2,
    inspection_item_is_current_revision: false,
    is_active: true,
    version_no: 3,
  };
}
