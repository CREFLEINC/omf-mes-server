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
import {
  MaintenanceResultView,
  ResultLineProjection,
  ResultPartProjection,
  ResultProjection,
  maintenanceResultViews,
} from "./result-view";

export interface MaintenanceResultQuery {
  maintenanceOrderId?: number;
  targetTypeCode?: "EQUIPMENT" | "MOLD";
  targetId?: number;
  startedFrom?: string;
  startedTo?: string;
  page?: number;
  size?: number;
}

export type MaintenanceResultList = PagedResponse<MaintenanceResultView> & {
  totalCount: number;
};
type ResultId = { maintenance_result_id: bigint };
type ResultPlant = {
  plant_id: bigint | null;
  timezone_code: string | null;
  has_invalid_target: boolean;
};
export type ProjectedResult = {
  view: MaintenanceResultView;
  versionNo: number;
};

const RESULT_FROM = Prisma.sql`
  FROM maintenance.maintenance_result r
  LEFT JOIN mdm.equipment e
    ON r.target_type_code = 'EQUIPMENT' AND e.equipment_id = r.equipment_id
  LEFT JOIN mdm.mold m
    ON r.target_type_code = 'MOLD' AND m.mold_id = r.mold_id
  LEFT JOIN mdm.plant p ON p.plant_id = COALESCE(e.plant_id, m.plant_id)`;

@Injectable()
export class MaintenanceResultQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MaintenanceResultQuery): Promise<MaintenanceResultList> {
    const page = pageRequest(query);
    if (!Number.isSafeInteger(page.skip))
      throw rangeError("page", "페이지 범위가 너무 큽니다.");
    for (const name of ["maintenanceOrderId", "targetId"] as const) {
      if (query[name] !== undefined && !Number.isSafeInteger(query[name]))
        throw rangeError(name, "식별자 범위가 너무 큽니다.");
    }
    if (
      query.startedFrom &&
      query.startedTo &&
      query.startedFrom > query.startedTo
    )
      throw rangeError(
        "startedTo",
        "시작 종료일은 시작일보다 빠를 수 없습니다.",
      );

