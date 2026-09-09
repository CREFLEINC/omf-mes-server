import { Prisma } from "@prisma/client";

import { CalibrationCreateService } from "./calibration-create.service";
import { CalibrationProjection } from "./calibration-view";
import { CalibrationWriteContext } from "./calibration-write-context";

describe("CalibrationCreateService", () => {
  const raw = jest.fn();
  const codeRows = jest.fn();
  const findUser = jest.fn();
  const findDuplicate = jest.fn();
  const create = jest.fn();
  const updateEquipment = jest.fn();
  const tx = {
    $queryRaw: raw,
    app_user: { findUnique: findUser },
    equipment_calibration: { findFirst: findDuplicate, create },
    equipment: { update: updateEquipment },
  } as unknown as Prisma.TransactionClient;
  const service = new CalibrationCreateService();
  const context: CalibrationWriteContext = {
    key: "idem-1",
    fingerprint: "fingerprint",
    appUserId: 17,
    successStatus: 201,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    codeRows.mockImplementation((sql: Prisma.Sql) =>
      sql.values.reduce<{ group_code: string; code: string }[]>((rows, value, index) => {
        if (index % 2 === 0) rows.push({ group_code: String(value), code: String(sql.values[index + 1]) });
        return rows;
      }, []),
    );
    raw.mockImplementation((sql: Prisma.Sql) => {
      if (sql.sql.includes("FROM mdm.code_value")) return codeRows(sql);
      if (sql.sql.includes("FROM mdm.equipment WHERE")) return [{ equipment_id: 41n }];
      return [projection()];
    });
    findUser.mockResolvedValue({ app_user_id: 19n });
    findDuplicate.mockResolvedValue(null);
    create.mockResolvedValue({ equipment_calibration_id: 31n });
    updateEquipment.mockResolvedValue({});
  });

  it("비검교정은 필수 네 칸만 이력에 저장하고 마스터를 바꾸지 않는다", async () => {
    await expect(
      service.createWithin(
        tx,
        {
          equipmentId: 41,
          historyTypeCode: "CHECK",
          performedOn: "2026-09-09",
          resultCode: "NORMAL",
        },
        context,
      ),
    ).resolves.toMatchObject({ calibrationId: 31 });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recorded_by: 17n,
          created_by: 17n,
          blocks_use: false,
          valid_until: null,
        }),
      }),
    );
    expect(updateEquipment).not.toHaveBeenCalled();
  });

  it("합격은 수행자와 기록자를 나누고 설비 날짜·version을 같은 tx에서 바꾼다", async () => {
    await service.createWithin(
      tx,
      {
        equipmentId: 41,
        historyTypeCode: "CALIBRATION",
        performedOn: "2026-09-09",
        resultCode: "PASS",
        agencyTypeCode: "INTERNAL",
        performedByUserId: 19,
        nextDueOn: null,
        blocksUse: true,
      },
      context,
    );
    expect(create.mock.calls[0][0].data).toMatchObject({
      calibrated_by: 19n,
      recorded_by: 17n,
      created_by: 17n,
      blocks_use: true,
    });
    expect(updateEquipment).toHaveBeenCalledWith({
      where: { equipment_id: 41n },
      data: {
        last_calibration_date: new Date("2026-09-09T00:00:00.000Z"),
        calibration_due_date: null,
        version_no: { increment: 1 },
        updated_by: 17n,
      },
    });
  });

  it("없거나 비활성인 코드는 어떤 쓰기보다 먼저 400이다", async () => {
    codeRows.mockReturnValue([]);
    await expect(
      service.createWithin(
        tx,
        { equipmentId: 41, historyTypeCode: "CHECK", performedOn: "2026-09-09", resultCode: "NORMAL" },
        context,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
    expect(updateEquipment).not.toHaveBeenCalled();
  });

  it("없는 설비와 없는 수행자는 입력 오류다", async () => {
    findUser.mockResolvedValueOnce(null);
    await expect(
      service.createWithin(
        tx,
        {
          equipmentId: 41,
          historyTypeCode: "CALIBRATION",
          performedOn: "2026-09-09",
          resultCode: "PASS",
          agencyTypeCode: "INTERNAL",
          performedByUserId: 19,
        },
        context,
      ),
    ).rejects.toMatchObject({ errors: [{ field: "performedByUserId", code: "INVALID" }] });

    raw.mockImplementation((sql: Prisma.Sql) => {
      if (sql.sql.includes("FROM mdm.code_value")) return codeRows(sql);
      return [];
    });
    await expect(
      service.createWithin(
        tx,
        { equipmentId: 41, historyTypeCode: "CHECK", performedOn: "2026-09-09", resultCode: "NORMAL" },
        context,
      ),
    ).rejects.toMatchObject({ errors: [{ field: "equipmentId", code: "INVALID" }] });
    expect(create).not.toHaveBeenCalled();
  });

  it("같은 설비·수행일·유형 중복은 세 축을 밝힌 400이다", async () => {
    findDuplicate.mockResolvedValue({ equipment_calibration_id: 30n });
    await expect(
      service.createWithin(
        tx,
        { equipmentId: 41, historyTypeCode: "CHECK", performedOn: "2026-09-09", resultCode: "NORMAL" },
        context,
      ),
    ).rejects.toMatchObject({
      status: 400,
      errors: [
        {
          code: "UNIQUE_VIOLATION",
          uniqueScope: ["equipmentId", "performedOn", "historyTypeCode"],
        },
      ],
    });
    expect(create).not.toHaveBeenCalled();
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
    recorded_by: 17n,
    calibrated_by: null,
    remarks: null,
    blocks_use: false,
    cleared_epoch_microseconds: null,
  };
}
