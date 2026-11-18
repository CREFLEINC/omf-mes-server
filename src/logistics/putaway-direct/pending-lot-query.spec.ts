import { Prisma } from '@prisma/client';

import { PendingLotFacts, pendingReasonOf } from './pending-lot-query';

/** research R-3 — 적치 대기 조건 (a)~(e) 와 숨김 이유 코드 7개. */
const closed = { inboundLotId: 3n, inboundLotNo: 'IL-1', statusCode: 'RECEIVED', closedAt: new Date() };
const facts: PendingLotFacts = {
  lotId: 1n, lotNo: 'L-1', plantId: 1n, itemId: 10n, itemCode: 'X', itemName: 'X', uomId: 1n, uomCode: 'EA',
  statusCode: 'NORMAL', inboundLineId: 7n, inboundLot: closed,
  supplierName: 'S', receivableQty: new Prisma.Decimal(10), liveReceipt: null, pendingTaskIds: [],
};
const reason = (patch: Partial<PendingLotFacts>, plantId: bigint | null = 1n) => pendingReasonOf({ ...facts, ...patch }, plantId);

describe('적치 대기 조건 (research R-3)', () => {
  it('US1-1 조건을 모두 만족하면 적치 대기(이유 없음) — 불량 LOT 도 포함', () => {
    expect(reason({})).toBeNull();
    expect(reason({ statusCode: 'DEFECTIVE' })).toBeNull();
  });
  it('US6-2 입하 LOT 없는 이전 흐름 LOT 도 (a) 를 통과한다', () => expect(reason({ inboundLot: null })).toBeNull());
  it('세션이 공장을 주지 않으면 LOT 의 공장을 그대로 본다', () => expect(reason({}, null)).toBeNull());
  it('NOT_INBOUND — 입하에서 오지 않은 LOT', () => expect(reason({ inboundLineId: null })).toBe('NOT_INBOUND'));
  it('OTHER_PLANT — 단말 공장 밖', () => expect(reason({}, 2n)).toBe('OTHER_PLANT'));
  it('HAS_TASK (e) — PENDING 적치 지시가 있으면 지시로 끝낸다(입고가 있어도 먼저)', () => {
    expect(reason({ pendingTaskIds: [5n], liveReceipt: { goodsReceiptLineId: 1n } })).toBe('HAS_TASK');
  });
  it('ALREADY_PUT_AWAY (d) — 취소되지 않은 입고가 있다', () => expect(reason({ liveReceipt: { goodsReceiptLineId: 1n } })).toBe('ALREADY_PUT_AWAY'));
  it('US5-1 RECEIVING (a) — 입하 마감 전', () => {
    expect(reason({ inboundLot: { ...closed, statusCode: 'RECEIVING' }, statusCode: 'INSPECTION_PENDING' })).toBe('RECEIVING');
  });
  it('US5-2 INSPECTION (b) — 검사 대기·보류', () => expect(reason({ statusCode: 'INSPECTION_PENDING' })).toBe('INSPECTION'));
  it('US5-5 DISPOSED — 폐기·입고 가능 0·폐기된 입하 LOT', () => {
    expect(reason({ statusCode: 'SCRAPPED' })).toBe('DISPOSED');
    expect(reason({ receivableQty: new Prisma.Decimal(0) })).toBe('DISPOSED');
    expect(reason({ inboundLot: { ...closed, statusCode: 'VOIDED' } })).toBe('DISPOSED');
  });
});
