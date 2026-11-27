/**
 * LOT 추적 그래프 따라가기 틀(피처 015 · omf-all-around#355 · research R-2) — 방향과 DB 를 모른다.
 * 정방향(자재 → 고객)·역방향(제품 → 공급사)이 같은 틀에 «단계 확장» 함수만 바꿔 끼운다.
 *
 * - 한 단계 = 그 단계 LOT 묶음에서 다음 LOT 까지(LOT → W/O → LOT, LOT → 분할 LOT, LOT → 출하 같은 끝 항목). 확장 함수는
 *   단계마다 한 번, 그 단계 LOT 전부로 불린다 — 질의 수가 LOT 수와 상관없이 단계 수에만 따른다(F-2).
 * - 이미 펼친 LOT 은 다시 펼치지 않는다. 그래서 순환(조상으로 되돌아옴)·여러 길이 있어도 끝난다. 줄은 길마다 남긴다 —
 *   화면이 계보를 그릴 때 「중복」·「순환」을 줄로 가린다.
 * - 깊이(기준 LOT 에서 지나온 단계 수) 상한, 겹치지 않는 LOT 수 상한. 넘으면 멈추고 `limit` 에 적는다(오류가 아니다).
 * - 기준 LOT 은 여럿을 받는다(내보내기). 기준마다 닿는 항목은 `reachableFrom` 이 줄로 다시 구한다 — 펼치기를 함께 쓰므로
 *   먼저 닿은 기준이 펼친 LOT 도 다른 기준의 결과에 든다.
 */

/** 그래프 줄 — `from` → `to`. 같은 (from, to, kind) 는 한 줄이다. */
export interface StepEdge {
  from: string;
  to: string;
  kind: string;
}

/** 확장 함수가 한 단계에 돌려주는 것 — 새로 닿은 항목, 줄, 그리고 다음 단계로 펼칠 LOT 키(`reached`). */
export interface GraphStep<N extends { key: string }, E extends StepEdge> {
  nodes: N[];
  edges: E[];
  reached: string[];
}

export interface GraphLimit {
  /** 겹치지 않는 LOT 수가 상한을 넘어 그 단계 뒤에 멈췄다. */
  exceeded: boolean;
  /** 깊이 상한에 닿았는데 더 펼칠 LOT 이 남았다. */
  maxDepthReached: boolean;
  lotCount: number;
  lotCap: number;
}

export interface TraceGraphResult<N extends { key: string }, E extends StepEdge> {
  /** 확장 함수가 돌려준 항목(기준 LOT 자신은 넣지 않는다 — 호출 쪽이 머리를 읽는다). 처음 닿은 순서. */
  nodes: Map<string, N>;
  edges: E[];
  /** 펼친(또는 닿은) LOT 의 깊이 — 기준 0. */
  depthOf: Map<string, number>;
  limit: GraphLimit;
}

export const TRACE_MAX_DEPTH = 20;
export const TRACE_LOT_CAP = 5000;

export interface FollowGraphOptions<N extends { key: string }, E extends StepEdge> {
  roots: readonly string[];
  expand: (frontier: string[]) => Promise<GraphStep<N, E>>;
  maxDepth?: number;
  lotCap?: number;
}

const edgeId = (edge: StepEdge): string => `${edge.from}|${edge.to}|${edge.kind}`;

export async function followGraph<N extends { key: string }, E extends StepEdge>(
  options: FollowGraphOptions<N, E>,
): Promise<TraceGraphResult<N, E>> {
  const maxDepth = options.maxDepth ?? TRACE_MAX_DEPTH;
  const lotCap = options.lotCap ?? TRACE_LOT_CAP;
  const nodes = new Map<string, N>();
  const edges: E[] = [];
  const seenEdges = new Set<string>();
  const depthOf = new Map<string, number>();
  let frontier = [...new Set(options.roots)];
  for (const root of frontier) depthOf.set(root, 0);
  let depth = 0;
  let exceeded = false;

  while (frontier.length > 0 && depth < maxDepth) {
    const step = await options.expand(frontier);
    depth += 1;
    for (const node of step.nodes) if (!nodes.has(node.key)) nodes.set(node.key, node);
    for (const edge of step.edges) {
      const id = edgeId(edge);
      if (seenEdges.has(id)) continue;
      seenEdges.add(id);
      edges.push(edge);
    }
    const next: string[] = [];
    for (const lot of step.reached) {
      if (depthOf.has(lot)) continue;
      depthOf.set(lot, depth);
      next.push(lot);
    }
    frontier = next;
    if (depthOf.size > lotCap) {
      exceeded = true;
      break;
    }
  }

  return {
    nodes,
    edges,
    depthOf,
    limit: { exceeded, maxDepthReached: !exceeded && frontier.length > 0, lotCount: depthOf.size, lotCap },
  };
}

/** 줄을 따라 `root` 에서 닿는 항목 키(자신 포함) — 기준 LOT 마다 결과를 나눌 때 쓴다. */
export function reachableFrom(edges: readonly StepEdge[], root: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = out.get(edge.from);
    if (targets === undefined) out.set(edge.from, [edge.to]);
    else targets.push(edge.to);
  }
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    for (const to of out.get(key) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}
