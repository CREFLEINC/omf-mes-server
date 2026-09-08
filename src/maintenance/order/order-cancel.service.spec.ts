import { ConflictException } from "../../common/errors";
import { DocumentStateService } from "../../core/document-state";
import { MaintenanceOrderCancelService } from "./order-cancel.service";
import { MaintenanceOrderRow } from "./order-view";
import { MaintenanceOrderWriteContext } from "./order-write-context";

describe("MaintenanceOrderCancelService", () => {
  const raw = jest.fn();
  const count = jest.fn();
  const updateMany = jest.fn();
  const findUnique = jest.fn();
  const tx = {
    $queryRaw: raw,
    maintenance_result: { count },
    maintenance_order: { updateMany, findUnique },
  };
  const service = new MaintenanceOrderCancelService(
    new DocumentStateService(),
  );
  const context: MaintenanceOrderWriteContext = {
    key: "key",
    fingerprint: "fingerprint",
    appUserId: 9,
    successStatus: 200,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    raw.mockResolvedValue([
      { maintenance_order_id: 11n, status_code: "ISSUED", version_no: 3 },
    ]);
    count.mockResolvedValue(0);
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue(orderRow());
  });

  it("지시를 잠그고 실적 0건이면 상태·취소 감사·version을 한 번에 갱신한다", async () => {
    await expect(
      service.cancelWithin(tx as never, 11, 3, context),
    ).resolves.toMatchObject({
      maintenanceOrderId: 11,
      statusCode: "CANCELLED",
    });
    expect(raw.mock.calls[0][0].sql).toContain("FOR UPDATE");
    expect(count).toHaveBeenCalledWith({
      where: { maintenance_order_id: 11n },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { maintenance_order_id: 11n, version_no: 3 },
      data: expect.objectContaining({
        status_code: "CANCELLED",
        cancelled_by: 9n,
        updated_by: 9n,
        version_no: { increment: 1 },
      }),
    });
    expect(updateMany.mock.calls[0][0].data.cancelled_at).toBe(
      updateMany.mock.calls[0][0].data.updated_at,
    );
  });

  it("없는 지시는 404이고 안전 정수 밖 ID는 DB 전에 400이다", async () => {
    raw.mockResolvedValueOnce([]);
    await expect(
      service.cancelWithin(tx as never, 99, 1, context),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.cancelWithin(
        tx as never,
        Number.MAX_SAFE_INTEGER + 1,
        1,
        context,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("stale version은 상태·실적보다 먼저 409다", async () => {
    await expect(
      service.cancelWithin(tx as never, 11, 2, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(count).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["DONE", 0],
    ["CANCELLED", 0],
    ["ISSUED", 1],
  ])("상태 %s·실적 %i건이면 400 STATE_LOCKED다", async (status, results) => {
    raw.mockResolvedValueOnce([
      { maintenance_order_id: 11n, status_code: status, version_no: 3 },
    ]);
    count.mockResolvedValueOnce(results);
    await expect(
      service.cancelWithin(tx as never, 11, 3, context),
    ).rejects.toMatchObject({
      status: 400,
      errors: [{ code: "STATE_LOCKED" }],
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("잠금 뒤 조건부 update가 0행이면 저장 충돌 409다", async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.cancelWithin(tx as never, 11, 3, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

function orderRow(): MaintenanceOrderRow {
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
    status_code: "CANCELLED",
    cancellation_reason_code: null,
    planned_date: new Date("2026-09-08"),
    base_date: null,
    order_note: null,
    assignee_user_id: 9n,
    issued_by: 9n,
    issued_at: new Date("2026-09-08T00:00:00Z"),
    cancelled_at: new Date("2026-09-08T01:00:00Z"),
    cancelled_by: 9n,
    created_at: new Date("2026-09-08T00:00:00Z"),
    created_by: 9n,
    updated_at: new Date("2026-09-08T01:00:00Z"),
    updated_by: 9n,
    version_no: 4,
    equipment: { equipment_code: "EQ-21" },
    mold: null,
    maintenance_order_item: [],
    maintenance_order_trigger: [],
  } as MaintenanceOrderRow;
}
