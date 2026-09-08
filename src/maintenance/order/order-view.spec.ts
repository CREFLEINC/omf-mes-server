import { MaintenanceOrderRow, maintenanceOrderView } from "./order-view";

describe("maintenanceOrderView", () => {
  it("E-Q01 지시·항목·촉발 전 필드를 정본 원천으로 반환한다", () => {
    const view = maintenanceOrderView(orderRow());
    expect(view).toEqual({
      maintenanceOrderId: 11,
      maintenanceOrderNo: "MO-11",
      targetTypeCode: "EQUIPMENT",
      targetId: 21,
      targetCode: "EQ-CURRENT",
      maintenanceTypeCode: "CORRECTIVE",
      plannedDate: "2026-09-08",
      assigneeUserId: 31,
      statusCode: "ISSUED",
      items: [
        {
          orderItemId: 41,
          itemName: "현재 마스터명",
          statusCode: "PLANNED",
          inspectionItemId: 51,
          sequenceNo: 1,
        },
      ],
      triggers: [
        {
          triggerTypeCode: "BREAKDOWN",
          sourceId: 61,
          snapshotNote: null,
          shotCountAtDue: 2147483648,
          guaranteedShotCountAtDue: null,
        },
      ],
      baseDate: null,
      orderNote: "지시 원문",
      issuedByUserId: 71,
      issuedAt: "2026-09-08T06:00:00.000Z",
    });
    expect(view).not.toHaveProperty("versionNo");
    expect(view.triggers[0]).not.toHaveProperty("pmDueAxisCode");
  });

  it("MOLD는 저장된 자유 항목명과 DATE 촉발축을 보존한다", () => {
    const row = orderRow({
      target_type_code: "MOLD",
      equipment_id: null,
      equipment: null,
      mold_id: 22n,
      mold: { mold_code: "MOLD-CURRENT" },
      assignee_user_id: null,
    });
    row.maintenance_order_item[0].item_name = "자유 항목";
    row.maintenance_order_item[0].inspection_item_id = null;
    row.maintenance_order_item[0].equipment_inspection_item = null;
    row.maintenance_order_trigger[0].pm_due_axis_code = "DATE";
    const view = maintenanceOrderView(row);
    expect(view.items[0].itemName).toBe("자유 항목");
    expect(view.triggers[0].pmDueAxisCode).toBe("DATE");
    expect(view).not.toHaveProperty("assigneeUserId");
  });

  it.each([
    { planned_date: null },
    { target_type_code: "LEGACY" },
    { target_type_code: "EQUIPMENT", equipment_id: null },
  ])("E-Q08 required 구행을 추측해 보완하지 않는다: %j", (change) => {
    expect(() => maintenanceOrderView(orderRow(change))).toThrow();
  });

  it("응답 int64를 반올림한 식별자나 누계로 내리지 않는다", () => {
    expect(() =>
      maintenanceOrderView(
        orderRow({
          maintenance_order_id: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        }),
      ),
    ).toThrow("safe range");
    const row = orderRow();
    row.maintenance_order_trigger[0].shot_count_at_due =
      BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => maintenanceOrderView(row)).toThrow("safe range");
  });
});

function orderRow(
  change: Partial<MaintenanceOrderRow> = {},
): MaintenanceOrderRow {
  return {
    maintenance_order_id: 11n,
    maintenance_order_no: "MO-11",
    target_type_code: "EQUIPMENT",
    equipment_id: 21n,
    mold_id: null,
    breakdown_id: null,
    order_type_code: "CORRECTIVE",
    priority_code: null,
    scheduled_start_at: null,
    scheduled_end_at: null,
    assigned_worker_id: null,
    status_code: "ISSUED",
    cancellation_reason_code: null,
    planned_date: new Date("2026-09-08T00:00:00Z"),
    base_date: null,
    order_note: "지시 원문",
    assignee_user_id: 31n,
    issued_by: 71n,
    issued_at: new Date("2026-09-08T06:00:00Z"),
    cancelled_at: null,
    cancelled_by: null,
    created_at: new Date("2026-09-08T06:00:00Z"),
    created_by: 71n,
    updated_at: new Date("2026-09-08T06:00:00Z"),
    updated_by: null,
    version_no: 7,
    equipment: { equipment_code: "EQ-CURRENT" },
    mold: null,
    maintenance_order_item: [
      {
        maintenance_order_item_id: 41n,
        maintenance_order_id: 11n,
        sequence_no: 1,
        inspection_item_id: 51n,
        item_name: "옛 스냅샷명",
        status_code: "PLANNED",
        equipment_inspection_item: { inspection_item_name: "현재 마스터명" },
      },
    ],
    maintenance_order_trigger: [
      {
        maintenance_order_trigger_id: 81n,
        maintenance_order_id: 11n,
        trigger_type_code: "BREAKDOWN",
        source_id: 61n,
        snapshot_note: null,
        pm_due_axis_code: null,
        shot_count_at_due: 2147483648n,
        guaranteed_shot_count_at_due: null,
        created_at: new Date("2026-09-08T06:00:00Z"),
      },
    ],
    ...change,
  } as MaintenanceOrderRow;
}
