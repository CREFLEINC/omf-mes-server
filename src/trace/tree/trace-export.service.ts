import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Workbook } from 'exceljs';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { followGraph, reachableFrom } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { backwardEndRows } from './backward-end-rows';
import { backwardExpand, serialKey } from './backward-expand';
import { forwardEndRows } from './forward-end-rows';
import { TraceEdge, forwardExpand } from './forward-expand';
import { lotKey } from './trace-node-facts';
import { TraceGraph, TraceNode, TraceTreeService } from './trace-tree.service';

export interface TraceExportBody {
  plantId: number;
  lotIds: number[];
  serialNos?: Record<string, string>;
}

/** 「LOT 계보」 시트 줄 상한 — 넘으면 파일을 만들지 않는다(422). */
export const TRACE_EXPORT_ROW_CAP = 100_000;

type Cell = string | number | null;
const KIND: Record<string, string> = {
  MATERIAL_LOT: '자재 LOT', SPLIT_LOT: '분할 LOT', WORK_ORDER: 'W/O', PRODUCTION_LOT: '생산 LOT', PACKAGE: '포장', SHIPMENT: '출하', STOCK: '재고',
  SERIAL: '시리얼', COMPONENT_SERIAL: '부품 시리얼', INBOUND_LOT: '입하 LOT',
};
const BASIS: Record<string, string> = { RECORDED: '기록', LOT_GENEALOGY_ESTIMATE: '추정(계보)', WORK_ORDER_ESTIMATE: '추정(W/O 단위)' };
const FATE: Record<string, string> = { SHIPPED: '출하', IN_STOCK: '재고', PARTIAL: '출하·재고', CONSUMED_OUT: '소진', VOIDED: '폐기' };
const PARTIAL = '일부';
/* eslint-disable @typescript-eslint/no-explicit-any -- 항목 칸은 종류마다 다르다(계약 TraceGraphNode) */
const numberOf = (node: any): string => node.lot?.lotNo ?? node.workOrder?.workOrderNo ?? node.shipment?.shipmentNo ?? node.handlingUnitNo ?? node.serialNo
  ?? node.inboundLot?.inboundLotNo ?? (node.location === undefined ? node.nodeKey : `${node.warehouse.code}/${node.location.code}`);

/**
 * 목록의 LOT 들을 .xlsx 하나로(피처 015 · R-8). 기준 LOT 들을 따라가기 틀로 한 번에 따라가고(상한도 함께 센다), 기준 LOT 마다
 * 닿는 항목으로 나눠 「최종 LOT」·「LOT 계보」 시트를 쓴다. 계보 줄은 화면과 같은 규칙 — 깊이 우선, 같은 항목 두 번째부터
 * 「중복」, 조상과 같으면 「순환」으로 멈춘다. 멈춘 단계에서 펼치지 못한 LOT 이 닿는 기준 LOT 은 「일부」다.
 */
@Injectable()
export class TraceExportService {
  /** 시험이 상한을 낮춰 422 를 본다. */
  lineageRowCap = TRACE_EXPORT_ROW_CAP;

  constructor(private readonly prisma: PrismaService, private readonly trees: TraceTreeService) {}

  async build(direction: 'FORWARD' | 'BACKWARD', body: TraceExportBody): Promise<{ fileName: string; bytes: Buffer }> {
    const lotIds = [...new Set(body.lotIds.map((id) => BigInt(id)))];
    const found = await this.prisma.lot.findMany({ where: { lot_id: { in: lotIds }, plant_id: BigInt(body.plantId) }, select: { lot_id: true } });
    if (found.length !== lotIds.length) throw new NotFoundException('공장에 없는 LOT 이 있습니다. 목록을 새로 불러 다시 내보내세요.');
    const roots: string[] = [];
    for (const id of lotIds) {
      const serialNo = direction === 'BACKWARD' ? body.serialNos?.[String(id)] : undefined;
      roots.push(serialNo === undefined ? lotKey(id) : serialKey(await this.trees.rootSerial(id, serialNo)));
    }
    const raw = await followGraph({ roots, expand: direction === 'FORWARD' ? forwardExpand(this.prisma) : backwardExpand(this.prisma) });
    const graph = await this.trees.assemble(roots, raw);
    const deepest = Math.max(...raw.depthOf.values());
    const stuck = raw.limit.exceeded || raw.limit.maxDepthReached
      ? new Set([...raw.depthOf].filter(([, depth]) => depth === deepest).map(([key]) => key)) : new Set<string>();
    const nodes = new Map(graph.nodes.map((node) => [node.nodeKey, node]));
    const out = new Map<string, TraceEdge[]>();
    for (const edge of graph.edges) {
      const list = out.get(edge.from);
      if (list === undefined) out.set(edge.from, [edge]);
      else list.push(edge);
    }
    const tz = await this.plantZone(body.plantId);

    const lineage: Cell[][] = [];
    const ends: Cell[][] = [];
    roots.forEach((root, index) => {
      const within = reachableFrom(graph.edges, root);
      const partial = [...within].some((key) => stuck.has(key)) ? PARTIAL : null;
      const base = (nodes.get(lotKey(lotIds[index])) as any)?.lot?.lotNo as string;
      for (const row of lineageRows(root, nodes, out, base, partial)) {
        lineage.push(row);
        if (lineage.length > this.lineageRowCap) {
          throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [{ scope: 'screen', code: ERROR_CODE.TRACE_EXPORT_TOO_LARGE,
            message: `LOT 이 너무 많습니다 — 「LOT 계보」가 ${this.lineageRowCap.toLocaleString('en-US')}줄을 넘습니다. 조건을 좁히세요.` }]);
        }
      }
      ends.push(...(direction === 'FORWARD' ? forwardSheet(graph, within, base, partial, tz) : backwardSheet(graph, within, base, partial)));
    });

