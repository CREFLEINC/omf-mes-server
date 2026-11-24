import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Workbook } from 'exceljs';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { followGraph, reachableFrom } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { backwardEndRows } from './backward-end-rows';
import { backwardExpand, serialKey } from './backward-expand';
import { forwardEndRows } from './forward-end-rows';
import { TraceEdge, forwardExpand } from './forward-expand';
import { ExportLanguage, LineageStage, exportLabels, named } from './trace-export-labels';
import { lotKey } from './trace-node-facts';
import { TraceGraph, TraceNode, TraceTreeService } from './trace-tree.service';

export interface TraceExportBody {
  plantId: number;
  lotIds: number[];
  serialNos?: Record<string, string>;
  language?: ExportLanguage;
}

/** 「LOT 계보」 시트 줄 상한 — 넘으면 파일을 만들지 않는다(422). */
export const TRACE_EXPORT_ROW_CAP = 100_000;

type Cell = string | number | null;
/* eslint-disable @typescript-eslint/no-explicit-any -- 항목 칸은 종류마다 다르다(계약 TraceGraphNode) */
const numberOf = (node: any): string => node.lot?.lotNo ?? node.workOrder?.workOrderNo ?? node.shipment?.shipmentNo ?? node.handlingUnitNo ?? node.serialNo
  ?? node.inboundLot?.inboundLotNo ?? (node.location === undefined ? node.nodeKey : `${named(node.warehouse)} / ${named(node.location)}`);

/** 시트 문맥 — 언어 문구와 LOT 상태 코드 이름(LOT_STATUS 공통코드). */
interface SheetContext {
  labels: ReturnType<typeof exportLabels>;
  status: (code: string | null | undefined) => string | null;
}

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

  async build(direction: 'FORWARD' | 'BACKWARD', body: TraceExportBody, language: ExportLanguage): Promise<{ fileName: string; bytes: Buffer }> {
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
    const context: SheetContext = { labels: exportLabels(language), status: await this.statusNames(language) };
    const { labels } = context;

    const lineage: Cell[][] = [];
    const ends: Cell[][] = [];
    roots.forEach((root, index) => {
      const within = reachableFrom(graph.edges, root);
      const partial = [...within].some((key) => stuck.has(key)) ? labels.partial : null;
      const base = (nodes.get(lotKey(lotIds[index])) as any)?.lot?.lotNo as string;
      for (const row of lineageRows(root, nodes, out, base, partial, context)) {
        lineage.push(row);
        if (lineage.length > this.lineageRowCap) {
          throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [{ scope: 'screen', code: ERROR_CODE.TRACE_EXPORT_TOO_LARGE,
            message: `LOT 이 너무 많습니다 — 「LOT 계보」가 ${this.lineageRowCap.toLocaleString('en-US')}줄을 넘습니다. 조건을 좁히세요.` }]);
        }
      }
      ends.push(...(direction === 'FORWARD' ? forwardSheet(graph, within, base, partial, tz, context) : backwardSheet(graph, within, base, partial, context)));
    });

    const book = new Workbook();
    writeSheet(book, labels.sheets.end, direction === 'FORWARD' ? labels.forwardHead : labels.backwardHead, ends);
    writeSheet(book, labels.sheets.lineage, labels.lineageHead, lineage);
    const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date()).replace(/-/g, '').replace(' ', '-').replace(':', '');
    return { fileName: `${direction === 'FORWARD' ? 'material' : 'product'}-trace-${stamp}.xlsx`, bytes: Buffer.from(await book.xlsx.writeBuffer()) };
  }

  /** LOT 상태 코드 → 공통코드 이름(LOT_STATUS). 언어 이름이 비면 기본 이름, 사전에 없으면 코드 그대로. */
  private async statusNames(language: ExportLanguage): Promise<(code: string | null | undefined) => string | null> {
    const rows = await this.prisma.$queryRawUnsafe<{ code: string; name: string }[]>(
      `SELECT cv.code, COALESCE(${language === 'vi' ? 'cv.name_vi' : 'cv.name_ko'}, cv.code_name) AS name
         FROM mdm.code_value cv JOIN mdm.code_group cg ON cg.code_group_id = cv.code_group_id WHERE cg.group_code = 'LOT_STATUS'`,
    );
    const names = new Map(rows.map((row) => [row.code, row.name]));
    return (code) => (code === null || code === undefined ? null : (names.get(code) ?? code));
  }

  private async plantZone(plantId: number): Promise<string> {
    return (await this.prisma.plant.findUniqueOrThrow({ where: { plant_id: BigInt(plantId) }, select: { timezone_code: true } })).timezone_code;
  }
}

/**
 * 계보 줄의 단계 이름 — 화면 `graph-rows` 와 같은 규칙. 008 분할(출고 번호 있음·자재 LOT)은 「분할 LOT」, 출고 번호 없는 생산 LOT 자식은
 * 013 「분리 LOT」, 역방향에서 자식이 가리키는 원래 LOT 은 자식 갈래를 따라 「분할된/분리된 원래 LOT」, 다음 W/O 에 투입된 생산 LOT 은 「반제품 LOT」.
 */
