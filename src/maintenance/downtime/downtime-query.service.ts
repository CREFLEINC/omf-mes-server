import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import {
  PagedResponse,
  pageRequest,
  pagedResponse,
} from "../../common/pagination";
import { PrismaService } from "../../prisma/prisma.service";
import { maintenanceDateRange } from "../maintenance-calendar";
import { DowntimeRow, DowntimeView, downtimeView } from "./downtime-view";

export interface DowntimeQuery {
  equipmentId?: number;
  reasonCode?: string;
  openOnly?: boolean;
  overlappingOnly?: boolean;
  startedFrom?: string;
  startedTo?: string;
  page?: number;
  size?: number;
}

export type DowntimeList = PagedResponse<DowntimeView> & { totalCount: number };
type DowntimePlant = { plant_id: bigint; timezone_code: string };

const FROM = Prisma.sql`
  FROM maintenance.equipment_downtime d
  JOIN mdm.equipment e ON e.equipment_id = d.equipment_id
  JOIN mdm.plant p ON p.plant_id = e.plant_id`;

const OVERLAPS = Prisma.sql`(d.ended_at IS NULL OR d.ended_at > d.started_at)
AND EXISTS (
  SELECT 1 FROM maintenance.equipment_downtime x
  WHERE x.equipment_id = d.equipment_id
    AND x.equipment_downtime_id <> d.equipment_downtime_id
    AND (x.ended_at IS NULL OR x.ended_at > x.started_at)
    AND x.started_at < COALESCE(d.ended_at, 'infinity'::timestamptz)
    AND COALESCE(x.ended_at, 'infinity'::timestamptz) > d.started_at
)`;

@Injectable()
export class DowntimeQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: DowntimeQuery): Promise<DowntimeList> {
    const page = pageRequest(query);
    const period =
      query.startedFrom !== undefined || query.startedTo !== undefined;
    if (query.openOnly !== true || period) {
      const missing = (["startedFrom", "startedTo"] as const)
        .filter((name) => query[name] === undefined)
        .map((name) =>
          field(name, ERROR_CODE.REQUIRED, "비가동 조회 기간이 필요합니다."),
        );
      if (missing.length)
        throw new ContractException(HttpStatus.BAD_REQUEST, missing);
    }
    if (
      query.startedFrom &&
      query.startedTo &&
      query.startedFrom > query.startedTo
    ) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field(
          "startedTo",
          ERROR_CODE.RANGE,
          "비가동 조회 종료일이 시작일보다 빠릅니다.",
        ),
      ]);
    }

    return this.prisma.$transaction(
      async (tx) => {
        const conditions = [Prisma.sql`TRUE`];
        if (query.equipmentId !== undefined)
          conditions.push(Prisma.sql`d.equipment_id = ${query.equipmentId}`);
        if (query.reasonCode !== undefined)
          conditions.push(Prisma.sql`d.reason_code = ${query.reasonCode}`);
        if (query.openOnly === true)
          conditions.push(Prisma.sql`d.ended_at IS NULL`);
        if (query.overlappingOnly === true) conditions.push(OVERLAPS);

        if (period) {
          const plants = await tx.$queryRaw<DowntimePlant[]>(Prisma.sql`
            SELECT DISTINCT p.plant_id, p.timezone_code ${FROM}
            WHERE ${Prisma.join(conditions, " AND ")}`);
          const ranges = plants.map((plant) => {
            const range = maintenanceDateRange(
              query.startedFrom,
              query.startedTo,
              plant.timezone_code,
            );
            return Prisma.sql`(p.plant_id = ${plant.plant_id}
              AND d.started_at >= ${range.gte} AND d.started_at < ${range.lt})`;
          });
          conditions.push(
            ranges.length
              ? Prisma.sql`(${Prisma.join(ranges, " OR ")})`
              : Prisma.sql`FALSE`,
          );
        }

        const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
        const direction =
          query.openOnly === true ? Prisma.sql`ASC` : Prisma.sql`DESC`;
        const [rows, counts] = await Promise.all([
          tx.$queryRaw<DowntimeRow[]>(Prisma.sql`
            SELECT d.equipment_downtime_id AS downtime_id, d.equipment_id,
              e.equipment_code, d.reason_code, cv.code_name AS reason_name,
              (extract(epoch FROM d.started_at) * 1000000)::bigint::text AS started_epoch_us,
              CASE WHEN d.ended_at IS NULL THEN NULL ELSE
                (extract(epoch FROM d.ended_at) * 1000000)::bigint::text END AS ended_epoch_us,
              d.breakdown_id, d.recorded_by_worker_no, d.remarks, d.version_no
            ${FROM}
            LEFT JOIN mdm.code_group cg ON cg.group_code = 'DOWNTIME_REASON' AND cg.is_active
            LEFT JOIN mdm.code_value cv ON cv.code_group_id = cg.code_group_id
              AND cv.code = d.reason_code AND cv.is_active
            ${where}
            ORDER BY d.started_at ${direction}, d.equipment_downtime_id ${direction}
            LIMIT ${page.take} OFFSET ${page.skip}`),
          tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
            SELECT count(*) AS total ${FROM} ${where}`),
        ]);
        const total = Number(counts[0].total);
        if (!Number.isSafeInteger(total))
          throw new Error("Downtime count exceeds safe range");
        return {
          ...pagedResponse(rows.map(downtimeView), total, page),
          totalCount: total,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(
    downtimeId: number,
  ): Promise<{ view: DowntimeView; versionNo: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<DowntimeRow[]>(Prisma.sql`
          SELECT d.equipment_downtime_id AS downtime_id, d.equipment_id,
            e.equipment_code, d.reason_code, cv.code_name AS reason_name,
            (extract(epoch FROM d.started_at) * 1000000)::bigint::text AS started_epoch_us,
            CASE WHEN d.ended_at IS NULL THEN NULL ELSE
              (extract(epoch FROM d.ended_at) * 1000000)::bigint::text END AS ended_epoch_us,
            d.breakdown_id, d.recorded_by_worker_no, d.remarks, d.version_no
          ${FROM}
          LEFT JOIN mdm.code_group cg ON cg.group_code = 'DOWNTIME_REASON' AND cg.is_active
          LEFT JOIN mdm.code_value cv ON cv.code_group_id = cg.code_group_id
            AND cv.code = d.reason_code AND cv.is_active
          WHERE d.equipment_downtime_id = ${downtimeId}`);
        const row = rows[0];
        if (!row) throw new NotFoundException("없는 비가동 기록입니다.");
        if (!Number.isSafeInteger(row.version_no) || row.version_no <= 0)
          throw new Error("Invalid stored downtime version");
        return { view: downtimeView(row), versionNo: row.version_no };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
