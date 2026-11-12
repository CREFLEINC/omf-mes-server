import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { InboundLotFinalizeInput, LotFinalizeFacts, assertInboundLotMutable, finalizeStateOf } from './inbound-lot-finalizable';

const lot = (lotNo: string, facts: Partial<LotFinalizeFacts> = {}): LotFinalizeFacts => ({
  lotNo, statusCode: 'NORMAL', posted: false, cancelPending: false, inDisposition: false, returned: false, ...facts,
});
const input = (lots: LotFinalizeFacts[], overrides: Partial<InboundLotFinalizeInput> = {}): InboundLotFinalizeInput => ({
  statusCode: 'RECEIVED', erpSendModeCode: 'ON_FINALIZE', iqcOpen: false, lots, ...overrides,
});

describe('finalizeStateOf — 「마감 승인 대기」 판정(R-24)', () => {
  it('US8-2 LOT 이 모두 입고(POSTED)·취소 요청 없음이면 마감 승인 대기 — 막힘 없음', () => {
    expect(finalizeStateOf(input([lot('ML-1', { posted: true }), lot('ML-2', { posted: true })]))).toEqual({
      finalizable: true, blockers: [], progress: { received: 2, inIqc: 0, inDisposition: 0, disposed: 0, returned: 0 },
    });
  });

  it('US8-2 입고·폐기 처분(SCRAPPED)·공급사 반품으로 끝나면 포함', () => {
    const state = finalizeStateOf(input([
      lot('ML-1', { posted: true }), lot('ML-2', { statusCode: 'SCRAPPED' }), lot('ML-3', { statusCode: 'DEFECTIVE', returned: true }),
    ]));
    expect(state.finalizable).toBe(true);
    expect(state.progress).toEqual({ received: 1, inIqc: 0, inDisposition: 0, disposed: 1, returned: 1 });
  });

  it('US8-2 IQC 기록 중이면 IQC_IN_PROGRESS(검사 대기 LOT) — 그 LOT 은 NOT_RECEIVED 로 세지 않는다', () => {
    const state = finalizeStateOf(input([lot('ML-2', { statusCode: 'INSPECTION_PENDING' }), lot('ML-1', { statusCode: 'INSPECTION_PENDING' })], { iqcOpen: true }));
    expect(state).toMatchObject({ finalizable: false, blockers: [{ code: 'IQC_IN_PROGRESS', lotNos: ['ML-1', 'ML-2'] }] });
    expect(state.progress.inIqc).toBe(2);
  });

  it('US8-2 IQC 기록 중인데 검사 대기 LOT 이 없으면 LOT 전부를 IQC_IN_PROGRESS 로', () => {
    const state = finalizeStateOf(input([lot('ML-1', { posted: true })], { iqcOpen: true }));
    expect(state.blockers).toEqual([{ code: 'IQC_IN_PROGRESS', lotNos: ['ML-1'] }]);
  });

  it('US8-2 처분 진행·입고 취소 요청·입고 안 됨 — 코드마다 LOT 번호, LOT 하나는 한 코드에만, 순서 고정', () => {
    const state = finalizeStateOf(input([
      lot('ML-4'), lot('ML-1', { posted: true, cancelPending: true }), lot('ML-2', { inDisposition: true, cancelPending: true }),
      lot('ML-3', { posted: true }), lot('ML-5', { statusCode: 'DEFECTIVE' }),
    ]));
    expect(state.finalizable).toBe(false);
    expect(state.blockers).toEqual([
      { code: 'DISPOSITION_IN_PROGRESS', lotNos: ['ML-2'] },
      { code: 'RECEIPT_CANCEL_PENDING', lotNos: ['ML-1'] },
      { code: 'NOT_RECEIVED', lotNos: ['ML-4', 'ML-5'] },
    ]);
  });

  it('US8-1 RECEIVED·ON_FINALIZE 가 아니면(입하 중·최종 마감·이전 데이터) 판정하지 않는다 — 빈 막힘, false', () => {
    const lots = [lot('ML-1')];
    for (const overrides of [{ statusCode: 'RECEIVING' }, { statusCode: 'FINALIZED' }, { erpSendModeCode: 'PER_RECEIPT' }]) {
      expect(finalizeStateOf(input(lots, overrides))).toMatchObject({ finalizable: false, blockers: [] });
    }
  });

  it('자재 관리 LOT 이 없으면 마감 승인 대기가 아니다', () => {
    expect(finalizeStateOf(input([])).finalizable).toBe(false);
  });
});

describe('assertInboundLotMutable — 최종 마감 뒤 불변', () => {
  const tx = (statusCode: string | null) => ({
    $queryRaw: jest.fn().mockResolvedValue(statusCode === null ? [] : [{ status_code: statusCode }]),
  }) as unknown as Prisma.TransactionClient;

  it('US8-5 FINALIZED 면 409 INBOUND_LOT_FINALIZED', async () => {
    const error = await assertInboundLotMutable(tx('FINALIZED'), 7n).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(409);
    expect((error as ContractException).errors).toEqual([expect.objectContaining({ scope: 'screen', code: 'INBOUND_LOT_FINALIZED' })]);
  });

  it('RECEIVED·RECEIVING 은 지나간다 · 없으면 404', async () => {
    await expect(assertInboundLotMutable(tx('RECEIVED'), 7n)).resolves.toBeUndefined();
    await expect(assertInboundLotMutable(tx('RECEIVING'), 7n)).resolves.toBeUndefined();
    await expect(assertInboundLotMutable(tx(null), 7n)).rejects.toMatchObject({ status: 404 });
  });
});
