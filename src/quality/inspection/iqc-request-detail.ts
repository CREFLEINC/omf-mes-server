import { Prisma } from '@prisma/client';

import { MaterialPackageView, packageView } from '../../logistics/material-lot-batch/material-lot-view';
import { PrismaService } from '../../prisma/prisma.service';
import { INBOUND_LOT_TARGET, nextResultSequence } from './iqc-inbound-lot-result';
import { iqcOverallJudgment, judgedResults } from './iqc-overall-judgment';

/**
 * 입하 LOT 를 가진 IQC 요청의 목록·상세 칸(피처 005 §8). 칸 이름은 클라이언트 C3 이 먼저 정한 것(forward-contract)을 따른다.
 * 미리 보기·입하 칸은 새 흐름(`INBOUND_LOT` 대상) 요청만 — 이전된 옛 요청은 입하 LOT 번호·LOT 수까지만 싣는다.
 */
export interface InboundLotSummary {
  inboundLotId: number;
  inboundLotNo: string;
  lotCount: number;
  previewJudgmentCode?: string | null;
  splitFromInboundLotNo?: string | null;
  receivedAt?: string | null;
  receivedChannelCode?: 'PDA' | 'WEB' | null;
  supplierName?: string;
}

/** 계약 `InspectionRequestLot` — 입하 LOT 검사의 자재 관리 LOT 한 개. */
export interface InspectionRequestLotView {
  lotId: number;
  lotNo: string;
  lotQty: number;
  package: MaterialPackageView | null;
  statusCode: string;
  goodsReceived: boolean;
}

/** 계약 `InspectionRequestResultSummary` — 결과 목록 한 줄(R-10). */
export interface InspectionRequestResultView {
  inspectionResultId: number;
  inspectionResultNo: string;
  seqNo: number;
  confirmCycle: number | null;
  statusCode: string;
  overallJudgmentCode: string | null;
  inspectedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  heldQty: number;
  defectNames: string[];
  inspectedAt: string;
  inspectorName: string | null;
  matchedLotIds: number[];
  matchedLotNos: string[];
  versionNo: number;
}

/** 계약 `InspectionRequestPoAllocation` — 입하 LOT 의 P/O 배정(참고 · logistics `InboundLotPoAllocation` 과 같은 모양). */
export interface InspectionRequestPoAllocationView {
  purchaseOrderLineId: number;
  purchaseOrderNo: string;
  lineNo: number;
  orderDate: string;
  erpPurchaseOrderNo: string | null;
  qty: number;
}

export interface InboundLotRequestDetailView {
  inboundLotVersionNo: number;
  lots: InspectionRequestLotView[];
  poAllocations: InspectionRequestPoAllocationView[];
  unallocatedQty: number;
  results: InspectionRequestResultView[];
  nextResultSeqNo: number;
  confirmedByName: string | null;
  nonconformanceId: number | null;
  nonconformanceNo: string | null;
}

type Row = { inspection_request_id: bigint; target_type_code: string; inbound_lot_id: bigint | null; lot_id: bigint | null };

