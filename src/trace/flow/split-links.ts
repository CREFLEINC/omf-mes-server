import { SplitRelationRow } from '../../core/lot/lot-genealogy';
import { PrismaService } from '../../prisma/prisma.service';
import { LotHead, lotHeads, pick } from './lot-flow-nodes';

const GOODS_ISSUE_LINE_EVENT = 'GOODS_ISSUE_LINE';

export interface SplitGoodsIssue {
  goodsIssueId: number;
  goodsIssueNo: string;
  goodsIssueLineId: number;
  lineNo: number;
}

/** 분할 관계 한 줄(피처 008 · 계약 `LotFlowSplitLink`). `lot` 은 이 관계로 이어진 «상대» LOT 이다. */
export interface SplitLink {
  relationTypeCode: 'SPLIT';
  lot: LotHead;
  qty: number;
  uomCode: string;
  splitAt: string;
  goodsIssue: SplitGoodsIssue | null;
}

/** 분할을 일으킨 출고 라인 — 출고가 아닌 분할(옛 처분 선별)은 비어 있다. */
export async function splitGoodsIssues(prisma: PrismaService, lineIds: readonly bigint[]): Promise<Map<bigint, SplitGoodsIssue>> {
  if (lineIds.length === 0) return new Map();
  const lines = await prisma.goods_issue_line.findMany({
    where: { goods_issue_line_id: { in: [...new Set(lineIds)] } },
    select: { goods_issue_line_id: true, line_no: true, goods_issue: { select: { goods_issue_id: true, goods_issue_no: true } } },
  });
  return new Map(lines.map((line) => [line.goods_issue_line_id, {
    goodsIssueId: Number(line.goods_issue.goods_issue_id), goodsIssueNo: line.goods_issue.goods_issue_no,
    goodsIssueLineId: Number(line.goods_issue_line_id), lineNo: line.line_no,
  }]));
}

/**
 * 계보 줄을 응답 모양으로 — `side` 가 `parent` 면 상대가 부모(분할된 원래 LOT), `child` 면 상대가 자식(분할 LOT)이다.
 * 노드 머리·출고는 줄 묶음으로 한 번에 읽는다.
 */
export async function splitLinks(
  prisma: PrismaService,
  rows: readonly SplitRelationRow[],
  side: 'parent' | 'child',
): Promise<SplitLink[]> {
  if (rows.length === 0) return [];
  const other = (row: SplitRelationRow) => (side === 'parent' ? row.parent_lot_id : row.child_lot_id);
  const [heads, issues] = await Promise.all([
    lotHeads(prisma, [...new Set(rows.map(other))]),
    splitGoodsIssues(prisma, rows.flatMap((row) =>
      row.source_event_type_code === GOODS_ISSUE_LINE_EVENT && row.source_event_id !== null ? [row.source_event_id] : [])),
  ]);
  return rows.map((row) => {
    const lot = pick(heads, other(row));
    return {
      relationTypeCode: 'SPLIT',
      lot,
      qty: Number(row.qty),
      uomCode: lot.uomCode,
      splitAt: row.occurred_at.toISOString(),
      goodsIssue: row.source_event_type_code === GOODS_ISSUE_LINE_EVENT && row.source_event_id !== null
        ? (issues.get(row.source_event_id) ?? null) : null,
    };
  });
}
