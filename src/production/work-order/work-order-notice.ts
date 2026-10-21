import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationEmitter, NotificationValues, resolveByLine } from '../../core/notification';
import { ACTIVE_RESULT_WHERE } from './work-order-progress';

type Tx = Prisma.TransactionClient;

export interface WorkOrderNoticeOptions {
  /** 실행한 사람 — 계정이 있으면 그 이름, 없으면 단말 작업자(`X-Worker-No`) 이름(data-model §6). */
  appUserId?: number;
  workerNo?: string;
  /** 중단 사유 이름 — STOP 만. */
  reason?: string;
  /**
   * 계획·양품 수량을 싣는다. 양품은 «지금까지»의 W/O 누계 스냅샷이다(research R-13) —
   * 마감은 같은 tx 에서 이미 센 합을 넘긴다.
   */
  quantities?: { goodQty?: Prisma.Decimal };
}

export type WorkOrderEventCode = 'WORK_SESSION_STARTED' | 'WORK_SESSION_STOPPED' | 'WORK_SESSION_ENDED' | 'WORK_ORDER_CLOSED';

/** 생산 4종 알림 — 값을 모아 생성기에 넘긴다. 대상은 W/O 다(계약 targetType 에 세션이 없다 · research R-6). */
@Injectable()
export class WorkOrderNotifier {
  constructor(private readonly emitter: NotificationEmitter) {}

  async notify(
    tx: Tx,
    eventCode: WorkOrderEventCode,
    workOrderId: bigint,
    occurredAt: Date,
    options: WorkOrderNoticeOptions,
  ): Promise<void> {
    const notice = await workOrderNotice(tx, workOrderId, options);
    await this.emitter.emit(tx, { eventCode, aggregateTypeCode: 'WORK_ORDER', aggregateId: workOrderId, occurredAt, ...notice });
  }
}

/**
 * 생산 4종 알림의 부서·값. 부서는 W/O 의 라인 «자신»의 담당 부서다(상속 없음 · research R-7).
 * ⭐ 생산 도메인에 둔다 — 누계 규칙 `ACTIVE_RESULT_WHERE` 가 여기 있고 core 가 도메인을 읽지 않게 한다.
 */
export async function workOrderNotice(
  tx: Tx,
  workOrderId: bigint,
  options: WorkOrderNoticeOptions,
): Promise<{ departmentId: bigint | null; values: NotificationValues }> {
  const workOrder = await tx.work_order.findUniqueOrThrow({
    where: { work_order_id: workOrderId },
    select: {
      work_order_no: true,
      order_qty: true,
      production_line_id: true,
      item: { select: { item_code: true, item_name: true } },
      routing_operation: { select: { process: { select: { process_name: true } } } },
      production_line: { select: { line_name: true } },
    },
  });
  const values: NotificationValues = {
    wo_no: workOrder.work_order_no,
    item: `${workOrder.item.item_code} ${workOrder.item.item_name}`,
    process: workOrder.routing_operation.process.process_name,
    line: workOrder.production_line?.line_name,
    actor: await actorName(tx, options),
    reason: options.reason,
  };
  if (options.quantities !== undefined) {
    values.plan_qty = workOrder.order_qty.toString();
    values.good_qty = (options.quantities.goodQty ?? (await goodQty(tx, workOrderId))).toString();
  }
  return { departmentId: await resolveByLine(tx, workOrder.production_line_id), values };
}

async function actorName(tx: Tx, options: WorkOrderNoticeOptions): Promise<string | undefined> {
  if (options.appUserId !== undefined) {
    const user = await tx.app_user.findUnique({ where: { app_user_id: options.appUserId }, select: { user_name: true } });
    if (user !== null) return user.user_name;
  }
  if (options.workerNo === undefined) return undefined;
  const worker = await tx.worker.findUnique({ where: { worker_no: options.workerNo }, select: { worker_name: true } });
  return worker?.worker_name;
}

/** 마감 경로의 `goodQty` 와 같은 기준 — 정정된 원본을 뺀 잎만 센다. */
async function goodQty(tx: Tx, workOrderId: bigint): Promise<Prisma.Decimal> {
  const sums = await tx.production_result.aggregate({
    where: { work_order_id: workOrderId, ...ACTIVE_RESULT_WHERE },
    _sum: { good_qty: true },
  });
  return sums._sum.good_qty ?? new Prisma.Decimal(0);
}
