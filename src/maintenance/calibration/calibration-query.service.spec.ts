import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { CalibrationQueryService } from "./calibration-query.service";
import { CalibrationProjection } from "./calibration-view";

describe("CalibrationQueryService", () => {
  const raw = jest.fn();
  const service = new CalibrationQueryService({ $queryRaw: raw } as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it("상세는 DATE 문자열과 clearedAt 원시 마이크로초를 조회한다", async () => {
    raw.mockResolvedValue([projection()]);
    await expect(service.get(31)).resolves.toMatchObject({ calibrationId: 31 });
    const sql = raw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain("to_char(c.calibration_date, 'YYYY-MM-DD')");
    expect(sql.sql).toContain("extract(epoch FROM c.cleared_at) * 1000000");
    expect(sql.values).toEqual([31n]);
  });

  it("없는 이력은 404다", async () => {
    raw.mockResolvedValue([]);
    await expect(service.get(404)).rejects.toMatchObject({ status: 404 });
  });

  it("안전 범위를 넘은 ID는 DB 전에 거절한다", async () => {
    await expect(service.get(Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "calibrationId", code: "RANGE" }],
    });
    expect(raw).not.toHaveBeenCalled();
  });
});

function projection(): CalibrationProjection {
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
    recorded_by: 51n,
    calibrated_by: 51n,
    remarks: null,
    blocks_use: false,
    cleared_epoch_microseconds: null,
  };
}
