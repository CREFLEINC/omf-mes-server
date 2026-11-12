import { Prisma } from '@prisma/client';

import { SplitAllocationRow, classifySplitResults, planAllocationTransfer } from './inbound-lot-split';

const d = (value: number) => new Prisma.Decimal(value);

function row(id: number, orderDate: string, purchaseOrderNo: string, lineNo: number, qty: number): SplitAllocationRow {
  return { purchaseOrderLineId: BigInt(id), orderDate, purchaseOrderNo, lineNo, qty: d(qty) };
}

const view = (moved: ReturnType<typeof planAllocationTransfer>) => moved.map((entry) => [entry.purchaseOrderLineId === null ? null : Number(entry.purchaseOrderLineId), Number(entry.qty)]);

describe('planAllocationTransfer — 배정 이전 순서(R-14b · T085)', () => {
  // 채움 순서: A(10-01) → B(10-02 PO-1 라인 1) → C(10-02 PO-1 라인 2). 마지막에 채운 라인 = C.
  const allocations = [row(3, '2026-10-02', 'PO-1', 2, 300), row(1, '2026-10-01', 'PO-0', 1, 1_000), row(2, '2026-10-02', 'PO-1', 1, 700)];

  it('US7-1 「P/O 없음」이 옮길 수량을 다 덮으면 P/O 몫은 그대로다', () => {
    expect(view(planAllocationTransfer(d(400), d(500), allocations))).toEqual([[null, 400]]);
  });

  it('US7-1 「P/O 없음」 먼저 → 그다음 마지막에 채운 라인부터(채움 역순)', () => {
    expect(view(planAllocationTransfer(d(1_500), d(300), allocations))).toEqual([[null, 300], [3, 300], [2, 700], [1, 200]]);
  });

  it('US7-1 「P/O 없음」이 없으면 마지막 라인부터 — 옮긴 P/O 몫 합 + P/O 없음 = 옮긴 수량, P/O 라인별 합은 그대로(두 줄로 나뉠 뿐)', () => {
    const moved = planAllocationTransfer(d(500), d(0), allocations);
    expect(view(moved)).toEqual([[3, 300], [2, 200]]);
    expect(moved.reduce((sum, entry) => sum.plus(entry.qty), d(0)).toNumber()).toBe(500);
    // 원래 줄에 남는 몫 + 새 줄 몫 = 원래 배정(P/O 받은 양 합 불변).
    for (const allocation of allocations) {
      const taken = moved.find((entry) => entry.purchaseOrderLineId === allocation.purchaseOrderLineId)?.qty ?? d(0);
      expect(allocation.qty.minus(taken).plus(taken).equals(allocation.qty)).toBe(true);
      expect(taken.lessThanOrEqualTo(allocation.qty)).toBe(true);
    }
  });

  it('US7-1 배정 A 2,500·P/O 없음 500 에서 1,000 을 옮기면 P/O 없음 500 + A 500', () => {
    expect(view(planAllocationTransfer(d(1_000), d(500), [row(9, '2026-11-01', 'PO-A', 1, 2_500)]))).toEqual([[null, 500], [9, 500]]);
  });
});

describe('classifySplitResults — 결과 이동 분류(R-14b · T085)', () => {
  const result = (id: number, seqNo: number, lotIds: number[]) => ({
    inspectionResultId: BigInt(id), seqNo, overallJudgmentCode: 'REJECTED', lotIds: lotIds.map(BigInt),
  });

  it('US7-1 옮긴 LOT 에만 매칭 → 이동, 함께 매칭 → 그 LOT 매칭만 삭제, 매칭 없음·다른 LOT 만 → 남김(순번 순)', () => {
    const classes = classifySplitResults(
      [result(12, 2, [1, 2, 3]), result(11, 1, [3]), result(13, 3, [1]), result(14, 4, []), result(15, 5, [3, 4])],
      [3n, 4n],
    );
    expect(classes.moved.map((entry) => Number(entry.inspectionResultId))).toEqual([11, 15]);
    expect(classes.unmatched.map((entry) => [Number(entry.inspectionResultId), entry.removedLotIds.map(Number)])).toEqual([[12, [3]]]);
    expect(classes.kept.map((entry) => Number(entry.inspectionResultId))).toEqual([13, 14]);
  });
});
