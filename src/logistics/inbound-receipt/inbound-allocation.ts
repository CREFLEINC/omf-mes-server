import { Prisma } from '@prisma/client';

import { ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { CLOSED_ORDER_STATUSES } from '../purchase-order/purchase-order-receipt';

/** 배정할 입하 줄 — 대상 P/O 라인과 맞춰 볼 것. */
export interface AllocationLine {
  item_id: bigint;
  uom_id: bigint;
  inbound_receipt: { plant_id: bigint; supplier_id: bigint };
}

/** 배정 대상 P/O 라인. */
export interface AllocationTarget {
  item_id: bigint;
  uom_id: bigint;
  cancelled_at: Date | null;
  ordered_qty: Prisma.Decimal;
  tolerance_over_qty: Prisma.Decimal;
  received_qty: Prisma.Decimal;
  purchase_order: { plant_id: bigint; supplier_id: bigint; status_code: string };
}

/** 미배정 = 받은 수량 − 배정 합. 표에 두지 않고 늘 여기서 센다. 무발주 줄은 배정이 없어 받은 수량 전체다. */
export function unallocatedQtyOf(
  receivedQty: Prisma.Decimal,
  allocations: readonly { allocated_qty: Prisma.Decimal }[],
): Prisma.Decimal {
  return allocations.reduce((rest, row) => rest.minus(row.allocated_qty), receivedQty);
}

/**
 * 이 줄을 그 P/O 라인에 배정할 수 있나 — 같은 공장·공급사·품목·단위이고 취소·닫힘이 아니어야 한다.
 * 줄이 이미 배정된 P/O 라인도 된다(초과분 잇기와 다른 점) — ERP 가 추가 P/O 를 만드는 대신 원래 P/O 수량을
 * 늘려 주면 같은 라인에 몫을 더 잇는다.
 */
export function allocationTargetError(line: AllocationLine, target: AllocationTarget, at: string): ErrorItem | null {
  const mismatch =
    target.item_id !== line.item_id ||
    target.uom_id !== line.uom_id ||
    target.purchase_order.plant_id !== line.inbound_receipt.plant_id ||
    target.purchase_order.supplier_id !== line.inbound_receipt.supplier_id;
  if (mismatch) return field(at, ERROR_CODE.INVALID, '같은 공장·공급사·품목·단위의 P/O 라인이어야 합니다.');
  if (target.cancelled_at !== null || CLOSED_ORDER_STATUSES.includes(target.purchase_order.status_code)) {
    return field(at, ERROR_CODE.INVALID, '취소했거나 닫힌 P/O 라인입니다.');
  }
  return null;
}
