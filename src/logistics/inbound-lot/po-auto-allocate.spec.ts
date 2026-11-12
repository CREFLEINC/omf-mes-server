import { Prisma } from '@prisma/client';

import { AllocationCandidate, allocateByOrderAge } from './po-auto-allocate';

const d = (value: number): Prisma.Decimal => new Prisma.Decimal(value);

function line(id: number, orderDate: string, purchaseOrderNo: string, qty: { ordered: number; received?: number; tolerance?: number }, lineNo = 1): AllocationCandidate {
  return {
    purchaseOrderLineId: BigInt(id), orderDate, purchaseOrderNo, lineNo,
    orderedQty: d(qty.ordered), receivedQty: d(qty.received ?? 0), toleranceOverQty: d(qty.tolerance ?? 0),
  };
}

function shares(result: ReturnType<typeof allocateByOrderAge>): [number, number][] {
  return result.allocations.map((row) => [Number(row.purchaseOrderLineId), row.qty.toNumber()]);
}

describe('allocateByOrderAge — 입하 마감 P/O 자동 배정(R-22)', () => {
  it('US2-8 0031 잔량 300·0012 잔량 2,500·허용치 100 에 3,000 → 300·2,600·P/O 없음 100', () => {
    const result = allocateByOrderAge(d(3000), [
      line(12, '2026-11-05', 'PO-0012', { ordered: 2500, tolerance: 100 }),
      line(31, '2026-11-01', 'PO-0031', { ordered: 1000, received: 700 }),
    ]);
    expect(shares(result)).toEqual([[31, 300], [12, 2600]]);
    expect(result.unallocatedQty.toNumber()).toBe(100);
  });

  it('US2-2 A 2,500(허용치 0)에 3,000 → 2,500·P/O 없음 500', () => {
    const result = allocateByOrderAge(d(3000), [line(1, '2026-11-01', 'PO-A', { ordered: 2500 })]);
    expect(shares(result)).toEqual([[1, 2500]]);
    expect(result.unallocatedQty.toNumber()).toBe(500);
  });

  it('후보가 없으면 전량 P/O 없음', () => {
    const result = allocateByOrderAge(d(750), []);
    expect(result.allocations).toEqual([]);
    expect(result.unallocatedQty.toNumber()).toBe(750);
  });

  it('이미 발주 + 허용치를 넘게 받은 라인은 0 이다', () => {
    const result = allocateByOrderAge(d(100), [
      line(1, '2026-11-01', 'PO-1', { ordered: 100, received: 130, tolerance: 20 }),
      line(2, '2026-11-02', 'PO-2', { ordered: 50 }),
    ]);
    expect(shares(result)).toEqual([[2, 50]]);
    expect(result.unallocatedQty.toNumber()).toBe(50);
  });

  it('같은 발주일이면 P/O 번호, 같은 P/O 면 라인 번호 순이다', () => {
    const result = allocateByOrderAge(d(25), [
      line(3, '2026-11-01', 'PO-B', { ordered: 10 }, 1),
      line(2, '2026-11-01', 'PO-A', { ordered: 10 }, 2),
      line(1, '2026-11-01', 'PO-A', { ordered: 10 }, 1),
    ]);
    expect(shares(result)).toEqual([[1, 10], [2, 10], [3, 5]]);
  });

  it('1차 잔량을 모든 라인에서 채운 뒤에만 2차 허용치를 쓴다', () => {
    const result = allocateByOrderAge(d(230), [
      line(1, '2026-11-01', 'PO-1', { ordered: 100, tolerance: 50 }),
      line(2, '2026-11-02', 'PO-2', { ordered: 100, tolerance: 50 }),
    ]);
    // 1차 100·100, 남은 30 은 오래된 라인의 허용치로.
    expect(shares(result)).toEqual([[1, 130], [2, 100]]);
    expect(result.unallocatedQty.toNumber()).toBe(0);
  });

  it('배정이 0 인 라인은 행이 없다 — 수량이 오래된 라인에서 끝나면 뒤 라인은 빠진다', () => {
    const result = allocateByOrderAge(d(40), [
      line(1, '2026-11-01', 'PO-1', { ordered: 100 }),
      line(2, '2026-11-02', 'PO-2', { ordered: 100 }),
    ]);
    expect(shares(result)).toEqual([[1, 40]]);
    expect(result.unallocatedQty.toNumber()).toBe(0);
  });
});
