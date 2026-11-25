import { PrismaService } from '../../prisma/prisma.service';
import { WIP_LOT_TYPE, WORK_ORDER_LOT_SOURCE, wipQuantities, wipRemaining } from '../../core/lot';

/** 반제품 LOT 의 생산 공정 — LOT 에 복사하지 않고 원천 W/O 에서 읽는다(피처 016 R-1). */
export interface ProducedOperationView {
  workOrderId: number;
  operationSeq: number;
  processCode: string;
  processName: string;
}

/** 계약 `Lot` 의 반제품 칸 셋 — 반제품(WIP)만 채우고 나머지는 null 이다. */
export interface WipLotView {
  producedOperation: ProducedOperationView | null;
  /** 실적 배분 합 — POP 투입 줄의 「실적」. */
  wipProducedQty: number | null;
  /** 실적 − 투입(0 아래 없음) — 투입량 처음 값. 「투입」은 두 값의 차다. */
  wipRemainingQty: number | null;
}

export const NOT_WIP: WipLotView = { producedOperation: null, wipProducedQty: null, wipRemainingQty: null };

interface WipLotRow {
  lot_id: bigint;
  lot_type_code: string;
  source_type_code: string;
  source_id: bigint;
}

/** 목록·단건이 LOT 들을 한 번에 — W/O → 공정 → 공정 마스터 한 질의, 실적·투입 합 한 질의. 반제품이 아니면 키가 없다. */
export async function wipLotViews(prisma: PrismaService, rows: readonly WipLotRow[]): Promise<Map<bigint, WipLotView>> {
  const wips = rows.filter((row) => row.lot_type_code === WIP_LOT_TYPE && row.source_type_code === WORK_ORDER_LOT_SOURCE);
  if (wips.length === 0) return new Map();
  const [workOrders, quantities] = await Promise.all([
    prisma.work_order.findMany({
      where: { work_order_id: { in: [...new Set(wips.map((row) => row.source_id))] } },
      select: {
        work_order_id: true,
        routing_operation: { select: { operation_seq: true, process: { select: { process_code: true, process_name: true } } } },
      },
    }),
    wipQuantities(prisma, wips.map((row) => row.lot_id)),
  ]);
  const byWorkOrder = new Map(workOrders.map((row) => [row.work_order_id, row]));
  return new Map(wips.map((row) => {
    const workOrder = byWorkOrder.get(row.source_id);
    const quantity = quantities.get(row.lot_id);
    return [row.lot_id, {
      producedOperation: workOrder === undefined ? null : {
        workOrderId: Number(workOrder.work_order_id),
        operationSeq: workOrder.routing_operation.operation_seq,
        processCode: workOrder.routing_operation.process.process_code,
        processName: workOrder.routing_operation.process.process_name,
      },
      wipProducedQty: quantity === undefined ? 0 : quantity.produced.toNumber(),
      wipRemainingQty: quantity === undefined ? 0 : wipRemaining(quantity).toNumber(),
    }];
  }));
}
