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
