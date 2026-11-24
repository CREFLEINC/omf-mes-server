import { GraphStep, StepEdge, followGraph, reachableFrom } from './trace-graph';

interface Node {
  key: string;
}

/**
 * 가짜 그래프 — LOT 키는 `L:`, 그 밖(W/O·출하)은 다른 머리글자. 한 단계는 LOT 에서 다음 LOT 까지(LOT → W/O → LOT)다.
 * `links` 는 LOT 마다 [중간 항목 | null, 다음 LOT 또는 끝 항목] 줄.
 */
function fakeExpand(links: Record<string, [string | null, string][]>) {
  const calls: string[][] = [];
  const expand = async (frontier: string[]): Promise<GraphStep<Node, StepEdge>> => {
    calls.push([...frontier]);
    const nodes: Node[] = [];
    const edges: StepEdge[] = [];
    const reached: string[] = [];
    for (const lot of frontier) {
      for (const [via, to] of links[lot] ?? []) {
        if (via !== null) {
          nodes.push({ key: via }, { key: to });
          edges.push({ from: lot, to: via, kind: 'CONSUMED' }, { from: via, to, kind: 'PRODUCED' });
        } else {
          nodes.push({ key: to });
          edges.push({ from: lot, to, kind: to.startsWith('L:') ? 'SPLIT' : 'SHIPPED' });
        }
        if (to.startsWith('L:')) reached.push(to);
      }
    }
    return { nodes, edges, reached };
  };
  return { expand, calls };
}

/** 한 줄로 이어진 LOT n 개 — L:0 → W:0 → L:1 → W:1 → … */
function chain(n: number): Record<string, [string | null, string][]> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`L:${i}`, [[`W:${i}`, `L:${i + 1}`]]]));
}

