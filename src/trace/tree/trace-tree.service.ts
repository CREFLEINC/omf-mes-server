import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, field } from '../../common/errors';

import { GraphLimit, TraceGraphResult, followGraph } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { BackwardEndRow, BackwardSummary, backwardEndRows } from './backward-end-rows';
import { backwardExpand, serialKey } from './backward-expand';
import { ForwardEndRow, ForwardSummary, forwardEndRows } from './forward-end-rows';
import { TraceEdge, TraceNodeBody, TraceOtherNode, forwardExpand } from './forward-expand';
import { SHIPMENT_DONE } from './trace-lot-row';
import { TraceLotNode, lotKey, lotNodes } from './trace-node-facts';

export interface TraceTreeQuery {
  plantId: number;
  lotId: number;
  serialNo?: string;
}

/** 고른 LOT 의 출하(출하 완료분) — 역방향 화면 요약에 보인다. 계보에는 넣지 않는다. */
export interface RootShipment {
  shipmentNo: string;
  customer: { partnerId: number; code: string; name: string };
  shippedAt: string;
  qty: number;
}

export type TraceNode = TraceLotNode | TraceNodeBody;

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

  async forward(query: TraceTreeQuery): Promise<TraceGraph & { endRows: ForwardEndRow[]; summary: ForwardSummary }> {
    const root = await this.rootLot(query);
    const graph = await this.assemble(lotKey(root), await followGraph({ roots: [lotKey(root)], expand: forwardExpand(this.prisma) }));
    return { ...graph, ...forwardEndRows(graph) };
  }

  async backward(query: TraceTreeQuery): Promise<TraceGraph & { endRows: BackwardEndRow[]; summary: BackwardSummary; rootShipments: RootShipment[] }> {
    const lot = await this.rootLot(query);
    const root = query.serialNo === undefined ? lotKey(lot) : serialKey(await this.rootSerial(lot, query.serialNo));
    const graph = await this.assemble(root, await followGraph({ roots: [root], expand: backwardExpand(this.prisma) }));
    return { ...graph, ...backwardEndRows(graph), rootShipments: await this.rootShipments(lot) };
  }

  /** 시리얼로 들어온 줄 — 그 LOT 의 시리얼이어야 한다(아니면 400, 없으면 404). */
  async rootSerial(lotId: bigint, serialNo: string): Promise<bigint> {
    const serial = await this.prisma.serial_number.findUnique({ where: { serial_no: serialNo }, select: { serial_number_id: true, lot_id: true } });
    if (serial === null) throw new NotFoundException('없는 시리얼입니다. 시리얼 번호를 확인해 다시 조회하세요.');
    if (serial.lot_id !== lotId) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('serialNo', ERROR_CODE.INVALID, '이 LOT 의 시리얼이 아닙니다. 시리얼로 들어온 LOT 을 다시 고르세요.')]);
    }
    return serial.serial_number_id;
  }

  private async rootShipments(lotId: bigint): Promise<RootShipment[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ shipment_no: string; partner_id: bigint; partner_code: string; partner_name: string; shipped_at: Date; qty: unknown }[]>(
      `SELECT s.shipment_no, c.partner_id, c.partner_code, c.partner_name, s.shipped_at, SUM(a.allocated_qty) AS qty
         FROM logistics.shipment_lot_allocation a
         JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
         JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
         JOIN logistics.shipment_request sr ON sr.shipment_request_id = s.shipment_request_id
         JOIN mdm.partner c ON c.partner_id = sr.customer_id
        WHERE a.lot_id = $1::bigint AND ${SHIPMENT_DONE('s')}
        GROUP BY s.shipment_id, c.partner_id ORDER BY s.shipped_at, s.shipment_id`, lotId,
    );
    return rows.map((row) => ({ shipmentNo: row.shipment_no, customer: { partnerId: Number(row.partner_id), code: row.partner_code, name: row.partner_name },
      shippedAt: row.shipped_at.toISOString(), qty: Number(row.qty) }));
  }

  async rootLot(query: TraceTreeQuery): Promise<bigint> {
    const lot = await this.prisma.lot.findUnique({ where: { lot_id: BigInt(query.lotId) }, select: { lot_id: true, plant_id: true } });
    if (lot === null || lot.plant_id !== BigInt(query.plantId)) throw lotNotFound();
    return lot.lot_id;
  }

  /** 그래프 결과를 응답 모양으로 — LOT 항목은 따라간 LOT(depthOf) 전부를 한 번에 읽는다. 기준이 여럿이면(내보내기) 모두 앞에 둔다. */
  async assemble(roots: string | string[], graph: TraceGraphResult<TraceOtherNode, TraceEdge>): Promise<TraceGraph> {
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
    const starts = typeof roots === 'string' ? [roots] : roots;
    starts.forEach(push);
    for (const edge of graph.edges) {
      push(edge.from);
      push(edge.to);
    }
    const lotCount = lotIds.length;
    return { root: starts[0], nodes, edges: graph.edges, limit: { ...graph.limit, lotCount } };
  }
}
