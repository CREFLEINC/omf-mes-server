import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { MaintenanceResultQueryService } from "./result-query.service";
import { MaintenanceResultView } from "./result-view";
import {
  MaintenanceResultCreate,
  checkMaintenanceResultCreate,
} from "./result-write-input";
import { resolveMaintenanceResultCreateReferences } from "./result-write-references";

@Injectable()
export class MaintenanceResultCreateService {
  constructor(private readonly queries: MaintenanceResultQueryService) {}

  async createWithin(
    tx: Prisma.TransactionClient,
    body: MaintenanceResultCreate,
    appUserId: number,
    ifMatch: number | undefined,
  ): Promise<MaintenanceResultView> {
    const input = checkMaintenanceResultCreate(body);
    await resolveMaintenanceResultCreateReferences(tx, input, ifMatch);
    const actorId = BigInt(appUserId);
    const now = new Date();
    const completedAt = input.finishedAt?.sqlTimestamp ?? null;
    const equipmentId =
      input.targetTypeCode === "EQUIPMENT" ? input.targetId : null;
    const moldId = input.targetTypeCode === "MOLD" ? input.targetId : null;
    const rows = await tx.$queryRaw<{ maintenance_result_id: bigint }[]>(
      Prisma.sql`
        INSERT INTO maintenance.maintenance_result
          (maintenance_order_id,result_seq,action_code,action_description,
           started_at,completed_at,performed_by,result_code,target_type_code,
           equipment_id,mold_id,breakdown_id,result_note,performed_by_user_id,
           is_outsourced,outsource_vendor_name,reset_counter,
           shot_count_before_reset,shot_count_after_reset,closed,version_no,
           updated_at,updated_by,created_at,created_by)
        VALUES
          (${input.maintenanceOrderId},NULL,NULL,NULL,
           ${input.startedAt.sqlTimestamp}::timestamptz,
           ${completedAt}::timestamptz,NULL,NULL,${input.targetTypeCode},
           ${equipmentId},${moldId},${input.breakdownId},${input.resultNote},
           ${input.performedByUserId},${input.isOutsourced},
           ${input.outsourceVendorName},false,NULL,NULL,false,1,
           ${now},${actorId},${now},${actorId})
        RETURNING maintenance_result_id`,
    );
    const resultId = rows[0].maintenance_result_id;
    if (input.lines.length)
      await tx.maintenance_result_line.createMany({
        data: input.lines.map((line, index) => ({
          maintenance_result_id: resultId,
          sequence_no: index + 1,
          maintenance_order_item_id: line.orderItemId,
          part_name: line.partName,
          result_code: line.resultCode,
          remarks: line.remarks,
        })),
      });
    if (input.parts.length)
      await tx.maintenance_result_part.createMany({
        data: input.parts.map((part, index) => ({
          maintenance_result_id: resultId,
          sequence_no: index + 1,
          spare_part_id: part.sparePartId,
          part_name: part.partName,
          used_qty: part.usedQty,
          goods_issue_id: part.goodsIssueId,
        })),
      });
    const projected = await this.queries.getWithin(tx, resultId);
    if (!projected) throw new Error("Created maintenance result is missing");
    return projected.view;
  }
}
