import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationEmitter, formatQty } from '../../core/notification';

type Tx = Prisma.TransactionClient;

const RECEIPT_SELECT = {
  inbound_receipt: { select: { inbound_receipt_no: true, partner: { select: { partner_name: true } } } },
} satisfies Prisma.inbound_receipt_lineSelect;

/** 알림 끝에 붙이는 다음 할 일 — 불합격 LOT 실물은 관리웹 입하 처리로 불량 창고에 넣는다. */
export const IQC_REJECTED_NEXT_STEP = '불량 창고로 입하 처리';

/**
 * 인계 작업 「검사 불합격(IQC)」 — 불합격 확정된 LOT 1건에 한 번. 공장 = LOT 공장.
 * 수량은 검사 불합격 수(샘플)가 아니라 LOT 수량이다 — 옮길 실물이 LOT 전체다.
 * LOT 단건 등록처럼 입하가 없으면 입하번호·공급사는 비운다.
 */
@Injectable()
export class IqcRejectedHandoverNotifier {
  constructor(private readonly emitter: NotificationEmitter) {}

  async rejected(tx: Tx, lotId: bigint): Promise<void> {
    await this.emit(tx, lotId);
  }

  /**
   * 입하 LOT 검사 불합격(피처 005 R-12) — 입하 LOT 당 한 번. 대상은 첫 자재 관리 LOT, LOT 번호는 「첫 번호 외 n」, 수량은 LOT 합이다.
   * 확정 취소 뒤 다시 불합격으로 확정해도 같은 대상이라 다시 알리지 않는다(이미 보낸 알림은 그대로 · R-13).
   */
  async rejectedInboundLot(tx: Tx, lots: readonly { lot_id: bigint; lot_no: string; initial_qty: Prisma.Decimal }[]): Promise<void> {
    if (lots.length === 0) return;
    const total = lots.reduce((sum, lot) => sum.plus(lot.initial_qty), new Prisma.Decimal(0));
    await this.emit(tx, lots[0].lot_id, {
      lotNo: lots.length === 1 ? lots[0].lot_no : `${lots[0].lot_no} 외 ${String(lots.length - 1)}`,
      qty: total,
      // 확정 취소 뒤 다시 불합격 확정하면 같은 대상이라도 다시 알린다(G1 의 입하 마감 알림과 같은 규칙).
      repeatable: true,
    });
  }

  private async emit(tx: Tx, lotId: bigint, inbound?: { lotNo: string; qty: Prisma.Decimal; repeatable: boolean }): Promise<void> {
    await this.emitter.guarded(tx, `IQC_INSPECTION_REJECTED LOT ${lotId}`, async () => {
      const lot = await tx.lot.findUniqueOrThrow({
        where: { lot_id: lotId },
        select: {
          lot_no: true,
          plant_id: true,
          initial_qty: true,
          uom: { select: { uom_code: true } },
          item: { select: { item_code: true, item_name: true } },
          inbound_receipt_line: {
            take: 1,
            orderBy: { inbound_receipt_line_id: 'asc' },
            select: RECEIPT_SELECT,
          },
          // 새 흐름 자재 관리 LOT 은 입하 줄의 `lot_id` 에 실리지 않는다 — 입하 LOT 으로 찾는다(피처 005).
          inbound_lot: { select: { inbound_receipt_line: { select: RECEIPT_SELECT } } },
        },
      });
      const receipt =
        lot.inbound_receipt_line[0]?.inbound_receipt ?? lot.inbound_lot?.inbound_receipt_line.inbound_receipt;
      await this.emitter.emitHandover(tx, {
        alertTypeCode: 'IQC_INSPECTION_REJECTED',
        plantId: lot.plant_id,
        aggregateTypeCode: 'LOT',
        aggregateId: lotId,
        occurredAt: new Date(),
        ...(inbound?.repeatable === true ? { repeatable: true } : {}),
        values: {
          receipt_no: receipt?.inbound_receipt_no,
          item: `${lot.item.item_code} ${lot.item.item_name}`,
          lot_no: inbound?.lotNo ?? lot.lot_no,
          supplier: receipt?.partner.partner_name,
          qty: formatQty(inbound?.qty ?? lot.initial_qty, lot.uom.uom_code),
          next_step: IQC_REJECTED_NEXT_STEP,
        },
      });
    }, undefined);
  }
}
