import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationEmitter, formatQty } from '../../core/notification';

type Tx = Prisma.TransactionClient;

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
            select: { inbound_receipt: { select: { inbound_receipt_no: true, partner: { select: { partner_name: true } } } } },
          },
        },
      });
      const receipt = lot.inbound_receipt_line[0]?.inbound_receipt;
      await this.emitter.emitHandover(tx, {
        alertTypeCode: 'IQC_INSPECTION_REJECTED',
        plantId: lot.plant_id,
        aggregateTypeCode: 'LOT',
        aggregateId: lotId,
        occurredAt: new Date(),
        values: {
          receipt_no: receipt?.inbound_receipt_no,
          item: `${lot.item.item_code} ${lot.item.item_name}`,
          lot_no: lot.lot_no,
          supplier: receipt?.partner.partner_name,
          qty: formatQty(lot.initial_qty, lot.uom.uom_code),
          next_step: IQC_REJECTED_NEXT_STEP,
        },
      });
    }, undefined);
  }
}
