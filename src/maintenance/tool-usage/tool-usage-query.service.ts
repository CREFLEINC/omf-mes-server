import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { PagedResponse, pageRequest, pagedResponse } from "../../common/pagination";
import { PrismaService } from "../../prisma/prisma.service";
import { maintenanceDateRange } from "../maintenance-calendar";
import { ToolUsageProjection, ToolUsageView, toolUsageView } from "./tool-usage-view";

export interface ToolUsageQuery {
  moldId?: number;
  workOrderId?: number;
  occurredFrom?: string;
  occurredTo?: string;
  page?: number;
  size?: number;
}

export type ToolUsageList = PagedResponse<ToolUsageView> & { totalCount: number };
type ToolUsageId = { tool_usage_id: bigint };
type ToolUsagePlant = { plant_id: bigint; timezone_code: string; has_missing_time: boolean };

const TOOL_USAGE_FROM = Prisma.sql`
  FROM maintenance.tool_usage u
  JOIN mdm.mold m ON m.mold_id = u.mold_id
  JOIN mdm.plant p ON p.plant_id = m.plant_id`;

@Injectable()
export class ToolUsageQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ToolUsageQuery): Promise<ToolUsageList> {
    const page = pageRequest(query);
    if (!Number.isSafeInteger(page.skip)) throw rangeError("page", "페이지 범위가 너무 큽니다.");
    for (const name of ["moldId", "workOrderId"] as const) {
      if (query[name] !== undefined && !Number.isSafeInteger(query[name])) {
        throw rangeError(name, "식별자 범위가 너무 큽니다.");
      }
    }
    if (query.occurredFrom && query.occurredTo && query.occurredFrom > query.occurredTo) {
      return { ...pagedResponse([], 0, page), totalCount: 0 };
    }

    return this.prisma.$transaction(
      async (tx) => {
        const conditions = [Prisma.sql`TRUE`];
        if (query.moldId !== undefined) conditions.push(Prisma.sql`u.mold_id = ${query.moldId}`);
        if (query.workOrderId !== undefined) {
          conditions.push(Prisma.sql`u.work_order_id = ${query.workOrderId}`);
        }
        await addCalendarCondition(tx, conditions, query);
        const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
        const [ids, counts] = await Promise.all([
          tx.$queryRaw<ToolUsageId[]>(Prisma.sql`
            SELECT u.tool_usage_id ${TOOL_USAGE_FROM} ${where}
            ORDER BY u.occurred_at DESC NULLS LAST, u.tool_usage_id DESC
            LIMIT ${page.take} OFFSET ${page.skip}`),
          tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
            SELECT count(*) AS total ${TOOL_USAGE_FROM} ${where}`),
        ]);
        const orderedIds = ids.map((row) => row.tool_usage_id);
        const rows =
          orderedIds.length === 0
            ? []
            : await project(tx, Prisma.sql`u.tool_usage_id IN (${Prisma.join(orderedIds)})`);
        const byId = new Map(rows.map((row) => [row.tool_usage_id, row]));
        const items = orderedIds.map((id) => {
          const row = byId.get(id);
          if (!row) throw new Error("Tool usage disappeared from read snapshot");
          return toolUsageView(row);
        });
        const total = Number(counts[0].total);
        if (!Number.isSafeInteger(total)) throw new Error("Tool usage count exceeds safe range");
        return { ...pagedResponse(items, total, page), totalCount: total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(toolUsageId: number): Promise<ToolUsageView> {
    if (!Number.isSafeInteger(toolUsageId)) {
      throw rangeError("toolUsageId", "사용이력 식별자 범위가 너무 큽니다.");
    }
    const rows = await project(this.prisma, Prisma.sql`u.tool_usage_id = ${BigInt(toolUsageId)}`);
    if (rows.length === 0) throw new NotFoundException("없는 툴 사용이력입니다.");
    return toolUsageView(rows[0]);
  }
}

async function addCalendarCondition(
  tx: Prisma.TransactionClient,
  conditions: Prisma.Sql[],
  query: ToolUsageQuery,
): Promise<void> {
  if (query.occurredFrom === undefined && query.occurredTo === undefined) return;
  const plants = await tx.$queryRaw<ToolUsagePlant[]>(Prisma.sql`
    SELECT p.plant_id, p.timezone_code,
           bool_or(u.occurred_at IS NULL) AS has_missing_time
    ${TOOL_USAGE_FROM} WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY p.plant_id, p.timezone_code`);
  const ranges = plants.map((plant) => {
    if (plant.has_missing_time) throw new Error("Missing required tool usage occurrence time");
    const range = maintenanceDateRange(query.occurredFrom, query.occurredTo, plant.timezone_code);
    const bounds = [Prisma.sql`p.plant_id = ${plant.plant_id}`];
    if (range.gte) bounds.push(Prisma.sql`u.occurred_at >= ${range.gte}`);
    if (range.lt) bounds.push(Prisma.sql`u.occurred_at < ${range.lt}`);
    return Prisma.sql`(${Prisma.join(bounds, " AND ")})`;
  });
  conditions.push(ranges.length ? Prisma.sql`(${Prisma.join(ranges, " OR ")})` : Prisma.sql`FALSE`);
}

type ProjectionClient = Pick<PrismaService, "$queryRaw"> | Prisma.TransactionClient;

function project(client: ProjectionClient, condition: Prisma.Sql): Promise<ToolUsageProjection[]> {
  return client.$queryRaw<ToolUsageProjection[]>(Prisma.sql`
    SELECT u.tool_usage_id, u.mold_id, m.mold_code, u.work_order_id,
           u.shot_count, u.collection_method_code, u.conversion_base_qty,
           u.conversion_ratio,
           CASE WHEN u.occurred_at IS NULL THEN NULL ELSE
             (extract(epoch FROM u.occurred_at) * 1000000)::numeric(30,0)::text END
             AS occurred_epoch_microseconds,
           w.worker_no
    FROM maintenance.tool_usage u
    JOIN mdm.mold m ON m.mold_id = u.mold_id
    LEFT JOIN mdm.worker w ON w.worker_id = u.recorded_by
    WHERE ${condition}`);
}

function rangeError(name: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [field(name, ERROR_CODE.RANGE, message)]);
}
