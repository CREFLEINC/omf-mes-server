import { GOODS_ISSUE_SPLIT_SOURCE, SPLIT_RELATION, lotWithSplitDescendants, splitAncestors } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';

/** LOT 상세의 분할 칸(피처 008 · 계약 §7) — 단건 조회만 싣는다. */
export interface LotSplitDetail {
  parentLotNo: string | null;
  splitGoodsIssue: { goodsIssueId: number; goodsIssueNo: string; goodsIssueLineId: number; lineNo: number } | null;
  splitAt: string | null;
  splitChildCount: number;
  /** 분할 LOT 은 입하 LOT 칸이 비어 있다 — 조상의 입하 LOT 으로 채운다(FR-003). 칸이 차 있으면 손대지 않는다. */
  inbound?: { inboundLotId: number; inboundLotNo: string };
}

export async function lotSplitDetail(
  prisma: PrismaService,
  lot: { lot_id: bigint; parent_lot_id: bigint | null; source_type_code: string; source_id: bigint; inbound_lot_id: bigint | null },
): Promise<LotSplitDetail> {
  const [family, relation, parent, issueLine] = await Promise.all([
    lotWithSplitDescendants(prisma, [lot.lot_id]),
    lot.parent_lot_id === null ? null : prisma.lot_relation.findFirst({
      where: { target_lot_id: lot.lot_id, relation_type_code: SPLIT_RELATION },
      select: { occurred_at: true },
    }),
    lot.parent_lot_id === null ? null : prisma.lot.findUnique({ where: { lot_id: lot.parent_lot_id }, select: { lot_no: true } }),
    lot.source_type_code !== GOODS_ISSUE_SPLIT_SOURCE ? null : prisma.goods_issue_line.findUnique({
      where: { goods_issue_line_id: lot.source_id },
      select: { goods_issue_line_id: true, line_no: true, goods_issue: { select: { goods_issue_id: true, goods_issue_no: true } } },
    }),
  ]);
  return {
    parentLotNo: parent?.lot_no ?? null,
    splitGoodsIssue: issueLine === null ? null : {
      goodsIssueId: Number(issueLine.goods_issue.goods_issue_id), goodsIssueNo: issueLine.goods_issue.goods_issue_no,
      goodsIssueLineId: Number(issueLine.goods_issue_line_id), lineNo: issueLine.line_no,
    },
    splitAt: relation?.occurred_at.toISOString() ?? null,
    splitChildCount: family.length - 1,
    ...(lot.inbound_lot_id === null && lot.parent_lot_id !== null ? await ancestorInbound(prisma, lot.lot_id) : {}),
  };
}

async function ancestorInbound(prisma: PrismaService, lotId: bigint): Promise<Pick<LotSplitDetail, 'inbound'>> {
  const chain = (await splitAncestors(prisma, [lotId])).get(lotId) ?? [];
  const ancestors = await prisma.lot.findMany({
    where: { lot_id: { in: chain.map((row) => row.parent_lot_id) }, inbound_lot_id: { not: null } },
    select: { lot_id: true, inbound_lot: { select: { inbound_lot_id: true, inbound_lot_no: true } } },
  });
  // 가까운 조상부터 — 처음 만나는 입하 LOT.
  const nearest = chain.map((row) => ancestors.find((lot) => lot.lot_id === row.parent_lot_id)?.inbound_lot).find((lot) => lot != null);
  return nearest == null ? {} : { inbound: { inboundLotId: Number(nearest.inbound_lot_id), inboundLotNo: nearest.inbound_lot_no } };
}
