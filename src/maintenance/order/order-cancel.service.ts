import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { assertUpdated } from "../../common/optimistic-lock";
import { DocumentStateService } from "../../core/document-state";
import { MaintenanceOrderView, ORDER_INCLUDE, maintenanceOrderView } from "./order-view";
import { MaintenanceOrderWriteContext } from "./order-write-context";

type OrderTx = Prisma.TransactionClient;
type LockedOrder = {
  maintenance_order_id: bigint;
  status_code: string;
  version_no: number;
};

@Injectable()
export class MaintenanceOrderCancelService {
  constructor(private readonly state: DocumentStateService) {}

  async cancelWithin(
    tx: OrderTx,
    maintenanceOrderId: number,
    version: number,
    context: MaintenanceOrderWriteContext,
  ): Promise<MaintenanceOrderView> {
    if (!Number.isSafeInteger(maintenanceOrderId))
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field(
          "maintenanceOrderId",
          ERROR_CODE.RANGE,
          "지시 식별자 범위가 너무 큽니다.",
        ),
      ]);
    const rows = await tx.$queryRaw<LockedOrder[]>(Prisma.sql`
      SELECT maintenance_order_id, status_code, version_no
      FROM maintenance.maintenance_order
      WHERE maintenance_order_id = ${maintenanceOrderId}
      FOR UPDATE`);
    const locked = rows[0];
    if (!locked) throw new NotFoundException("없는 보전 지시입니다.");
    assertUpdated(locked.version_no === version ? 1 : 0, "user");
    const transition = this.state.assertTransition(
      "maintenance.maintenance_order.status_code",
      "maintenance-order-cancel",
      locked.status_code,
      HttpStatus.BAD_REQUEST,
    );
    const resultCount = await tx.maintenance_result.count({
      where: { maintenance_order_id: locked.maintenance_order_id },
    });
    if (resultCount > 0)
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: "screen",
          code: ERROR_CODE.STATE_LOCKED,
          message: "보전 실적이 등록된 지시는 취소할 수 없습니다.",
        },
      ]);

    const now = new Date();
    const actorId = BigInt(context.appUserId);
    const updated = await tx.maintenance_order.updateMany({
      where: {
        maintenance_order_id: locked.maintenance_order_id,
        version_no: version,
      },
      data: {
        status_code: transition.to,
        cancelled_at: now,
        cancelled_by: actorId,
        updated_at: now,
        updated_by: actorId,
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count, "user");
    const row = await tx.maintenance_order.findUnique({
      where: { maintenance_order_id: locked.maintenance_order_id },
      include: ORDER_INCLUDE,
    });
    if (!row) throw new Error("Cancelled maintenance order is missing");
    return maintenanceOrderView(row);
  }
}
