import {
  IqcJudgedResult, iqcLotJudgments, iqcOverallJudgment, nonconformanceSourceResult, reinspectionReasonRequired,
} from './iqc-overall-judgment';

const L1 = 1n;
const L2 = 2n;
const L3 = 3n;
const r = (seqNo: number, judgmentCode: string | null, ...lotIds: bigint[]): IqcJudgedResult => ({ resultId: BigInt(100 + seqNo), seqNo, judgmentCode, lotIds });
/** 결과마다 같은 LOT 하나 — 판정 순서만 보는 시험. */
const each = (...codes: (string | null)[]) => codes.map((code, index) => r(index + 1, code, BigInt(index + 1)));

describe('iqcOverallJudgment — 입하 LOT 검사 종합 판정(R-12 · 2026-11-12 LOT별 마지막 결과)', () => {
  it('US3-5 LOT별 판정 중 불합격이 하나라도 있으면 불합격 — 불합격 > 보류 > 합격', () => {
    expect(iqcOverallJudgment(each('ACCEPTED', 'REJECTED'))).toEqual({ judgmentCode: 'REJECTED', blockers: [] });
    expect(iqcOverallJudgment(each('HELD', 'REJECTED', 'ACCEPTED'))).toEqual({ judgmentCode: 'REJECTED', blockers: [] });
  });

  it('불합격이 없고 보류가 있으면 보류, 모두 합격이면 합격', () => {
    expect(iqcOverallJudgment(each('ACCEPTED', 'HELD')).judgmentCode).toBe('HELD');
    expect(iqcOverallJudgment(each('ACCEPTED', 'ACCEPTED')).judgmentCode).toBe('ACCEPTED');
    expect(iqcOverallJudgment(each('ACCEPTED')).judgmentCode).toBe('ACCEPTED');
  });

  it('결과가 0건이면 확정할 수 없다 — NO_RESULTS', () => {
    expect(iqcOverallJudgment([])).toEqual({ judgmentCode: null, blockers: ['NO_RESULTS'] });
  });

  it('판정이 빈 결과가 있으면 확정할 수 없다 — JUDGMENT_MISSING(다른 결과가 불합격이어도, 그 결과가 LOT 판정에 안 쓰여도)', () => {
    expect(iqcOverallJudgment(each('REJECTED', null))).toEqual({ judgmentCode: null, blockers: ['JUDGMENT_MISSING'] });
    expect(iqcOverallJudgment([r(1, null, L1), r(2, 'ACCEPTED', L1)])).toEqual({ judgmentCode: null, blockers: ['JUDGMENT_MISSING'] });
  });

  it('US3-8 LOT별 순번 최대 결과 — 결과 1 불합격(LOT 1·2) 뒤 결과 2 합격(LOT 1) → LOT 1 합격·LOT 2 불합격·종합 불합격', () => {
    const results = [r(1, 'REJECTED', L1, L2), r(2, 'ACCEPTED', L1)];
    const lots = iqcLotJudgments(results);
    expect(lots.get(L1)).toEqual({ used: results[1], superseded: [results[0]] });
    expect(lots.get(L2)).toEqual({ used: results[0], superseded: [] });
    expect(iqcOverallJudgment(results).judgmentCode).toBe('REJECTED');
    expect(iqcOverallJudgment([...results, r(3, 'ACCEPTED', L1, L2)]).judgmentCode).toBe('ACCEPTED');
  });

  it('순번이 기준이다 — 넘긴 순서·확정 차수·결과 상태와 상관없다(재열기 앞 확정 결과도 같은 규칙)', () => {
    const shuffled = [r(3, 'ACCEPTED', L1), r(1, 'REJECTED', L1, L2), r(2, 'HELD', L2)];
    expect(iqcLotJudgments(shuffled).get(L1)?.superseded.map((result) => result.seqNo)).toEqual([1]);
    expect(iqcOverallJudgment(shuffled).judgmentCode).toBe('HELD');
  });

  it('매칭된 결과가 없는 LOT 는 계산에서 빠진다 — 매칭이 하나도 없으면 NO_RESULTS', () => {
    const lots = iqcLotJudgments([r(1, 'ACCEPTED', L1)]);
    expect([...lots.keys()]).toEqual([L1]);
    expect(lots.has(L3)).toBe(false);
    expect(iqcOverallJudgment([r(1, 'REJECTED')])).toEqual({ judgmentCode: null, blockers: ['NO_RESULTS'] });
  });

  it('US3-10 결과를 지우면 그 LOT 의 앞 결과로 다시 판정한다', () => {
    const remaining = [r(1, 'REJECTED', L1, L2), r(2, 'ACCEPTED', L1)];
    expect(iqcLotJudgments(remaining).get(L2)?.used.seqNo).toBe(1);
    expect(iqcOverallJudgment(remaining).judgmentCode).toBe('REJECTED');
  });
});