function stageOf(node: any, edge: TraceEdge | null, out: Map<string, TraceEdge[]>, parentStage: LineageStage | null): LineageStage {
  if (edge?.kind === 'SPLIT_FROM') return parentStage === 'SEPARATED_LOT' ? 'SEPARATED_ORIGIN' : 'SPLIT_ORIGIN';
  if (node === undefined) return 'PRODUCTION_LOT';
  if (node.kind === 'SPLIT_LOT') return (node.split?.goodsIssueNo ?? null) === null && node.lot?.lotTypeCode !== 'MATERIAL' ? 'SEPARATED_LOT' : 'SPLIT_LOT';
  if (node.kind === 'PRODUCTION_LOT' && (edge?.kind === 'CONSUMED' || (out.get(node.nodeKey) ?? []).some((next) => next.kind === 'CONSUMED'))) return 'SEMI_LOT';
  return node.kind as LineageStage;
}

/** 기준 하나의 계보 줄 — 깊이 우선, 줄 순서는 그래프 줄 순서(화면 `graph-rows` 와 같다). */
function lineageRows(
  root: string, nodes: Map<string, TraceNode>, out: Map<string, TraceEdge[]>, base: string, partial: string | null, { labels, status }: SheetContext,
): Cell[][] {
  const rows: Cell[][] = [];
  const expanded = new Set<string>();
  const path = new Set<string>();
  const line = (key: string, depth: number, edge: TraceEdge | null, parent: string | null, stage: LineageStage, note: string | null): Cell[] => {
    const node = nodes.get(key) as any;
    return [base, depth, labels.stages[stage], node === undefined ? key : numberOf(node), node?.item?.code ?? null, node?.item?.name ?? null,
      edge === null ? (node?.qty ?? null) : edge.qty, node?.uomCode ?? null, parent, edge === null ? null : labels.basis[edge.basis], status(node?.lot?.statusCode), note];
  };
  const visit = (key: string, depth: number, edge: TraceEdge | null, parent: string | null, parentStage: LineageStage | null): void => {
    const stage = stageOf(nodes.get(key), edge, out, parentStage);
    rows.push(line(key, depth, edge, parent, stage, depth === 0 ? partial : null));
    expanded.add(key);
    path.add(key);
    const label = numberOf(nodes.get(key) ?? { nodeKey: key });
    for (const next of out.get(key) ?? []) {
      const childStage = stageOf(nodes.get(next.to), next, out, stage);
      if (path.has(next.to)) rows.push(line(next.to, depth + 1, next, label, childStage, labels.cycle));
      else if (expanded.has(next.to)) rows.push(line(next.to, depth + 1, next, label, childStage, labels.duplicate));
      else visit(next.to, depth + 1, next, label, stage);
    }
    path.delete(key);
  };
  visit(root, 0, null, null, null);
  return rows;
}

function forwardSheet(graph: TraceGraph, within: Set<string>, base: string, partial: string | null, tz: string, { labels, status }: SheetContext): Cell[][] {
  const time = (at: string | null) => (at === null ? null : new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(at)));
  return forwardEndRows(graph, within).endRows.flatMap((row) => {
    const stock = [row.stock.map((one: any) => named(one.warehouse)).join(', ') || null, row.stock.map((one: any) => named(one.location)).join(', ') || null,
      row.stock.length === 0 ? null : row.stock.reduce((sum, one) => sum + one.qty, 0)];
    const head = [base, row.lot.lotNo, row.item.code, row.item.name, row.producedQty, row.uomCode, labels.fates[row.fate]];
    const tail = [row.viaWorkOrders.join(', ') || null, status(row.lot.statusCode), partial];
    const shipments = row.shipments.length === 0 ? [null] : row.shipments;
    return shipments.map((shipment) => [...head, shipment?.customer.name ?? null, shipment?.shipmentNo ?? null, time(shipment?.shippedAt ?? null), shipment?.qty ?? null, ...stock, ...tail]);
  });
}

function backwardSheet(graph: TraceGraph, within: Set<string>, base: string, partial: string | null, { labels, status }: SheetContext): Cell[][] {
  return backwardEndRows(graph, within).endRows.map((row) => [
    base, row.lot.lotNo, row.item.code, row.item.name, row.supplier?.name ?? null, row.supplierLotNo, row.inboundLot?.inboundLotNo ?? null,
    row.inboundLot?.receivedDate ?? null, row.inboundLot?.iqcJudgmentCode ?? null, row.workOrder.workOrderNo, row.productLots.join(', ') || null,
    row.consumedQty, row.uomCode, labels.basis[row.basis], status(row.lot.statusCode), partial,
  ]);
}

/** 시트 하나 — 머리 굵게, 숫자 칸은 천 단위 표시(정수는 소수 없이). */
function writeSheet(book: Workbook, name: string, head: string[], rows: Cell[][]): void {
  const sheet = book.addWorksheet(name);
  sheet.addRow(head).font = { bold: true };
  for (const values of rows) {
    const row = sheet.addRow(values);
    values.forEach((value, index) => {
      if (typeof value === 'number') row.getCell(index + 1).numFmt = Number.isInteger(value) ? '#,##0' : '#,##0.0#####';
    });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
