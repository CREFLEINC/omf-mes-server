import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { VOIDED_LIFECYCLE, WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { postReceipt } from '../../logistics/goods-receipt/receipt-posting';
import { PrismaService } from '../../prisma/prisma.service';
import { NUMBERING_DOCUMENT, ProductionResultService } from '../../production/production-result/production-result.service';
import { WorkOrderCloseService } from '../../production/work-order/work-order-close.service';
import { ACTIVE_RESULT_WHERE } from '../../production/work-order/work-order-progress';
import { lockWorkOrder } from '../../production/work-order/work-order-write.service';
import { registerSerialNumbers } from '../../trace/serial-number/serial-number-register';
import { backflush } from './backflush';
import { claimTransmission, screen } from './tracking-transmission';

type Tx = Prisma.TransactionClient;

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

/** PL13 시스템 작업자 — 연동 실적·LOT 이력·마감의 작업자다. 초기 데이터가 넣는다(사용자 2026-11-16). */
export const SYSTEM_WORKER_NO = 'TRACKING-SYSTEM';
const KIND = 'STOCK_MOVE';
const LOCKED_STATUSES = ['CLOSED', 'CANCELLED'];

const WORK_ORDER_SELECT = {
  work_order_id: true,
  item_id: true,
  uom_id: true,
  default_fg_location_id: true,
  item: { select: { item_code: true } },
  production_plan: { select: { bom_id: true, production_order: { select: { plant_id: true } } } },
  location_work_order_default_fg_location_idTolocation: { select: { warehouse_id: true } },
} satisfies Prisma.work_orderSelect;

/**
 * 포장 한 묶음을 한 트랜잭션에서 실적 → 시리얼 → 제품 입고 → 자재 차감 → (양품 합이 지시수량이면) 마감으로 받는다.
 * 처리한 전송 번호가 다시 오면 아무것도 하지 않는다. 거절하면 전송 행도 되돌려져 원인을 고친 뒤 같은 전송을 다시 받을 수 있다.
 */
@Injectable()
export class StockMoveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly posting: InventoryPostingService,
    private readonly results: ProductionResultService,
    private readonly closes: WorkOrderCloseService,
  ) {}

  async receive(input: StockMove, plantId: bigint): Promise<{ replayed: boolean }> {
    if (input.qty !== input.serialNos.length) {
      throw one(field('qty', ERROR_CODE.INVALID, `수량(${input.qty})이 시리얼 수(${input.serialNos.length})와 다릅니다.`));
    }
    if (new Set(input.serialNos).size !== input.serialNos.length) {
      throw one(field('serialNos', ERROR_CODE.INVALID, '본문 안에 같은 시리얼이 두 번 있습니다.'));
    }
    const workOrder = await this.workOrderOf(input, plantId);
    const workerId = await this.systemWorkerId();
    // 번호는 트랜잭션을 열기 전에 뽑는다(I-2 R-2) — 다시 온 전송은 번호를 버린다(결번 허용). 실적 번호의 기간은 실적 시각의 UTC 날짜다(실적 등록과 같다).
    const resultNo = await this.numbering.next(NUMBERING_DOCUMENT, null, new Date(input.packedTo).toISOString().slice(0, 10));
    const receiptNo = await this.numbering.next('GOODS_RECEIPT', plantId, input.businessDate);
    const issueNo = await this.numbering.next('GOODS_ISSUE', plantId, input.businessDate);

    return this.prisma.$transaction(async (tx) => {
      const transmission = await claimTransmission(tx, {
        transmissionId: input.transmissionId, kindCode: KIND, plantId, workOrderId: workOrder.work_order_id, payload: input,
      });
      if (transmission === null) return { replayed: true };
      const workOrderId = Number(workOrder.work_order_id);
      const locked = await lockWorkOrder(tx, workOrderId);
      if (LOCKED_STATUSES.includes(locked.status_code)) {
        throw one(field('workOrderNo', ERROR_CODE.STATE_LOCKED, `마감·취소된 W/O 입니다(${locked.status_code}).`));
      }
      const total = (await goodQty(tx, workOrderId)).plus(input.qty);
      if (total.greaterThan(locked.order_qty)) {
        throw one(field('qty', ERROR_CODE.RANGE, `양품 합(${total.toString()})이 지시수량(${locked.order_qty.toString()})을 넘습니다.`));
      }
      const lotId = await productLot(tx, workOrder.work_order_id);
      const result = await this.results.recordWithin(tx, {
        workOrderId, goodQty: input.qty, uomId: Number(workOrder.uom_id), lotId, occurredAt: new Date(input.packedTo),
        resultSourceCode: 'TRACKING_SYSTEM', workerId, idempotencyKey: `${KIND}:${input.transmissionId}`, productionResultNo: resultNo,
      });
      await assertLotNormal(tx, lotId);
      await registerSerialNumbers(tx, { lotId, itemId: workOrder.item_id, serialNos: input.serialNos });
      const location = workOrder.location_work_order_default_fg_location_idTolocation as { warehouse_id: bigint };
      const receiptId = await postReceipt(tx, this.posting, {
        receiptTypeCode: 'PRODUCT', plantId: Number(plantId), warehouseId: Number(location.warehouse_id), receiptDatetime: input.packedTo,
        sourceDocumentTypeCode: 'PRODUCTION_RESULT', sourceDocumentId: result.productionResultId, businessDate: input.businessDate,
        lines: [{
          itemId: Number(workOrder.item_id), lotId: Number(lotId), receiptQty: input.qty, uomId: Number(workOrder.uom_id),
          qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(workOrder.default_fg_location_id),
        }],
      }, undefined, receiptNo, null);
      const issueId = await backflush(tx, this.posting, {
        trackingTransmissionId: transmission, transmissionId: input.transmissionId, plantId, workOrderId: workOrder.work_order_id,
        bomId: (workOrder.production_plan as { bom_id: bigint }).bom_id, qty: new Prisma.Decimal(input.qty),
        productionResultId: BigInt(result.productionResultId), workerId, goodsIssueNo: issueNo, businessDate: input.businessDate,
        occurredAt: new Date(input.packedTo),
      });
      await tx.tracking_transmission_document.createMany({ data: [
        { tracking_transmission_id: transmission, document_type_code: 'PRODUCTION_RESULT', document_id: BigInt(result.productionResultId) },
        { tracking_transmission_id: transmission, document_type_code: 'GOODS_RECEIPT', document_id: receiptId },
        ...(issueId === null ? [] : [{ tracking_transmission_id: transmission, document_type_code: 'GOODS_ISSUE', document_id: issueId }]),
      ] });
      if (total.equals(locked.order_qty)) await this.closes.closeWithin(tx, workOrderId, {}, workerId);
      return { replayed: false };
    }, { timeout: 15_000, maxWait: 5_000 });
  }

  /** `mesWorkOrderId` 가 있으면 그것으로, 없으면 번호로 찾는다. 다른 공장의 W/O 는 없는 W/O 와 같게 답한다. */
  private async workOrderOf(input: StockMove, plantId: bigint) {
    const byId = input.mesWorkOrderId !== null;
    const row = await this.prisma.work_order.findUnique({
      where: byId ? { work_order_id: BigInt(input.mesWorkOrderId as number) } : { work_order_no: input.workOrderNo },
      select: WORK_ORDER_SELECT,
    });
    if (row === null || row.production_plan?.production_order.plant_id !== plantId) {
      throw one(field(byId ? 'mesWorkOrderId' : 'workOrderNo', ERROR_CODE.INVALID, `MES 에 없는 W/O 입니다: ${input.workOrderNo}`));
    }
    if (row.item.item_code !== input.itemCode) {
      throw one(field('itemCode', ERROR_CODE.INVALID, `W/O 의 품목(${row.item.item_code})과 다릅니다.`));
    }
    if (row.location_work_order_default_fg_location_idTolocation === null) {
      throw screen(ERROR_CODE.INVALID, 'W/O 에 완제품 위치가 없습니다 — ERP W/O 의 입고 창고(SL_CD)와 같은 코드의 MES 창고를 확인하세요.');
    }
    return row;
  }

  private async systemWorkerId(): Promise<bigint> {
    const worker = await this.prisma.worker.findFirst({ where: { worker_no: SYSTEM_WORKER_NO, is_active: true }, select: { worker_id: true } });
    if (worker === null) throw screen(ERROR_CODE.INVALID, `MES 에 시스템 작업자(${SYSTEM_WORKER_NO})가 없습니다 — 초기 데이터를 넣으세요.`);
    return worker.worker_id;
  }
}

