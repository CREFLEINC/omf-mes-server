import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ConflictException } from "../../common/errors";
import { NumberedMaintenanceWrite } from "../numbered-maintenance-write";
import { MaintenanceAssignmentPathChanged } from "./order-create-assignment";
import {
  MaintenanceOrderCreate,
  checkMaintenanceOrderCreate,
} from "./order-create-input";
import { resolveMaintenanceOrderReferences } from "./order-create-references";
import {
  MaintenanceOrderView,
  ORDER_INCLUDE,
  maintenanceOrderView,
} from "./order-view";
import { MaintenanceOrderWriteContext } from "./order-write-context";

const ASSIGNMENT_PATH_RETRIES = 3;

type CheckedOrder = ReturnType<typeof checkMaintenanceOrderCreate>;

@Injectable()
export class MaintenanceOrderCreateService {
  constructor(private readonly numbered: NumberedMaintenanceWrite) {}

  create(
    input: MaintenanceOrderCreate,
    context: MaintenanceOrderWriteContext,
  ): Promise<MaintenanceOrderView> {
    let checked: CheckedOrder | undefined;
    const current = () => (checked ??= checkMaintenanceOrderCreate(input));
    return this.numbered.run({
      context,
      documentTypeCode: "MAINTENANCE_ORDER",
      target: {
        get type() {
          return current().targetTypeCode;
        },
        get id() {
          return Number(current().targetId);
        },
        field: "targetId",
      },
      periodDate: () => current().plannedDate.toISOString().slice(0, 10),
      numberField: "maintenanceOrderNo",
      numberColumn: "maintenance_order_no",
      workRetry: {
        maxRetries: ASSIGNMENT_PATH_RETRIES,
        matches: (error) => error instanceof MaintenanceAssignmentPathChanged,
        exhausted: () =>
          new ConflictException(
            "user",
            "설비 보전 항목 부여 경로가 계속 바뀌었습니다. 다시 시도해 주세요.",
          ),
      },
      work: (tx, maintenanceOrderNo) =>
        this.createWithin(
          tx,
          current(),
          context,
          maintenanceOrderNo,
          new Date(),
        ),
    });
  }

  private async createWithin(
    tx: Prisma.TransactionClient,
    input: CheckedOrder,
    context: MaintenanceOrderWriteContext,
    maintenanceOrderNo: string,
    now: Date,
  ): Promise<MaintenanceOrderView> {
    const target = await resolveMaintenanceOrderReferences(tx, input, now);
    const actorId = BigInt(context.appUserId);
    const row = await tx.maintenance_order.create({
      data: {
        maintenance_order_no: maintenanceOrderNo,
        target_type_code: input.targetTypeCode,
        equipment_id: target.equipmentId,
        mold_id: target.moldId,
        breakdown_id: null,
        order_type_code: input.maintenanceTypeCode,
        priority_code: null,
        scheduled_start_at: null,
        scheduled_end_at: null,
        assigned_worker_id: null,
        status_code: "ISSUED",
        cancellation_reason_code: null,
        planned_date: input.plannedDate,
        base_date: input.baseDate,
        order_note: input.orderNote,
        assignee_user_id: input.assigneeUserId,
        issued_by: actorId,
        issued_at: now,
        cancelled_at: null,
        cancelled_by: null,
        created_at: now,
        created_by: actorId,
        updated_at: now,
        updated_by: actorId,
        maintenance_order_item: {
          create: input.items.map((item) => ({
            sequence_no: item.sequenceNo,
            inspection_item_id: item.inspectionItemId,
            item_name: item.itemName,
            status_code: "PLANNED",
          })),
        },
        maintenance_order_trigger: {
          create: input.triggers.map((trigger) => ({
            trigger_type_code: trigger.triggerTypeCode,
            source_id: trigger.sourceId,
            snapshot_note: trigger.snapshotNote,
            pm_due_axis_code: trigger.pmDueAxisCode ?? null,
            shot_count_at_due: trigger.shotCountAtDue ?? null,
            guaranteed_shot_count_at_due:
              trigger.guaranteedShotCountAtDue ?? null,
            created_at: now,
          })),
        },
      },
      include: ORDER_INCLUDE,
    });
    return maintenanceOrderView(row);
  }
}
