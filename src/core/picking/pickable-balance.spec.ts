import { PICKABLE_BALANCE } from './picking-generation';

describe('PICKABLE_BALANCE (omf-all-around#302)', () => {
  it('lets an inspection-pending stamped row through once the LOT itself is NORMAL', () => {
    expect(PICKABLE_BALANCE.quality_status_code).toEqual({ in: ['NORMAL', 'INSPECTION_PENDING'] });
    expect(PICKABLE_BALANCE.lot).toEqual({
      is: { status_code: 'NORMAL', lot_hold: { none: { released_at: null } } },
    });
  });

  it('never lets a DEFECTIVE stamped row through', () => {
    expect((PICKABLE_BALANCE.quality_status_code as { in: string[] }).in).not.toContain('DEFECTIVE');
  });
});
