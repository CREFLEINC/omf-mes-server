import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { InspectionHistoryService } from './inspection-history.service';

/** omf-all-around#61 — 검사 대상 이력(장부 P-55). */

const at = (iso: string) => new Date(iso);

const request = (overrides: Record<string, unknown> = {}) => ({
  inspection_request_id: 5n, inspection_request_no: 'IRQ-5', inspection_type_code: 'IQC',
  target_type_code: 'LOT', target_id: 10n, requested_at: at('2026-10-16T01:00:00Z'),
  lot: { lot_no: 'MLOT-10', inbound_receipt_line: [{ inbound_receipt: { inbound_receipt_no: 'IR-77' } }] },
  work_order: null,
  inspection_result: [{
    inspection_result_id: 31n, inspection_result_no: 'IRS-31', inspection_round: 1, status_code: 'CONFIRMED',
    overall_judgment_code: 'REJECTED', accepted_qty: new Prisma.Decimal(90), rejected_qty: new Prisma.Decimal(10),
    held_qty: new Prisma.Decimal(0), inspected_at: at('2026-10-16T02:00:00Z'), confirmed_at: at('2026-10-16T03:00:00Z'),
    worker: { worker_name: '검사자 김' },
  }],
  ...overrides,
});

const harness = (row: unknown, lotEvents: unknown[] = []) => {
  const lotFind = jest.fn().mockResolvedValue(lotEvents);
  const prisma = {
    inspection_request: { findUnique: jest.fn().mockResolvedValue(row) },
    lot_status_event: { findMany: lotFind },
    shipment_request: { findUnique: jest.fn().mockResolvedValue({ shipment_request_no: 'SHR-9' }) },
  } as unknown as PrismaService;
  return { service: new InspectionHistoryService(prisma), lotFind };
};

describe('InspectionHistoryService', () => {
  it('전달 → 저장 → 확정 → LOT 전이를 시간순으로, 출처는 입하 번호다', async () => {
    const { service, lotFind } = harness(request(), [{
      changed_at: at('2026-10-16T03:00:00Z'), previous_status_code: 'INSPECTION_PENDING', new_status_code: 'DEFECTIVE',
      transition_code: 'C6', lot: { lot_no: 'MLOT-10' }, app_user: { user_name: '관리자' }, changed_worker: null,
    }]);
    const history = await service.history(5);

    expect(history.source).toEqual({ targetTypeCode: 'LOT', targetId: 10, documentNo: 'IR-77', lotNo: 'MLOT-10' });
    expect(history.events.map((event) => event.eventTypeCode)).toEqual([
      'REQUESTED', 'RESULT_SAVED', 'RESULT_CONFIRMED', 'LOT_STATUS_CHANGED',
    ]);
    expect(history.events[2]).toMatchObject({ actorName: '검사자 김', overallJudgmentCode: 'REJECTED', rejectedQty: 10 });
    expect(history.events[3]).toMatchObject({ newStatusCode: 'DEFECTIVE', transitionCode: 'C6', actorName: '관리자' });
    expect(lotFind).toHaveBeenCalledWith(expect.objectContaining({
      where: { source_document_type_code: 'INSPECTION_RESULT', source_document_id: { in: [31n] } },
    }));
  });

  it('PQC 는 작업지시 번호, OQC 출하 지시 대상은 출하 지시 번호가 출처다 · 회차가 없으면 LOT 이력을 묻지 않는다', async () => {
    const pqc = harness(request({ lot: null, work_order: { work_order_no: 'WO-41' }, inspection_result: [] }));
    await expect(pqc.service.history(5)).resolves.toMatchObject({ source: { documentNo: 'WO-41' }, events: [{ eventTypeCode: 'REQUESTED' }] });
    expect(pqc.lotFind).not.toHaveBeenCalled();

    const oqc = harness(request({ lot: null, target_type_code: 'SHIPMENT_REQUEST', target_id: 9n, inspection_result: [] }));
    await expect(oqc.service.history(5)).resolves.toMatchObject({ source: { documentNo: 'SHR-9' } });
  });

  it('없는 의뢰는 404', async () => {
    await expect(harness(null).service.history(5)).rejects.toBeInstanceOf(NotFoundException);
  });
});
