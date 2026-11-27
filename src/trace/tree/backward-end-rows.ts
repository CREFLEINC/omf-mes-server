import { TraceEdge } from './forward-expand';
import { MaterialFacts, Named, TraceLotNode, TraceTreeLot } from './trace-node-facts';

/** 역방향 최종 LOT 줄(contracts §4 · R-4) — 원자재 LOT × 그것이 투입된 W/O 한 줄. */
export interface BackwardEndRow {
  lot: TraceTreeLot;
  item: TraceLotNode['item'];
  supplier: Named | null;
  supplierLotNo: string | null;
  inboundLot: { inboundLotNo: string; receivedDate: string; iqcJudgmentCode: string | null } | null;
  workOrder: { workOrderNo: string };
  productLots: string[];
  consumedQty: number | null;
  uomCode: string;
  basis: string;
}

export interface BackwardSummary {
  rawLotCount: number;
  supplierCount: number;
  workOrderCount: number;
  productLotCount: number;
}

type AnyNode = { nodeKey: string; kind: string; [field: string]: unknown };

/**
 * 그래프에서 원자재 LOT 줄과 요약을 센다(`within` 을 주면 그 항목만 — 내보내기의 기준 LOT 별). 원자재 = 투입됐고 생산으로 만들어지지
 * 않은 LOT(원래 LOT 까지 SPLIT_FROM 을 올라가도 PRODUCED_BY 가 없다). 입하·공급사는 분할이면 원래 LOT 것(LOT 항목의 material).
 */
export function backwardEndRows(graph: { nodes: readonly { nodeKey: string; kind: string }[]; edges: readonly TraceEdge[] }, within?: Set<string>): {
  endRows: BackwardEndRow[]; summary: BackwardSummary;
} {
  const inside = (key: string) => within === undefined || within.has(key);
  const nodes = new Map(graph.nodes.filter((node) => inside(node.nodeKey)).map((node) => [node.nodeKey, node as AnyNode]));
  const edges = graph.edges.filter((edge) => inside(edge.from) && inside(edge.to));
  const out = new Map<string, TraceEdge[]>();
  for (const edge of edges) {
    const list = out.get(edge.from);
    if (list === undefined) out.set(edge.from, [edge]);
    else list.push(edge);
  }
  const produced = (key: string, seen = new Set<string>()): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    const leaving = out.get(key) ?? [];
    return leaving.some((edge) => edge.kind === 'PRODUCED_BY') || leaving.some((edge) => edge.kind === 'SPLIT_FROM' && produced(edge.to, seen));
  };
  const madeBy = new Map<string, string[]>();
  for (const edge of edges.filter((one) => one.kind === 'PRODUCED_BY')) {
    const lot = nodes.get(edge.from)?.lot as TraceTreeLot | undefined;
    if (lot !== undefined) madeBy.set(edge.to, [...(madeBy.get(edge.to) ?? []), lot.lotNo]);
  }

  const endRows: BackwardEndRow[] = [];
  for (const edge of edges.filter((one) => one.kind === 'CONSUMED')) {
    const input = nodes.get(edge.to) as unknown as TraceLotNode | undefined;
    const order = nodes.get(edge.from)?.workOrder as { workOrderNo: string } | undefined;
    if (input === undefined || order === undefined || produced(edge.to)) continue;
    const material: MaterialFacts | undefined = input.material;
    const inbound = material?.inboundLotId == null ? undefined
      : (nodes.get(`I:${material.inboundLotId}`)?.inboundLot as { inboundLotNo: string; receivedDate: string; iqcJudgmentCode: string | null } | undefined);
    endRows.push({
      lot: input.lot, item: input.item, supplier: material?.supplier ?? null, supplierLotNo: material?.supplierLotNo ?? null,
      inboundLot: inbound === undefined ? null : { inboundLotNo: inbound.inboundLotNo, receivedDate: inbound.receivedDate, iqcJudgmentCode: inbound.iqcJudgmentCode },
      workOrder: { workOrderNo: order.workOrderNo }, productLots: [...new Set(madeBy.get(edge.from) ?? [])].sort(),
      consumedQty: edge.qty, uomCode: input.uomCode, basis: edge.basis,
    });
  }
  endRows.sort((a, b) => a.lot.lotNo.localeCompare(b.lot.lotNo) || a.workOrder.workOrderNo.localeCompare(b.workOrder.workOrderNo));
  return {
    endRows,
    summary: {
      rawLotCount: new Set(endRows.map((row) => row.lot.lotId)).size,
      supplierCount: new Set(endRows.flatMap((row) => (row.supplier === null ? [] : [row.supplier.partnerId]))).size,
      workOrderCount: [...nodes.keys()].filter((key) => key.startsWith('W:')).length,
      productLotCount: [...nodes.keys()].filter((key) => key.startsWith('L:') && produced(key)).length,
    },
  };
}
