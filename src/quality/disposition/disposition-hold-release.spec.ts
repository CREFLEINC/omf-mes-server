import type { Prisma } from '@prisma/client';

import { LotHoldService } from '../../core/lot';
import { releaseInspectionHoldsWithin } from './disposition-hold-release';

/** 장부 P-63 — 처분으로 정상이 된 LOT 의 수입검사 대기 보류를 닫는다. */
describe('releaseInspectionHoldsWithin', () => {
  const tx = {} as Prisma.TransactionClient;

  it('LOT 마다 수입검사 대기 보류를 처분 정상 사유로 닫는다', async () => {
    const holds = {
      lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: 1n }, { lot_id: 2n }]),
      releaseWithin: jest.fn().mockResolvedValue({ released: [], openAfter: 0 }),
    } as unknown as LotHoldService;
    const at = new Date('2026-10-16T02:00:00Z');

    await releaseInspectionHoldsWithin(tx, holds, [1n, 2n], { by: 9n, at });

    expect(holds.lockLotsWithin).toHaveBeenCalledWith(tx, [1n, 2n]);
    expect(holds.releaseWithin).toHaveBeenNthCalledWith(
      2,
      tx,
      expect.any(Array),
      { lotId: 2n, reasonCode: 'INCOMING_INSPECTION_WAIT' },
      { releaseReasonCode: 'DISPOSITION_NORMAL' },
      { by: 9n, at },
    );
  });

  it('옮긴 LOT 이 없으면 잠그지도 않는다', async () => {
    const holds = { lockLotsWithin: jest.fn(), releaseWithin: jest.fn() } as unknown as LotHoldService;

    await releaseInspectionHoldsWithin(tx, holds, [], { by: 9n, at: new Date() });

    expect(holds.lockLotsWithin).not.toHaveBeenCalled();
  });
});
