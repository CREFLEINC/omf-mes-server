import { assertWorkerNoExists } from "../../common/master";
import type { MaintenanceInstant } from "../maintenance-instant";
import {
  assertDowntimeBreakdown,
  assertDowntimeNotReopened,
  assertDowntimeReason,
  assertDowntimeVersion,
  assertDowntimeWindow,
  assertNoOpenDowntime,
  type DowntimeTx,
  type LockedDowntime,
  lockDowntimeEquipment,
  lockDowntimeForUpdate,
} from "./downtime-rules";

describe("downtime rules", () => {
  const raw = jest.fn();
  const worker = { findUnique: jest.fn() };
  const codeValue = { findFirst: jest.fn() };
  const tx = {
    $queryRaw: raw,
    worker,
    code_value: codeValue,
  } as unknown as DowntimeTx;

  beforeEach(() => jest.clearAllMocks());

  it("작업자 실재와 활성 사유 그룹·값을 각각 검증한다", async () => {
    worker.findUnique.mockResolvedValue({ worker_id: 1n });
    codeValue.findFirst.mockResolvedValue({ code_value_id: 2n });

    // 판정은 `common/master/worker-no.ts` 로 옮겼다(#337) — 여기서는 «가동중지가 그것을 쓴다»를 잰다.
    await assertWorkerNoExists(tx, "W-1");
    await assertDowntimeReason(tx, "MOLD_CHANGE");

    expect(worker.findUnique).toHaveBeenCalledWith({
      where: { worker_no: "W-1" },
      select: { worker_id: true },
    });
    expect(codeValue.findFirst).toHaveBeenCalledWith({
      where: {
        code: "MOLD_CHANGE",
        is_active: true,
        code_group: { group_code: "DOWNTIME_REASON", is_active: true },
      },
      select: { code_value_id: true },
    });
  });

  it("없는 작업자와 사용할 수 없는 사유는 400 INVALID다", async () => {
    worker.findUnique.mockResolvedValue(null);
    codeValue.findFirst.mockResolvedValue(null);

    await expect(assertWorkerNoExists(tx, "NONE")).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "X-Worker-No", code: "INVALID" }],
    });
    await expect(assertDowntimeReason(tx, "OLD")).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "reasonCode", code: "INVALID" }],
    });
  });

  it("설비는 활성 여부를 묻지 않고 그 행 자체를 잠근다", async () => {
    raw.mockResolvedValue([{ equipment_id: 7n }]);
    await expect(lockDowntimeEquipment(tx, 7)).resolves.toBe(7n);

    const { sql, values } = statement(raw.mock.calls[0]);
    expect(sql).toContain("FROM mdm.equipment");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).not.toContain("is_active");
    expect(values).toEqual([7n]);
  });

  it("없는 설비는 400 INVALID다", async () => {
    raw.mockResolvedValue([]);
    await expect(lockDowntimeEquipment(tx, 404)).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "equipmentId", code: "INVALID" }],
    });
  });

  it("수정은 대상 조회 뒤 설비를 먼저 잠그고 비가동 행을 잠근다", async () => {
    raw
      .mockResolvedValueOnce([{ equipment_id: 7n }])
      .mockResolvedValueOnce([{ equipment_id: 7n }])
      .mockResolvedValueOnce([downtime()]);

    await expect(lockDowntimeForUpdate(tx, 5)).resolves.toEqual(downtime());

    const statements = raw.mock.calls.map((call) => statement(call).sql);
    expect(statements[0]).toContain("equipment_downtime");
    expect(statements[0]).not.toContain("FOR UPDATE");
    expect(statements[1]).toContain("mdm.equipment");
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements[2]).toContain("equipment_downtime");
    expect(statements[2]).toContain("FOR UPDATE");
    expect(statements[2]).toContain("started_epoch_us");
  });

  it.each([0, 2])(
    "수정 대상이 잠금 전후 사라지면 404다 (단계 %i)",
    async (stage) => {
      if (stage === 0) raw.mockResolvedValueOnce([]);
      else {
        raw
          .mockResolvedValueOnce([{ equipment_id: 7n }])
          .mockResolvedValueOnce([{ equipment_id: 7n }])
          .mockResolvedValueOnce([]);
      }
      await expect(lockDowntimeForUpdate(tx, 404)).rejects.toMatchObject({
        status: 404,
      });
    },
  );

  it("버전은 일치하면 통과하고 다르면 409 user 충돌이다", () => {
    expect(() => assertDowntimeVersion(downtime(), 3)).not.toThrow();
    expect(() => assertDowntimeVersion(downtime(), 2)).toThrow(
      expect.objectContaining({
        status: 409,
        conflict: expect.objectContaining({ conflictCause: "user" }),
      }),
    );
  });

  it("종료 null·동시각은 허용하고 역전은 두 필드 PAIR다", () => {
    expect(() => assertDowntimeWindow(instant(10n), null)).not.toThrow();
    expect(() =>
      assertDowntimeWindow(instant(10n), instant(10n)),
    ).not.toThrow();
    expect(() => assertDowntimeWindow(instant(10n), instant(9n))).toThrow(
      expect.objectContaining({
        status: 400,
        errors: [
          expect.objectContaining({ field: "startedAt", code: "PAIR" }),
          expect.objectContaining({ field: "endedAt", code: "PAIR" }),
        ],
      }),
    );
  });

  it("열린 비가동 중복은 422 STATE_LOCKED다", async () => {
    raw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ found: 1 }]);
    await expect(assertNoOpenDowntime(tx, 7n)).resolves.toBeUndefined();
    await expect(assertNoOpenDowntime(tx, 7n)).rejects.toMatchObject({
      status: 422,
      errors: [{ field: "equipmentId", code: "STATE_LOCKED" }],
    });
  });

  it("고장 연결 생략·열린 동일 설비는 허용하고 행을 잠근다", async () => {
    await assertDowntimeBreakdown(tx, null, 7n, "create");
    expect(raw).not.toHaveBeenCalled();

    raw.mockResolvedValue([{ equipment_id: 7n, status_code: "HANDLING" }]);
    await assertDowntimeBreakdown(tx, 8, 7n, "create");
    expect(statement(raw.mock.calls[0]).sql).toContain("FOR UPDATE");
  });

  it("없는 고장과 다른 설비 고장은 각각 INVALID와 두 필드 PAIR다", async () => {
    raw.mockResolvedValueOnce([]);
    await expect(
      assertDowntimeBreakdown(tx, 404, 7n, "create"),
    ).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "breakdownId", code: "INVALID" }],
    });

    raw.mockResolvedValueOnce([{ equipment_id: 8n, status_code: "RECEIVED" }]);
    await expect(
      assertDowntimeBreakdown(tx, 8, 7n, "create"),
    ).rejects.toMatchObject({
      status: 400,
      errors: [
        { field: "equipmentId", code: "PAIR" },
        { field: "breakdownId", code: "PAIR" },
      ],
    });
  });

  it.each([
    ["create" as const, 422],
    ["update" as const, 400],
  ])("완료 고장 새 연결은 %s에서 %i다", async (operation, status) => {
    raw.mockResolvedValue([{ equipment_id: 7n, status_code: "DONE" }]);
    await expect(
      assertDowntimeBreakdown(tx, 8, 7n, operation),
    ).rejects.toMatchObject({
      status,
      errors: [{ field: "breakdownId", code: "STATE_LOCKED" }],
    });
  });

  it("종료 행의 명시적 null만 재개로 보고 거절한다", () => {
    expect(() =>
      assertDowntimeNotReopened(downtime(), undefined),
    ).not.toThrow();
    expect(() =>
      assertDowntimeNotReopened(downtime({ ended_epoch_us: null }), null),
    ).not.toThrow();
    expect(() => assertDowntimeNotReopened(downtime(), null)).toThrow(
      expect.objectContaining({
        status: 400,
        errors: [
          expect.objectContaining({ field: "endedAt", code: "STATE_LOCKED" }),
        ],
      }),
    );
  });
});

function downtime(change: Partial<LockedDowntime> = {}): LockedDowntime {
  return {
    downtime_id: 5n,
    equipment_id: 7n,
    version_no: 3,
    started_epoch_us: "10",
    ended_epoch_us: "20",
    ...change,
  };
}

function instant(epochMicroseconds: bigint): MaintenanceInstant {
  return { epochMicroseconds, utcIso: "", sqlTimestamp: "" };
}

function statement(call: unknown[]): { sql: string; values: unknown[] } {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return { sql: strings.join("?"), values };
}
