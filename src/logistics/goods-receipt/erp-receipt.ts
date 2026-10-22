import { Prisma } from '@prisma/client';

import { LOT_SPLIT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { inboundLineOfLot } from './lot-receivable';

/** 자재 입고 — 입하(P/O)에서 온 자재를 받는다. ERP 구매입고는 이 유형만 간다. */
export const MATERIAL_RECEIPT = 'MATERIAL';
/** 특채가 적용된 상태(`quality.concession` · 장부 P-79). */
const APPLIED_CONCESSION = 'APPROVED';
const POSTED = 'POSTED';
const INBOUND_LOT_SOURCE = 'INBOUND_RECEIPT_LINE';
/** 선별의 선별을 따라가는 깊이 — `inboundLineOfLot` 과 같다. */
const MAX_DEPTH = 10;

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
 * - 입하 줄이 ERP 발주 라인에 이어져야 한다. 선별로 떼어 낸 LOT 은 조상의 입하 줄을 따른다(P-56).
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
    const toErp =
      inboundLineId !== null &&
      (await db.inbound_receipt_line.count({
        where: {
          inbound_receipt_line_id: inboundLineId,
          purchase_order_line: { purchase_order: { erp_purchase_order_no: { not: null } } },
        },
      })) > 0;
    found.push(toErp ? inboundLineId : null);
  }
  return found;
}

export interface ErpReceiptLine {
  goodsReceiptId: bigint;
  goodsReceiptNo: string;
  receiptDatetime: Date;
  lotId: bigint;
  receiptQty: Prisma.Decimal;
}

/**
 * 입하 줄 하나에서 ERP 구매입고로 가는 입고 줄 — 전기된 자재 입고이고, 불량창고가 아니고, 특채 LOT 이 아니다.
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
      goods_receipt: { status_code: POSTED, receipt_type_code: MATERIAL_RECEIPT, warehouse: { is_defect: false } },
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
