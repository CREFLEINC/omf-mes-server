import { assertScoped, balanceRowsQuery } from './balance-query';

describe('inventory balance scope', () => {
  it('accepts a location-only mobile hopper query and binds that location', () => {
    const filters = { locationId: 4, today: '2026-09-12', includeZero: false, heldOnly: false };
    expect(() => assertScoped(filters)).not.toThrow();
    const query = balanceRowsQuery('LOT', filters);
    expect(query.sql).toContain('b.location_id = ');
    expect(query.params).toContain(4);
  });

  it('continues to reject an unscoped inventory query', () => {
    expect(() => assertScoped({})).toThrow();
  });
});

describe('inventory balance availability follows the LOT judgment (omf-all-around#302)', () => {
  const filters = { warehouseId: 1, today: '2026-11-18', includeZero: false, heldOnly: false };

  it('counts LOT rows as available only when the LOT is NORMAL and the row is not stamped DEFECTIVE', () => {
    const { sql } = balanceRowsQuery('LOT', filters);
    expect(sql).toContain("WHEN b.lot_id IS NULL THEN b.quality_status_code = 'NORMAL'");
    expect(sql).toContain("ELSE l.status_code = 'NORMAL' AND b.quality_status_code IN ('NORMAL', 'INSPECTION_PENDING')");
  });

  it('reports and filters the quality of LOT-judged rows by the LOT judgment', () => {
    const { sql } = balanceRowsQuery('ITEM', { ...filters, qualityStatusCode: 'NORMAL' });
    const judged = "(CASE WHEN b.lot_id IS NOT NULL AND b.quality_status_code IN ('NORMAL', 'INSPECTION_PENDING') THEN l.status_code";
    expect(sql).toContain(`count(DISTINCT ${judged}`);
    expect(sql).toContain(`${judged}\n  ELSE b.quality_status_code END) = $`);
  });
});
