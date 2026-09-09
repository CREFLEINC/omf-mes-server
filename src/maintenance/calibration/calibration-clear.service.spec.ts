import { Prisma } from "@prisma/client";

import { CalibrationClearService } from "./calibration-clear.service";
import { CalibrationProjection } from "./calibration-view";
import { CalibrationWriteContext } from "./calibration-write-context";

describe("CalibrationClearService", () => {
  const raw = jest.fn();
  const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
  const service = new CalibrationClearService();
  const context: CalibrationWriteContext = {
    key: "idem-1",
    fingerprint: "fingerprint",
    appUserId: 17,
    successStatus: 200,
  };

  beforeEach(() => jest.clearAllMocks());

  it("차단 의사를 유지하며 서버 시각과 해소 계정만 기록한다", async () => {
    raw
      .mockResolvedValueOnce([
        { equipment_calibration_id: 31n, blocks_use: true, cleared_epoch_microseconds: null },
      ])
      .mockResolvedValueOnce([{ cleared_epoch_microseconds: "1788915723123456" }])
      .mockResolvedValueOnce([projection("1788915723123456")]);
    await expect(service.clearWithin(tx, 31, context)).resolves.toMatchObject({
      calibrationId: 31,
      blocksUse: true,
      clearedAt: "2026-09-09T01:02:03.123456Z",
    });
    const update = raw.mock.calls[1][0] as Prisma.Sql;
    expect(update.sql).toContain("cleared_at = clock_timestamp()");
    expect(update.values).toEqual([17n, 31n]);
  });

  it("없는 이력은 404다", async () => {
    raw.mockResolvedValue([]);
    await expect(service.clearWithin(tx, 404, context)).rejects.toMatchObject({ status: 404 });
  });

  it("비차단 이력은 이미 해소됐더라도 400을 먼저 낸다", async () => {
    raw.mockResolvedValue([
      {
        equipment_calibration_id: 31n,
        blocks_use: false,
        cleared_epoch_microseconds: "1788915723123456",
      },
    ]);
    await expect(service.clearWithin(tx, 31, context)).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "calibrationId", code: "STATE_LOCKED" }],
    });
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("이미 해소된 차단 이력은 공용 409 봉투다", async () => {
    raw.mockResolvedValue([
      {
        equipment_calibration_id: 31n,
        blocks_use: true,
        cleared_epoch_microseconds: "1788915723123456",
      },
    ]);
    await expect(service.clearWithin(tx, 31, context)).rejects.toMatchObject({
      status: 409,
      conflict: { conflictCause: "user" },
    });
  });

  it("안전 범위 밖 ID는 DB 전에 400이다", async () => {
    await expect(
      service.clearWithin(tx, Number.MAX_SAFE_INTEGER + 1, context),
    ).rejects.toMatchObject({ status: 400, errors: [{ field: "calibrationId", code: "RANGE" }] });
    expect(raw).not.toHaveBeenCalled();
  });
});

function projection(cleared: string): CalibrationProjection {
  return {
    equipment_calibration_id: 31n,
    equipment_id: 41n,
    equipment_code: "GAU-0041",
    history_type_code: "CHECK",
    performed_on: "2026-09-09",
    result_code: "NORMAL",
    certificate_no: null,
    agency_type_code: null,
    agency_name: null,
    next_due_on: null,
    tolerance_note: null,
    recorded_by: 17n,
    calibrated_by: null,
    remarks: null,
    blocks_use: true,
    cleared_epoch_microseconds: cleared,
  };
}
