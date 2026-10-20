import { buildInspectionResultWhere } from './inspection-result-query.service';

/** omf-all-around#85 · 장부 P-76 — 검사 결과 목록을 LOT 하나로 좁힌다. */
describe('buildInspectionResultWhere — lotId', () => {
  it('lotId 는 결과의 검사 의뢰 LOT 으로 건다', () => {
    expect(buildInspectionResultWhere({ lotId: 7, inspectionTypeCode: 'IQC' })).toEqual({
      inspection_request: { inspection_type_code: 'IQC', lot_id: 7 },
    });
  });

  it('lotId 가 없으면 LOT 조건을 싣지 않는다', () => {
    expect(buildInspectionResultWhere({ itemId: 3 })).toEqual({ inspection_request: { item_id: 3 } });
  });
});
