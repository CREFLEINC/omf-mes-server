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

  it('샘플 방식 + 비율은 통과한다', () => {
    expect(fieldOf(() => assertSamplingRatio({ samplingMethodCode: 'SAMPLE_BY_LOT', samplingRatio: 10 }))).toBeUndefined();
  });
});