    const book = new Workbook();
    const endSheet = book.addWorksheet('최종 LOT');
    endSheet.addRow(direction === 'FORWARD'
      ? ['기준 LOT', '제품 LOT', '품목 코드', '품목명', '생산 수량', '단위', '행방', '고객', '출하번호', '출하일', '출하 수량', '창고', '위치', '재고 수량', 'W/O', 'LOT 상태', '비고']
      : ['기준 LOT', '자재 LOT', '품목 코드', '품목명', '공급사', '공급사 LOT', '입하 LOT', '입하일', 'IQC', 'W/O', '생산 LOT', '투입량', '단위', '연결 근거', 'LOT 상태', '비고']);
    ends.forEach((row) => endSheet.addRow(row));
    const lineSheet = book.addWorksheet('LOT 계보');
    lineSheet.addRow(['기준 LOT', '깊이', '단계', '번호', '품목 코드', '품목명', '수량', '단위', '부모 번호', '연결 근거', 'LOT 상태', '비고']);
    lineage.forEach((row) => lineSheet.addRow(row));
    const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date()).replace(/-/g, '').replace(' ', '-').replace(':', '');
    return { fileName: `${direction === 'FORWARD' ? 'material' : 'product'}-trace-${stamp}.xlsx`, bytes: Buffer.from(await book.xlsx.writeBuffer()) };
  }

  private async plantZone(plantId: number): Promise<string> {
    return (await this.prisma.plant.findUniqueOrThrow({ where: { plant_id: BigInt(plantId) }, select: { timezone_code: true } })).timezone_code;
  }
}

/** 기준 하나의 계보 줄 — 깊이 우선, 줄 순서는 그래프 줄 순서(화면 `graph-rows` 와 같다). */
function lineageRows(root: string, nodes: Map<string, TraceNode>, out: Map<string, TraceEdge[]>, base: string, partial: string | null): Cell[][] {
  const rows: Cell[][] = [];
  const expanded = new Set<string>();
  const path = new Set<string>();
  const line = (key: string, depth: number, edge: TraceEdge | null, parent: string | null, note: string | null): Cell[] => {
    const node = nodes.get(key) as any;
    return [base, depth, KIND[node?.kind] ?? node?.kind ?? null, node === undefined ? key : numberOf(node), node?.item?.code ?? null, node?.item?.name ?? null,
      edge === null ? (node?.qty ?? null) : edge.qty, node?.uomCode ?? null, parent, edge === null ? null : BASIS[edge.basis], node?.lot?.statusCode ?? null, note];
  };
  const visit = (key: string, depth: number, edge: TraceEdge | null, parent: string | null): void => {
    rows.push(line(key, depth, edge, parent, depth === 0 ? partial : null));
    expanded.add(key);
    path.add(key);
    const label = numberOf(nodes.get(key) ?? { nodeKey: key });
    for (const next of out.get(key) ?? []) {
      if (path.has(next.to)) rows.push(line(next.to, depth + 1, next, label, '순환 참조 — 전개 중단'));
      else if (expanded.has(next.to)) rows.push(line(next.to, depth + 1, next, label, '중복 — 위와 같음'));
      else visit(next.to, depth + 1, next, label);
    }
    path.delete(key);
  };
  visit(root, 0, null, null);
  return rows;
}

function forwardSheet(graph: TraceGraph, within: Set<string>, base: string, partial: string | null, tz: string): Cell[][] {
  const time = (at: string | null) => (at === null ? null : new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(at)));
  return forwardEndRows(graph, within).endRows.flatMap((row) => {
    const stock = [row.stock.map((one: any) => one.warehouse.code).join(', ') || null, row.stock.map((one: any) => one.location.code).join(', ') || null,
      row.stock.length === 0 ? null : row.stock.reduce((sum, one) => sum + one.qty, 0)];
    const head = [base, row.lot.lotNo, row.item.code, row.item.name, row.producedQty, row.uomCode, FATE[row.fate]];
    const tail = [row.viaWorkOrders.join(', ') || null, row.lot.statusCode, partial];
    const shipments = row.shipments.length === 0 ? [null] : row.shipments;
    return shipments.map((shipment) => [...head, shipment?.customer.name ?? null, shipment?.shipmentNo ?? null, time(shipment?.shippedAt ?? null), shipment?.qty ?? null, ...stock, ...tail]);
  });
}

function backwardSheet(graph: TraceGraph, within: Set<string>, base: string, partial: string | null): Cell[][] {
  return backwardEndRows(graph, within).endRows.map((row) => [
    base, row.lot.lotNo, row.item.code, row.item.name, row.supplier?.name ?? null, row.supplierLotNo, row.inboundLot?.inboundLotNo ?? null,
    row.inboundLot?.receivedDate ?? null, row.inboundLot?.iqcJudgmentCode ?? null, row.workOrder.workOrderNo, row.productLots.join(', ') || null,
    row.consumedQty, row.uomCode, BASIS[row.basis], row.lot.statusCode, partial,
  ]);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
