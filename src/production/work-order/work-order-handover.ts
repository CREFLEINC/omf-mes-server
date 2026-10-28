import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationEmitter, NotificationValues, formatQty } from '../../core/notification';

type Tx = Prisma.TransactionClient;

const EMERGENCY_TYPE = 'EMERGENCY';
const REWORK_TYPE = 'REWORK';

/**
 * 인계 작업 알림 T6·T7·T9 — W/O 하나에서 공장·값을 모은다(omf-all-around#190 · research R-3).
 * 공장은 ERP W/O 의 공장이다 — 재작업 W/O 는 라인이 없어 라인으로 풀 수 없다.
 * 생산 도메인에 둔다 — 배포(생산)와 재작업 발행(품질)이 함께 쓴다.
 */
@Injectable()
export class WorkOrderHandoverNotifier {
  constructor(private readonly emitter: NotificationEmitter) {}

  /** T6 일반 · T7 긴급 W/O 배포. 재작업 W/O 는 발행 때 T9 로 이미 알렸다. */
  async released(tx: Tx, workOrderId: bigint): Promise<void> {
    const { plantId, workOrderTypeCode, values } = await workOrderValues(tx, workOrderId);
    if (plantId === null || workOrderTypeCode === REWORK_TYPE) return;
    await this.emitter.emitHandover(tx, {
      alertTypeCode: workOrderTypeCode === EMERGENCY_TYPE ? 'EMERGENCY_WORK_ORDER_RELEASED' : 'WORK_ORDER_RELEASED',
      plantId,
      aggregateTypeCode: 'WORK_ORDER',
      aggregateId: workOrderId,
      occurredAt: new Date(),
      values,
    });
  }

  /** T9 재작업 W/O 생성 — 원천 부적합 번호와 발행한 사람을 함께 싣는다. */
  async reworkCreated(tx: Tx, workOrderId: bigint, nonconformanceId: bigint, appUserId: number): Promise<void> {
    const { plantId, values } = await workOrderValues(tx, workOrderId);
    if (plantId === null) return;
    const nonconformance = await tx.nonconformance.findUniqueOrThrow({
      where: { nonconformance_id: nonconformanceId },
      select: { nonconformance_no: true },
    });
    const user = await tx.app_user.findUnique({ where: { app_user_id: appUserId }, select: { user_name: true } });
    await this.emitter.emitHandover(tx, {
      alertTypeCode: 'REWORK_WORK_ORDER_CREATED',
      plantId,
      aggregateTypeCode: 'WORK_ORDER',
      aggregateId: workOrderId,
      occurredAt: new Date(),
      values: { ...values, qty: values.plan_qty, ncr_no: nonconformance.nonconformance_no, actor: user?.user_name },
    });
  }
}

async function workOrderValues(
  tx: Tx,
  workOrderId: bigint,
): Promise<{ plantId: bigint | null; workOrderTypeCode: string; values: NotificationValues }> {
  const row = await tx.work_order.findUniqueOrThrow({
    where: { work_order_id: workOrderId },
    select: {
      work_order_no: true,
      work_order_type_code: true,
      order_qty: true,
      uom: { select: { uom_code: true } },
      item: { select: { item_code: true, item_name: true } },
      routing_operation: { select: { process: { select: { process_name: true } } } },
      equipment: { select: { equipment_name: true } },
      production_plan: { select: { production_order: { select: { plant_id: true } } } },
    },
  });
  return {
    plantId: row.production_plan?.production_order.plant_id ?? null,
    workOrderTypeCode: row.work_order_type_code,
    values: {
      wo_no: row.work_order_no,
      item: `${row.item.item_code} ${row.item.item_name}`,
      plan_qty: formatQty(row.order_qty, row.uom.uom_code),
      process: row.routing_operation.process.process_name,
      equipment: row.equipment?.equipment_name,
    },
  };
}
