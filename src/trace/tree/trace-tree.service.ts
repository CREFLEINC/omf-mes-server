import { Injectable, NotFoundException } from '@nestjs/common';

import { GraphLimit, TraceGraphResult, followGraph } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { TraceEdge, TraceOtherNode, forwardExpand } from './forward-expand';
import { TraceLotNode, lotKey, lotNodes } from './trace-node-facts';

export interface TraceTreeQuery {
  plantId: number;
  lotId: number;
}

export type TraceNode = TraceLotNode | Omit<TraceOtherNode, 'key'>;

export interface TraceGraph {
  root: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  limit: GraphLimit;
}

/** 공장에 없는 LOT — 다른 공장 LOT 도 없는 것과 같다(R-11). */
export function lotNotFound(): NotFoundException {
  return new NotFoundException('없는 LOT 입니다. LOT 번호를 확인해 다시 조회하세요.');
}

/**
 * LOT 하나의 계보(피처 015 · R-2) — 따라가기 틀(`followGraph`)에 방향별 단계 확장을 끼우고, 다 따라간 뒤 LOT 항목을 묶음으로 읽는다.
 * 항목은 뿌리 → 처음 닿은 순서, 같은 LOT·W/O 는 한 항목이다.
 */
@Injectable()
export class TraceTreeService {
  constructor(private readonly prisma: PrismaService) {}

  async forward(query: TraceTreeQuery): Promise<TraceGraph> {
    const root = await this.rootLot(query);
    const graph = await followGraph({ roots: [lotKey(root)], expand: forwardExpand(this.prisma) });
    return this.assemble(lotKey(root), graph);
  }

  async rootLot(query: TraceTreeQuery): Promise<bigint> {
    const lot = await this.prisma.lot.findUnique({ where: { lot_id: BigInt(query.lotId) }, select: { lot_id: true, plant_id: true } });
    if (lot === null || lot.plant_id !== BigInt(query.plantId)) throw lotNotFound();
    return lot.lot_id;
  }

  /** 그래프 결과를 응답 모양으로 — LOT 항목은 따라간 LOT(depthOf) 전부를 한 번에 읽는다. */
  async assemble(root: string, graph: TraceGraphResult<TraceOtherNode, TraceEdge>): Promise<TraceGraph> {
    const lotIds = [...graph.depthOf.keys()].filter((key) => key.startsWith('L:')).map((key) => BigInt(key.slice(2)));
    const lots = await lotNodes(this.prisma, lotIds);
    const nodes: TraceNode[] = [];
    const seen = new Set<string>();
    const push = (key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      const lot = key.startsWith('L:') ? lots.get(BigInt(key.slice(2))) : undefined;
      if (lot !== undefined) return nodes.push(lot);
      const other = graph.nodes.get(key);
      if (other === undefined) return;
      const { key: _drop, ...rest } = other;
      nodes.push(rest);
    };
    push(root);
    for (const edge of graph.edges) {
      push(edge.from);
      push(edge.to);
    }
    return { root, nodes, edges: graph.edges, limit: graph.limit };
  }
}
