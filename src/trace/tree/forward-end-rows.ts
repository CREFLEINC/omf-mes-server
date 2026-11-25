import { WIP_LOT_TYPE } from '../../core/lot';
import { TraceEdge } from './forward-expand';
import { Named, TraceLotNode, TraceTreeLot } from './trace-node-facts';

/** 정방향 최종 LOT 줄(contracts §3 · R-3) — 이 자재가 들어간 마지막 생산 LOT 과 그 행방. */
export interface ForwardEndRow {
  lot: TraceTreeLot;
  item: TraceLotNode['item'];
  producedQty: number;
  uomCode: string;
  fate: 'SHIPPED' | 'IN_STOCK' | 'PARTIAL' | 'CONSUMED_OUT' | 'VOIDED' | 'WIP_PENDING';
  shipments: { shipmentNo: string; customer: Named; shippedAt: string | null; qty: number }[];
  stock: { warehouse: unknown; location: unknown; qty: number }[];
  viaWorkOrders: string[];
}

export interface ForwardSummary {
  lotCount: number;
  workOrderCount: number;
  endLotCount: number;
  shippedLotCount: number;
  customerCount: number;
  stockLotCount: number;
}

type AnyNode = { nodeKey: string; kind: string; [field: string]: unknown };

/**
 * 그래프에서 최종 LOT 줄과 요약을 센다 — DB 를 다시 읽지 않는다. `within` 을 주면 그 항목들만 본다(내보내기의 기준 LOT 별).
 * 마지막 생산 LOT = 생산으로 만들어졌고(분리·분할 자식 포함) 더 나가는 투입(CONSUMED)이 없는 LOT. 자식이 있는 원래 LOT 은
 * 자기 출하·재고가 남았을 때만 선다. 같은 LOT 이 여러 길로 와도 항목이 하나라 한 번만 센다.
 */
export function forwardEndRows(graph: { nodes: readonly { nodeKey: string; kind: string }[]; edges: readonly TraceEdge[] }, within?: Set<string>): { endRows: ForwardEndRow[]; summary: ForwardSummary } {
  const inside = (key: string) => within === undefined || within.has(key);
  const nodes = new Map(graph.nodes.filter((node) => inside(node.nodeKey)).map((node) => [node.nodeKey, node as AnyNode]));
  const edges = graph.edges.filter((edge) => inside(edge.from) && inside(edge.to));
  const out = group(edges, (edge) => edge.from);
  const into = group(edges, (edge) => edge.to);
  const lots = [...nodes.values()].filter((node) => node.nodeKey.startsWith('L:')) as unknown as TraceLotNode[];

  const produced = (lot: TraceLotNode): boolean => lot.kind === 'PRODUCTION_LOT' || (lot.kind === 'SPLIT_LOT' && lot.lot.lotTypeCode !== 'MATERIAL')
    || (into.get(lot.nodeKey) ?? []).some((edge) => edge.kind === 'PRODUCED');
  const viaWorkOrders = (key: string, seen = new Set<string>()): string[] => {
    if (seen.has(key)) return [];
    seen.add(key);
    const incoming = into.get(key) ?? [];
    const made = incoming.filter((edge) => edge.kind === 'PRODUCED').map((edge) => nodes.get(edge.from)?.workOrder as { workOrderNo: string } | undefined);
    if (made.length > 0) return made.flatMap((wo) => (wo === undefined ? [] : [wo.workOrderNo]));
    return incoming.filter((edge) => edge.kind === 'SPLIT').flatMap((edge) => viaWorkOrders(edge.from, seen));
  };
  const shipmentsOf = (key: string) => (out.get(key) ?? []).flatMap((edge) => {
    // 옛 흐름 — 포장 상자로 나갔으면 이 LOT 이 그 상자에 담은 양을 출하량으로 본다.
    const legs = edge.kind === 'SHIPPED' ? [{ to: edge.to, qty: edge.qty }]
      : edge.kind === 'PACKED' ? (out.get(edge.to) ?? []).filter((next) => next.kind === 'SHIPPED').map((next) => ({ to: next.to, qty: edge.qty })) : [];
    return legs.flatMap((leg) => {
      const shipment = nodes.get(leg.to)?.shipment as { shipmentNo: string; customer: Named; shippedAt: string | null } | undefined;
      return shipment === undefined ? [] : [{ shipmentNo: shipment.shipmentNo, customer: shipment.customer, shippedAt: shipment.shippedAt, qty: leg.qty ?? 0 }];
    });
  });
  const stockOf = (key: string) => (out.get(key) ?? []).filter((edge) => edge.kind === 'STOCKED').flatMap((edge) => {
    const stock = nodes.get(edge.to);
    return stock === undefined ? [] : [{ warehouse: stock.warehouse, location: stock.location, qty: edge.qty ?? 0 }];
  });

  const endRows: ForwardEndRow[] = [];
  for (const lot of lots) {
    const leaving = out.get(lot.nodeKey) ?? [];
    if (!produced(lot) || leaving.some((edge) => edge.kind === 'CONSUMED')) continue;
    const shipments = shipmentsOf(lot.nodeKey);
    const stock = stockOf(lot.nodeKey);
    if (leaving.some((edge) => edge.kind === 'SPLIT') && shipments.length === 0 && stock.length === 0) continue;
    const producedQty = (into.get(lot.nodeKey) ?? []).filter((edge) => edge.kind === 'PRODUCED').reduce((sum, edge) => sum + (edge.qty ?? 0), 0) || lot.qty;
    endRows.push({
      lot: lot.lot, item: lot.item, producedQty, uomCode: lot.uomCode, fate: fateOf(lot.lot, shipments.length > 0, stock.length > 0),
      shipments, stock, viaWorkOrders: [...new Set(viaWorkOrders(lot.nodeKey))].sort(),
    });
  }
  endRows.sort((a, b) => a.lot.lotNo.localeCompare(b.lot.lotNo));
  return {
    endRows,
    summary: {
      lotCount: lots.length,
      workOrderCount: [...nodes.keys()].filter((key) => key.startsWith('W:')).length,
      endLotCount: endRows.length,
      shippedLotCount: endRows.filter((row) => row.shipments.length > 0).length,
      customerCount: new Set(endRows.flatMap((row) => row.shipments.map((shipment) => shipment.customer.partnerId))).size,
      stockLotCount: endRows.filter((row) => row.stock.length > 0).length,
    },
  };
}

function fateOf(lot: TraceTreeLot, shipped: boolean, stocked: boolean): ForwardEndRow['fate'] {
  if (lot.lifecycleStatusCode === 'VOIDED' || lot.statusCode === 'SCRAPPED') return 'VOIDED';
  // 아직 다음 공정에 투입되지 않은 반제품 — 계보의 끝이지만 소진이 아니다. 거쳐 간 반제품은 위에서 줄이 서지 않는다(피처 016 FR-013).
  if (lot.lotTypeCode === WIP_LOT_TYPE) return 'WIP_PENDING';
  if (shipped && stocked) return 'PARTIAL';
  if (shipped) return 'SHIPPED';
  return stocked ? 'IN_STOCK' : 'CONSUMED_OUT';
}

function group(edges: readonly TraceEdge[], by: (edge: TraceEdge) => string): Map<string, TraceEdge[]> {
  const grouped = new Map<string, TraceEdge[]>();
  for (const edge of edges) {
    const list = grouped.get(by(edge));
    if (list === undefined) grouped.set(by(edge), [edge]);
    else list.push(edge);
  }
  return grouped;
}
