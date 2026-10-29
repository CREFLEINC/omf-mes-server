/**
 * LOT 추적의 단계 — 앞에서 뒤로. 한 LOT 의 「현재 단계」는 하위 사슬에서 가장 멀리 간 단계다
 * (생산 LOT 하나라도 출하됐으면 그 자재 LOT 은 출하 단계).
 */
export const FORWARD_STAGES = ['RECEIVED', 'CONSUMED', 'PRODUCED', 'PRODUCTION_RECEIVED', 'PACKED', 'SHIPPED'] as const;
/** 생산 LOT 은 생산에서 시작한다 — 입고·투입은 그 LOT 의 단계가 아니다. */
export const BACKWARD_STAGES = ['PRODUCED', 'PRODUCTION_RECEIVED', 'PACKED', 'SHIPPED'] as const;
export type StageCode = (typeof FORWARD_STAGES)[number];

/**
 * 단계별 건수를 가진 SQL 열에서 현재 단계를 고르는 CASE. `columns` 는 단계 → 「그 단계에 닿은 수」 열이다.
 * 첫 단계는 목록에 든 것만으로 닿았다고 본다.
 */
export function stageCaseSql(stages: readonly StageCode[], columns: Partial<Record<StageCode, string>>): string {
  const whens = [...stages]
    .slice(1)
    .reverse()
    .map((stage) => `WHEN ${columns[stage]} > 0 THEN '${stage}'`);
  return `CASE ${whens.join(' ')} ELSE '${stages[0]}' END`;
}

/** 단계별 건수 — 단계 조건만 빼고 센 것(조건 칩 건수). 없는 단계도 0 으로 싣는다. */
export function stageCounts(stages: readonly StageCode[], rows: { stage: string; count: bigint }[]): Record<string, number> {
  const counts = Object.fromEntries(stages.map((stage) => [stage, 0]));
  for (const row of rows) counts[row.stage] = Number(row.count);
  return counts;
}

export function stageFilter(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}