    return this.prisma.$transaction(
      async (tx) => {
        const conditions = resultConditions(query);
        await this.addCalendarCondition(tx, conditions, query);
        const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
        const [ids, counts] = await Promise.all([
          tx.$queryRaw<ResultId[]>(Prisma.sql`
            SELECT r.maintenance_result_id ${RESULT_FROM} ${where}
            ORDER BY r.started_at DESC, r.maintenance_result_id DESC
            LIMIT ${page.take} OFFSET ${page.skip}`),
          tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
            SELECT count(*) AS total ${RESULT_FROM} ${where}`),
        ]);
        const pageIds = ids.map((row) => row.maintenance_result_id);
        const projected = await this.project(tx, pageIds);
        if (projected.length !== pageIds.length)
          throw new Error("Maintenance result disappeared from read snapshot");
        const total = Number(counts[0].total);
        if (!Number.isSafeInteger(total))
          throw new Error(
            "Maintenance result count exceeds safe integer range",
          );
        return {
          ...pagedResponse(
            projected.map((row) => row.view),
            total,
            page,
          ),
          totalCount: total,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(maintenanceResultId: number): Promise<ProjectedResult> {
    if (!Number.isSafeInteger(maintenanceResultId))
      throw rangeError(
        "maintenanceResultId",
        "실적 식별자 범위가 너무 큽니다.",
      );
    return this.prisma.$transaction(
      async (tx) => {
        const result = await this.getWithin(tx, BigInt(maintenanceResultId));
        if (!result) throw new NotFoundException("없는 보전 실적입니다.");
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async getWithin(
    tx: Prisma.TransactionClient,
    maintenanceResultId: bigint,
  ): Promise<ProjectedResult | undefined> {
    const [result] = await this.project(tx, [maintenanceResultId]);
    return result;
  }

  private async addCalendarCondition(
    tx: Prisma.TransactionClient,
    conditions: Prisma.Sql[],
    query: MaintenanceResultQuery,
  ): Promise<void> {
    if (query.startedFrom === undefined && query.startedTo === undefined)
      return;
    const plants = await tx.$queryRaw<ResultPlant[]>(Prisma.sql`
      SELECT p.plant_id, p.timezone_code,
             bool_or(p.plant_id IS NULL) AS has_invalid_target
      ${RESULT_FROM} WHERE ${Prisma.join(conditions, " AND ")}
      GROUP BY p.plant_id, p.timezone_code`);
    const ranges = plants.map((plant) => {
      if (
        plant.has_invalid_target ||
        plant.plant_id === null ||
        plant.timezone_code === null
      )
        throw new Error("Missing required maintenance result target");
      const range = maintenanceDateRange(
        query.startedFrom,
        query.startedTo,
        plant.timezone_code,
      );
      const bounds = [Prisma.sql`p.plant_id = ${plant.plant_id}`];
      if (range.gte) bounds.push(Prisma.sql`r.started_at >= ${range.gte}`);
      if (range.lt) bounds.push(Prisma.sql`r.started_at < ${range.lt}`);
      return Prisma.sql`(${Prisma.join(bounds, " AND ")})`;
    });
    conditions.push(
      ranges.length
        ? Prisma.sql`(${Prisma.join(ranges, " OR ")})`
        : Prisma.sql`FALSE`,
    );
  }

  private async project(
    tx: Prisma.TransactionClient,
    ids: bigint[],
  ): Promise<ProjectedResult[]> {
    if (ids.length === 0) return [];
    const [results, lines, parts] = await Promise.all([
      tx.$queryRaw<ResultProjection[]>(Prisma.sql`
        SELECT r.maintenance_result_id, r.maintenance_order_id, r.breakdown_id,
               r.target_type_code, r.equipment_id, r.mold_id,
               (extract(epoch FROM r.started_at) * 1000000)::numeric(30,0)::text
                 AS started_epoch_microseconds,
               CASE WHEN r.completed_at IS NULL THEN NULL ELSE
                 (extract(epoch FROM r.completed_at) * 1000000)::numeric(30,0)::text END
                 AS finished_epoch_microseconds,
               r.result_note, r.performed_by_user_id, r.is_outsourced,
               r.outsource_vendor_name, r.reset_counter,
               r.shot_count_before_reset, r.shot_count_after_reset,
               r.closed, r.version_no
        FROM maintenance.maintenance_result r
        WHERE r.maintenance_result_id IN (${Prisma.join(ids)})`),
      tx.$queryRaw<ResultLineProjection[]>(Prisma.sql`
        SELECT maintenance_result_id, sequence_no, maintenance_order_item_id,
               part_name, result_code, remarks
        FROM maintenance.maintenance_result_line
        WHERE maintenance_result_id IN (${Prisma.join(ids)})
        ORDER BY maintenance_result_id, sequence_no, maintenance_result_line_id`),
      tx.$queryRaw<ResultPartProjection[]>(Prisma.sql`
        SELECT rp.maintenance_result_id, rp.sequence_no, rp.spare_part_id,
               rp.part_name, rp.used_qty, rp.goods_issue_id, gi.goods_issue_no,
               CASE WHEN gi.issued_at IS NULL THEN NULL ELSE
                 (extract(epoch FROM gi.issued_at) * 1000000)::numeric(30,0)::text END
                 AS issued_epoch_microseconds,
               CASE WHEN rp.goods_issue_id IS NULL THEN base_uom.uom_code
                    WHEN issue_uom.unit_count = 1 THEN issue_uom.uom_code
                    ELSE NULL END AS uom_code
        FROM maintenance.maintenance_result_part rp
        JOIN mdm.spare_part sp ON sp.spare_part_id = rp.spare_part_id
        LEFT JOIN mdm.uom base_uom ON base_uom.uom_id = sp.base_uom_id
        LEFT JOIN logistics.goods_issue gi ON gi.goods_issue_id = rp.goods_issue_id
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT line.uom_id)::int AS unit_count,
                 min(u.uom_code) AS uom_code
          FROM logistics.goods_issue_spare_line line
          JOIN mdm.uom u ON u.uom_id = line.uom_id
          WHERE line.goods_issue_id = rp.goods_issue_id
            AND line.spare_part_id = rp.spare_part_id
        ) issue_uom ON rp.goods_issue_id IS NOT NULL
        WHERE rp.maintenance_result_id IN (${Prisma.join(ids)})
        ORDER BY rp.maintenance_result_id, rp.sequence_no,
                 rp.maintenance_result_part_id`),
    ]);
    const views = maintenanceResultViews(results, lines, parts);
    const byId = new Map(
      results.map((row, index) => [
        row.maintenance_result_id,
        { view: views[index], versionNo: row.version_no },
      ]),
    );
    return ids.flatMap((id) => {
      const result = byId.get(id);
      return result ? [result] : [];
    });
  }
}

function resultConditions(query: MaintenanceResultQuery): Prisma.Sql[] {
  const conditions = [Prisma.sql`TRUE`];
  if (query.maintenanceOrderId !== undefined)
    conditions.push(
      Prisma.sql`r.maintenance_order_id = ${query.maintenanceOrderId}`,
    );
  if (query.targetTypeCode !== undefined) {
    conditions.push(Prisma.sql`r.target_type_code = ${query.targetTypeCode}`);
    if (query.targetId !== undefined)
      conditions.push(
        query.targetTypeCode === "EQUIPMENT"
          ? Prisma.sql`r.equipment_id = ${query.targetId}`
          : Prisma.sql`r.mold_id = ${query.targetId}`,
      );
  } else if (query.targetId !== undefined) {
    conditions.push(
      Prisma.sql`(r.equipment_id = ${query.targetId} OR r.mold_id = ${query.targetId})`,
    );
  }
  return conditions;
}

function rangeError(name: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    field(name, ERROR_CODE.RANGE, message),
  ]);
}
