import { NotFoundException } from '@nestjs/common';

import { ContractException } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderPqcSkipService } from './work-order-pqc-skip.service';

/** omf-all-around#212 — PQC 건별 생략 요청·실행(장부 P-152). OQC 생략(`shipment-oqc-skip.service.ts`)의 거울이다. */
function harness(options: { exists?: boolean; open?: number; approval?: boolean; heldLotIds?: bigint[] } = {}) {
  const count = jest.fn().mockResolvedValue(options.open ?? 1);
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const lotFindMany = jest.fn().mockResolvedValue([{ lot_id: 701n }, { lot_id: 702n }]);
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(options.exists === false ? [] : [{ work_order_id: 11n }]),
    inspection_request: { count, updateMany },
    approval_request: {
      findFirst: jest.fn().mockResolvedValue(options.approval === false ? null : { approval_request_id: 81n }),
    },
    lot: { findMany: lotFindMany },
    lot_hold: {
      findMany: jest.fn().mockResolvedValue((options.heldLotIds ?? []).map((lot_id) => ({ lot_id }))),
    },
  };
  const prisma = {
    ...tx,
    work_order: {
      findUnique: jest.fn().mockResolvedValue(options.exists === false ? null : { work_order_id: 11n }),
    },
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const numbering = { next: jest.fn().mockResolvedValue('AP-20261029-0001') } as unknown as NumberingService;
  const approvals = { request: jest.fn().mockResolvedValue({ approvalRequestId: 81n }) } as unknown as ApprovalService;
  const holds = { lockLotsWithin: jest.fn().mockResolvedValue(undefined) } as unknown as LotHoldService;
  const qualities = { moveWithin: jest.fn().mockResolvedValue({ movedLotIds: [] }) } as unknown as LotQualityStatusService;
  const service = new WorkOrderPqcSkipService(prisma, numbering, approvals, holds, qualities);
  return { service, numbering, approvals, qualities, count, updateMany, lotFindMany };
}

const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
  const error = await run().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContractException);
  return JSON.stringify((error as ContractException).getResponse());
};

describe('PQC 생략 요청', () => {
  it('열린 PQC 의뢰가 있으면 PQC_SKIP 결재를 작업지시 대상으로 상신한다', async () => {
    const { service, approvals } = harness();
    await expect(service.requestSkip(11, '긴급 생산', 5)).resolves.toEqual({ approvalRequestId: 81 });

    expect(approvals.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        approvalTypeCode: 'PQC_SKIP',
        targetTypeCode: 'WORK_ORDER',
        targetId: 11n,
        requestedBy: 5n,
        reason: '긴급 생산',
      }),
    );
  });

  it('생략할 수 있는 의뢰는 그 W/O 의 «확정 결과가 없는» 열린 PQC 의뢰다', async () => {
    const { service, count } = harness();
    await service.requestSkip(11, '사유', 5);

    expect(count).toHaveBeenCalledWith({
      where: {
        inspection_type_code: 'PQC',
        work_order_id: 11n,
        status_code: { in: ['REQUESTED', 'IN_PROGRESS'] },
        inspection_result: { none: { status_code: 'CONFIRMED' } },
      },
    });
  });

  it('⛔ 열린 의뢰가 없으면(기본 생략·확정) 400 — 번호를 받기 전에 막는다', async () => {
    const { service, numbering } = harness({ open: 0 });
    expect(await messageOf(() => service.requestSkip(11, '사유', 5))).toContain('생략을 요청할 수 없습니다');
    expect(numbering.next).not.toHaveBeenCalled();
  });

  it('⛔ 없는 작업지시는 404', async () => {
    const { service } = harness({ exists: false });
    await expect(service.requestSkip(99, '사유', 5)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('승인된 PQC 생략 실행', () => {
  it('열린 의뢰를 SKIPPED(근거 APPROVAL)로 닫고 검사 대기 생산LOT 을 C28 로 올린다(원천 = 승인 요청)', async () => {
    const { service, updateMany, qualities } = harness();
    await service.execute(11, 5);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status_code: 'SKIPPED', skip_basis_code: 'APPROVAL', updated_by: 5n }),
      }),
    );
    expect(qualities.moveWithin).toHaveBeenCalledWith(
      expect.anything(),
      [701n, 702n],
      'pqc-skip-approved',
      expect.objectContaining({ changedBy: 5n, sourceDocumentTypeCode: 'APPROVAL_REQUEST', sourceDocumentId: 81n }),
    );
  });

  it('⛔ 실적이 없는 슬롯(WAITING)과 취소로 폐번된 LOT(VOIDED)은 모집단에서 뺀다(#213)', async () => {
    const { service, lotFindMany } = harness();
    await service.execute(11, 5);

    expect(lotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status_code: 'INSPECTION_PENDING', lifecycle_status_code: { notIn: ['WAITING', 'VOIDED'] } }),
      }),
    );
  });

  it('다른 열린 보류가 있는 LOT 은 올리지 않는다', async () => {
    const { service, qualities } = harness({ heldLotIds: [702n] });
    await service.execute(11, 5);

    expect(qualities.moveWithin).toHaveBeenCalledWith(expect.anything(), [701n], 'pqc-skip-approved', expect.anything());
  });

  it('⛔ 승인된 요청이 없으면 400', async () => {
    const { service, updateMany } = harness({ approval: false });
    expect(await messageOf(() => service.execute(11, 5))).toContain('승인된 PQC 생략 요청이 없습니다.');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('⛔ 생략할 열린 의뢰가 없으면 400 — 같은 승인을 두 번 쓰지 못한다', async () => {
    const { service } = harness({ open: 0 });
    expect(await messageOf(() => service.execute(11, 5))).toContain('생략을 실행할 수 없습니다');
  });
});
