import { GOODS_ISSUE_SPLIT_SOURCE, SPLIT_RELATION, lotWithSplitDescendants, productionRootOf, splitAncestors } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';

/** LOT 상세의 분할 칸(피처 008 · 계약 §7) — 단건 조회만 싣는다. */
export interface LotSplitDetail {
  parentLotNo: string | null;
  splitGoodsIssue: { goodsIssueId: number; goodsIssueNo: string; goodsIssueLineId: number; lineNo: number } | null;
  splitAt: string | null;
  splitChildCount: number;
  /** 제품 분리(피처 013) — 자식이면 자기 분리, 원래 LOT 이면 가장 최근 분리. 없으면 null. */
  productLotSplit: ProductLotSplitDetail | null;
  /** 분할 LOT 은 입하 LOT 칸이 비어 있다 — 조상의 입하 LOT 으로 채운다(FR-003). 칸이 차 있으면 손대지 않는다. */
  inbound?: { inboundLotId: number; inboundLotNo: string };
}

export interface ProductLotSplitDetail {
  productLotSplitId: number;
  role: 'PARENT' | 'CHILD';
  splitQty: number;
  splitAt: string;
  splitWorkerNo: string | null;
  splitTerminalCode: string | null;
  location: { locationId: number; locationCode: string; warehouseCode: string; warehouseName: string };
  confirmedAt: string | null;
  confirmedWorkerNo: string | null;
  /** 생산 뿌리(원천 W/O LOT)의 W/O. */
  workOrderNo: string | null;
}

export async function lotSplitDetail(
  prisma: PrismaService,
  lot: { lot_id: bigint; parent_lot_id: bigint | null; source_type_code: string; source_id: bigint; inbound_lot_id: bigint | null },
): Promise<LotSplitDetail> {
  const [family, relation, parent, issueLine, productLotSplit] = await Promise.all([
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
    productLotSplitOf(prisma, lot.lot_id),
  ]);
  return {
    parentLotNo: parent?.lot_no ?? null,
    splitGoodsIssue: issueLine === null ? null : {
      goodsIssueId: Number(issueLine.goods_issue.goods_issue_id), goodsIssueNo: issueLine.goods_issue.goods_issue_no,
      goodsIssueLineId: Number(issueLine.goods_issue_line_id), lineNo: issueLine.line_no,
    },
    splitAt: relation?.occurred_at.toISOString() ?? null,
    splitChildCount: family.length - 1,
    productLotSplit,
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

async function productLotSplitOf(prisma: PrismaService, lotId: bigint): Promise<ProductLotSplitDetail | null> {
  const select = {
    product_lot_split_id: true, child_lot_id: true, split_qty: true, split_at: true, split_worker_no: true, confirmed_at: true,
    confirmed_worker_no: true, location_id: true, location: { select: { location_code: true, warehouse: { select: { warehouse_code: true, warehouse_name: true } } } },
    split_terminal: { select: { terminal_code: true } },
  } as const;
  const row = await prisma.product_lot_split.findUnique({ where: { child_lot_id: lotId }, select })
    ?? await prisma.product_lot_split.findFirst({ where: { parent_lot_id: lotId }, orderBy: [{ split_at: 'desc' }, { product_lot_split_id: 'desc' }], select });
  if (row === null) return null;
  const root = (await productionRootOf(prisma, [lotId])).get(lotId) ?? null;
  const workOrder = root === null ? null
    : await prisma.work_order.findUnique({ where: { work_order_id: root.workOrderId }, select: { work_order_no: true } });
  return {
    productLotSplitId: Number(row.product_lot_split_id),
    role: row.child_lot_id === lotId ? 'CHILD' : 'PARENT',
    splitQty: Number(row.split_qty),
    splitAt: row.split_at.toISOString(),
    splitWorkerNo: row.split_worker_no,
    splitTerminalCode: row.split_terminal?.terminal_code ?? null,
    location: {
      locationId: Number(row.location_id), locationCode: row.location.location_code,
      warehouseCode: row.location.warehouse.warehouse_code, warehouseName: row.location.warehouse.warehouse_name,
    },
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    confirmedWorkerNo: row.confirmed_worker_no,
    workOrderNo: workOrder?.work_order_no ?? null,
  };
}
