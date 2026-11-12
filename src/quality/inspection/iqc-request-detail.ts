import { Prisma } from '@prisma/client';

import { MaterialPackageView, packageView } from '../../logistics/material-lot-batch/material-lot-view';
import { PrismaService } from '../../prisma/prisma.service';
import { INBOUND_LOT_TARGET } from './iqc-inbound-lot-result';
import { iqcOverallJudgment } from './iqc-overall-judgment';

/** 계약 `InspectionRequestLot` — 입하 LOT 검사의 자재 관리 LOT 한 개. */
export interface InspectionRequestLotView {
  lotId: number;
  lotNo: string;
  lotQty: number;
  package: MaterialPackageView | null;
  statusCode: string;
}

/** 계약 `InspectionRequestResultSummary` — 입하 LOT 검사의 결과 목록 한 줄(R-10). */
export interface InspectionRequestResultView {
  inspectionResultId: number;
  inspectionResultNo: string;
  inspectionRound: number;
  confirmCycle: number | null;
  statusCode: string;
  overallJudgmentCode: string | null;
  inspectedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  heldQty: number;
  inspectedAt: string;
  inspectorName: string;
  matchedLotIds: number[];
  matchedLotNos: string[];
  versionNo: number;
}

/** 계약 `InspectionRequestPoAllocation` — 입하 LOT 의 P/O 배정(참고). */
export interface InspectionRequestPoAllocationView {
  purchaseOrderLineId: number;
  purchaseOrderNo: string;
  lineNo: number;
  qty: number;
}

export interface InboundLotRequestDetailView {
  lots: InspectionRequestLotView[];
  poAllocations: InspectionRequestPoAllocationView[];
  unallocatedQty: number;
  results: InspectionRequestResultView[];
  previewJudgmentCode: string | null;
}

/** 목록 행의 입하 LOT 칸 — 번호·LOT 수. `lot_id` 가 있는 옛 요청은 LOT 하나다(「요청의 LOT 들」 · R-9). */
export async function inboundLotSummaries(
  prisma: PrismaService,
  rows: readonly { inbound_lot_id: bigint | null; lot_id: bigint | null }[],
): Promise<({ inboundLotId: number; inboundLotNo: string; lotCount: number } | undefined)[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.inbound_lot_id == null ? [] : [row.inbound_lot_id])))];
  if (ids.length === 0) return rows.map(() => undefined);
  const [lots, counts] = await Promise.all([
    prisma.inbound_lot.findMany({ where: { inbound_lot_id: { in: ids } }, select: { inbound_lot_id: true, inbound_lot_no: true } }),
    prisma.lot.groupBy({ by: ['inbound_lot_id'], where: { inbound_lot_id: { in: ids } }, _count: { _all: true } }),
  ]);
  const noOf = new Map(lots.map((lot) => [lot.inbound_lot_id, lot.inbound_lot_no]));
  const countOf = new Map(counts.map((count) => [count.inbound_lot_id, count._count._all]));
  return rows.map((row) => {
    if (row.inbound_lot_id == null) return undefined;
    return {
      inboundLotId: Number(row.inbound_lot_id),
      inboundLotNo: noOf.get(row.inbound_lot_id) ?? '',
      lotCount: row.lot_id === null ? (countOf.get(row.inbound_lot_id) ?? 0) : 1,
    };
  });
}

/** 상세의 입하 LOT 검사 칸(§8) — 새 흐름 요청(`INBOUND_LOT` 대상)만. 그 밖은 `undefined`. */
export async function inboundLotRequestDetail(
  prisma: PrismaService,
  row: { inspection_request_id: bigint; target_type_code: string; inbound_lot_id: bigint | null },
): Promise<InboundLotRequestDetailView | undefined> {
  if (row.target_type_code !== INBOUND_LOT_TARGET || row.inbound_lot_id === null) return undefined;
  const [lots, line, results] = await Promise.all([
    prisma.lot.findMany({
      where: { inbound_lot_id: row.inbound_lot_id },
      orderBy: { lot_no: 'asc' },
      select: {
        lot_id: true, lot_no: true, initial_qty: true, status_code: true,
        package_uom_id: true, package_count: true, qty_per_package: true, package_uom: { select: { uom_code: true, uom_name: true } },
      },
    }),
    prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: row.inbound_lot_id }, select: { inbound_receipt_line: { select: LINE_SELECT } } }),
    prisma.inspection_result.findMany({
      where: { inspection_request_id: row.inspection_request_id },
      orderBy: { inspection_round: 'asc' },
      select: RESULT_SELECT,
    }),
  ]);
  const receiptLine = line.inbound_receipt_line;
  const allocated = receiptLine.inbound_receipt_po_allocation.reduce((sum, allocation) => sum.plus(allocation.allocated_qty), new Prisma.Decimal(0));
  return {
    lots: lots.map((lot) => ({
      lotId: Number(lot.lot_id), lotNo: lot.lot_no, lotQty: Number(lot.initial_qty), package: packageView(lot), statusCode: lot.status_code,
    })),
    poAllocations: receiptLine.inbound_receipt_po_allocation.map((allocation) => ({
      purchaseOrderLineId: Number(allocation.purchase_order_line_id),
      purchaseOrderNo: allocation.purchase_order_line.purchase_order.purchase_order_no,
      lineNo: allocation.purchase_order_line.line_no,
      qty: Number(allocation.allocated_qty),
    })),
    unallocatedQty: Number(receiptLine.received_qty.minus(allocated)),
    results: results.map(resultView),
    previewJudgmentCode: iqcOverallJudgment(results.map((result) => ({ overallJudgmentCode: result.overall_judgment_code }))).judgmentCode,
  };
}

const LINE_SELECT = {
  received_qty: true,
  inbound_receipt_po_allocation: {
    orderBy: { purchase_order_line_id: 'asc' },
    select: {
      purchase_order_line_id: true, allocated_qty: true,
      purchase_order_line: { select: { line_no: true, purchase_order: { select: { purchase_order_no: true } } } },
    },
  },
} satisfies Prisma.inbound_receipt_lineSelect;

const RESULT_SELECT = {
  inspection_result_id: true, inspection_result_no: true, inspection_round: true, confirm_cycle: true, status_code: true,
  overall_judgment_code: true, inspected_qty: true, accepted_qty: true, rejected_qty: true, held_qty: true, inspected_at: true,
  version_no: true, worker: { select: { worker_name: true } },
  inspection_result_lot: { orderBy: { lot_id: 'asc' }, select: { lot: { select: { lot_id: true, lot_no: true } } } },
} satisfies Prisma.inspection_resultSelect;

function resultView(row: Prisma.inspection_resultGetPayload<{ select: typeof RESULT_SELECT }>): InspectionRequestResultView {
  const lots = row.inspection_result_lot.map((match) => match.lot);
  return {
    inspectionResultId: Number(row.inspection_result_id),
    inspectionResultNo: row.inspection_result_no,
    inspectionRound: row.inspection_round,
    confirmCycle: row.confirm_cycle,
    statusCode: row.status_code,
    overallJudgmentCode: row.overall_judgment_code,
    inspectedQty: Number(row.inspected_qty),
    acceptedQty: Number(row.accepted_qty),
    rejectedQty: Number(row.rejected_qty),
    heldQty: Number(row.held_qty),
    inspectedAt: row.inspected_at.toISOString(),
    inspectorName: row.worker.worker_name,
    matchedLotIds: lots.map((lot) => Number(lot.lot_id)),
    matchedLotNos: lots.map((lot) => lot.lot_no),
    versionNo: row.version_no,
  };
}
