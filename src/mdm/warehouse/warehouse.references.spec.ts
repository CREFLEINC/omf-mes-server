import { WAREHOUSE_REFERENCES, referenceKey } from './warehouse.references';

describe('WAREHOUSE_REFERENCES', () => {
  it('같은 (스키마, 테이블, 컬럼)이 두 번 들어 있지 않다 — 중복은 건수를 부풀린다', () => {
    const keys = WAREHOUSE_REFERENCES.map(referenceKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('한 테이블이 창고를 두 방향으로 참조하는 경우를 빠뜨리지 않았다', () => {
    const keys = WAREHOUSE_REFERENCES.map(referenceKey);

    expect(keys).toContain('inventory.inventory_transaction_line.from_warehouse_id');
    expect(keys).toContain('inventory.inventory_transaction_line.to_warehouse_id');
    expect(keys).toContain('logistics.stock_transfer.from_warehouse_id');
    expect(keys).toContain('logistics.stock_transfer.to_warehouse_id');
  });
});
