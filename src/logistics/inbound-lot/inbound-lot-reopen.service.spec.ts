import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService } from '../../core/lot';
import { reopenStatesOf } from './inbound-lot-reopenable';
import { InboundLotReopenService } from './inbound-lot-reopen.service';

jest.mock('./inbound-lot-reopenable', () => ({
  ...jest.requireActual<typeof import('./inbound-lot-reopenable')>('./inbound-lot-reopenable'),
  reopenStatesOf: jest.fn(),
}));

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
    const reopener = new InboundLotReopenService(holds, {} as DocumentStateService);
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

/** 없앤 건별 생략(결재)으로 닫힌 옛 의뢰 — 마감을 취소하면 LOT(정상)과 다시 선 IQC 요청이 어긋나 막는다(omf-all-around#353). */
describe('InboundLotReopenService — 옛 결재 생략 건', () => {
  function service(request: { status_code: string; skip_basis_code: string | null }): {
    reopener: InboundLotReopenService; tx: Prisma.TransactionClient; update: jest.Mock;
  } {
    jest.mocked(reopenStatesOf).mockResolvedValue(new Map([[7n, { blockers: [], reasonCode: 'INSPECTION_NOT_REQUIRED', openInboundLotNo: null }]]));
    const update = jest.fn().mockResolvedValue({});
    const tx = {
      lot: { findMany: jest.fn().mockResolvedValue([{ lot_id: 11n }]) },
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ status_code: 'RECEIVED', version_no: 3, inbound_receipt_line_id: 21n, plant_id: 31n }])
        .mockResolvedValueOnce([{ status_code: 'RECEIVED' }])
        .mockResolvedValueOnce([{ inspection_request_id: 41n, ...request }]),
      inbound_receipt_po_allocation: { findMany: jest.fn().mockResolvedValue([]) },
      plant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ timezone_code: 'Asia/Ho_Chi_Minh' }) },
      inbound_lot: { update: jest.fn().mockResolvedValue({}) },
      inspection_request: { update },
      inspection_result: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as Prisma.TransactionClient;
    const holds = { lockLotsWithin: jest.fn().mockResolvedValue([]) } as unknown as LotHoldService;
    return { reopener: new InboundLotReopenService(holds, {} as DocumentStateService), tx, update };
  }

  it.each([['APPROVAL'], [null]])('근거가 %s 인 생략 의뢰는 409 IQC_RECORDED — 의뢰를 취소하지 않는다', async (basis) => {
    const { reopener, tx, update } = service({ status_code: 'SKIPPED', skip_basis_code: basis });

    const error = await reopener.reopen(tx, 7, { versionNo: 3 }, { appUserId: 1 }).catch((thrown: unknown) => thrown);

    expect((error as ContractException).getStatus()).toBe(409);
    expect((error as ContractException).errors).toEqual([expect.objectContaining({ code: 'IQC_RECORDED' })]);
    expect(update).not.toHaveBeenCalled();
  });
});
