import { VerdictLocation, VerdictLot, designationAddable, verdictOf } from './location-verdict';

/** research R-5 판정 표 — 위에서부터 처음 맞는 것이 답이다. */
const lot: VerdictLot = { plantId: 1n, itemId: 10n, defective: false };
const base: VerdictLocation = {
  locationId: 5n, locationCode: 'A-R1', isActive: true, warehouseId: 2n, warehouseName: 'A', warehouseActive: true,
  warehousePlantId: 1n, isDefect: false, systemRoleCode: null, hasActiveChild: false, itemRestricted: false,
  designatedItemIds: [10n], warehouseDivided: true,
};
const at = (patch: Partial<VerdictLocation>) => verdictOf({ ...base, ...patch }, lot);

describe('위치 판정 표 (research R-5)', () => {
  it('1 NOT_FOUND — 코드가 없다', () => expect(verdictOf(null, lot)).toBe('NOT_FOUND'));
  it('2 INACTIVE — 위치 또는 창고가 꺼졌다', () => {
    expect(at({ isActive: false })).toBe('INACTIVE');
    expect(at({ warehouseActive: false })).toBe('INACTIVE');
  });
  it('3 OTHER_PLANT — 다른 공장 창고', () => expect(at({ warehousePlantId: 9n })).toBe('OTHER_PLANT'));
  it('4 STAGING — 적치 대기 자리', () => expect(at({ systemRoleCode: 'PUTAWAY_STAGING' })).toBe('STAGING'));
  it('5 NOT_LEAF — 켜진 하위 위치가 있다', () => expect(at({ hasActiveChild: true })).toBe('NOT_LEAF'));
  it('6 불량 LOT 은 불량창고만', () => {
    expect(verdictOf(base, { ...lot, defective: true })).toBe('DEFECT_LOT_NEEDS_DEFECT_WAREHOUSE');
    expect(verdictOf({ ...base, isDefect: true }, { ...lot, defective: true })).toBe('DESIGNATED');
  });
  it('7 정상 LOT 은 불량창고 금지', () => expect(at({ isDefect: true })).toBe('NORMAL_LOT_IN_DEFECT_WAREHOUSE'));
  it('US2-8 7a 「지정 품목만 받기」 켜진 위치에 지정 밖 품목 → RESTRICTED_LOCATION, 지정 품목이면 DESIGNATED', () => {
    expect(at({ itemRestricted: true, designatedItemIds: [11n] })).toBe('RESTRICTED_LOCATION');
    expect(at({ itemRestricted: true, designatedItemIds: [10n, 11n] })).toBe('DESIGNATED');
  });
  it('8 이 품목이 걸린 위치 → DESIGNATED', () => expect(at({})).toBe('DESIGNATED'));
  it('9 위치를 나누지 않은 창고의 「창고 전체」 → DESIGNATED, 나뉜 창고의 「창고 전체」 → UNDESIGNATED', () => {
    expect(at({ systemRoleCode: 'WAREHOUSE_WHOLE', designatedItemIds: [], warehouseDivided: false })).toBe('DESIGNATED');
    expect(at({ systemRoleCode: 'WAREHOUSE_WHOLE', designatedItemIds: [], warehouseDivided: true })).toBe('UNDESIGNATED');
  });
  it('US2-6 10 지정 없는 위치·다른 품목만 지정된 위치 → UNDESIGNATED', () => {
    expect(at({ designatedItemIds: [] })).toBe('UNDESIGNATED');
    expect(at({ designatedItemIds: [11n] })).toBe('UNDESIGNATED');
  });

  /* SC-006 · Q23 — 활성·맨 아래·STAGING 아님·불량 규칙 맞음·옵션 꺼짐이면 지정 여부와 상관없이 늘 적치할 수 있다. */
  it('Q23 SC-006 옵션 꺼진 정상 위치는 늘 DESIGNATED 또는 UNDESIGNATED', () => {
    for (const designatedItemIds of [[], [10n], [11n], [10n, 11n]]) {
      for (const systemRoleCode of [null, 'WAREHOUSE_WHOLE']) {
        for (const warehouseDivided of [true, false]) {
          for (const defective of [true, false]) {
            const verdict = verdictOf({ ...base, designatedItemIds, systemRoleCode, warehouseDivided, isDefect: defective }, { ...lot, defective });
            expect(['DESIGNATED', 'UNDESIGNATED']).toContain(verdict);
          }
        }
      }
    }
  });
});

describe('designationAddable — 미지정 위치 적치가 보관 품목을 더하는가(FR-017a)', () => {
  it('Q24 UNDESIGNATED 이고 사람이 만든 위치일 때만 true', () => {
    expect(designationAddable('UNDESIGNATED', { ...base, systemRoleCode: null })).toBe(true);
    expect(designationAddable('UNDESIGNATED', { ...base, systemRoleCode: 'WAREHOUSE_WHOLE' })).toBe(false);
    expect(designationAddable('DESIGNATED', base)).toBe(false);
    expect(designationAddable('RESTRICTED_LOCATION', base)).toBe(false);
    expect(designationAddable('NOT_FOUND', null)).toBe(false);
  });
});
