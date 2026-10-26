import { ContractException } from '../../common/errors';
import { changedLotIds, correctionAllocations } from './correction-lots';

const ONE = [{ lotId: 1, lotNo: 'L-1', allocatedQty: 10 }];
const TWO = [{ lotId: 1, lotNo: 'L-1', allocatedQty: 6 }, { lotId: 2, lotNo: 'L-2', allocatedQty: 4 }];

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as ContractException).errors[0].code;
  }
  return undefined;
}

describe('정정의 LOT 배분', () => {
  it('양품이 같으면 원본 배분을 그대로 옮긴다', () => {
    expect(correctionAllocations(TWO, undefined, 10, 10)).toEqual([{ lotId: 1, allocatedQty: 6 }, { lotId: 2, allocatedQty: 4 }]);
  });

  it('원본 LOT 이 하나면 양품 차이만큼 고치고, 0 이 되면 배분을 비운다', () => {
    expect(correctionAllocations(ONE, undefined, 10, 7)).toEqual([{ lotId: 1, allocatedQty: 7 }]);
    expect(correctionAllocations(ONE, undefined, 10, 0)).toEqual([]);
  });

  it('배분보다 많이 줄이면 400 INVALID — 원본 배분이 양품보다 적었던 경우다', () => {
    expect(codeOf(() => correctionAllocations([{ lotId: 1, lotNo: 'L-1', allocatedQty: 3 }], undefined, 10, 5))).toBe('INVALID');
  });

  it('원본 LOT 이 여럿인데 양품이 바뀌면 400 REQUIRED · 원본에 배분이 없으면 배분 없음', () => {
    expect(codeOf(() => correctionAllocations(TWO, undefined, 10, 9))).toBe('REQUIRED');
    expect(correctionAllocations([], undefined, 10, 9)).toEqual([]);
  });

  it('보낸 배분은 원본 LOT 안에서만 받는다', () => {
    expect(correctionAllocations(TWO, [{ lotId: 2, allocatedQty: 9 }], 10, 9)).toEqual([{ lotId: 2, allocatedQty: 9 }]);
    expect(codeOf(() => correctionAllocations(TWO, [{ lotId: 3, allocatedQty: 9 }], 10, 9))).toBe('INVALID');
  });

  it('바뀌는 LOT 만 고른다 — 빠진 LOT 도 바뀐 것이다', () => {
    expect(changedLotIds(TWO, [{ lotId: 1, allocatedQty: 6 }, { lotId: 2, allocatedQty: 3 }])).toEqual([2]);
    expect(changedLotIds(TWO, [{ lotId: 1, allocatedQty: 9 }])).toEqual([1, 2]);
  });
});