/** 목록 행의 입하 LOT 칸 — 한 번에 모아 읽는다. `lot_id` 가 있는 옛 요청은 LOT 하나다(「요청의 LOT 들」 · R-9). */
export async function inboundLotSummaries(prisma: PrismaService, rows: readonly Row[]): Promise<(InboundLotSummary | undefined)[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.inbound_lot_id == null ? [] : [row.inbound_lot_id])))];
  if (ids.length === 0) return rows.map(() => undefined);
  const newFlow = rows.filter((row) => row.target_type_code === INBOUND_LOT_TARGET).map((row) => row.inspection_request_id);
  const [lots, counts, firsts, judgments] = await Promise.all([
    prisma.inbound_lot.findMany({
      where: { inbound_lot_id: { in: ids } },
      select: {
        inbound_lot_id: true, inbound_lot_no: true,
        supplier: { select: { partner_name: true } }, split_from_inbound_lot: { select: { inbound_lot_no: true } },
      },
    }),
    prisma.lot.groupBy({ by: ['inbound_lot_id'], where: { inbound_lot_id: { in: ids } }, _count: { _all: true } }),
    // 첫 등록 — 작업자(PDA 단말)가 받았으면 PDA, 계정이면 WEB.
    prisma.inbound_lot_event.findMany({
      where: { inbound_lot_id: { in: ids }, event_type_code: 'LOTS_REGISTERED' },
      orderBy: [{ occurred_at: 'asc' }, { inbound_lot_event_id: 'asc' }],
      distinct: ['inbound_lot_id'],
      select: { inbound_lot_id: true, occurred_at: true, actor_worker_id: true },
    }),
    newFlow.length === 0
      ? Promise.resolve([] as { inspection_request_id: bigint; overall_judgment_code: string | null; status_code: string; confirmed_at: Date | null }[])
      : prisma.inspection_result.findMany({
        where: { inspection_request_id: { in: newFlow } },
        select: { inspection_request_id: true, overall_judgment_code: true, status_code: true, confirmed_at: true },
      }),
  ]);
  const lotOf = new Map(lots.map((lot) => [lot.inbound_lot_id, lot]));
  const countOf = new Map(counts.map((count) => [count.inbound_lot_id, count._count._all]));
  const firstOf = new Map(firsts.map((first) => [first.inbound_lot_id, first]));
  return rows.map((row) => {
    if (row.inbound_lot_id == null) return undefined;
    const lot = lotOf.get(row.inbound_lot_id);
    const base = {
      inboundLotId: Number(row.inbound_lot_id),
      inboundLotNo: lot?.inbound_lot_no ?? '',
      lotCount: row.lot_id === null ? (countOf.get(row.inbound_lot_id) ?? 0) : 1,
    };
    if (row.target_type_code !== INBOUND_LOT_TARGET) return base;
    const first = firstOf.get(row.inbound_lot_id);
    const results = judgedResults(judgments.filter((result) => result.inspection_request_id === row.inspection_request_id));
    return {
      ...base,
      // 결과가 없으면 null — 판정이 빈 결과가 끼어도 null(확정할 수 없음).
      previewJudgmentCode: iqcOverallJudgment(results.map((result) => ({ overallJudgmentCode: result.overall_judgment_code }))).judgmentCode,
      splitFromInboundLotNo: lot?.split_from_inbound_lot?.inbound_lot_no ?? null,
      receivedAt: first?.occurred_at.toISOString() ?? null,
      receivedChannelCode: first === undefined ? null : first.actor_worker_id === null ? 'WEB' : 'PDA',
      supplierName: lot?.supplier.partner_name,
    };
  });
}

