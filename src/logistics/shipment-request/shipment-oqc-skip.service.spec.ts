import { NotFoundException } from '@nestjs/common';

import { ContractException } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentOqcSkipService } from './shipment-oqc-skip.service';

/** omf-all-around#119 — OQC 생략 요청·실행(장부 P-83). IQC 생략(`lot-iqc-skip*`)의 거울이다. */
function harness(options: { exists?: boolean; open?: number; approval?: boolean; picked?: boolean } = {}) {
  const count = jest.fn().mockResolvedValue(options.open ?? 2);
  const updateMany = jest.fn().mockResolvedValue({ count: 2 });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(options.exists === false ? [] : [{ shipment_request_id: 21n }]),
    inspection_request: { count, updateMany },
    approval_request: {
      findFirst: jest.fn().mockResolvedValue(options.approval === false ? null : { approval_request_id: 61n }),
    },
    shipment_request_line: {
      findMany: jest.fn().mockResolvedValue([{ shipment_request_line_id: 31n, line_no: 1, allocated_qty: 10 }]),
    },
    inventory_reservation: {
      findMany: jest.fn().mockResolvedValue([
        { source_document_id: 31n, lot_id: 501n, reserved_qty: options.picked === false ? 4 : 10, released_qty: 0 },
      ]),
    },
  };
  const prisma = {
    ...tx,
    shipment_request: {
      findUnique: jest.fn().mockResolvedValue(options.exists === false ? null : { shipment_request_id: 21n }),
    },
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const numbering = { next: jest.fn().mockResolvedValue('AP-20261020-0001') } as unknown as NumberingService;
  const approvals = { request: jest.fn().mockResolvedValue({ approvalRequestId: 61n }) } as unknown as ApprovalService;
  const qualities = { moveWithin: jest.fn().mockResolvedValue({ movedLotIds: [501n] }) } as unknown as LotQualityStatusService;
  const service = new ShipmentOqcSkipService(prisma, numbering, approvals, qualities);
  return { service, numbering, approvals, qualities, count, updateMany };
}

const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
  const error = await run().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContractException);
  return JSON.stringify((error as ContractException).getResponse());
};

describe('OQC 생략 요청', () => {
  it('열린 OQC 의뢰가 있으면 OQC_SKIP 결재를 출하작업지시 대상으로 상신한다', async () => {
    const { service, approvals } = harness();
    await expect(service.requestSkip(21, '고객 승인 출하', 5)).resolves.toEqual({ approvalRequestId: 61 });

    expect(approvals.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        approvalTypeCode: 'OQC_SKIP',
        targetTypeCode: 'SHIPMENT_REQUEST',
        targetId: 21n,
        requestedBy: 5n,
        reason: '고객 승인 출하',
      }),
    );
  });

  it('생략할 수 있는 의뢰는 «확정 결과가 없는» 열린 의뢰다', async () => {
    const { service, count } = harness();
    await service.requestSkip(21, '사유', 5);

    expect(count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        inspection_type_code: 'OQC',
        target_type_code: 'SHIPMENT_REQUEST',
        target_id: 21n,
        status_code: { in: ['REQUESTED', 'IN_PROGRESS'] },
        inspection_result: { none: { status_code: 'CONFIRMED' } },
      }),
    });
  });

  it('⛔ 열린 의뢰가 없으면 400 — 번호를 받기 전에 막는다', async () => {
    const { service, numbering } = harness({ open: 0 });
    expect(await messageOf(() => service.requestSkip(21, '사유', 5))).toContain('생략을 요청할 수 없습니다');
    expect(numbering.next).not.toHaveBeenCalled();
  });

  it('⛔ 없는 출하작업지시는 404', async () => {
    const { service } = harness({ exists: false });
    await expect(service.requestSkip(99, '사유', 5)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('승인된 OQC 생략 실행', () => {
  it('열린 의뢰를 SKIPPED 로 닫고 집은 LOT 에 C27 이력을 남긴다(원천 = 승인 요청)', async () => {
    const { service, updateMany, qualities } = harness();
    await service.execute(21, 5);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status_code: 'SKIPPED', updated_by: 5n }) }),
    );
    expect(qualities.moveWithin).toHaveBeenCalledWith(
      expect.anything(),
      [501n],
      'oqc-skipped',
      expect.objectContaining({ changedBy: 5n, sourceDocumentTypeCode: 'APPROVAL_REQUEST', sourceDocumentId: 61n }),
    );
  });

  it('⛔ 승인된 요청이 없으면 400', async () => {
    const { service, updateMany } = harness({ approval: false });
    expect(await messageOf(() => service.execute(21, 5))).toContain('승인된 OQC 생략 요청이 없습니다.');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('⛔ 생략할 열린 의뢰가 없으면(이미 생략·확정) 400 — 같은 승인을 두 번 쓰지 못한다', async () => {
    const { service } = harness({ open: 0 });
    expect(await messageOf(() => service.execute(21, 5))).toContain('생략을 실행할 수 없습니다');
  });

  it('⛔ 검사 대상 라인의 피킹이 덜 끝났으면 400(D6-b)', async () => {
    const { service, updateMany } = harness({ picked: false });
    expect(await messageOf(() => service.execute(21, 5))).toContain('피킹을 마친 뒤 생략을 실행하세요.');
    expect(updateMany).not.toHaveBeenCalled();
  });
});
