import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { PagedResponse, pageRequest, pagedResponse } from "../../common/pagination";
import { PrismaService } from "../../prisma/prisma.service";
import { CalibrationProjection, CalibrationView, calibrationView } from "./calibration-view";

export interface CalibrationQuery {
  equipmentId?: number;
  historyTypeCode?: string;
  dueBefore?: string;
  performedFrom?: string;
  performedTo?: string;
  page?: number;
  size?: number;
}

export type CalibrationList = PagedResponse<CalibrationView> & { totalCount: number };
type CalibrationId = { equipment_calibration_id: bigint };
type MissingType = { has_missing_type: boolean | null };
type ProjectionClient = Pick<PrismaService, "$queryRaw"> | Prisma.TransactionClient;

const CALIBRATION_FROM = Prisma.sql`
  FROM quality.equipment_calibration c
  JOIN mdm.equipment e ON e.equipment_id = c.equipment_id`;

@Injectable()
export class CalibrationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: CalibrationQuery): Promise<CalibrationList> {
    const page = pageRequest(query);
    if (!Number.isSafeInteger(page.skip)) throw rangeError("page", "페이지 범위가 너무 큽니다.");
    if (query.equipmentId !== undefined && !Number.isSafeInteger(query.equipmentId)) {
      throw rangeError("equipmentId", "설비 식별자 범위가 너무 큽니다.");
    }
    if (query.performedFrom && query.performedTo && query.performedFrom > query.performedTo) {
      return { ...pagedResponse([], 0, page), totalCount: 0 };
    }

    return this.prisma.$transaction(
      async (tx) => {
        const conditions = calibrationConditions(query);
        const missing = await tx.$queryRaw<MissingType[]>(Prisma.sql`
          SELECT bool_or(c.history_type_code IS NULL) AS has_missing_type
          ${CALIBRATION_FROM}
          WHERE ${Prisma.join(conditions, " AND ")}`);
        if (missing[0]?.has_missing_type) {
          throw new Error("Missing required calibration history type");
        }
        if (query.historyTypeCode !== undefined) {
          conditions.push(Prisma.sql`c.history_type_code = ${query.historyTypeCode}`);
        }
        const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
        const [ids, counts] = await Promise.all([
          tx.$queryRaw<CalibrationId[]>(Prisma.sql`
            SELECT c.equipment_calibration_id ${CALIBRATION_FROM} ${where}
            ORDER BY c.calibration_date DESC, c.equipment_calibration_id DESC
            LIMIT ${page.take} OFFSET ${page.skip}`),
          tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
            SELECT count(*) AS total ${CALIBRATION_FROM} ${where}`),
        ]);
        const orderedIds = ids.map((row) => row.equipment_calibration_id);
        const rows =
          orderedIds.length === 0
            ? []
            : await project(
                tx,
                Prisma.sql`c.equipment_calibration_id IN (${Prisma.join(orderedIds)})`,
              );
        const byId = new Map(rows.map((row) => [row.equipment_calibration_id, row]));
        const items = orderedIds.map((id) => {
          const row = byId.get(id);
          if (!row) throw new Error("Calibration disappeared from read snapshot");
          return calibrationView(row);
        });
        const total = Number(counts[0].total);
        if (!Number.isSafeInteger(total)) throw new Error("Calibration count exceeds safe range");
        return { ...pagedResponse(items, total, page), totalCount: total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(calibrationId: number): Promise<CalibrationView> {
    if (!Number.isSafeInteger(calibrationId)) {
      throw rangeError("calibrationId", "검교정 이력 식별자 범위가 너무 큽니다.");
    }
    const rows = await project(
      this.prisma,
      Prisma.sql`c.equipment_calibration_id = ${BigInt(calibrationId)}`,
    );
    if (rows.length === 0) throw new NotFoundException("없는 검교정 이력입니다.");
    return calibrationView(rows[0]);
  }
}

function calibrationConditions(query: CalibrationQuery): Prisma.Sql[] {
  const conditions = [Prisma.sql`TRUE`];
  if (query.equipmentId !== undefined) {
    conditions.push(Prisma.sql`c.equipment_id = ${query.equipmentId}`);
  }
  if (query.dueBefore !== undefined) {
    conditions.push(Prisma.sql`c.valid_until < ${query.dueBefore}::date`);
  }
  if (query.performedFrom !== undefined) {
    conditions.push(Prisma.sql`c.calibration_date >= ${query.performedFrom}::date`);
  }
  if (query.performedTo !== undefined) {
    conditions.push(Prisma.sql`c.calibration_date <= ${query.performedTo}::date`);
  }
  return conditions;
}

function project(
  client: ProjectionClient,
  condition: Prisma.Sql,
): Promise<CalibrationProjection[]> {
  return client.$queryRaw<CalibrationProjection[]>(Prisma.sql`
      SELECT c.equipment_calibration_id, c.equipment_id, e.equipment_code,
             c.history_type_code, to_char(c.calibration_date, 'YYYY-MM-DD') AS performed_on,
             c.result_code, c.certificate_no, c.agency_type_code, c.agency_name,
             CASE WHEN c.valid_until IS NULL THEN NULL
               ELSE to_char(c.valid_until, 'YYYY-MM-DD') END AS next_due_on,
             c.tolerance_note, c.recorded_by, c.calibrated_by, c.remarks, c.blocks_use,
             CASE WHEN c.cleared_at IS NULL THEN NULL ELSE
               (extract(epoch FROM c.cleared_at) * 1000000)::numeric(30,0)::text END
               AS cleared_epoch_microseconds
      ${CALIBRATION_FROM}
      WHERE ${condition}`);
}

function rangeError(name: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [field(name, ERROR_CODE.RANGE, message)]);
}