/** 상세의 입하 LOT 검사 칸 — 새 흐름 요청만. 그 밖은 `undefined`. */
export async function inboundLotRequestDetail(
  prisma: PrismaService,
  row: Row & { confirmed_by?: bigint | null },
): Promise<InboundLotRequestDetailView | undefined> {
  if (row.target_type_code !== INBOUND_LOT_TARGET || row.inbound_lot_id == null) return undefined;
  const inboundLotId = row.inbound_lot_id;
  const [lots, received, inbound, results, nextSeqNo, confirmer, nonconformance] = await Promise.all([
    prisma.lot.findMany({
      where: { inbound_lot_id: inboundLotId },
      orderBy: { lot_no: 'asc' },
      select: {
        lot_id: true, lot_no: true, initial_qty: true, status_code: true,
        package_uom_id: true, package_count: true, qty_per_package: true, package_uom: { select: { uom_code: true, uom_name: true } },
      },
    }),
    prisma.$queryRaw<{ lot_id: bigint }[]>`
      SELECT DISTINCT grl.lot_id
        FROM logistics.goods_receipt_line grl
        JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = grl.goods_receipt_id
        JOIN trace.lot l ON l.lot_id = grl.lot_id
       WHERE l.inbound_lot_id = ${inboundLotId} AND gr.status_code <> 'CANCELLED'`,
    prisma.inbound_lot.findUniqueOrThrow({
      where: { inbound_lot_id: inboundLotId }, select: { version_no: true, inbound_receipt_line: { select: LINE_SELECT } },
    }),
    prisma.inspection_result.findMany({ where: { inspection_request_id: row.inspection_request_id }, orderBy: { inspection_round: 'asc' }, select: RESULT_SELECT }),
    nextResultSequence(prisma, row.inspection_request_id),
    row.confirmed_by == null ? null : prisma.app_user.findUnique({ where: { app_user_id: row.confirmed_by }, select: { user_name: true } }),
    prisma.nonconformance.findFirst({
      where: {
        status_code: { not: 'CANCELLED' },
        OR: [{ inspection_request_id: row.inspection_request_id }, { inspection_result: { is: { inspection_request_id: row.inspection_request_id } } }],
      },
      orderBy: { nonconformance_id: 'desc' },
      select: { nonconformance_id: true, nonconformance_no: true },
    }),
  ]);
  const receivedLots = new Set(received.map((lot) => lot.lot_id));
  const line = inbound.inbound_receipt_line;
  const allocated = line.inbound_receipt_po_allocation.reduce((sum, allocation) => sum.plus(allocation.allocated_qty), new Prisma.Decimal(0));
  return {
    inboundLotVersionNo: inbound.version_no,
    lots: lots.map((lot) => ({
      lotId: Number(lot.lot_id), lotNo: lot.lot_no, lotQty: Number(lot.initial_qty), package: packageView(lot), statusCode: lot.status_code,
      goodsReceived: receivedLots.has(lot.lot_id),
    })),
    poAllocations: line.inbound_receipt_po_allocation.map((allocation) => {
      const order = allocation.purchase_order_line.purchase_order;
      return {
        purchaseOrderLineId: Number(allocation.purchase_order_line_id), purchaseOrderNo: order.purchase_order_no,
        lineNo: allocation.purchase_order_line.line_no, orderDate: order.order_date.toISOString().slice(0, 10),
        erpPurchaseOrderNo: order.erp_purchase_order_no, qty: Number(allocation.allocated_qty),
      };
    }),
    unallocatedQty: Number(line.received_qty.minus(allocated)),
    results: results.map(resultView),
    nextResultSeqNo: nextSeqNo,
    confirmedByName: confirmer?.user_name ?? null,
    nonconformanceId: nonconformance === null ? null : Number(nonconformance.nonconformance_id),
    nonconformanceNo: nonconformance?.nonconformance_no ?? null,
  };
}

const LINE_SELECT = {
  received_qty: true,
  inbound_receipt_po_allocation: {
    orderBy: { purchase_order_line_id: 'asc' },
    select: {
      purchase_order_line_id: true, allocated_qty: true,
      purchase_order_line: {
        select: { line_no: true, purchase_order: { select: { purchase_order_no: true, order_date: true, erp_purchase_order_no: true } } },
      },
    },
  },
} satisfies Prisma.inbound_receipt_lineSelect;

const RESULT_SELECT = {
  inspection_result_id: true, inspection_result_no: true, inspection_round: true, confirm_cycle: true, status_code: true,
  overall_judgment_code: true, inspected_qty: true, accepted_qty: true, rejected_qty: true, held_qty: true, inspected_at: true,
  version_no: true, worker: { select: { worker_name: true } },
  inspection_result_lot: { orderBy: { lot_id: 'asc' }, select: { lot: { select: { lot_id: true, lot_no: true } } } },
  defect_record: { orderBy: { defect_record_id: 'asc' }, select: { defect_code: { select: { defect_name: true } } } },
} satisfies Prisma.inspection_resultSelect;

function resultView(row: Prisma.inspection_resultGetPayload<{ select: typeof RESULT_SELECT }>): InspectionRequestResultView {
  const lots = row.inspection_result_lot.map((match) => match.lot);
  return {
    inspectionResultId: Number(row.inspection_result_id),
    inspectionResultNo: row.inspection_result_no,
    seqNo: row.inspection_round,
    confirmCycle: row.confirm_cycle,
    statusCode: row.status_code,
    overallJudgmentCode: row.overall_judgment_code,
    inspectedQty: Number(row.inspected_qty),
    acceptedQty: Number(row.accepted_qty),
    rejectedQty: Number(row.rejected_qty),
    heldQty: Number(row.held_qty),
    defectNames: [...new Set(row.defect_record.map((defect) => defect.defect_code.defect_name))],
    inspectedAt: row.inspected_at.toISOString(),
    inspectorName: row.worker?.worker_name ?? null,
    matchedLotIds: lots.map((lot) => Number(lot.lot_id)),
    matchedLotNos: lots.map((lot) => lot.lot_no),
    versionNo: row.version_no,
  };
}
