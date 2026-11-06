import { matchErpWarehouse } from './erp-warehouse-match';

describe('matchErpWarehouse — ERP 창고 코드로 MES 창고 고르기', () => {
  const row = (code: string, plant: bigint, active = true) => ({ warehouse_code: code, plant_id: plant, is_active: active });

  it('코드가 정확히 같은 입하 공장의 활성 창고를 고른다', () => {
    const own = row('S510', 1n);
    expect(matchErpWarehouse('S510', 1n, [row('S511', 1n), own])).toEqual({ kind: 'MATCHED', warehouse: own });
  });

  it('코드가 같은 창고가 없으면 UNMAPPED — 비슷한 이름·다른 코드로 추정하지 않는다', () => {
    expect(matchErpWarehouse('S510', 1n, [row('S511', 1n), row('s510', 1n)])).toEqual({ kind: 'UNMAPPED' });
    expect(matchErpWarehouse('S510', 1n, [])).toEqual({ kind: 'UNMAPPED' });
  });

  it('같은 코드가 다른 공장에만 있으면 OTHER_PLANT', () => {
    expect(matchErpWarehouse('S510', 1n, [row('S510', 2n)])).toEqual({ kind: 'OTHER_PLANT' });
  });

  it('입하 공장의 창고가 꺼져 있으면 INACTIVE — 후보에 꺼진 창고를 넘긴 호출자만 본다', () => {
    const off = row('S510', 1n, false);
    expect(matchErpWarehouse('S510', 1n, [off])).toEqual({ kind: 'INACTIVE', warehouse: off });
  });
});
