/** 판정 확정을 막는 까닭 — 판정에 쓸 결과가 없거나(결과 0건·매칭된 LOT 없음), 판정이 빈 결과가 있다(R-12). */
export type IqcConfirmBlocker = 'NO_RESULTS' | 'JUDGMENT_MISSING';

/** 무거운 판정이 이긴다 — 불합격 > 보류 > 합격(R-12 ①). */
const WEIGHT: Record<string, number> = { REJECTED: 3, HELD: 2, ACCEPTED: 1 };
const REJECTED = 'REJECTED';

/** 판정 계산이 보는 결과 한 건 — 순번(`inspection_round`)·판정·매칭한 자재 관리 LOT. 상태·확정 차수는 보지 않는다. */
export interface IqcJudgedResult {
  resultId: bigint;
  seqNo: number;
  judgmentCode: string | null;
  lotIds: readonly bigint[];
}

/** 자재 관리 LOT 하나의 판정 근거 — 판정에 쓰인 결과와 그 LOT 에서 대체된 앞 결과들(순번 오름차순). */
export interface IqcLotJudgment<R extends IqcJudgedResult = IqcJudgedResult> {
  used: R;
  superseded: R[];
}

/**
 * 자재 관리 LOT별 판정(2026-11-12 사용자 결정 · R-10 「판정 규칙」) — 그 LOT 를 매칭한 결과 중 순번이 가장 큰 결과.
 * 확정 차수·결과 상태(DRAFT/CONFIRMED)와 상관없다. 매칭된 결과가 없는 LOT 는 맵에 없다(계산에서 빠짐).
 */
export function iqcLotJudgments<R extends IqcJudgedResult>(results: readonly R[]): Map<bigint, IqcLotJudgment<R>> {
  const byLot = new Map<bigint, R[]>();
  for (const result of [...results].sort((a, b) => a.seqNo - b.seqNo)) {
    for (const lotId of result.lotIds) byLot.set(lotId, [...(byLot.get(lotId) ?? []), result]);
  }
  return new Map([...byLot].map(([lotId, matched]) => [lotId, { used: matched[matched.length - 1], superseded: matched.slice(0, -1) }]));
}

/**
 * 입하 LOT 검사의 종합 판정 — LOT별 판정 중 가장 무거운 것. 확정할 수 없으면(판정에 쓸 결과 없음·판정이 빈 결과) 판정은 `null`
 * 이고 까닭을 함께 낸다. 판정이 빈 결과는 어느 결과든 막는다 — 확정이 기록 중인 결과 전부를 확정으로 바꾸고 CHECK 가 판정을 요구한다.
 * 상세·목록의 미리 보기(`previewJudgmentCode`)·요청 `:confirm`·확정 취소나 재작업 재열기 뒤 재확정이 모두 이 함수를 쓴다.
 */
export function iqcOverallJudgment(results: readonly IqcJudgedResult[]): { judgmentCode: string | null; blockers: IqcConfirmBlocker[] } {
  if (results.some((result) => result.judgmentCode === null)) return { judgmentCode: null, blockers: ['JUDGMENT_MISSING'] };
  const codes = [...iqcLotJudgments(results).values()].map((lot) => lot.used.judgmentCode as string);
  if (codes.length === 0) return { judgmentCode: null, blockers: ['NO_RESULTS'] };
  const judgmentCode = codes.reduce((worst, code) => ((WEIGHT[code] ?? 0) > (WEIGHT[worst] ?? 0) ? code : worst));
  return { judgmentCode, blockers: [] };
}

/** 불합격 → 보류·합격, 보류 → 합격 — 앞 판정을 «가볍게» 덮는다(FR-023a). */
function lightens(previous: string | null, next: string | null): boolean {
  if (previous === null || next === null) return false;
  return (previous === REJECTED || previous === 'HELD') && (WEIGHT[next] ?? 0) < (WEIGHT[previous] ?? 0);
}

/**
 * 이 결과(새로 쓰거나 고친 판정·매칭)가 재검 사유를 요구하는가(FR-023a). 매칭한 LOT 마다 그 LOT 의 바로 앞 결과(그 LOT 를 매칭한,
 * 이 결과보다 순번이 작은 결과 중 가장 큰 것)의 판정을 가볍게 덮으면 필요하다. 이 결과가 그 LOT 의 마지막이 아니어도 그 시점의
 * 대체로 본다 — 뒤 결과를 지우면 이 결과가 다시 그 LOT 의 판정이 되기 때문이다. `others` 에 이 결과 자신은 없다.
 */
export function reinspectionReasonRequired(others: readonly IqcJudgedResult[], written: Omit<IqcJudgedResult, 'resultId'>): boolean {
  return written.lotIds.some((lotId) => {
    const previous = others
      .filter((result) => result.seqNo < written.seqNo && result.lotIds.includes(lotId))
      .reduce<IqcJudgedResult | undefined>((last, result) => (last === undefined || result.seqNo > last.seqNo ? result : last), undefined);
    return previous !== undefined && lightens(previous.judgmentCode, written.judgmentCode);
  });
}

/** 불합격 확정이 만드는 부적합의 결과 연결 — LOT 판정에 쓰인 불합격 결과 중 순번이 가장 작은 것. */
export function nonconformanceSourceResult<R extends IqcJudgedResult>(results: readonly R[]): R | undefined {
  return [...iqcLotJudgments(results).values()]
    .map((lot) => lot.used)
    .filter((result) => result.judgmentCode === REJECTED)
    .reduce<R | undefined>((first, result) => (first === undefined || result.seqNo < first.seqNo ? result : first), undefined);
}
