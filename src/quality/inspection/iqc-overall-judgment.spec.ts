import { iqcOverallJudgment } from './iqc-overall-judgment';

const of = (...codes: (string | null)[]) => codes.map((overallJudgmentCode) => ({ overallJudgmentCode }));

describe('iqcOverallJudgment — 입하 LOT 검사 종합 판정(R-12)', () => {
  it('US3-5 불합격이 하나라도 있으면 불합격 — 불합격 > 보류 > 합격', () => {
    expect(iqcOverallJudgment(of('ACCEPTED', 'REJECTED'))).toEqual({ judgmentCode: 'REJECTED', blockers: [] });
    expect(iqcOverallJudgment(of('HELD', 'REJECTED', 'ACCEPTED'))).toEqual({ judgmentCode: 'REJECTED', blockers: [] });
  });

  it('불합격이 없고 보류가 있으면 보류, 모두 합격이면 합격', () => {
    expect(iqcOverallJudgment(of('ACCEPTED', 'HELD')).judgmentCode).toBe('HELD');
    expect(iqcOverallJudgment(of('ACCEPTED', 'ACCEPTED')).judgmentCode).toBe('ACCEPTED');
    expect(iqcOverallJudgment(of('ACCEPTED')).judgmentCode).toBe('ACCEPTED');
  });

  it('결과가 0건이면 확정할 수 없다 — NO_RESULTS', () => {
    expect(iqcOverallJudgment([])).toEqual({ judgmentCode: null, blockers: ['NO_RESULTS'] });
  });

  it('판정이 빈 결과가 있으면 확정할 수 없다 — JUDGMENT_MISSING(다른 결과가 불합격이어도)', () => {
    expect(iqcOverallJudgment(of('REJECTED', null))).toEqual({ judgmentCode: null, blockers: ['JUDGMENT_MISSING'] });
  });
});
