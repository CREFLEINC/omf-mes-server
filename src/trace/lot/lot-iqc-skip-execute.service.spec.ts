import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { LotIqcSkipExecuteService } from './lot-iqc-skip-execute.service';

type LotRow = { source_type_code: string; status_code: string };

/** omf-all-around#105 — 승인된 IQC 생략의 실행. 경로의 LOT 은 그 입하 LOT(입하 LOT 30 · 자재 관리 LOT 20·21)을 가리킨다(FR-032). */
function harness(
  options: { lot?: LotRow | null; approved?: boolean; voided?: boolean; openAfter?: number; openRequests?: number } = {},
) {
  const lot =
    options.lot === undefined ? { source_type_code: 'INBOUND_RECEIPT_LINE', status_code: 'INSPECTION_PENDING' } : options.lot;
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const lots = lot === null ? [] : [{ lot_id: 20n, ...lot }, { lot_id: 21n, ...lot }];
  const tx = {
    lot: { findUnique: jest.fn().mockResolvedValue(lot === null ? null : { inbound_lot_id: 30n, ...lot }) },
    $queryRaw: jest.fn().mockResolvedValueOnce(lots).mockResolvedValueOnce([{ inbound_lot_no: 'IL-1', status_code: 'RECEIVED' }]),
    approval_request: {
      findMany: jest.fn().mockResolvedValue(options.approved === false
        ? [] : [{ approval_request_id: 3n, target_summary: options.voided === true ? { voidedAt: '2026-11-12T00:00:00Z' } : null }]),
    },
    inspection_request: {
      updateMany,
      findMany: jest.fn().mockResolvedValue(Array.from({ length: options.openRequests ?? 1 }, (_, i) => ({ inspection_request_id: BigInt(40 + i), status_code: 'REQUESTED' }))),
    },
    inspection_request_event: { create: jest.fn() },
  } as unknown as Prisma.TransactionClient;
  const prisma = { $transaction: (work: (t: typeof tx) => Promise<unknown>) => work(tx) } as unknown as PrismaService;
  const holds = {
    lockLotsWithin: jest.fn().mockResolvedValue([{ lot_id: 20n }, { lot_id: 21n }]),
    releaseWithin: jest.fn().mockResolvedValue({ openAfter: options.openAfter ?? 0 }),
  } as unknown as LotHoldService;
  const qualities = { moveWithin: jest.fn().mockResolvedValue({ movedLotIds: [20n, 21n] }) } as unknown as LotQualityStatusService;
  return { service: new LotIqcSkipExecuteService(prisma, holds, qualities), updateMany, holds, qualities, tx };
}

describe('LotIqcSkipExecuteService (omf-all-around#105)', () => {
  it('FR-032 입하 LOT 의 IQC 요청을 SKIPPED 로 닫고 자재 관리 LOT 전부의 수입검사 보류를 생략 사유로 풀고 C22 로 정상화한다', async () => {
    const { service, updateMany, holds, qualities, tx } = harness();
    await service.execute(20, 9);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ inbound_lot_id: 30n }, { lot_id: { in: [20n, 21n] } }],
          inspection_type_code: 'IQC',
          status_code: { in: ['REQUESTED', 'IN_PROGRESS'] },
        }),
        data: expect.objectContaining({ status_code: 'SKIPPED' }),
      }),
    );
    expect(tx.approval_request.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ approval_type_code: 'IQC_SKIP', target_type_code: 'INBOUND_LOT', target_id: 30n, status_code: 'APPROVED' }),
    }));
    for (const lotId of [20n, 21n]) {
      expect(holds.releaseWithin).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Array),
        { lotId, reasonCode: 'INCOMING_INSPECTION_WAIT' },
        { releaseReasonCode: 'INCOMING_INSPECTION_SKIPPED' },
        expect.objectContaining({ by: 9n }),
      );
    }
    expect(qualities.moveWithin).toHaveBeenCalledWith(
      expect.anything(),
      [20n, 21n],
      'iqc-skipped',
      expect.objectContaining({ changedBy: 9n }),
    );
    expect(tx.inspection_request_event.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ inspection_request_id: 40n, event_type_code: 'SKIPPED' }),
    }));
  });

  it('FR-032 마감 취소가 무효로 만든 승인(voidedAt)은 다시 쓰지 않는다 — 400', async () => {
    const { service, updateMany } = harness({ voided: true });
    const error = await service.execute(20, 9).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContractException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  /* #105 리뷰 — 200 인데 LOT 이 검사 대기 그대로면 실행된 줄 안다. 400 으로 내고 트랜잭션을 되돌린다. */
  it('⛔ 다른 열린 보류가 남으면 400 으로 막고 LOT 을 정상으로 올리지 않는다', async () => {
    const { service, qualities } = harness({ openAfter: 1 });
    const error = await service.execute(20, 9).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContractException);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('다른 보류가 남아 있어');
    expect(qualities.moveWithin).not.toHaveBeenCalled();
  });

  /* #105 리뷰 — 보류(HELD)로 확정돼 끝난 의뢰·이미 생략된 의뢰에 승인을 쓰면 판정을 건너뛰고 정상이 됐다(승인 재사용 포함). */
  it('⛔ IQC 의뢰가 열려 있지 않으면(완료·생략) 400 이고 아무것도 옮기지 않는다', async () => {
    const { service, updateMany, holds, qualities } = harness({ openRequests: 0 });
    const error = await service.execute(20, 9).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContractException);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('생략을 실행할 수 없습니다');
    expect(updateMany).not.toHaveBeenCalled();
    expect(holds.releaseWithin).not.toHaveBeenCalled();
    expect(qualities.moveWithin).not.toHaveBeenCalled();
  });

  it('실행 거절 문구는 「실행」으로 말한다', async () => {
    const { service } = harness({ lot: { source_type_code: 'INBOUND_RECEIPT_LINE', status_code: 'NORMAL' } });
    const error = await service.execute(20, 9).catch((e: unknown) => e);

    expect(JSON.stringify((error as ContractException).getResponse())).toContain('생략을 실행할 수 있습니다');
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
