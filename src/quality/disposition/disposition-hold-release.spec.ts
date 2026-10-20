import type { Prisma } from '@prisma/client';

import { LotHoldService } from '../../core/lot';
import { releaseInspectionHoldsWithin } from './disposition-hold-release';

/** 장부 P-63 — 처분으로 정상이 된 LOT 의 수입검사 대기 보류를 닫는다. */
describe('releaseInspectionHoldsWithin', () => {
  const tx = (defectStockLots: bigint[] = []) => ({
    inventory_balance: { findMany: jest.fn().mockResolvedValue(defectStockLots.map((lot_id) => ({ lot_id }))) },
  }) as unknown as Prisma.TransactionClient;

  it('LOT 마다 수입검사 대기 보류를 처분 정상 사유로 닫는다', async () => {
    const holds = {
      lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: 1n }, { lot_id: 2n }]),
      releaseWithin: jest.fn().mockResolvedValue({ released: [], openAfter: 0 }),
    } as unknown as LotHoldService;
    const at = new Date('2026-10-16T02:00:00Z');

    const client = tx();
    await releaseInspectionHoldsWithin(client, holds, [1n, 2n], { by: 9n, at });

    expect(holds.lockLotsWithin).toHaveBeenCalledWith(client, [1n, 2n]);
    expect(holds.releaseWithin).toHaveBeenNthCalledWith(
      2,
      client,
      expect.any(Array),
      { lotId: 2n, reasonCode: 'INCOMING_INSPECTION_WAIT' },
      { releaseReasonCode: 'DISPOSITION_NORMAL' },
      { by: 9n, at },
    );
  });

  it('옮긴 LOT 이 없으면 잠그지도 않는다', async () => {
    const holds = { lockLotsWithin: jest.fn(), releaseWithin: jest.fn() } as unknown as LotHoldService;

    await releaseInspectionHoldsWithin(tx(), holds, [], { by: 9n, at: new Date() });

    expect(holds.lockLotsWithin).not.toHaveBeenCalled();
  });

  /* #108 리뷰 M1 — 불량창고 재고가 있는 LOT 은 재고 재등록(W-04-11)이 보류를 닫는다. */
  it('불량창고에 재고가 있는 LOT 은 건너뛰고 나머지만 닫는다', async () => {
    const holds = {
      lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: 2n }]),
      releaseWithin: jest.fn().mockResolvedValue({ released: [], openAfter: 0 }),
    } as unknown as LotHoldService;
    const client = tx([1n]);

    await releaseInspectionHoldsWithin(client, holds, [1n, 2n], { by: 9n, at: new Date() });

    expect(holds.lockLotsWithin).toHaveBeenCalledWith(client, [2n]);
    expect(holds.releaseWithin).toHaveBeenCalledTimes(1);
    expect((holds.releaseWithin as jest.Mock).mock.calls[0][2]).toEqual({ lotId: 2n, reasonCode: 'INCOMING_INSPECTION_WAIT' });
  });

  it('모두 불량창고 재고면 잠그지도 않는다', async () => {
    const holds = { lockLotsWithin: jest.fn(), releaseWithin: jest.fn() } as unknown as LotHoldService;

    await releaseInspectionHoldsWithin(tx([1n]), holds, [1n], { by: 9n, at: new Date() });

    expect(holds.lockLotsWithin).not.toHaveBeenCalled();
  });

  /* #84 · 장부 P-79 — 담당자 결정 2026-10-20 「현행 유지」: 특채 적용은 불량창고 재고가 남아 있어도 보류를 닫는다. */
  it('특채 적용(CONCESSION_APPROVED)은 불량창고 재고가 있어도 건너뛰지 않는다', async () => {
    const holds = {
      lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: 1n }]),
      releaseWithin: jest.fn().mockResolvedValue({ released: [], openAfter: 0 }),
    } as unknown as LotHoldService;
    const client = tx([1n]);

    await releaseInspectionHoldsWithin(client, holds, [1n], { by: 9n, at: new Date() }, 'CONCESSION_APPROVED');

    expect(holds.lockLotsWithin).toHaveBeenCalledWith(client, [1n]);
    expect((holds.releaseWithin as jest.Mock).mock.calls[0][3]).toEqual({ releaseReasonCode: 'CONCESSION_APPROVED' });
  });
});
