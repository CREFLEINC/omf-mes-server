import { Prisma } from '@prisma/client';

import { confirmCancelBlockers, loadConfirmCancelFacts } from './iqc-confirm-cancel';

const NONE = { receivedLotNos: [], dispositionLotNos: [], concessionLotNos: [], statusChangedLotNos: [] };
const LOTS = [
  { lot_id: 1n, lot_no: 'ML-0001' },
  { lot_id: 2n, lot_no: 'ML-0002' },
];
const CONFIRMED_AT = new Date('2026-11-12T03:00:00.000Z');

/** 막힘 사실을 읽는 네 표만 흉내 낸다 — 각 표가 돌려줄 LOT id. */
function txWith(rows: { received?: bigint[]; decided?: bigint[]; concessions?: bigint[]; changed?: bigint[] }) {
  const of = (ids: bigint[] | undefined) => jest.fn().mockResolvedValue((ids ?? []).map((lot_id) => ({ lot_id })));
  const tx = {
    goods_receipt_line: { findMany: of(rows.received) },
    nonconformance_lot: { findMany: of(rows.decided) },
    concession: { findMany: of(rows.concessions) },
    lot_status_event: { findMany: of(rows.changed) },
  };
  return tx as typeof tx & Prisma.TransactionClient;
}

describe('판정 확정 취소 막힘 (T080)', () => {
  it('SC-006 막힘이 없으면 빈 목록 — 취소가 된다', () => {
    expect(confirmCancelBlockers(NONE)).toEqual([]);
  });

  it('US5-3 입고된 자재 관리 LOT 이 있으면 GOODS_RECEIVED — LOT 번호를 번호 순·중복 없이 싣는다', () => {
    expect(confirmCancelBlockers({ ...NONE, receivedLotNos: ['ML-0002', 'ML-0001', 'ML-0002'] })).toEqual([
      { scope: 'screen', code: 'GOODS_RECEIVED', lotNos: ['ML-0001', 'ML-0002'], message: expect.stringContaining('ML-0001, ML-0002') as string },
    ]);
  });

  it('US5-4 처분 판정·특채·확정 뒤 다른 상태 변경 — 막힘이 여럿이면 정해진 순서로 모두', () => {
    const blockers = confirmCancelBlockers({
      receivedLotNos: ['ML-0001'], dispositionLotNos: ['ML-0001', 'ML-0002'], concessionLotNos: ['ML-0002'], statusChangedLotNos: ['ML-0001'],
    });
    expect(blockers.map((blocker) => [blocker.code, blocker.lotNos])).toEqual([
      ['GOODS_RECEIVED', ['ML-0001']],
      ['DISPOSITION_STARTED', ['ML-0001', 'ML-0002']],
      ['CONCESSION_EXISTS', ['ML-0002']],
      ['LOT_STATUS_CHANGED', ['ML-0001']],
    ]);
    expect(blockers.every((blocker) => blocker.scope === 'screen' && blocker.message.length > 0)).toBe(true);
  });

  it('US5-3·US5-4 사실 읽기 — 표마다 걸린 LOT id 를 LOT 번호로 바꾼다', async () => {
    const tx = txWith({ received: [2n], decided: [1n, 2n], concessions: [1n], changed: [2n, 2n] });
    await expect(loadConfirmCancelFacts(tx, { inspectionRequestId: 9n, lots: LOTS, confirmedAt: CONFIRMED_AT, nonconformanceIds: [5n] })).resolves.toEqual({
      receivedLotNos: ['ML-0002'], dispositionLotNos: ['ML-0001', 'ML-0002'], concessionLotNos: ['ML-0001'], statusChangedLotNos: ['ML-0002'],
    });
  });

  it('SC-006 확정이 만든 부적합이 없으면 처분·특채 표를 읽지 않는다 — 확정 뒤 이력은 이 요청이 남긴 것을 뺀다', async () => {
    const tx = txWith({});
    await expect(loadConfirmCancelFacts(tx, { inspectionRequestId: 9n, lots: LOTS, confirmedAt: CONFIRMED_AT, nonconformanceIds: [] })).resolves.toEqual(NONE);
    expect(tx.nonconformance_lot.findMany).not.toHaveBeenCalled();
    expect(tx.concession.findMany).not.toHaveBeenCalled();
    const where = (tx.lot_status_event.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({
      lot_id: { in: [1n, 2n] },
      changed_at: { gte: CONFIRMED_AT },
      OR: [{ source_document_type_code: null }, { source_document_type_code: { not: 'INSPECTION_REQUEST' } }, { source_document_id: { not: 9n } }],
    });
  });
});
