import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { PrismaService } from "../../prisma/prisma.service";
import { CalibrationProjection, CalibrationView, calibrationView } from "./calibration-view";

@Injectable()
export class CalibrationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async get(calibrationId: number): Promise<CalibrationView> {
    if (!Number.isSafeInteger(calibrationId)) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field("calibrationId", ERROR_CODE.RANGE, "검교정 이력 식별자 범위가 너무 큽니다."),
      ]);
    }
    const rows = await this.prisma.$queryRaw<CalibrationProjection[]>(Prisma.sql`
      SELECT c.equipment_calibration_id, c.equipment_id, e.equipment_code,
             c.history_type_code, to_char(c.calibration_date, 'YYYY-MM-DD') AS performed_on,
             c.result_code, c.certificate_no, c.agency_type_code, c.agency_name,
             CASE WHEN c.valid_until IS NULL THEN NULL
               ELSE to_char(c.valid_until, 'YYYY-MM-DD') END AS next_due_on,
             c.tolerance_note, c.recorded_by, c.calibrated_by, c.remarks, c.blocks_use,
             CASE WHEN c.cleared_at IS NULL THEN NULL ELSE
               (extract(epoch FROM c.cleared_at) * 1000000)::numeric(30,0)::text END
               AS cleared_epoch_microseconds
      FROM quality.equipment_calibration c
      JOIN mdm.equipment e ON e.equipment_id = c.equipment_id
      WHERE c.equipment_calibration_id = ${BigInt(calibrationId)}`);
    if (rows.length === 0) throw new NotFoundException("없는 검교정 이력입니다.");
    return calibrationView(rows[0]);
  }
}
