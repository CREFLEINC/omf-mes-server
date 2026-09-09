import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, ErrorItem, field, one } from "../../common/errors";
import { readCalibrationWithin } from "./calibration-query.service";
import { CalibrationView, calibrationView } from "./calibration-view";
import { CalibrationWriteContext } from "./calibration-write-context";
import {
  CALIBRATION_AGENCY_GROUP,
  CALIBRATION_HISTORY_GROUP,
  CALIBRATION_RESULT_GROUP,
  CalibrationCreate,
  CheckedCalibrationCreate,
  calibrationMasterEffect,
  checkCalibrationCreate,
} from "./calibration-write-input";

type CodeRow = { group_code: string; code: string };
type EquipmentRow = { equipment_id: bigint };

@Injectable()
export class CalibrationCreateService {
  async createWithin(
    tx: Prisma.TransactionClient,
    input: CalibrationCreate,
    context: CalibrationWriteContext,
  ): Promise<CalibrationView> {
    const checked = checkCalibrationCreate(input);
    await assertCodes(tx, checked);
    const effect = calibrationMasterEffect(checked);
    await assertPerformer(tx, checked.performedByUserId);
    await lockEquipment(tx, checked.equipmentId);
    await assertNotDuplicate(tx, checked);

    const actorId = BigInt(context.appUserId);
    const created = await tx.equipment_calibration.create({
      data: {
        equipment_id: checked.equipmentId,
        calibration_date: dateOf(checked.performedOn),
        result_code: checked.resultCode,
        valid_until: checked.nextDueOn === null ? null : dateOf(checked.nextDueOn),
        certificate_no: checked.certificateNo,
        calibrated_by: checked.performedByUserId,
        remarks: checked.remarks,
        created_by: actorId,
        history_type_code: checked.historyTypeCode,
        agency_type_code: checked.agencyTypeCode,
        agency_name: checked.agencyName,
        tolerance_note: checked.toleranceNote,
        recorded_by: actorId,
        blocks_use: checked.blocksUse,
      },
      select: { equipment_calibration_id: true },
    });

    if (effect === "UPDATE_MASTER") {
      await tx.equipment.update({
        where: { equipment_id: checked.equipmentId },
        data: {
          last_calibration_date: dateOf(checked.performedOn),
          calibration_due_date:
            checked.nextDueOn === null ? null : dateOf(checked.nextDueOn),
          version_no: { increment: 1 },
          updated_by: actorId,
        },
      });
    }

    const row = await readCalibrationWithin(tx, created.equipment_calibration_id);
    if (row === null) throw new Error("Created calibration is missing");
    return calibrationView(row);
  }
}

async function assertCodes(
  tx: Prisma.TransactionClient,
  input: CheckedCalibrationCreate,
): Promise<void> {
  const checks = [
    { field: "historyTypeCode", value: input.historyTypeCode, group: CALIBRATION_HISTORY_GROUP },
    { field: "resultCode", value: input.resultCode, group: CALIBRATION_RESULT_GROUP },
    ...(input.agencyTypeCode === null
      ? []
      : [{ field: "agencyTypeCode", value: input.agencyTypeCode, group: CALIBRATION_AGENCY_GROUP }]),
  ];
  const rows = await tx.$queryRaw<CodeRow[]>(Prisma.sql`
    SELECT cg.group_code, cv.code
    FROM mdm.code_value cv
    JOIN mdm.code_group cg ON cg.code_group_id = cv.code_group_id
    WHERE cg.is_active AND cv.is_active AND
      (${Prisma.join(
        checks.map(
          (check) => Prisma.sql`(cg.group_code = ${check.group} AND cv.code = ${check.value})`,
        ),
        " OR ",
      )})`);
  const known = new Set(rows.map((row) => `${row.group_code} ${row.code}`));
  const errors: ErrorItem[] = checks
    .filter((check) => !known.has(`${check.group} ${check.value}`))
    .map((check) =>
      field(check.field, ERROR_CODE.INVALID, `${check.group} 에 없거나 사용 중지된 코드입니다.`),
    );
  if (errors.length) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

async function assertPerformer(
  tx: Prisma.TransactionClient,
  performedByUserId: bigint | null,
): Promise<void> {
  if (performedByUserId === null) return;
  const user = await tx.app_user.findUnique({
    where: { app_user_id: performedByUserId },
    select: { app_user_id: true },
  });
  if (!user) {
    throw one(field("performedByUserId", ERROR_CODE.INVALID, "없는 수행자 계정입니다."));
  }
}

async function lockEquipment(tx: Prisma.TransactionClient, equipmentId: bigint): Promise<void> {
  const rows = await tx.$queryRaw<EquipmentRow[]>(Prisma.sql`
    SELECT equipment_id FROM mdm.equipment WHERE equipment_id = ${equipmentId} FOR UPDATE`);
  if (rows.length === 0) {
    throw one(field("equipmentId", ERROR_CODE.INVALID, "없는 설비입니다."));
  }
}

async function assertNotDuplicate(
  tx: Prisma.TransactionClient,
  input: CheckedCalibrationCreate,
): Promise<void> {
  const duplicate = await tx.equipment_calibration.findFirst({
    where: {
      equipment_id: input.equipmentId,
      calibration_date: dateOf(input.performedOn),
      history_type_code: input.historyTypeCode,
    },
    select: { equipment_calibration_id: true },
  });
  if (duplicate) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: "screen",
        code: ERROR_CODE.UNIQUE_VIOLATION,
        message: "같은 설비·수행일·이력 유형이 이미 있습니다.",
        uniqueScope: ["equipmentId", "performedOn", "historyTypeCode"],
      },
    ]);
  }
}

function dateOf(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
