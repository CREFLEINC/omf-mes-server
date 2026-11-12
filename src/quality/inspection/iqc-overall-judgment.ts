/** 판정 확정을 막는 까닭 — 결과가 없거나, 판정이 빈 결과가 있다(R-12). */
export type IqcConfirmBlocker = 'NO_RESULTS' | 'JUDGMENT_MISSING';

/** 무거운 판정이 이긴다 — 불합격 > 보류 > 합격(R-12 ①). */
const WEIGHT: Record<string, number> = { REJECTED: 3, HELD: 2, ACCEPTED: 1 };

/**
 * 입하 LOT 검사의 종합 판정 — 결과 전부의 판정 중 가장 무거운 것. 확정할 수 없으면(결과 0건·판정이 빈 결과) 판정은 `null` 이고
 * 까닭을 함께 낸다. 상세의 미리 보기(`previewJudgmentCode`)와 판정 확정이 같은 함수를 쓴다.
 */
export function iqcOverallJudgment(results: readonly { overallJudgmentCode: string | null }[]): {
  judgmentCode: string | null;
  blockers: IqcConfirmBlocker[];
} {
  if (results.length === 0) return { judgmentCode: null, blockers: ['NO_RESULTS'] };
  if (results.some((result) => result.overallJudgmentCode === null)) return { judgmentCode: null, blockers: ['JUDGMENT_MISSING'] };
  const codes = results.map((result) => result.overallJudgmentCode as string);
  const judgmentCode = codes.reduce((worst, code) => ((WEIGHT[code] ?? 0) > (WEIGHT[worst] ?? 0) ? code : worst));
  return { judgmentCode, blockers: [] };
}
