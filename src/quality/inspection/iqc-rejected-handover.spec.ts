import { Prisma } from '@prisma/client';

import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { NotificationEmitter } from '../../core/notification';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordWriteService } from '../defect/defect-record-write.service';
import { InspectionConfirmService } from './inspection-confirm.service';
import { IQC_REJECTED_NEXT_STEP, IqcRejectedHandoverNotifier } from './iqc-rejected-handover';

const LOT_ROW = {
  lot_no: 'LOT-001',
  plant_id: 2n,
  initial_qty: new Prisma.Decimal('1200'),
  uom: { uom_code: 'EA' },
  item: { item_code: 'P-100', item_name: '커넥터' },
  inbound_receipt_line: [{ inbound_receipt: { inbound_receipt_no: 'IR-1', partner: { partner_name: '공급사A' } } }],
};

function emitterStub() {
  return {
    guarded: jest.fn(async (_tx: unknown, _label: string, work: () => Promise<unknown>) => work()),
    emitHandover: jest.fn().mockResolvedValue({}),
  };
}

describe('IqcRejectedHandoverNotifier', () => {
  it('불합격 LOT 1건을 LOT 공장으로, LOT 수량과 입하·공급사를 실어 보낸다', async () => {
    const emitter = emitterStub();
    const tx = { lot: { findUniqueOrThrow: jest.fn().mockResolvedValue(LOT_ROW) } } as unknown as Prisma.TransactionClient;
    await new IqcRejectedHandoverNotifier(emitter as unknown as NotificationEmitter).rejected(tx, 3n);
    expect(emitter.emitHandover).toHaveBeenCalledWith(tx, expect.objectContaining({
      alertTypeCode: 'IQC_INSPECTION_REJECTED',
      plantId: 2n,
      aggregateTypeCode: 'LOT',
      aggregateId: 3n,
      values: {
        receipt_no: 'IR-1',
        item: 'P-100 커넥터',
        lot_no: 'LOT-001',
        supplier: '공급사A',
        qty: '1,200 EA',
        next_step: IQC_REJECTED_NEXT_STEP,
      },
    }));
  });

  it('입하가 없는 LOT 은 입하번호·공급사를 비우고 보낸다', async () => {
    const emitter = emitterStub();
    const tx = {
      lot: { findUniqueOrThrow: jest.fn().mockResolvedValue({ ...LOT_ROW, inbound_receipt_line: [] }) },
    } as unknown as Prisma.TransactionClient;
    await new IqcRejectedHandoverNotifier(emitter as unknown as NotificationEmitter).rejected(tx, 3n);
    expect(emitter.emitHandover.mock.calls[0][1].values).toMatchObject({ receipt_no: undefined, supplier: undefined, lot_no: 'LOT-001' });
  });
});

describe('IQC 확정 → 검사 불합격 인계 알림', () => {
  async function confirm(inspectionTypeCode: string, judgment: string, lotId: bigint | null) {
    const tx = {
      inspection_request: { update: jest.fn().mockResolvedValue({
        lot_id: lotId, work_order_id: null, inspection_type_code: inspectionTypeCode, inspection_plan_version: null,
      }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as unknown as Prisma.TransactionClient;
    const holds = {
      lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: lotId }]),
      releaseWithin: jest.fn().mockResolvedValue({ openAfter: 0 }),
    } as unknown as LotHoldService;
    const lots = { moveWithin: jest.fn().mockResolvedValue({ movedLotIds: [lotId] }) } as unknown as LotQualityStatusService;
    const notices = { rejected: jest.fn() };
    const service = new InspectionConfirmService({} as PrismaService, {} as DocumentStateService, lots, holds,
      {} as NumberingService, {} as DefectRecordWriteService, notices as unknown as IqcRejectedHandoverNotifier);
    await service.applyConfirmEffects(tx, {
      inspectionResultId: 8n, inspectionRequestId: 9n, judgment, rejectedQty: 2,
      changedAt: new Date('2026-11-10T01:00:00Z'), appUserId: 5,
    });
    return { tx, notices };
  }

  it('IQC 불합격 확정이면 그 LOT 으로 알린다', async () => {
    const { tx, notices } = await confirm('IQC', 'REJECTED', 3n);
    expect(notices.rejected).toHaveBeenCalledWith(tx, 3n);
  });

  it('합격·보류이거나 LOT 이 없으면 알리지 않는다', async () => {
    expect((await confirm('IQC', 'ACCEPTED', 3n)).notices.rejected).not.toHaveBeenCalled();
    expect((await confirm('IQC', 'HELD', 3n)).notices.rejected).not.toHaveBeenCalled();
    expect((await confirm('IQC', 'REJECTED', null)).notices.rejected).not.toHaveBeenCalled();
  });
});
