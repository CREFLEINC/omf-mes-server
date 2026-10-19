import type { Prisma } from '@prisma/client';

import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionConfirmService } from './inspection-confirm.service';

/** omf-all-around#105 — PQC 합격 확정이 그 W/O 의 생산된 검사대기 생산LOT 을 정상으로 올린다. */
function harness(
  judgment: string,
  options: { acceptanceNumber?: number | null; rejectedQty?: number; heldLotIds?: bigint[] } = {},
) {
  const findMany = jest.fn().mockResolvedValue([{ lot_id: 41n }, { lot_id: 42n }]);
  const openHolds = jest.fn().mockResolvedValue((options.heldLotIds ?? []).map((lot_id) => ({ lot_id })));
  const tx = {
    inspection_request: {
      update: jest.fn().mockResolvedValue({
        lot_id: null,
        work_order_id: 7n,
        inspection_type_code: 'PQC',
        inspection_plan_version: { acceptance_number: options.acceptanceNumber ?? null },
      }),
    },
    lot: { findMany },
    lot_hold: { findMany: openHolds },
  } as unknown as Prisma.TransactionClient;
  const lots = { moveWithin: jest.fn().mockResolvedValue({ movedLotIds: [] }) } as unknown as LotQualityStatusService;
  const holds = { lockLotsWithin: jest.fn().mockResolvedValue([]) } as unknown as LotHoldService;
  const service = new InspectionConfirmService({} as PrismaService, {} as DocumentStateService, lots, holds);
  const run = () =>
    service.applyConfirmEffects(tx, {
      inspectionResultId: 8n,
      inspectionRequestId: 9n,
      judgment,
      rejectedQty: options.rejectedQty ?? 0,
      changedAt: new Date('2026-10-16T01:00:00Z'),
      appUserId: 5,
    });
  return { run, findMany, lots };
}

describe('PQC 확정 — 생산LOT 정상 전환 (omf-all-around#105)', () => {
  it('합격이면 실적이 난(대기 아님) 검사대기 생산LOT 을 C4 로 옮긴다', async () => {
    const { run, findMany, lots } = harness('ACCEPTED');
    await run();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source_id: 7n,
          status_code: 'INSPECTION_PENDING',
          lifecycle_status_code: { not: 'WAITING' },
        }),
      }),
    );
    expect(lots.moveWithin).toHaveBeenCalledWith(
      expect.anything(),
      [41n, 42n],
      'inspection-accepted',
      expect.objectContaining({ changedBy: 5n, sourceDocumentTypeCode: 'INSPECTION_RESULT', sourceDocumentId: 8n }),
    );
  });

  /* #105 리뷰 — C14(불합격 수 > 합격판정개수)가 검사 대기로 돌린 LOT 을 같은 트랜잭션에서 C4 로 되돌리면 안 된다. */
  it('⛔ 합격이어도 C14 가 걸리면 정상으로 올리지 않는다 — C14 만 탄다', async () => {
    const { run, lots } = harness('ACCEPTED', { acceptanceNumber: 1, rejectedQty: 2 });
    await run();

    expect(lots.moveWithin).toHaveBeenCalledTimes(1);
    expect(lots.moveWithin).toHaveBeenCalledWith(expect.anything(), [41n, 42n], 'pqc-acceptance-exceeded', expect.anything());
  });

  it('합격판정개수 이내면 C14 없이 정상으로 올린다', async () => {
    const { run, lots } = harness('ACCEPTED', { acceptanceNumber: 2, rejectedQty: 2 });
    await run();

    expect(lots.moveWithin).toHaveBeenCalledWith(expect.anything(), [41n, 42n], 'inspection-accepted', expect.anything());
  });

  /* #105 리뷰 — IQC 확정·생략 실행처럼 다른 열린 보류가 있는 LOT 은 올리지 않는다. */
  it('⛔ 다른 열린 보류가 있는 생산LOT 은 정상으로 올리지 않는다', async () => {
    const { run, lots } = harness('ACCEPTED', { heldLotIds: [42n] });
    await run();

    expect(lots.moveWithin).toHaveBeenCalledWith(expect.anything(), [41n], 'inspection-accepted', expect.anything());
  });

  it.each(['HELD', 'REJECTED'])('%s 이면 생산LOT 을 옮기지 않는다', async (judgment) => {
    const { run, findMany } = harness(judgment);
    await run();

    expect(findMany).not.toHaveBeenCalled();
  });
});
