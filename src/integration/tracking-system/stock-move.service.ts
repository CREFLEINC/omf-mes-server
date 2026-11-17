import { Injectable } from '@nestjs/common';

import { ERROR_CODE, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderCloseService } from '../../production/work-order/work-order-close.service';
import { TrackingProduction, lockOpenWorkOrder } from './tracking-production';
import { claimTransmission } from './tracking-transmission';

/** 포장 입고이동 — flowtrack 이 W/O 하나의 포장 묶음을 보낸다(flowtrack 연동 제안 §3-3). */
export interface StockMove {
  transmissionId: string;
  workOrderNo: string;
  mesWorkOrderId: number | null;
  itemCode: string;
  qty: number;
  serialNos: string[];
  packedFrom: string;
  packedTo: string;
  businessDate: string;
}

const KIND = 'STOCK_MOVE';

/**
 * 포장 한 묶음을 한 트랜잭션에서 실적 → 시리얼 → 제품 입고 → 자재 차감 → (양품 합이 지시수량이면) 마감으로 받는다.
 * 처리한 전송 번호가 다시 오면 아무것도 하지 않는다. 거절하면 전송 행도 되돌려져 원인을 고친 뒤 같은 전송을 다시 받을 수 있다.
 */
@Injectable()
export class StockMoveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly production: TrackingProduction,
    private readonly closes: WorkOrderCloseService,
  ) {}

  async receive(input: StockMove, plantId: bigint): Promise<{ replayed: boolean }> {
    if (input.qty !== input.serialNos.length) {
      throw one(field('qty', ERROR_CODE.INVALID, `수량(${input.qty})이 시리얼 수(${input.serialNos.length})와 다릅니다.`));
    }
    if (new Set(input.serialNos).size !== input.serialNos.length) {
      throw one(field('serialNos', ERROR_CODE.INVALID, '본문 안에 같은 시리얼이 두 번 있습니다.'));
    }
    const workOrder = await this.production.workOrderOf(input, plantId);
    const workerId = await this.production.systemWorkerId();
    const occurredAt = new Date(input.packedTo);
    const numbers = await this.production.numbersFor(plantId, occurredAt, input.businessDate);

    return this.prisma.$transaction(async (tx) => {
      const transmission = await claimTransmission(tx, {
        transmissionId: input.transmissionId, kindCode: KIND, plantId, workOrderId: workOrder.work_order_id, payload: input,
      });
      if (transmission === null) return { replayed: true };
      const { total, orderQty } = await lockOpenWorkOrder(tx, workOrder.work_order_id, input.qty);
      await this.production.produceWithin(tx, {
        trackingTransmissionId: transmission, transmissionId: input.transmissionId, kindCode: KIND, plantId, workOrder,
        qty: input.qty, serialNos: input.serialNos, occurredAt, businessDate: input.businessDate, workerId, numbers,
      });
      if (total.equals(orderQty)) await this.closes.closeWithin(tx, Number(workOrder.work_order_id), {}, workerId);
      return { replayed: false };
    }, { timeout: 15_000, maxWait: 5_000 });
  }
}