async function goodQty(tx: Tx, workOrderId: number): Promise<Prisma.Decimal> {
  const sums = await tx.production_result.aggregate({
    where: { work_order_id: BigInt(workOrderId), ...ACTIVE_RESULT_WHERE },
    _sum: { good_qty: true },
  });
  return sums._sum.good_qty ?? new Prisma.Decimal(0);
}

/** 자동 W/O 는 LOT 크기가 지시수량이라 생산 LOT 이 하나다. */
async function productLot(tx: Tx, workOrderId: bigint): Promise<bigint> {
  const lots = await tx.lot.findMany({
    where: { source_type_code: WORK_ORDER_LOT_SOURCE, source_id: workOrderId, lifecycle_status_code: { not: VOIDED_LIFECYCLE } },
    select: { lot_id: true },
  });
  if (lots.length !== 1) throw screen(ERROR_CODE.INVALID, `생산 LOT 이 하나인 W/O 만 받습니다 — 이 W/O 는 ${lots.length}개입니다.`);
  return lots[0].lot_id;
}

/** OA 품목의 공정 검사는 flowtrack 이 한다 — MES 에서 정상이 되지 않은 LOT 은 정상·가용으로 입고하지 않는다(사용자 2026-11-16). */
async function assertLotNormal(tx: Tx, lotId: bigint): Promise<void> {
  const lot = await tx.lot.findUniqueOrThrow({ where: { lot_id: lotId }, select: { status_code: true } });
  if (lot.status_code !== 'NORMAL') {
    throw screen(ERROR_CODE.STATE_LOCKED, `생산 LOT 이 정상이 아닙니다(${lot.status_code}) — MES 의 공정 검사 기준·LOT 보류를 확인하세요.`);
  }
}
