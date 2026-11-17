import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { VOIDED_LIFECYCLE, WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { postReceipt } from '../../logistics/goods-receipt/receipt-posting';
import { PrismaService } from '../../prisma/prisma.service';
import { NUMBERING_DOCUMENT, ProductionResultService } from '../../production/production-result/production-result.service';
import { ACTIVE_RESULT_WHERE } from '../../production/work-order/work-order-progress';
import { lockWorkOrder } from '../../production/work-order/work-order-write.service';
import { registerSerialNumbers } from '../../trace/serial-number/serial-number-register';
import { backflush } from './backflush';
import { screen } from './tracking-transmission';

type Tx = Prisma.TransactionClient;

/** PL13 시스템 작업자 — 연동 실적·LOT 이력·마감의 작업자다. 초기 데이터가 넣는다(사용자 2026-11-16). */
export const SYSTEM_WORKER_NO = 'TRACKING-SYSTEM';
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

export type TrackedWorkOrder = Prisma.work_orderGetPayload<{ select: typeof WORK_ORDER_SELECT }>;

/** flowtrack 이 W/O 를 가리키는 칸 — 입고이동과 마감 보고가 같다. */
export interface WorkOrderRef {
  workOrderNo: string;
  mesWorkOrderId: number | null;
  itemCode: string;
}

export interface ProductionNumbers {
  resultNo: string;
  receiptNo: string;
  issueNo: string;
}

/** 한 전송이 W/O 하나에 올리는 양품. */
export interface Production {
  trackingTransmissionId: bigint;
  transmissionId: string;
  kindCode: string;
  plantId: bigint;
  workOrder: TrackedWorkOrder;
  qty: number;
  serialNos: string[];
  occurredAt: Date;
  businessDate: string;
  workerId: bigint;
  numbers: ProductionNumbers;
}

/** 입고이동과 마감 보고가 함께 쓰는 생산 쪽 처리 — W/O 찾기 · 번호 · 실적 → 시리얼 → 제품 입고 → 자재 차감. */
@Injectable()
export class TrackingProduction {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly posting: InventoryPostingService,
    private readonly results: ProductionResultService,
  ) {}

  /** `mesWorkOrderId` 가 있으면 그것으로, 없으면 번호로 찾는다. 다른 공장의 W/O 는 없는 W/O 와 같게 답한다. */
  async workOrderOf(ref: WorkOrderRef, plantId: bigint): Promise<TrackedWorkOrder> {
    const byId = ref.mesWorkOrderId !== null;
    const row = await this.prisma.work_order.findUnique({
      where: byId ? { work_order_id: BigInt(ref.mesWorkOrderId as number) } : { work_order_no: ref.workOrderNo },
      select: WORK_ORDER_SELECT,
    });
    if (row === null || row.production_plan?.production_order.plant_id !== plantId) {
      throw one(field(byId ? 'mesWorkOrderId' : 'workOrderNo', ERROR_CODE.INVALID, `MES 에 없는 W/O 입니다: ${ref.workOrderNo}`));
    }
    if (row.item.item_code !== ref.itemCode) {
      throw one(field('itemCode', ERROR_CODE.INVALID, `W/O 의 품목(${row.item.item_code})과 다릅니다.`));
    }
    if (row.location_work_order_default_fg_location_idTolocation === null) {
      throw screen(ERROR_CODE.INVALID, 'W/O 에 완제품 위치가 없습니다 — ERP W/O 의 입고 창고(SL_CD)와 같은 코드의 MES 창고를 확인하세요.');
    }
    return row;
  }

  async systemWorkerId(): Promise<bigint> {
    const worker = await this.prisma.worker.findFirst({ where: { worker_no: SYSTEM_WORKER_NO, is_active: true }, select: { worker_id: true } });
    if (worker === null) throw screen(ERROR_CODE.INVALID, `MES 에 시스템 작업자(${SYSTEM_WORKER_NO})가 없습니다 — 초기 데이터를 넣으세요.`);
    return worker.worker_id;
  }

  /** 번호는 트랜잭션을 열기 전에 뽑는다(I-2 R-2) — 다시 온 전송은 번호를 버린다(결번 허용). 실적 번호의 기간은 실적 시각의 UTC 날짜다(실적 등록과 같다). */
  async numbersFor(plantId: bigint, occurredAt: Date, businessDate: string): Promise<ProductionNumbers> {
    return {
      resultNo: await this.numbering.next(NUMBERING_DOCUMENT, null, occurredAt.toISOString().slice(0, 10)),
      receiptNo: await this.numbering.next('GOODS_RECEIPT', plantId, businessDate),
      issueNo: await this.numbering.next('GOODS_ISSUE', plantId, businessDate),
    };
  }

  /** 실적 → 시리얼 → 제품 입고(W/O 완제품 위치 · 정상·가용 · 적치 지시 없음) → 자재 차감 → 전송이 만든 문서. */
  async produceWithin(tx: Tx, production: Production): Promise<void> {
    const { workOrder, trackingTransmissionId: transmission } = production;
    const lotId = await productLot(tx, workOrder.work_order_id);
    const result = await this.results.recordWithin(tx, {
      workOrderId: Number(workOrder.work_order_id), goodQty: production.qty, uomId: Number(workOrder.uom_id), lotId,
      occurredAt: production.occurredAt, resultSourceCode: 'TRACKING_SYSTEM', workerId: production.workerId,
      idempotencyKey: `${production.kindCode}:${production.transmissionId}`, productionResultNo: production.numbers.resultNo,
    });
    await assertLotNormal(tx, lotId);
    if (production.serialNos.length > 0) await registerSerialNumbers(tx, { lotId, itemId: workOrder.item_id, serialNos: production.serialNos });
    const location = workOrder.location_work_order_default_fg_location_idTolocation as { warehouse_id: bigint };
    const receiptId = await postReceipt(tx, this.posting, {
      receiptTypeCode: 'PRODUCT', plantId: Number(production.plantId), warehouseId: Number(location.warehouse_id),
      receiptDatetime: production.occurredAt.toISOString(), sourceDocumentTypeCode: 'PRODUCTION_RESULT', sourceDocumentId: result.productionResultId,
      businessDate: production.businessDate,
      lines: [{
        itemId: Number(workOrder.item_id), lotId: Number(lotId), receiptQty: production.qty, uomId: Number(workOrder.uom_id),
        qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(workOrder.default_fg_location_id),
      }],
    }, undefined, production.numbers.receiptNo, null);
    const issueId = await backflush(tx, this.posting, {
      trackingTransmissionId: transmission, transmissionId: production.transmissionId, plantId: production.plantId,
      workOrderId: workOrder.work_order_id, bomId: (workOrder.production_plan as { bom_id: bigint }).bom_id, qty: new Prisma.Decimal(production.qty),
      productionResultId: BigInt(result.productionResultId), workerId: production.workerId, goodsIssueNo: production.numbers.issueNo,
      businessDate: production.businessDate, occurredAt: production.occurredAt,
    });
    await tx.tracking_transmission_document.createMany({ data: [
      { tracking_transmission_id: transmission, document_type_code: 'PRODUCTION_RESULT', document_id: BigInt(result.productionResultId) },
      { tracking_transmission_id: transmission, document_type_code: 'GOODS_RECEIPT', document_id: receiptId },
      ...(issueId === null ? [] : [{ tracking_transmission_id: transmission, document_type_code: 'GOODS_ISSUE', document_id: issueId }]),
    ] });
  }
}

/** W/O 를 잠그고 마감·취소된 W/O 와 지시수량을 넘는 양품 합을 거절한다. 이번 수량을 더한 양품 합과 지시수량을 돌려준다. */
export async function lockOpenWorkOrder(tx: Tx, workOrderId: bigint, qty: number): Promise<{ total: Prisma.Decimal; orderQty: Prisma.Decimal }> {
  const locked = await lockWorkOrder(tx, Number(workOrderId));
  if (LOCKED_STATUSES.includes(locked.status_code)) {
    throw one(field('workOrderNo', ERROR_CODE.STATE_LOCKED, `마감·취소된 W/O 입니다(${locked.status_code}).`));
  }
  const total = (await goodQty(tx, workOrderId)).plus(qty);
  if (total.greaterThan(locked.order_qty)) {
    throw one(field('qty', ERROR_CODE.RANGE, `양품 합(${total.toString()})이 지시수량(${locked.order_qty.toString()})을 넘습니다.`));
  }
  return { total, orderQty: locked.order_qty };
}

async function goodQty(tx: Tx, workOrderId: bigint): Promise<Prisma.Decimal> {
  const sums = await tx.production_result.aggregate({
    where: { work_order_id: workOrderId, ...ACTIVE_RESULT_WHERE },
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
