import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { reopenStatesOf } from './inbound-lot-reopenable';
import { InboundLotReopenService } from './inbound-lot-reopen.service';

jest.mock('./inbound-lot-reopenable', () => ({ reopenStatesOf: jest.fn() }));

/** 판정(같은 조합 입하 중 없음) 뒤 같은 조합의 첫 받기가 먼저 입하 LOT 을 연 경우 — 실제로 겹치게 만들기 어려워 유일 위반을 목으로 던진다. */
describe('InboundLotReopenService — 동시 받기와 겹친 마감 취소', () => {
  const uniqueViolation = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002', clientVersion: 'test', meta: { target: ['plant_id', 'supplier_id', 'item_id'] },
  });

  function service(updateError: unknown): { reopener: InboundLotReopenService; tx: Prisma.TransactionClient } {
    jest.mocked(reopenStatesOf).mockResolvedValue(new Map([[7n, { blockers: [], reasonCode: 'NO_IQC_RESULT', openInboundLotNo: null }]]));
    const tx = {
      lot: { findMany: jest.fn().mockResolvedValue([{ lot_id: 11n }]) },
      $queryRaw: jest.fn().mockResolvedValue([{ status_code: 'RECEIVED', version_no: 3, inbound_receipt_line_id: 21n, plant_id: 31n }]),
      inbound_receipt_po_allocation: { findMany: jest.fn().mockResolvedValue([]) },
      plant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ timezone_code: 'Asia/Ho_Chi_Minh' }) },
      inbound_lot: { update: jest.fn().mockRejectedValue(updateError) },
    } as unknown as Prisma.TransactionClient;
    const holds = { lockLotsWithin: jest.fn().mockResolvedValue([]) } as unknown as LotHoldService;
    const reopener = new InboundLotReopenService({} as LotQualityStatusService, holds, {} as DocumentStateService);
    return { reopener, tx };
  }

  it('G1-5 RECEIVING 으로 바꿀 때 uq_inbound_lot_open 위반(P2002)이면 500 이 아니라 409 OPEN_RECEIPT_EXISTS(번호 null)', async () => {
    const { reopener, tx } = service(uniqueViolation);

    const error = await reopener.reopen(tx, 7, { versionNo: 3 }, { appUserId: 1 }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(409);
    expect((error as ContractException).errors).toEqual([expect.objectContaining({ scope: 'screen', code: 'OPEN_RECEIPT_EXISTS' })]);
    expect((error as ContractException).getResponse()).toMatchObject({ openInboundLotNo: null });
  });

  it('G1-5 다른 오류는 그대로 던진다', async () => {
    const other = new Error('connection lost');
    const { reopener, tx } = service(other);

    await expect(reopener.reopen(tx, 7, { versionNo: 3 }, { appUserId: 1 })).rejects.toBe(other);
  });
});
