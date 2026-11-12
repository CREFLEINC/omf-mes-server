import { ContractException } from '../../common/errors';
import { assertSamplingRatio } from './inspection-plan-version.service';

/** omf-all-around#103 — 샘플링 방식과 비율(%)의 짝(장부 P-37). */
describe('assertSamplingRatio', () => {
  const fieldOf = (run: () => void) => {
    try {
      run();
      return undefined;
    } catch (error) {
      return (error as ContractException).errors[0];
    }
  };

  it('전수검사 + 비율 없음은 통과한다', () => {
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode: 'FULL_INSPECTION', samplingRatio: null }))).toBeUndefined();
  });

  it('전수검사 + 비율은 400 INVALID 다', () => {
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode: 'FULL_INSPECTION', samplingRatio: 10 }))).toMatchObject({
      field: 'samplingRatio',
      code: 'INVALID',
    });
  });

  it.each(['SAMPLE_BY_UNIT', 'SAMPLE_BY_LOT'])('%s + 비율 없음은 400 REQUIRED 다', (samplingMethodCode) => {
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode, samplingRatio: undefined }))).toMatchObject({
      field: 'samplingRatio',
      code: 'REQUIRED',
    });
  });

  it('엑셀 올리기 작성중(allowMissingRatio)은 샘플 방식 + 비율 없음을 통과시키되, 전수검사 + 비율은 막는다', () => {
    const draft = { allowMissingRatio: true };
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode: 'SAMPLE_BY_LOT', samplingRatio: null }, draft))).toBeUndefined();
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode: 'FULL_INSPECTION', samplingRatio: 10 }, draft))).toMatchObject({ code: 'INVALID' });
  });

  it('샘플 방식은 비율 또는 개수 중 하나만 — 둘 다면 samplingQty INVALID, 전수 + 개수도 INVALID 다', () => {
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode: 'SAMPLE_BY_LOT', samplingRatio: null, samplingQty: 5 }))).toBeUndefined();
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode: 'SAMPLE_BY_LOT', samplingRatio: 10, samplingQty: 5 }))).toMatchObject({ field: 'samplingQty', code: 'INVALID' });
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode: 'FULL_INSPECTION', samplingRatio: null, samplingQty: 5 }))).toMatchObject({ field: 'samplingQty', code: 'INVALID' });
  });

  it('샘플 방식 + 비율은 통과한다', () => {
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode: 'SAMPLE_BY_LOT', samplingRatio: 10 }))).toBeUndefined();
  });

  /* omf-all-around#264 — AQL 샘플링은 시료 수를 표로 정한다. */
  describe('AQL 샘플링', () => {
    const aql = { samplingMethodCode: 'AQL', aqlValue: 0.4, aqlInspectionLevelCode: 'G-II' };

    it('표준 AQL 값 + AQL 검사 수준이면 통과한다', () => {
      expect(fieldOf(() => assertSamplingRatio(aql))).toBeUndefined();
    });

    it('AQL 값이 없으면 REQUIRED, 표에 없는 값이면 INVALID 다', () => {
      expect(fieldOf(() => assertSamplingRatio({ ...aql, aqlValue: null }))).toMatchObject({ field: 'aqlValue', code: 'REQUIRED' });
      expect(fieldOf(() => assertSamplingRatio({ ...aql, aqlValue: 0 }))).toMatchObject({ field: 'aqlValue', code: 'INVALID' });
    });

    it('AQL 검사 수준이 없으면 REQUIRED, 모르는 값이면 INVALID 다', () => {
      expect(fieldOf(() => assertSamplingRatio({ ...aql, aqlInspectionLevelCode: null }))).toMatchObject({ field: 'aqlInspectionLevelCode', code: 'REQUIRED' });
      expect(fieldOf(() => assertSamplingRatio({ ...aql, aqlInspectionLevelCode: 'NORMAL' }))).toMatchObject({ field: 'aqlInspectionLevelCode', code: 'INVALID' });
    });

    it('샘플 비율 · 개수를 함께 넣으면 INVALID 다', () => {
      expect(fieldOf(() => assertSamplingRatio({ ...aql, samplingRatio: 10 }))).toMatchObject({ field: 'samplingRatio', code: 'INVALID' });
      expect(fieldOf(() => assertSamplingRatio({ ...aql, samplingQty: 5 }))).toMatchObject({ field: 'samplingQty', code: 'INVALID' });
    });
  });
});
