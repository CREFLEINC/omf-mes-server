import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { CalibrationQueryService } from "./calibration-query.service";
import { CalibrationProjection } from "./calibration-view";

describe("CalibrationQueryService", () => {
  const raw = jest.fn();
  const tx = { $queryRaw: raw };
  const transaction = jest.fn(
    async (
      work: (client: typeof tx) => Promise<unknown>,
      _options?: { isolationLevel: string },
    ) => work(tx),
  );
  const service = new CalibrationQueryService({
    $queryRaw: raw,
    $transaction: transaction,
  } as unknown as PrismaService);

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

  it("목록은 필터·정렬·count·page·projection을 한 스냅샷에서 읽는다", async () => {
    raw
      .mockResolvedValueOnce([{ has_missing_type: false }])
      .mockResolvedValueOnce([{ equipment_calibration_id: 31n }])
      .mockResolvedValueOnce([{ total: 1n }])
      .mockResolvedValueOnce([projection()]);
    await expect(
      service.list({
        equipmentId: 41,
        historyTypeCode: "CHECK",
        dueBefore: "2027-09-10",
        performedFrom: "2026-09-01",
        performedTo: "2026-09-30",
        page: 2,
        size: 1,
      }),
    ).resolves.toMatchObject({
      items: [{ calibrationId: 31 }],
      totalCount: 1,
      page: { page: 2, size: 1, total: 1 },
    });
    const [missing, ids, count, projected] = raw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    expect(missing.sql).toContain("bool_or(c.history_type_code IS NULL)");
    expect(missing.values).not.toContain("CHECK");
    expect(ids.sql).toContain("ORDER BY c.calibration_date DESC");
    expect(ids.values.slice(0, -2)).toEqual(count.values);
    expect(projected.values).toEqual([31n]);
    expect(transaction.mock.calls[0][1]).toEqual({ isolationLevel: "RepeatableRead" });
  });

  it("유형 필터보다 먼저 같은 설비·DATE 후보의 과거 NULL 유형을 드러낸다", async () => {
    raw.mockResolvedValueOnce([{ has_missing_type: true }]);
    await expect(
      service.list({ equipmentId: 41, historyTypeCode: "CALIBRATION" }),
    ).rejects.toThrow("Missing required calibration history type");
    const sql = raw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values).toEqual([41]);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("역전 수행기간과 안전 범위 밖 질의는 DB 전에 끝낸다", async () => {
    await expect(
      service.list({ performedFrom: "2026-09-10", performedTo: "2026-09-09" }),
    ).resolves.toMatchObject({ items: [], totalCount: 0 });
    await expect(service.list({ equipmentId: Number.MAX_SAFE_INTEGER + 1 })).rejects.toMatchObject({
      status: 400,
      errors: [{ field: "equipmentId", code: "RANGE" }],
    });
    expect(transaction).not.toHaveBeenCalled();
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
