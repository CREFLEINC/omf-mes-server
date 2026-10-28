import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { OriginalShare, changedLotIds, correctionAllocations } from './correction-lots';

const d = (value: number) => new Prisma.Decimal(value);
const ONE: OriginalShare = { allocations: [{ lotId: 1, lotNo: 'L-1', allocatedQty: 10 }], goodQty: d(10) };
const TWO: OriginalShare = { allocations: [{ lotId: 1, lotNo: 'L-1', allocatedQty: 6 }, { lotId: 2, lotNo: 'L-2', allocatedQty: 4 }], goodQty: d(10) };
const PARTIAL: OriginalShare = { allocations: [{ lotId: 1, lotNo: 'L-1', allocatedQty: 3 }], goodQty: d(10) };

function errorOf(run: () => unknown): { field?: string; code: string; message: string } | undefined {
  try {
    run();
  } catch (error) {
    return (error as ContractException).errors[0] as { field?: string; code: string; message: string };
  }
  return undefined;
}

describe('정정의 LOT 배분', () => {
  it('양품이 같으면 원본 배분을 그대로 옮긴다', () => {
    expect(correctionAllocations(TWO, undefined, d(10))).toEqual([{ lotId: 1, allocatedQty: 6 }, { lotId: 2, allocatedQty: 4 }]);
  });

  it('원본 LOT 이 하나면 양품 차이만큼 고친다 · 0 정정은 배분이 없다(LOT 이 여럿이어도)', () => {
    expect(correctionAllocations(ONE, undefined, d(7))).toEqual([{ lotId: 1, allocatedQty: 7 }]);
    expect(correctionAllocations(ONE, undefined, d(0))).toEqual([]);
    expect(correctionAllocations(TWO, undefined, d(0))).toEqual([]);
  });

  it('담긴 것보다 많이 줄이면 400 INVALID 이고 goodQty 를 짚는다 — 문구에 API 칸 이름을 쓰지 않는다', () => {
    const error = errorOf(() => correctionAllocations(PARTIAL, undefined, d(5)));
    expect(error).toMatchObject({ field: 'goodQty', code: 'INVALID' });
    expect(error?.message).toBe('LOT L-1 에 담긴 3 보다 많이 줄일 수 없습니다. LOT 별 수량을 정해 다시 저장하세요.');
  });

  it('원본 LOT 이 여럿인데 양품이 바뀌면 400 REQUIRED 이고 LOT 번호를 짚는다 · 원본 배분이 없으면 배분 없음', () => {
    expect(errorOf(() => correctionAllocations(TWO, undefined, d(9)))).toEqual({
      scope: 'field', field: 'goodQty', code: 'REQUIRED',
      message: '이 실적은 LOT L-1·L-2 에 나눠 담겼습니다. 양품 수량이 바뀌므로 LOT 별 수량을 정해 다시 저장하세요.',
    });
    expect(correctionAllocations({ allocations: [], goodQty: d(10) }, undefined, d(9))).toEqual([]);
  });

  it('보낸 배분은 원본 LOT 안에서만, 원본이 양품을 다 담았으면 합이 양품과 같아야 한다', () => {
    expect(correctionAllocations(TWO, [{ lotId: 1, allocatedQty: 5 }, { lotId: 2, allocatedQty: 4 }], d(9))).toHaveLength(2);
    expect(errorOf(() => correctionAllocations(TWO, [{ lotId: 3, allocatedQty: 9 }], d(9)))).toMatchObject({ field: 'lotAllocations', code: 'INVALID' });
    expect(errorOf(() => correctionAllocations(TWO, [{ lotId: 2, allocatedQty: 5 }], d(9)))?.message)
      .toBe('원래 실적은 양품을 LOT(L-1·L-2)에 모두 나눠 담았습니다. LOT 별 수량의 합(5)을 양품 수량(9)에 맞춰 다시 저장하세요.');
    // 일부만 담았던 실적은 합을 맞출 필요가 없다.
    expect(correctionAllocations(PARTIAL, [{ lotId: 1, allocatedQty: 2 }], d(9))).toEqual([{ lotId: 1, allocatedQty: 2 }]);
  });

  it('바뀌는 LOT 만 고른다 — 빠진 LOT 도 바뀐 것이다', () => {
    expect(changedLotIds(TWO.allocations, [{ lotId: 1, allocatedQty: 6 }, { lotId: 2, allocatedQty: 3 }])).toEqual([2]);
    expect(changedLotIds(TWO.allocations, [{ lotId: 1, allocatedQty: 9 }])).toEqual([1, 2]);
  });
});
