import { estimateBasis } from './flow-sql';

describe('estimateBasis', () => {
  it('이음이 없으면 null 이다 — 투입 없음·투입만·문서로만 이어진 LOT', () => {
    expect(estimateBasis(false, false)).toBeNull();
    expect(estimateBasis(false, true)).toBeNull();
  });

  it('이음이 있으면 하나라도 W/O 단위 추정일 때 WORK_ORDER_ESTIMATE, 아니면 LOT_GENEALOGY_ESTIMATE 다', () => {
    expect(estimateBasis(true, true)).toBe('WORK_ORDER_ESTIMATE');
    expect(estimateBasis(true, false)).toBe('LOT_GENEALOGY_ESTIMATE');
  });
});
