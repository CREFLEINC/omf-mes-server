import type { Prisma } from '@prisma/client';

import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionConfirmService } from './inspection-confirm.service';

it('uses the real terminal worker for IQC LOT transition and hold release', async () => {
  const tx = { inspection_request: { update: jest.fn().mockResolvedValue({
    lot_id: 3n, work_order_id: null, inspection_type_code: 'IQC', inspection_plan_version: null,
  }) } } as unknown as Prisma.TransactionClient;
  const holds = {
    lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: 3n }]),
    releaseWithin: jest.fn().mockResolvedValue({ openAfter: 0 }),
  } as unknown as LotHoldService;
  const lots = { moveWithin: jest.fn().mockResolvedValue({ movedLotIds: [3n] }) } as unknown as LotQualityStatusService;
  const service = new InspectionConfirmService({} as PrismaService, {} as DocumentStateService, lots, holds);
  const changedAt = new Date('2026-09-12T01:00:00Z');
  await service.applyConfirmEffects(tx, {
    inspectionResultId: 8n, inspectionRequestId: 9n,
    judgment: 'ACCEPTED', rejectedQty: 0,
    changedAt,
    terminalAudit: {
      workerId: 23n, workerNo: 'W-23', terminalId: 7n, plantId: 2n,
      correlationId: 'quality-1', operationKey: 'POST /quality/inspection-results',
    },
  });
  expect(tx.inspection_request.update).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ updated_by: null }),
  }));
  expect(holds.releaseWithin).toHaveBeenCalledWith(tx, expect.any(Array),
    { lotId: 3n, reasonCode: 'INCOMING_INSPECTION_WAIT' },
    expect.any(Object), { workerId: 23n, at: changedAt });
  expect(lots.moveWithin).toHaveBeenCalledWith(tx, [3n], 'inspection-accepted',
    expect.objectContaining({ changedWorkerId: 23n }));
});
