import { ApprovalRequestService } from './approval-request.service';

describe('terminal approval request list', () => {
  const approvalCore = { currentStep: jest.fn() };
  const prisma = {
    approval_request: {
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    lot: { findMany: jest.fn() },
  };
  const service = new ApprovalRequestService(prisma as never, approvalCore as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.approval_request.count.mockResolvedValue(0);
  });

  it('limits the pending check to the verified inbound LOT and pending IQC skip', async () => {
    prisma.approval_request.findMany.mockResolvedValue([]);
    await service.listForTerminal({ targetTypeCode: 'INBOUND_LOT', targetId: 43,
      pendingOnly: true, size: 1 }, { plantId: 3n, lotId: 43n });
    expect(prisma.approval_request.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ approval_type_code: 'IQC_SKIP',
        target_type_code: 'INBOUND_LOT', target_id: { in: [43n] }, status_code: 'PENDING' }),
      take: 1,
    }));
  });

  it('excludes a worker request for a foreign-plant LOT before paging', async () => {
    prisma.approval_request.findMany.mockResolvedValueOnce([
      { target_id: 43n }, { target_id: 44n },
    ]).mockResolvedValueOnce([]);
    prisma.lot.findMany.mockResolvedValue([{ lot_id: 43n }]);
    await service.listForTerminal({ requestedByMe: true, size: 20 },
      { plantId: 3n, workerId: 9n });
    expect(prisma.lot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ plant_id: 3n,
        lot_id: { in: [43n, 44n] }, source_type_code: 'INBOUND_RECEIPT_LINE' }),
    }));
    expect(prisma.approval_request.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ requested_worker_id: 9n,
        target_id: { in: [43n] } }),
    }));
  });
});
