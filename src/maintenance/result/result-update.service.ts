import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field, one } from "../../common/errors";
import { assertUpdated } from "../../common/optimistic-lock";
import {
  MaintenanceResultQueryService,
  ProjectedResult,
} from "./result-query.service";
import {
  MaintenanceResultUpdate,
  checkMaintenanceResultUpdate,
} from "./result-write-input";
import {
  LockedMaintenanceResultOrder,
  LockedMaintenanceResultTarget,
  assertMaintenanceResultChildReferences,
} from "./result-write-references";

type Tx = Prisma.TransactionClient;

interface ResultIdentity {
  maintenance_result_id: bigint;
  maintenance_order_id: bigint | null;
  target_type_code: string | null;
  equipment_id: bigint | null;
  mold_id: bigint | null;
}

interface LockedResult extends ResultIdentity {
  version_no: number;
  closed: boolean | null;
  started_epoch_microseconds: string;
}

@Injectable()
export class MaintenanceResultUpdateService {
  constructor(private readonly queries: MaintenanceResultQueryService) {}

  async updateWithin(
    tx: Tx,
    maintenanceResultId: number,
    version: number,
    body: MaintenanceResultUpdate,
    appUserId: number,
  ): Promise<ProjectedResult> {
    if (!Number.isSafeInteger(maintenanceResultId) || maintenanceResultId <= 0)
      throw one(
        field(
          "maintenanceResultId",
          ERROR_CODE.RANGE,
          "안전한 양의 정수 ID여야 합니다.",
        ),
      );
    const identity = await tx.maintenance_result.findUnique({
      where: { maintenance_result_id: BigInt(maintenanceResultId) },
      select: {
        maintenance_result_id: true,
        maintenance_order_id: true,
        target_type_code: true,
        equipment_id: true,
        mold_id: true,
      },
    });
    if (!identity) throw new NotFoundException("없는 보전 실적입니다.");
    const target = await lockTarget(tx, identity);
    const order = await lockOrder(tx, identity, target);
    const locked = await lockResult(tx, identity);
    assertUpdated(locked.version_no === version ? 1 : 0, "user");
    if (locked.closed === true)
      lockedError(
        "maintenanceResultId",
        "마감한 보전 실적은 수정할 수 없습니다.",
      );
    if (order && order.status_code !== "ISSUED")
      lockedError(
        "maintenanceOrderId",
        "발행 상태가 아닌 지시의 실적은 수정할 수 없습니다.",
      );

    const input = checkMaintenanceResultUpdate(
      body,
      BigInt(locked.started_epoch_microseconds),
    );
    if (input.lines !== undefined || input.parts !== undefined)
      await assertMaintenanceResultChildReferences(
        tx,
        {
          targetTypeCode: targetType(identity),
          targetId: target.target_id,
          lines: input.lines ?? [],
          parts: input.parts ?? [],
        },
        target,
        order,
      );

    const now = new Date();
    const sets = [
      Prisma.sql`updated_at=${now}`,
      Prisma.sql`updated_by=${BigInt(appUserId)}`,
      Prisma.sql`version_no=version_no+1`,
    ];
    if (input.resultNote !== undefined)
      sets.push(Prisma.sql`result_note=${input.resultNote}`);
    if (input.finishedAt !== undefined) {
      const completedAt = input.finishedAt?.sqlTimestamp ?? null;
      sets.push(Prisma.sql`completed_at=${completedAt}::timestamptz`);
    }
    const affected = await tx.$executeRaw(Prisma.sql`
      UPDATE maintenance.maintenance_result SET ${Prisma.join(sets, ", ")}
      WHERE maintenance_result_id=${locked.maintenance_result_id}
        AND version_no=${version}`);
    assertUpdated(affected, "user");

    if (input.lines !== undefined) {
      await tx.maintenance_result_line.deleteMany({
        where: { maintenance_result_id: locked.maintenance_result_id },
      });
      if (input.lines.length)
        await tx.maintenance_result_line.createMany({
          data: input.lines.map((line, index) => ({
            maintenance_result_id: locked.maintenance_result_id,
            sequence_no: index + 1,
            maintenance_order_item_id: line.orderItemId,
            part_name: line.partName,
            result_code: line.resultCode,
            remarks: line.remarks,
          })),
        });
    }
    if (input.parts !== undefined) {
      await tx.maintenance_result_part.deleteMany({
        where: { maintenance_result_id: locked.maintenance_result_id },
      });
      if (input.parts.length)
        await tx.maintenance_result_part.createMany({
          data: input.parts.map((part, index) => ({
            maintenance_result_id: locked.maintenance_result_id,
            sequence_no: index + 1,
            spare_part_id: part.sparePartId,
            part_name: part.partName,
            used_qty: part.usedQty,
            goods_issue_id: part.goodsIssueId,
          })),
        });
    }
    const projected = await this.queries.getWithin(
      tx,
      locked.maintenance_result_id,
    );
    if (!projected) throw new Error("Updated maintenance result is missing");
    return projected;
  }
}

