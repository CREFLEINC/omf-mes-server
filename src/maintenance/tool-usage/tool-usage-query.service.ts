import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { PrismaService } from "../../prisma/prisma.service";
import { ToolUsageProjection, ToolUsageView, toolUsageView } from "./tool-usage-view";

@Injectable()
export class ToolUsageQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async get(toolUsageId: number): Promise<ToolUsageView> {
    if (!Number.isSafeInteger(toolUsageId)) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field("toolUsageId", ERROR_CODE.RANGE, "사용이력 식별자 범위가 너무 큽니다."),
      ]);
    }
    const rows = await this.prisma.$queryRaw<ToolUsageProjection[]>(Prisma.sql`
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
      WHERE u.tool_usage_id = ${BigInt(toolUsageId)}`);
    if (rows.length === 0) throw new NotFoundException("없는 툴 사용이력입니다.");
    return toolUsageView(rows[0]);
  }
}
