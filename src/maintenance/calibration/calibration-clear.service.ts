import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ConflictException, ContractException, ERROR_CODE, field } from "../../common/errors";
import { readCalibrationWithin } from "./calibration-query.service";
import { CalibrationView, calibrationView } from "./calibration-view";
import { CalibrationWriteContext } from "./calibration-write-context";

interface LockedCalibration {
  equipment_calibration_id: bigint;
  blocks_use: boolean;
  cleared_epoch_microseconds: string | null;
}

interface ClearedCalibration {
  cleared_epoch_microseconds: string;
}

@Injectable()
export class CalibrationClearService {
  async clearWithin(
    tx: Prisma.TransactionClient,
    calibrationId: number,
    context: CalibrationWriteContext,
  ): Promise<CalibrationView> {
    if (!Number.isSafeInteger(calibrationId)) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field("calibrationId", ERROR_CODE.RANGE, "검교정 이력 식별자 범위가 너무 큽니다."),
      ]);
    }
    const id = BigInt(calibrationId);
    const locked = await tx.$queryRaw<LockedCalibration[]>(Prisma.sql`
      SELECT equipment_calibration_id, blocks_use,
             CASE WHEN cleared_at IS NULL THEN NULL ELSE
               (extract(epoch FROM cleared_at) * 1000000)::numeric(30,0)::text END
               AS cleared_epoch_microseconds
      FROM quality.equipment_calibration
      WHERE equipment_calibration_id = ${id}
      FOR UPDATE`);
    const row = locked[0];
    if (!row) throw new NotFoundException("없는 검교정 이력입니다.");
    if (!row.blocks_use) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field("calibrationId", ERROR_CODE.STATE_LOCKED, "막고 있지 않은 이력입니다."),
      ]);
    }
    if (row.cleared_epoch_microseconds !== null) {
      throw new ConflictException("user", "이미 해소된 검교정 이력입니다.");
    }

    const cleared = await tx.$queryRaw<ClearedCalibration[]>(Prisma.sql`
      UPDATE quality.equipment_calibration
      SET cleared_at = clock_timestamp(), cleared_by = ${BigInt(context.appUserId)}
      WHERE equipment_calibration_id = ${id}
      RETURNING (extract(epoch FROM cleared_at) * 1000000)::numeric(30,0)::text
        AS cleared_epoch_microseconds`);
    const viewRow = await readCalibrationWithin(tx, id);
    if (!viewRow) throw new Error("Cleared calibration is missing");
    if (viewRow.cleared_epoch_microseconds !== cleared[0]?.cleared_epoch_microseconds) {
      throw new Error("Cleared calibration instant changed within transaction");
    }
    return calibrationView(viewRow);
  }
}
