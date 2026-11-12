import { Prisma } from '@prisma/client';

import { MATERIAL_LOT_BATCH_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `MaterialPackage` — 패키징 세 칸은 셋 다 있거나 다 없다(`ck_lot_package`). */
export interface MaterialPackageView {
  uomId: number;
  uomCode: string;
  count: number;
  qtyPerPackage: number;
}

export type MaterialLotChannelCode = 'POP' | 'WEB';

/** 계약 `MaterialLotSummary` — 발행·대기 목록 화면이 그리는 자재 관리 LOT 한 개. */
export interface MaterialLotSummaryView {
  lotId: number;
  lotNo: string;
  lotQty: number;
  package: MaterialPackageView | null;
  supplierLotNo: string | null;
  lifecycleStatusCode: string;
  statusCode: string;
  inboundLotId: number | null;
  inboundLotNo: string | null;
  lastLabelIssue: { issueSeq: number; issuedAt: string } | null;
  createdChannelCode: MaterialLotChannelCode;
  createdAt: string;
}

const MATERIAL_LOT_LABEL = 'MATERIAL_LOT_LABEL';
const SUPPLIER_LOT = 'SUPPLIER_LOT';

export const MATERIAL_LOT_SUMMARY_SELECT = {
  lot_id: true, lot_no: true, initial_qty: true, lifecycle_status_code: true, status_code: true,
  source_type_code: true, source_id: true, created_at: true, created_by: true,
  package_uom_id: true, package_count: true, qty_per_package: true, inbound_lot_id: true,
  package_uom: { select: { uom_code: true } },
  inbound_lot: { select: { inbound_lot_no: true } },
  lot_external_identifier: {
    where: { identifier_type_code: SUPPLIER_LOT },
    select: { external_identifier: true },
    orderBy: { lot_external_identifier_id: 'asc' },
    take: 1,
  },
  document_issue_log: {
    where: { document_type_code: MATERIAL_LOT_LABEL },
    select: { issue_seq: true, issued_at: true },
    orderBy: { issue_seq: 'desc' },
    take: 1,
  },
} satisfies Prisma.lotSelect;

export type MaterialLotSummaryRow = Prisma.lotGetPayload<{ select: typeof MATERIAL_LOT_SUMMARY_SELECT }>;

export function packageView(row: {
  package_uom_id: bigint | null; package_count: number | null; qty_per_package: Prisma.Decimal | null;
  package_uom: { uom_code: string } | null;
}): MaterialPackageView | null {
  if (row.package_uom_id === null || row.package_count === null || row.qty_per_package === null) return null;
  return {
    uomId: Number(row.package_uom_id),
    uomCode: row.package_uom?.uom_code ?? '',
    count: row.package_count,
    qtyPerPackage: Number(row.qty_per_package),
  };
}

/**
 * `channels` 는 발행 묶음 id → 채널이다. 입하로 원천이 입하 줄로 바뀐 LOT 은 묶음을 되짚을 칸이 없어
 * 만든 사람 칸으로 가른다 — 계정이면 `WEB`, 작업자(POP)는 `created_by` 가 비어 있다.
 */
export function materialLotSummaryView(
  row: MaterialLotSummaryRow,
  channels: ReadonlyMap<bigint, string>,
): MaterialLotSummaryView {
  const label = row.document_issue_log[0];
  const fromBatch = row.source_type_code === MATERIAL_LOT_BATCH_SOURCE ? channels.get(row.source_id) : undefined;
  return {
    lotId: Number(row.lot_id),
    lotNo: row.lot_no,
    lotQty: Number(row.initial_qty),
    package: packageView(row),
    supplierLotNo: row.lot_external_identifier[0]?.external_identifier ?? null,
    lifecycleStatusCode: row.lifecycle_status_code ?? 'ACTIVE',
    statusCode: row.status_code,
    inboundLotId: row.inbound_lot_id === null ? null : Number(row.inbound_lot_id),
    inboundLotNo: row.inbound_lot?.inbound_lot_no ?? null,
    lastLabelIssue: label === undefined ? null : { issueSeq: label.issue_seq, issuedAt: label.issued_at.toISOString() },
    createdChannelCode: (fromBatch ?? (row.created_by === null ? 'POP' : 'WEB')) as MaterialLotChannelCode,
    createdAt: row.created_at.toISOString(),
  };
}

/** LOT 들을 읽어 요약으로 — 묶음 채널을 한 번에 모아 읽는다. 순서는 `orderBy` 그대로다. */
export async function loadMaterialLotSummaries(
  prisma: PrismaService | Prisma.TransactionClient,
  where: Prisma.lotWhereInput,
  orderBy: Prisma.lotOrderByWithRelationInput[] = [{ lot_no: 'asc' }],
): Promise<MaterialLotSummaryView[]> {
  const rows = await prisma.lot.findMany({ where, select: MATERIAL_LOT_SUMMARY_SELECT, orderBy });
  const batchIds = [...new Set(rows.filter((row) => row.source_type_code === MATERIAL_LOT_BATCH_SOURCE)
    .map((row) => row.source_id))];
  const batches = batchIds.length === 0 ? [] : await prisma.material_lot_batch.findMany({
    where: { material_lot_batch_id: { in: batchIds } },
    select: { material_lot_batch_id: true, created_channel_code: true },
  });
  const channels = new Map(batches.map((batch) => [batch.material_lot_batch_id, batch.created_channel_code]));
  return rows.map((row) => materialLotSummaryView(row, channels));
}