describe('LOT 추적 그래프 따라가기 (피처 015 · omf-all-around#355)', () => {
  it('US1-2 반제품을 지나 끝까지 잇는다 — 단계마다 확장 함수를 그 단계 LOT 묶음으로 한 번 부른다', async () => {
    const { expand, calls } = fakeExpand({
      'L:A': [['W:1', 'L:P1'], ['W:1', 'L:P2']],
      'L:P1': [['W:2', 'L:P3']],
      'L:P2': [[null, 'H:STOCK']],
      'L:P3': [[null, 'S:SH1']],
    });

    const graph = await followGraph({ roots: ['L:A'], expand });

    expect(calls).toEqual([['L:A'], ['L:P1', 'L:P2'], ['L:P3']]);
    expect([...graph.nodes.keys()].sort()).toEqual(['H:STOCK', 'L:P1', 'L:P2', 'L:P3', 'S:SH1', 'W:1', 'W:2']);
    expect(graph.limit).toEqual({ exceeded: false, maxDepthReached: false, lotCount: 4, lotCap: 5000 });
    expect(graph.depthOf.get('L:P3')).toBe(2);
  });

  it('경계-여러 길 같은 LOT 에 두 길로 닿아도 한 번만 펼치고, 줄은 길마다 남긴다', async () => {
    const { expand, calls } = fakeExpand({
      'L:A': [['W:1', 'L:S1'], ['W:2', 'L:S2']],
      'L:S1': [['W:3', 'L:P']],
      'L:S2': [['W:3', 'L:P']],
      'L:P': [[null, 'S:SH1']],
    });

    const graph = await followGraph({ roots: ['L:A'], expand });

    expect(calls).toEqual([['L:A'], ['L:S1', 'L:S2'], ['L:P']]);
    expect(graph.edges.filter((edge) => edge.to === 'W:3').map((edge) => edge.from).sort()).toEqual(['L:S1', 'L:S2']);
    // 같은 W/O 를 두 LOT 이 지나며 같은 (W/O → P) 줄을 두 번 내도 한 줄이다.
    expect(graph.edges.filter((edge) => edge.from === 'W:3' && edge.to === 'L:P')).toHaveLength(1);
    expect(graph.limit.lotCount).toBe(4);
  });

  it('Q15 경계-순환 조상으로 되돌아와도 끝난다 — 되돌아가는 줄은 싣고 다시 펼치지 않는다', async () => {
    const { expand, calls } = fakeExpand({
      'L:A': [['W:1', 'L:Q']],
      'L:Q': [['W:2', 'L:A'], ['W:2', 'L:Q']],
    });

    const graph = await followGraph({ roots: ['L:A'], expand });

    expect(calls).toEqual([['L:A'], ['L:Q']]);
    expect(graph.edges).toContainEqual({ from: 'W:2', to: 'L:A', kind: 'PRODUCED' });
    expect(graph.limit).toMatchObject({ exceeded: false, maxDepthReached: false, lotCount: 2 });
  });

  it('Q15 경계-상한 깊이 20 에서 멈추고 maxDepthReached', async () => {
    const { expand, calls } = fakeExpand(chain(30));

    const graph = await followGraph({ roots: ['L:0'], expand });

    expect(calls).toHaveLength(20);
    expect(graph.nodes.has('L:20')).toBe(true);
    expect(graph.nodes.has('L:21')).toBe(false);
    expect(graph.limit).toMatchObject({ maxDepthReached: true, exceeded: false, lotCount: 21 });
  });

  it('Q15 경계-상한 깊이 20 에 닿은 LOT 은 더 묻지 않아 상한으로 본다 — 19 단계에서 끝나면 상한이 아니다', async () => {
    const { expand, calls } = fakeExpand(chain(20));

    const graph = await followGraph({ roots: ['L:0'], expand });

    // 20 번째 단계가 닿은 L:20 은 더 갈 곳이 없다 — 한 번 더 물어야 알 수 있으나 깊이 상한이라 묻지 않는다.
    expect(calls).toHaveLength(20);
    expect(graph.limit.maxDepthReached).toBe(true);

    const short = await followGraph({ roots: ['L:0'], expand: fakeExpand(chain(19)).expand });
    expect(short.limit.maxDepthReached).toBe(false);
  });

  it('Q15 경계-상한 겹치지 않는 LOT 이 상한을 넘으면 그 단계 뒤 멈추고 exceeded', async () => {
    const wide = Array.from({ length: 5001 }, (_, i) => ['W:1', `L:P${i}`] as [string, string]);
    const { expand, calls } = fakeExpand({ 'L:A': wide, 'L:P0': [['W:2', 'L:Z']] });

    const graph = await followGraph({ roots: ['L:A'], expand });

    expect(calls).toHaveLength(1);
    expect(graph.limit).toEqual({ exceeded: true, maxDepthReached: false, lotCount: 5002, lotCap: 5000 });
    expect(graph.nodes.has('L:Z')).toBe(false);

    const exact = await followGraph({ roots: ['L:A'], expand: fakeExpand({ 'L:A': wide.slice(0, 4999) }).expand });
    expect(exact.limit).toMatchObject({ exceeded: false, lotCount: 5000 });
  });

  it('US4-1 기준 여럿 — 한 번 따라가고 기준마다 닿는 항목을 구한다(겹치는 LOT 도 각 기준에 든다)', async () => {
    const { expand, calls } = fakeExpand({
      'L:A': [['W:1', 'L:P']],
      'L:B': [['W:2', 'L:P'], ['W:2', 'L:Q']],
      'L:P': [[null, 'S:SH1']],
      'L:C': [],
    });

    const graph = await followGraph({ roots: ['L:A', 'L:B', 'L:C'], expand });

    expect(calls).toEqual([['L:A', 'L:B', 'L:C'], ['L:P', 'L:Q']]);
    expect([...reachableFrom(graph.edges, 'L:A')].sort()).toEqual(['L:A', 'L:P', 'S:SH1', 'W:1']);
    expect([...reachableFrom(graph.edges, 'L:B')].sort()).toEqual(['L:B', 'L:P', 'L:Q', 'S:SH1', 'W:2']);
    expect([...reachableFrom(graph.edges, 'L:C')]).toEqual(['L:C']);
  });

  it('기준이 다른 기준의 자손이어도 기준은 깊이 0 이고 다시 펼치지 않는다', async () => {
    const { expand, calls } = fakeExpand({ 'L:A': [['W:1', 'L:B']], 'L:B': [['W:2', 'L:C']] });

    const graph = await followGraph({ roots: ['L:A', 'L:B'], expand });

    expect(calls).toEqual([['L:A', 'L:B'], ['L:C']]);
    expect(graph.depthOf.get('L:B')).toBe(0);
    expect([...reachableFrom(graph.edges, 'L:A')].sort()).toEqual(['L:A', 'L:B', 'L:C', 'W:1', 'W:2']);
  });
});