describe('reinspectionReasonRequired — 불합격·보류를 덮는 결과(FR-023a)', () => {
  const before = [r(1, 'REJECTED', L1, L2), r(2, 'HELD', L3)];

  it('US3-9 불합격 → 보류·합격, 보류 → 합격이면 필요하다', () => {
    expect(reinspectionReasonRequired(before, { seqNo: 3, judgmentCode: 'ACCEPTED', lotIds: [L1] })).toBe(true);
    expect(reinspectionReasonRequired(before, { seqNo: 3, judgmentCode: 'HELD', lotIds: [L2] })).toBe(true);
    expect(reinspectionReasonRequired(before, { seqNo: 3, judgmentCode: 'ACCEPTED', lotIds: [L3] })).toBe(true);
  });

  it('더 무겁거나 같은 판정·앞 결과가 없는 LOT·판정이 빈 결과는 필요 없다', () => {
    expect(reinspectionReasonRequired(before, { seqNo: 3, judgmentCode: 'REJECTED', lotIds: [L1, L3] })).toBe(false);
    expect(reinspectionReasonRequired(before, { seqNo: 3, judgmentCode: 'HELD', lotIds: [L3] })).toBe(false);
    expect(reinspectionReasonRequired([r(1, 'ACCEPTED', L1)], { seqNo: 2, judgmentCode: 'ACCEPTED', lotIds: [L2] })).toBe(false);
    expect(reinspectionReasonRequired(before, { seqNo: 3, judgmentCode: null, lotIds: [L1] })).toBe(false);
  });

  it('LOT 의 바로 앞 결과 기준 — 이 결과보다 순번이 작은 결과 중 가장 큰 것(수정은 그 결과 시점)', () => {
    const results = [r(1, 'REJECTED', L1), r(2, 'ACCEPTED', L1)];
    // 결과 2 를 고치면 앞은 결과 1(불합격)이다 — 합격을 유지해도 필요.
    expect(reinspectionReasonRequired([results[0]], { seqNo: 2, judgmentCode: 'ACCEPTED', lotIds: [L1] })).toBe(true);
    // 결과 1 을 고칠 때는 뒤 결과(2)를 보지 않는다.
    expect(reinspectionReasonRequired([results[1]], { seqNo: 1, judgmentCode: 'ACCEPTED', lotIds: [L1] })).toBe(false);
    // 바로 앞이 합격이면 그보다 앞의 불합격은 보지 않는다.
    expect(reinspectionReasonRequired(results, { seqNo: 3, judgmentCode: 'ACCEPTED', lotIds: [L1] })).toBe(false);
  });
});

describe('nonconformanceSourceResult — 불합격 확정이 만드는 부적합의 결과 연결', () => {
  it('LOT 판정에 쓰인 불합격 결과 중 순번이 가장 작은 것 — 대체된 불합격은 고르지 않는다', () => {
    const results = [r(1, 'REJECTED', L1), r(2, 'ACCEPTED', L1), r(3, 'REJECTED', L2), r(4, 'REJECTED', L3)];
    expect(nonconformanceSourceResult(results)?.seqNo).toBe(3);
  });

  it('R15-2 재검이 다시 보지 않은 LOT 의 앞 불합격 결과가 연결된다', () => {
    const results = [r(1, 'REJECTED', L1, L2, L3), r(2, 'ACCEPTED', L1, L2)];
    expect(nonconformanceSourceResult(results)?.seqNo).toBe(1);
    expect(nonconformanceSourceResult([...results, r(3, 'ACCEPTED', L3)])).toBeUndefined();
  });
});
