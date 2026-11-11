import { withDefects } from './dashboard-item-group-defects.service';
import { itemGroupProduction } from './dashboard-view';

const defect = (code: string | null, id: number, qty: number) => ({
  code,
  defectCodeId: BigInt(id),
  defectCode: `D${id}`,
  defectName: `불량${id}`,
  qty,
});

describe('제품군별 불량 현황(withDefects)', () => {
  const groups = itemGroupProduction([
    { code: 'ADT', name: 'ADT', totalQty: 1000, goodQty: 900, ngQty: 100 },
    { code: null, name: null, totalQty: 100, goodQty: 90, ngQty: 10 },
  ]);

  it('Worst 5 는 공장 사이 같은 유형을 합쳐 수량 순 다섯까지, 유형 미입력 = NG − 유형 합', () => {
    const [adt] = withDefects(groups, [
      defect('ADT', 1, 10), defect('ADT', 2, 30), defect('ADT', 3, 5), defect('ADT', 4, 7),
      defect('ADT', 5, 1), defect('ADT', 6, 2), defect('ADT', 1, 25),
    ]);
    expect(adt.topDefects.map((row) => [row.defectCode, row.qty])).toEqual([
      ['D1', 35], ['D2', 30], ['D4', 7], ['D3', 5], ['D6', 2],
    ]);
    expect(adt.untypedNgQty).toBe(100 - 80);
    // 상위 5 밖 = D5(1)
    expect(adt.otherTypedQty).toBe(1);
    expect(adt).not.toHaveProperty('goodQty');
  });

  it('미분류 줄은 품목군 없는 기록만 받고, 유형 합이 NG 를 넘어도 미입력은 0 이다', () => {
    const [, unclassified] = withDefects(groups, [defect('ADT', 1, 3), defect(null, 9, 12)]);
    expect(unclassified).toMatchObject({ itemGroupCode: null, untypedNgQty: 0, otherTypedQty: 0 });
    expect(unclassified.topDefects.map((row) => row.defectCode)).toEqual(['D9']);
  });

  it('생산 없는 제품군의 기록은 줄을 만들지 않는다', () => {
    expect(withDefects(groups, [defect('ESL', 1, 3)]).map((row) => row.itemGroupCode)).toEqual(['ADT', null]);
  });
});
