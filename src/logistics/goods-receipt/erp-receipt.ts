import { PrismaService } from '../../prisma/prisma.service';
import { inboundLineOfLot } from './lot-receivable';

/** 자재 입고 — 입하(P/O)에서 온 자재를 받는다. ERP 구매입고는 이 유형만 간다. */
export const MATERIAL_RECEIPT = 'MATERIAL';
/** 특채가 적용된 상태(`quality.concession` · 장부 P-79). */
const APPLIED_CONCESSION = 'APPROVED';

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