async function lockTarget(
  tx: Tx,
  identity: ResultIdentity,
): Promise<LockedMaintenanceResultTarget> {
  const type = targetType(identity);
  const targetId =
    type === "EQUIPMENT" ? identity.equipment_id : identity.mold_id;
  const rows =
    type === "EQUIPMENT"
      ? await tx.$queryRaw<LockedMaintenanceResultTarget[]>(Prisma.sql`
          SELECT equipment_id AS target_id,plant_id,version_no
          FROM mdm.equipment WHERE equipment_id=${targetId}
          FOR NO KEY UPDATE`)
      : await tx.$queryRaw<LockedMaintenanceResultTarget[]>(Prisma.sql`
          SELECT mold_id AS target_id,plant_id,version_no
          FROM mdm.mold WHERE mold_id=${targetId}
          FOR NO KEY UPDATE`);
  if (!rows[0]) throw new Error("Stored maintenance result target is missing");
  return rows[0];
}

async function lockOrder(
  tx: Tx,
  identity: ResultIdentity,
  target: LockedMaintenanceResultTarget,
): Promise<LockedMaintenanceResultOrder | null> {
  if (identity.maintenance_order_id === null) return null;
  const rows = await tx.$queryRaw<LockedMaintenanceResultOrder[]>(Prisma.sql`
    SELECT maintenance_order_id,target_type_code,equipment_id,mold_id,
           breakdown_id,order_type_code,status_code
    FROM maintenance.maintenance_order
    WHERE maintenance_order_id=${identity.maintenance_order_id} FOR UPDATE`);
  const order = rows[0];
  if (!order) throw new Error("Stored maintenance result order is missing");
  const linkedTarget =
    order.target_type_code === "EQUIPMENT" ? order.equipment_id : order.mold_id;
  if (
    order.target_type_code !== targetType(identity) ||
    linkedTarget !== target.target_id
  )
    throw new Error("Stored maintenance result order target is inconsistent");
  return order;
}

async function lockResult(
  tx: Tx,
  identity: ResultIdentity,
): Promise<LockedResult> {
  const rows = await tx.$queryRaw<LockedResult[]>(Prisma.sql`
    SELECT maintenance_result_id,maintenance_order_id,target_type_code,
           equipment_id,mold_id,version_no,closed,
           (extract(epoch FROM started_at)*1000000)::numeric(30,0)::text
             AS started_epoch_microseconds
    FROM maintenance.maintenance_result
    WHERE maintenance_result_id=${identity.maintenance_result_id} FOR UPDATE`);
  const row = rows[0];
  if (!row) throw new NotFoundException("없는 보전 실적입니다.");
  if (
    row.maintenance_order_id !== identity.maintenance_order_id ||
    row.target_type_code !== identity.target_type_code ||
    row.equipment_id !== identity.equipment_id ||
    row.mold_id !== identity.mold_id
  )
    throw new Error("Maintenance result identity changed while locking");
  return row;
}

function targetType(identity: ResultIdentity): "EQUIPMENT" | "MOLD" {
  if (
    identity.target_type_code === "EQUIPMENT" &&
    identity.equipment_id !== null &&
    identity.mold_id === null
  )
    return "EQUIPMENT";
  if (
    identity.target_type_code === "MOLD" &&
    identity.mold_id !== null &&
    identity.equipment_id === null
  )
    return "MOLD";
  throw new Error("Invalid stored maintenance result target");
}

function lockedError(name: string, message: string): never {
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field(name, ERROR_CODE.STATE_LOCKED, message),
  ]);
}
