import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationEmitter } from '../notification';

/**
 * T10 IQC 수입검사 — 입하 1건에 한 번(LOT 수를 내용에), `POST /trace/lots` 단건 등록은 LOT 1건
 * (omf-all-around#190 · plan 확정 항목 3). 공장 = LOT 공장(입하 공장과 같다).
 * 입하 등록(물류)과 LOT 등록(추적)이 함께 부른다 — IQC 의뢰를 세우는 `createWithin` 과 같은 코어에 둔다.
 */
@Injectable()
export class IqcHandoverNotifier {
  constructor(private readonly emitter: NotificationEmitter) {}

  async notify(
    tx: Prisma.TransactionClient,
    input: {
      aggregateTypeCode: 'INBOUND_RECEIPT' | 'LOT';
      aggregateId: bigint;
      plantId: bigint;
      receiptNo: string;
      lotCount: number;
      inboundReceiptId: bigint;
    },
  ): Promise<void> {
    await this.emitter.guarded(tx, `IQC_INSPECTION_REQUESTED ${input.aggregateTypeCode} ${input.aggregateId}`, async () => {
      const receipt = await tx.inbound_receipt.findUnique({
        where: { inbound_receipt_id: input.inboundReceiptId },
        select: { partner: { select: { partner_name: true } } },
      });
      await this.emitter.emitHandover(tx, {
        alertTypeCode: 'IQC_INSPECTION_REQUESTED',
        plantId: input.plantId,
        aggregateTypeCode: input.aggregateTypeCode,
        aggregateId: input.aggregateId,
        occurredAt: new Date(),
        values: {
          receipt_no: input.receiptNo,
          lot_count: input.lotCount,
          supplier: receipt?.partner.partner_name,
        },
      });
    }, undefined);
  }
}
