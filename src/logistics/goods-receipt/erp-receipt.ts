import { Prisma } from '@prisma/client';

import { LOT_SPLIT_SOURCE } from '../../core/lot';
import { IF_GOODS_RECEIPT, OutboxService, outboxMessageKey } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { unallocatedQtyOf } from '../inbound-receipt/inbound-allocation';
import { inboundLineOfLot } from './lot-receivable';

/** 자재 입고 — 입하(P/O)에서 온 자재를 받는다. ERP 구매입고는 이 유형만 간다. */
export const MATERIAL_RECEIPT = 'MATERIAL';
/** 특채가 적용된 상태(`quality.concession` · 장부 P-79). */
const APPLIED_CONCESSION = 'APPROVED';
/** 아직 취소되지 않은 입고 — 취소 요청 중이어도 결재가 반려되면 그대로 남는다. */
const LIVE_RECEIPT_STATUSES = ['POSTED', 'CANCEL_REQUESTED'];
const INBOUND_LOT_SOURCE = 'INBOUND_RECEIPT_LINE';
/** 선별의 선별을 따라가는 깊이 — `inboundLineOfLot` 과 같다. */
const MAX_DEPTH = 10;
/** 입고 취소 묶음의 대상 — 그 입고로 보낸 행마다 취소 행(C)이 간다. */
export const RECEIPT_CANCEL_TARGET = 'GOODS_RECEIPT_CANCEL';

/** 배정 몫 묶음의 대상 — 몫 하나가 ERP 구매입고 한 행이다. */
export const ALLOCATION_TARGET = 'INBOUND_RECEIPT_PO_ALLOCATION';
/** 배정 몫 묶음의 키 — 몫마다 한 번만 적재된다. 이 키가 있는 몫은 빼지 못한다. */
export function allocationMessageKey(allocationId: bigint): string {
  return outboxMessageKey(IF_GOODS_RECEIPT, `ALLOC:${allocationId}`);
}

type Db = Pick<
  PrismaService,
  'lot' | 'concession' | 'inbound_receipt_line' | 'goods_receipt_line' | 'inventory_transaction_line'
>;

export interface ReceiptLineRef {
  lotId: bigint;
  inboundReceiptLineId: bigint | null;
}

/**
 * ERP 구매입고로 갈 입고 줄의 입하 줄 — 줄마다, 가지 않을 줄은 `null`(장부 P-104 · 사용자 결정 2026-10-22).
 * - 입하 줄에 ERP 발주 라인 배정이 있거나 미배정 몫이 남아야 한다 — 미배정 몫은 나중에 ERP 발주에 배정되면 이 입고의
 *   번호로 간다(`ALLOC` 묶음). 그래서 입고 묶음을 세워 둔다 — 실을 행이 없어도 입고 취소가 C 행을 보낼 자리가 된다.
 *   MES 발주에만 다 배정된 줄은 가지 않는다. 선별로 떼어 낸 LOT 은 조상의 입하 줄을 따른다(P-56).
 * - 특채(한도승인)가 적용된 LOT 은 가지 않는다 — ERP G/R 은 합격품 한정이다(QA #1 · W-01-10 §5-5).
 *   처분 '정상'으로 풀린 LOT 은 합격으로 본다.
 */
export async function erpInboundLines(db: Db, lines: readonly ReceiptLineRef[]): Promise<(bigint | null)[]> {
  const concessions = await db.concession.findMany({
    where: { lot_id: { in: lines.map((line) => line.lotId) }, status_code: APPLIED_CONCESSION },
    select: { lot_id: true },
  });
  const conceded = new Set(concessions.map((row) => row.lot_id));
  const found: (bigint | null)[] = [];
  for (const line of lines) {
    const inboundLineId = conceded.has(line.lotId)
      ? null
      : (line.inboundReceiptLineId ?? (await inboundLineOfLot(db, line.lotId)));
    const inbound =
      inboundLineId === null
        ? null
        : await db.inbound_receipt_line.findUnique({
            where: { inbound_receipt_line_id: inboundLineId },
            select: {
              received_qty: true,
              inbound_receipt_po_allocation: {
                select: { allocated_qty: true, purchase_order_line: { select: { purchase_order: { select: { erp_purchase_order_no: true } } } } },
              },
            },
          });
    const toErp =
      inbound !== null &&
      (inbound.inbound_receipt_po_allocation.some((row) => row.purchase_order_line.purchase_order.erp_purchase_order_no !== null) ||
        unallocatedQtyOf(inbound.received_qty, inbound.inbound_receipt_po_allocation).greaterThan(0));
    found.push(toErp ? inboundLineId : null);
  }
  return found;
}

/**
 * 입고 수량을 배정 몫에 나눈다 — 배정을 만든 순서대로 채우고, 남는 것은 미배정 몫이다(P-100 의 「P/O 몫 먼저」와 같다).
 * 선별로 불량분을 떼어 내 입고가 받은 수량보다 적으면 뒤 몫부터 덜 받는다. 돌려주는 것은 배정 id → 이 입고가 채운 수량.
 */
