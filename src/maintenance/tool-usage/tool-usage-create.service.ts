import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field, one } from "../../common/errors";
import { resolveWorkerId } from "../../common/master";
import { maintenanceInstantFromEpoch } from "../maintenance-instant";
import {
  ToolUsageProjection,
  ToolUsageView,
  toolUsageView,
} from "./tool-usage-view";
import { ToolUsageWriteContext } from "./tool-usage-write-context";
import {
  ToolUsageCreate,
  checkToolUsageCreate,
} from "./tool-usage-write-input";

type MoldRow = {
  mold_id: bigint;
  current_shot_count: bigint;
  status_code: string;
};
type UsageRow = { tool_usage_id: bigint };
type CumulativeRow = {
  current_shot_count: bigint;
  updated_epoch_microseconds: string;
};
export type ToolUsageCreateView = ToolUsageView & {
  cumulativeShotCount: number;
  cumulativeAsOf: string;
};

@Injectable()
export class ToolUsageCreateService {
  async createWithin(
    tx: Prisma.TransactionClient,
    input: ToolUsageCreate,
    context: ToolUsageWriteContext,
  ): Promise<ToolUsageCreateView> {
    const checked = checkToolUsageCreate(input);
    const workerId = await resolveWorkerId(tx, context.workerNo);
    const workOrder = await tx.work_order.findUnique({
      where: { work_order_id: checked.workOrderId },
      select: { work_order_id: true },
    });
    if (!workOrder) {
      throw one(
        field("workOrderId", ERROR_CODE.INVALID, "없는 작업지시입니다."),
      );
    }

    const molds = await tx.$queryRaw<MoldRow[]>(Prisma.sql`
      SELECT mold_id, current_shot_count, status_code
      FROM mdm.mold WHERE mold_id = ${checked.moldId} FOR NO KEY UPDATE`);
    if (molds.length === 0) {
      throw one(field("moldId", ERROR_CODE.INVALID, "없는 툴입니다."));
    }
    const mold = molds[0];
    if (mold.status_code === "DISPOSED") {
      throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
        field(
          "moldId",
          ERROR_CODE.STATE_LOCKED,
          "폐기된 툴에는 사용실적을 등록할 수 없습니다.",
        ),
      ]);
    }
    assertStoredCount(mold.current_shot_count);
    if (
      mold.current_shot_count + checked.shotCount >
      BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw one(
        field(
          "shotCount",
          ERROR_CODE.RANGE,
          "누적 타발수가 안전 정수 범위를 넘습니다.",
        ),
      );
    }

    const usages = await tx.$queryRaw<UsageRow[]>(Prisma.sql`
      INSERT INTO maintenance.tool_usage
        (mold_id, work_order_id, shot_count, collection_method_code,
         conversion_base_qty, conversion_ratio, occurred_at, recorded_by)
      VALUES
        (${checked.moldId}, ${checked.workOrderId}, ${checked.shotCount},
         ${checked.collectionMethodCode}, ${checked.conversionBaseQty}, ${checked.conversionRatio},
         ${checked.occurredAt.sqlTimestamp}::timestamptz, ${workerId})
      RETURNING tool_usage_id`);
    const cumulative = await tx.$queryRaw<CumulativeRow[]>(Prisma.sql`
      UPDATE mdm.mold
      SET current_shot_count = current_shot_count + ${checked.shotCount},
          version_no = version_no + 1,
          updated_by = ${BigInt(context.appUserId)}
      WHERE mold_id = ${checked.moldId}
      RETURNING current_shot_count,
        (extract(epoch FROM updated_at) * 1000000)::numeric(30,0)::text
          AS updated_epoch_microseconds`);
    if (!usages[0] || !cumulative[0])
      throw new Error("Tool usage write disappeared");
    const projection = await readCreated(tx, usages[0].tool_usage_id);
    if (projection === null) throw new Error("Created tool usage is missing");
    return {
      ...toolUsageView(projection),
      cumulativeShotCount: safeCount(cumulative[0].current_shot_count),
      cumulativeAsOf: maintenanceInstantFromEpoch(
        cumulative[0].updated_epoch_microseconds,
      ).utcIso,
    };
  }
}

async function readCreated(
  tx: Prisma.TransactionClient,
  toolUsageId: bigint,
): Promise<ToolUsageProjection | null> {
  const rows = await tx.$queryRaw<ToolUsageProjection[]>(Prisma.sql`
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
    WHERE u.tool_usage_id = ${toolUsageId}`);
  return rows[0] ?? null;
}

function assertStoredCount(value: bigint): void {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Stored mold shot count exceeds safe range");
  }
}

function safeCount(value: bigint): number {
  assertStoredCount(value);
  return Number(value);
}
