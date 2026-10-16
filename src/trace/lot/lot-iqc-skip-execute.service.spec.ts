import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { LotIqcSkipExecuteService } from './lot-iqc-skip-execute.service';

type LotRow = { source_type_code: string; status_code: string };

/** omf-all-around#105 — 승인된 IQC 생략의 실행. */
function harness(options: { lot?: LotRow | null; approved?: boolean; openAfter?: number } = {}) {
  const lot =
    options.lot === undefined ? { source_type_code: 'INBOUND_RECEIPT_LINE', status_code: 'INSPECTION_PENDING' } : options.lot;
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(lot === null ? [] : [lot]),
    approval_request: {
      findFirst: jest.fn().mockResolvedValue(options.approved === false ? null : { approval_request_id: 3n }),
    },
    inspection_request: { updateMany },
  } as unknown as Prisma.TransactionClient;
  const prisma = { $transaction: (work: (t: typeof tx) => Promise<unknown>) => work(tx) } as unknown as PrismaService;
  const holds = {
    lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: 20n }]),
    releaseWithin: jest.fn().mockResolvedValue({ openAfter: options.openAfter ?? 0 }),
  } as unknown as LotHoldService;
  const qualities = { moveWithin: jest.fn().mockResolvedValue({ movedLotIds: [20n] }) } as unknown as LotQualityStatusService;
  return { service: new LotIqcSkipExecuteService(prisma, holds, qualities), updateMany, holds, qualities };
}

describe('LotIqcSkipExecuteService (omf-all-around#105)', () => {
  it('의뢰를 SKIPPED 로 닫고 수입검사 보류를 생략 사유로 풀고 LOT 을 C22 로 정상화한다', async () => {
    const { service, updateMany, holds, qualities } = harness();
    await service.execute(20, 9);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lot_id: 20n,
          inspection_type_code: 'IQC',
          status_code: { in: ['REQUESTED', 'IN_PROGRESS'] },
        }),
        data: expect.objectContaining({ status_code: 'SKIPPED' }),
      }),
    );
    expect(holds.releaseWithin).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      { lotId: 20n, reasonCode: 'INCOMING_INSPECTION_WAIT' },
      { releaseReasonCode: 'INCOMING_INSPECTION_SKIPPED' },
      expect.objectContaining({ by: 9n }),
    );
    expect(qualities.moveWithin).toHaveBeenCalledWith(
      expect.anything(),
      [20n],
      'iqc-skipped',
      expect.objectContaining({ changedBy: 9n }),
    );
  });

  it('다른 열린 보류가 남으면 LOT 을 정상으로 올리지 않는다', async () => {
    const { service, qualities } = harness({ openAfter: 1 });
    await service.execute(20, 9);

    expect(qualities.moveWithin).not.toHaveBeenCalled();
  });

  it('승인된 요청이 없으면 400 STATE_LOCKED 이고 아무것도 옮기지 않는다', async () => {
    const { service, updateMany } = harness({ approved: false });
    const error = await service.execute(20, 9).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContractException);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('STATE_LOCKED');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('이미 정상인 LOT(두 번째 실행)은 400 이다', async () => {
    const { service } = harness({ lot: { source_type_code: 'INBOUND_RECEIPT_LINE', status_code: 'NORMAL' } });
    await expect(service.execute(20, 9)).rejects.toBeInstanceOf(ContractException);
  });

  it('없는 LOT 은 404 다', async () => {
    const { service } = harness({ lot: null });
    await expect(service.execute(20, 9)).rejects.toMatchObject({ status: 404 });
  });
});
