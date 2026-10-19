/**
 * W/O 에 배정할 수 있는 설비·금형인가. 계획 확정의 자동 배정(`planning`)과 4M 점검·추천(`production`)이
 * 같은 판정을 써야 한다 — 갈리면 자동 배정한 자원이 4M 점검에서 BLOCK 이 된다.
 */
export interface UsableResource { status_code: string; is_active: boolean }

/** 설비·금형이 「쓸 수 있는」 유일한 값 — `transitions.ts` 의 두 축이 `IN_SERVICE`→`DISPOSED` 다. */
const IN_SERVICE = 'IN_SERVICE';

/** 마스터에 없는 id 도 못 쓰는 자원으로 본다 — FK 상 없을 수 없지만 조용히 통과시키지 않는다. */
export const unusable = (fact: UsableResource | undefined): boolean =>
  fact === undefined || fact.status_code !== IN_SERVICE || !fact.is_active;
