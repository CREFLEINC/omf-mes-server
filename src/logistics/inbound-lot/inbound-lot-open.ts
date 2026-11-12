import { Prisma } from '@prisma/client';

import { INBOUND_LOT_RECEIVING, type InboundLotActor } from '../../core/lot';
import { DOCUMENT_STATUS } from '../inbound-receipt/inbound-receipt-rules';

/** 열린(`RECEIVING`) 입하 LOT 한 건 — 받기가 붙는 자리. */
export interface OpenInboundLot {
  inboundLotId: bigint;
  inboundLotNo: string;
  inboundReceiptLineId: bigint;
  openSinceDate: string;
}

export interface InboundLotKey {
  plantId: bigint;
  supplierId: bigint;
  itemId: bigint;
}

export interface NewInboundLotInput {
  key: InboundLotKey;
  inboundReceiptNo: string;
  inboundLotNo: string;
  uomId: bigint;
  inspectionNeeded: boolean;
  receivedQty: Prisma.Decimal;
  receiptDatetime: string;
  deliveryNoteNo: string | null;
  /** 받기 업무 시각의 공장 현지 날짜 — `receiving_date`·`open_since_date`(R-20). */
  localDay: string;
  actor: InboundLotActor;
}

/** 새 흐름 입하 LOT 의 ERP 전송 방식 — 최종 마감 때 한 번(#265). */
const ON_FINALIZE = 'ON_FINALIZE';

/** (공장, 공급사, 품목)의 열린 입하 LOT 을 잠근다. 없으면 null. */
export async function lockOpenInboundLot(tx: Prisma.TransactionClient, key: InboundLotKey): Promise<OpenInboundLot | null> {
  const rows = await tx.$queryRaw<{ inbound_lot_id: bigint; inbound_lot_no: string; inbound_receipt_line_id: bigint; open_since_date: Date }[]>`
    SELECT inbound_lot_id, inbound_lot_no, inbound_receipt_line_id, open_since_date
      FROM trace.inbound_lot
     WHERE plant_id = ${key.plantId} AND supplier_id = ${key.supplierId} AND item_id = ${key.itemId}
       AND status_code = ${INBOUND_LOT_RECEIVING}
       FOR UPDATE`;
  const row = rows[0];
  return row === undefined ? null : {
    inboundLotId: row.inbound_lot_id, inboundLotNo: row.inbound_lot_no,
    inboundReceiptLineId: row.inbound_receipt_line_id, openSinceDate: row.open_since_date.toISOString().slice(0, 10),
  };
}

/**
 * 입하 헤더(품목마다 하나 — P-117)·줄(`lot_id` 비움)·입하 LOT 을 세운다. 입하 LOT 은 `INSERT … ON CONFLICT DO NOTHING` 이다 —
 * 다른 받기가 먼저 같은 조합을 열었으면(`uq_inbound_lot_open`) 방금 세운 헤더·줄을 지우고 null 을 돌려준다. 호출자가 다시 잠가 붙는다(R-20).
 */
export async function createInboundLotWithin(tx: Prisma.TransactionClient, input: NewInboundLotInput): Promise<OpenInboundLot | null> {
  const by = input.actor.appUserId === undefined ? null : BigInt(input.actor.appUserId);
  const header = await tx.inbound_receipt.create({
    data: {
      inbound_receipt_no: input.inboundReceiptNo, supplier_id: input.key.supplierId, plant_id: input.key.plantId,
      receipt_datetime: new Date(input.receiptDatetime), delivery_note_no: input.deliveryNoteNo,
      status_code: DOCUMENT_STATUS, received_by: by, created_by: by,
    },
    select: { inbound_receipt_id: true },
  });
  const line = await tx.inbound_receipt_line.create({
    data: {
      inbound_receipt_id: header.inbound_receipt_id, line_no: 1, item_id: input.key.itemId,
      received_qty: input.receivedQty, uom_id: input.uomId,
      // 자재 관리 LOT 마다 라벨·공급사 LOT 이 따로 있어 줄의 칸은 쓰지 않는다.
      supplier_lot_missing: false, supplier_lot_label_attached: false,
      inspection_required: input.inspectionNeeded, status_code: DOCUMENT_STATUS, created_by: by,
    },
    select: { inbound_receipt_line_id: true },
  });
  const inserted = await tx.$queryRaw<{ inbound_lot_id: bigint }[]>`
    INSERT INTO trace.inbound_lot (inbound_lot_no, plant_id, item_id, supplier_id, uom_id, status_code,
                                   receiving_date, open_since_date, erp_send_mode_code, inbound_receipt_line_id, created_by)
    VALUES (${input.inboundLotNo}, ${input.key.plantId}, ${input.key.itemId}, ${input.key.supplierId}, ${input.uomId},
            ${INBOUND_LOT_RECEIVING}, ${input.localDay}::date, ${input.localDay}::date, ${ON_FINALIZE},
            ${line.inbound_receipt_line_id}, ${by})
    ON CONFLICT (plant_id, supplier_id, item_id) WHERE status_code = 'RECEIVING' DO NOTHING
    RETURNING inbound_lot_id`;
  if (inserted.length > 0) {
    return { inboundLotId: inserted[0].inbound_lot_id, inboundLotNo: input.inboundLotNo,
      inboundReceiptLineId: line.inbound_receipt_line_id, openSinceDate: input.localDay };
  }
  await tx.inbound_receipt_line.delete({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id } });
  await tx.inbound_receipt.delete({ where: { inbound_receipt_id: header.inbound_receipt_id } });
  return null;
}
