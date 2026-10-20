import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordWriteService } from '../defect/defect-record-write.service';
import { InspectionConfirmService } from './inspection-confirm.service';

/** omf-all-around#119 D6 — 출하작업지시 OQC 확정이 그 품목 검사 대상 라인이 집은 LOT 에 판정을 남긴다(장부 P-83). */
function harness(
  judgment: string,
  options: { allocated?: number; reservations?: { lot_id: bigint | null; reserved_qty: number; released_qty: number }[]; lotId?: bigint | null } = {},
) {
  const lineFind = jest.fn().mockResolvedValue([{ shipment_request_line_id: 31n, line_no: 1, allocated_qty: options.allocated ?? 10 }]);
  const reservationFind = jest.fn().mockResolvedValue(
    (options.reservations ?? [
      { lot_id: 501n, reserved_qty: 6, released_qty: 0 },
      { lot_id: 502n, reserved_qty: 4, released_qty: 0 },
    ]).map((row) => ({ source_document_id: 31n, ...row })),
  );
  const tx = {
    inspection_request: {
      update: jest.fn().mockResolvedValue({
        lot_id: options.lotId ?? null,
        item_id: 77n,
        work_order_id: null,
        inspection_type_code: 'OQC',
        target_type_code: 'SHIPMENT_REQUEST',
        target_id: 21n,
        inspection_plan_version: { acceptance_number: null },
      }),
    },
    shipment_request_line: { findMany: lineFind },
    inventory_reservation: { findMany: reservationFind },
  } as unknown as Prisma.TransactionClient;
  const lots = { moveWithin: jest.fn().mockResolvedValue({ movedLotIds: [] }) } as unknown as LotQualityStatusService;
  const holds = { lockLotsWithin: jest.fn().mockResolvedValue([]) } as unknown as LotHoldService;
  const service = new InspectionConfirmService({} as PrismaService, {} as DocumentStateService, lots, holds, {} as NumberingService, {} as DefectRecordWriteService);
  const run = () =>
    service.applyConfirmEffects(tx, {
      inspectionResultId: 8n,
      inspectionRequestId: 9n,
      judgment,
      rejectedQty: 0,
      changedAt: new Date('2026-10-20T01:00:00Z'),
      appUserId: 5,
    });
  return { run, lots, lineFind };
}

describe('OQC 확정 — 피킹 LOT 이력 (omf-all-around#119 D6)', () => {
  it('합격이면 그 품목 검사 대상 라인이 집은 LOT 에 C4(정상 → 정상)를 남긴다', async () => {
    const { run, lots, lineFind } = harness('ACCEPTED');
    await run();

    expect(lineFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shipment_request_id: 21n, shipping_inspection_required: true, item_id: 77n } }),
    );
    expect(lots.moveWithin).toHaveBeenCalledWith(
      expect.anything(),
      [501n, 502n],
      'inspection-accepted',
      expect.objectContaining({ changedBy: 5n, sourceDocumentTypeCode: 'INSPECTION_RESULT', sourceDocumentId: 8n }),
    );
  });

  it('불합격이면 집은 LOT 을 불량(C6)으로 옮긴다 — 다음 출하·피킹이 막힌다(D6-c)', async () => {
    const { run, lots } = harness('REJECTED');
    await run();

    expect(lots.moveWithin).toHaveBeenCalledWith(expect.anything(), [501n, 502n], 'inspection-rejected', expect.anything());
  });

  it('보류는 LOT 을 옮기지 않는다 — 결정 (A) · 출하는 관문이 막는다', async () => {
    const { run, lots } = harness('HELD');
    await run();

    expect(lots.moveWithin).not.toHaveBeenCalledWith(expect.anything(), [501n, 502n], expect.anything(), expect.anything());
  });

  it('⛔ 피킹이 덜 끝났으면(P < A) 400 — 어느 라인인지 말한다(D6-b)', async () => {
    const { run } = harness('ACCEPTED', { reservations: [{ lot_id: 501n, reserved_qty: 6, released_qty: 0 }] });
    const error = await run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContractException);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain(
      '라인 1 의 피킹이 끝나지 않았습니다. 피킹을 마친 뒤 판정하세요.',
    );
  });

  it('⛔ 배분이 0 인 검사 대상 라인도 피킹 미완료다', async () => {
    const { run } = harness('ACCEPTED', { allocated: 0, reservations: [] });
    await expect(run()).rejects.toBeInstanceOf(ContractException);
  });

  it('예약을 푼 수량(released)은 피킹에서 빼고, 남은 수량이 0 인 LOT 은 대상에서 뺀다', async () => {
    const { run, lots } = harness('ACCEPTED', {
      allocated: 6,
      reservations: [
        { lot_id: 501n, reserved_qty: 6, released_qty: 0 },
        { lot_id: 502n, reserved_qty: 4, released_qty: 4 },
      ],
    });
    await run();

    expect(lots.moveWithin).toHaveBeenCalledWith(expect.anything(), [501n], 'inspection-accepted', expect.anything());
  });

  it('LOT 을 적은 OQC 의뢰는 그 LOT 하나만 옮기는 종전 길이다 — 피킹 LOT 을 다시 묻지 않는다', async () => {
    const { run, lots, lineFind } = harness('REJECTED', { lotId: 900n });
    (lots.moveWithin as jest.Mock).mockResolvedValue({ movedLotIds: [900n] });
    await run();

    expect(lineFind).not.toHaveBeenCalled();
  });
});