export function receiptShares(
  receiptQty: Prisma.Decimal,
  allocations: readonly { inbound_receipt_po_allocation_id: bigint; allocated_qty: Prisma.Decimal }[],
): Map<bigint, Prisma.Decimal> {
  const shares = new Map<bigint, Prisma.Decimal>();
  let rest = receiptQty;
  for (const row of [...allocations].sort((a, b) => (a.inbound_receipt_po_allocation_id < b.inbound_receipt_po_allocation_id ? -1 : 1))) {
    const share = Prisma.Decimal.min(rest, row.allocated_qty);
    shares.set(row.inbound_receipt_po_allocation_id, share);
    rest = rest.minus(share);
  }
  return shares;
}

export interface ErpReceiptLine {
  goodsReceiptId: bigint;
  goodsReceiptNo: string;
  receiptDatetime: Date;
  lotId: bigint;
  receiptQty: Prisma.Decimal;
}

/**
 * 입하 줄 하나에서 ERP 구매입고로 가는 입고 줄 — 취소되지 않은 자재 입고이고, 불량창고가 아니고, 특채 LOT 이 아니다.
 * 그 입하 줄의 LOT 과 선별로 떼어 낸 자손을 본다(P-56). 입하 줄의 몫(P-100)을 나눌 때 쓴다.
 */
export async function erpReceiptLinesOf(db: Db, inboundLineId: bigint): Promise<ErpReceiptLine[]> {
  let frontier = (
    await db.lot.findMany({
      where: { source_type_code: INBOUND_LOT_SOURCE, source_id: inboundLineId },
      select: { lot_id: true },
    })
  ).map((row) => row.lot_id);
  const lots = [...frontier];
  for (let depth = 0; frontier.length > 0 && depth < MAX_DEPTH; depth += 1) {
    frontier = (
      await db.lot.findMany({
        where: { parent_lot_id: { in: frontier }, source_type_code: LOT_SPLIT_SOURCE },
        select: { lot_id: true },
      })
    ).map((row) => row.lot_id);
    lots.push(...frontier);
  }
  const lines = await db.goods_receipt_line.findMany({
    where: {
      OR: [{ inbound_receipt_line_id: inboundLineId }, { lot_id: { in: lots } }],
      goods_receipt: {
        status_code: { in: LIVE_RECEIPT_STATUSES },
        receipt_type_code: MATERIAL_RECEIPT,
        warehouse: { is_defect: false },
      },
    },
    orderBy: { goods_receipt_line_id: 'asc' },
    select: {
      lot_id: true,
      receipt_qty: true,
      goods_receipt: { select: { goods_receipt_id: true, goods_receipt_no: true, receipt_datetime: true } },
    },
  });
  const conceded = new Set(
    (
      await db.concession.findMany({
        where: { lot_id: { in: lines.map((line) => line.lot_id) }, status_code: APPLIED_CONCESSION },
        select: { lot_id: true },
      })
    ).map((row) => row.lot_id),
  );
  return lines
    .filter((line) => !conceded.has(line.lot_id))
    .map((line) => ({
      goodsReceiptId: line.goods_receipt.goods_receipt_id,
      goodsReceiptNo: line.goods_receipt.goods_receipt_no,
      receiptDatetime: line.goods_receipt.receipt_datetime,
      lotId: line.lot_id,
      receiptQty: line.receipt_qty,
    }));
}

/**
 * 입고 취소를 ERP 에 알릴 일을 적재한다(사용자 결정 2026-10-22 · 장부 P-104) — 그 입고를 구매입고로 적재했을 때만.
 * 보내기 전에 취소되면 입고 묶음은 보낼 것이 없고 취소 묶음도 보낼 것이 없다(둘 다 바로 완료).
 */
export async function enqueueReceiptCancel(
  tx: Prisma.TransactionClient,
  outbox: OutboxService,
  goodsReceiptId: bigint,
): Promise<void> {
  const { goods_receipt_no: receiptNo } = await tx.goods_receipt.findUniqueOrThrow({
    where: { goods_receipt_id: goodsReceiptId },
    select: { goods_receipt_no: true },
  });
  const queued = await tx.integration_message.count({
    where: { message_key: outboxMessageKey(IF_GOODS_RECEIPT, receiptNo) },
  });
  if (queued === 0) return;
  await outbox.enqueue(tx, {
    interfaceCode: IF_GOODS_RECEIPT,
    messageKey: outboxMessageKey(IF_GOODS_RECEIPT, `CANCEL:${receiptNo}`),
    targetTypeCode: RECEIPT_CANCEL_TARGET,
    targetId: goodsReceiptId,
    payload: { goodsReceiptNo: receiptNo },
  });
}
