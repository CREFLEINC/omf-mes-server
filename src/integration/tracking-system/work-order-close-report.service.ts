import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderClose, assertCloseBody } from '../../production/work-order/close-rules';
import { judgeCompletion } from '../../production/work-order/completion';
import { WorkOrderCancelService } from '../../production/work-order/work-order-cancel.service';
import { WorkOrderCloseService } from '../../production/work-order/work-order-close.service';
import { TrackingProduction, lockOpenWorkOrder } from './tracking-production';
import { claimTransmission } from './tracking-transmission';

type Tx = Prisma.TransactionClient;

/** 마감 보고 — flowtrack 이 W/O 를 닫으며 보낸다(flowtrack 연동 제안 §3-5). S410 은 만든 수, 시리얼 품목은 0 이다. */
export interface WorkOrderCloseReport {
  transmissionId: string;
  workOrderNo: string;
  mesWorkOrderId: number | null;
  itemCode: string;
  qty: number;
  remainderDispositionCode?: string | null;
  reasonCode?: string | null;
  remarks?: string | null;
  businessDate: string;
}

const KIND = 'WORK_ORDER_CLOSE';
const VARIANCE_REASON_GROUP = 'WORK_ORDER_COMPLETION_VARIANCE_REASON';
const CANCEL_REASON_GROUP = 'WORK_ORDER_CANCEL_REASON';
const OTHER_REASON = 'OTHER';

/**
 * 마감 보고를 한 트랜잭션에서 받는다 — `qty` 만큼 실적 → 제품 입고 → 자재 차감(입고이동과 같다) → 마감. 양품 합이 0 이면 마감하지 않고 취소한다.
 * 마감한 작업자는 PL13 시스템 작업자다. 처리한 전송 번호가 다시 오면 아무것도 하지 않는다.
 */
@Injectable()
export class WorkOrderCloseReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly production: TrackingProduction,
    private readonly closes: WorkOrderCloseService,
    private readonly cancels: WorkOrderCancelService,
  ) {}

  async receive(input: WorkOrderCloseReport, plantId: bigint): Promise<{ replayed: boolean }> {
    const workOrder = await this.production.workOrderOf(input, plantId);
    const workerId = await this.production.systemWorkerId();
    // 본문에 시각이 없다 — 받은 시각이 실적·입고 시각이다.
    const occurredAt = new Date();
    const numbers = input.qty > 0 ? await this.production.numbersFor(plantId, occurredAt, input.businessDate) : null;
    const body: WorkOrderClose = {
      ...(input.remainderDispositionCode == null ? {} : { remainderDispositionCode: input.remainderDispositionCode }),
      ...(input.reasonCode == null ? {} : { reasonCode: input.reasonCode }),
      ...(input.remarks == null ? {} : { remarks: input.remarks }),
    };

    return this.prisma.$transaction(async (tx) => {
      const transmission = await claimTransmission(tx, {
        transmissionId: input.transmissionId, kindCode: KIND, plantId, workOrderId: workOrder.work_order_id, payload: input,
      });
      if (transmission === null) return { replayed: true };
      const { total, orderQty } = await lockOpenWorkOrder(tx, workOrder.work_order_id, input.qty);
      if (numbers !== null) {
        if (await hasSerials(tx, workOrder.work_order_id)) {
          throw one(field('qty', ERROR_CODE.INVALID, '시리얼 품목의 W/O 입니다 — 양품은 입고이동으로 보내고 마감 보고의 qty 는 0 으로 보내세요.'));
        }
        await this.production.produceWithin(tx, {
          trackingTransmissionId: transmission, transmissionId: input.transmissionId, kindCode: KIND, plantId, workOrder,
          qty: input.qty, serialNos: [], occurredAt, businessDate: input.businessDate, workerId, numbers,
        });
      }
      const workOrderId = Number(workOrder.work_order_id);
      if (!total.isZero()) {
        await this.closes.closeWithin(tx, workOrderId, body, workerId);
        return { replayed: false };
      }
      // 만든 것이 없는 W/O 는 마감하지 않고 취소한다(생산 LOT 폐번 · flowtrack 연동 결정 11). 마감과 같은 본문 규칙으로 거른다.
      assertCloseBody(judgeCompletion(total, orderQty), body, { goodQty: total, orderQty });
      await assertCodeValues(tx, [{ field: 'reasonCode', value: body.reasonCode, groupCode: VARIANCE_REASON_GROUP }]);
      await this.cancels.cancelWithin(tx, workOrderId, { reasonCode: await cancelReasonOf(tx, body.reasonCode as string) });
      return { replayed: false };
    }, { timeout: 15_000, maxWait: 5_000 });
  }
}

async function hasSerials(tx: Tx, workOrderId: bigint): Promise<boolean> {
  const serial = await tx.serial_number.findFirst({
    where: { lot: { source_type_code: WORK_ORDER_LOT_SOURCE, source_id: workOrderId } },
    select: { serial_number_id: true },
  });
  return serial !== null;
}

/** 취소 사유 목록에 같은 코드가 있으면 그것을, 없으면 「기타」를 쓴다(사용자 2026-11-17) — 두 목록은 일부만 겹친다. */
async function cancelReasonOf(tx: Tx, reasonCode: string): Promise<string> {
  const same = await tx.code_value.findFirst({
    where: { code: reasonCode, is_active: true, code_group: { group_code: CANCEL_REASON_GROUP } },
    select: { code: true },
  });
  return same?.code ?? OTHER_REASON;
}
