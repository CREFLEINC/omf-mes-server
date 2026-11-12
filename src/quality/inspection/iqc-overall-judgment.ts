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

/**
 * 판정 대상 결과(R-15) — 기록 중(DRAFT)인 결과가 있으면 그것, 없으면 마지막 확정의 결과. 재작업 재열기는 앞 확정의 결과를 확정 그대로
 * 남기고(그 판정의 근거) 재검사로 더한 결과만으로 다시 판정한다. 확정 취소는 그 확정의 결과를 DRAFT 로 되돌리므로 다시 판정 대상이 된다.
 */
export function judgedResults<T extends { status_code: string; confirmed_at: Date | null }>(results: readonly T[]): T[] {
  const drafts = results.filter((result) => result.status_code === 'DRAFT');
  if (drafts.length > 0) return drafts;
  const last = Math.max(...results.map((result) => result.confirmed_at?.getTime() ?? 0));
  return results.filter((result) => (result.confirmed_at?.getTime() ?? 0) === last);
}
