import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { Tx } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { remainingSummary } from './disposition-rollup';

/** 계약 `DispositionApproval`(omf-all-around#352). */
export interface DispositionApprovalView {
  dispositionApprovalId: number;
  nonconformanceId: number;
  dispositionTypeCode: string;
  decisionQty: number | null;
  uomId: number | null;
  uomCode: string | null;
  lotIds: number[];
  lots: { lotId: number; lotNo: string }[];
  goodQty: number | null;
  defectQty: number | null;
  reason: string;
  approvalRequestId: number;
  /** 결재 요청의 상태(`app.approval_request.status_code`) — 이 행의 `statusCode` 와 축이 다르다(반영 전 승인이 있다). */
  approvalStatusCode: string;
  statusCode: string;
  dispositionDecisionId: number | null;
  requestedByName: string;
  createdAt: string;
}

const SELECT = {
  disposition_approval_id: true, nonconformance_id: true, disposition_type_code: true, decision_qty: true, uom_id: true,
  lot_ids: true, good_qty: true, defect_qty: true, reason: true, approval_request_id: true, status_code: true,
  disposition_decision_id: true, created_at: true,
  uom: { select: { uom_code: true } },
  approval_request: { select: { status_code: true } },
  created_by_user: { select: { user_name: true } },
} satisfies Prisma.disposition_approvalSelect;

type Row = Prisma.disposition_approvalGetPayload<{ select: typeof SELECT }>;

const num = (value: Prisma.Decimal | null): number | null => (value === null ? null : value.toNumber());
// Prisma 목록 칸은 NULL 을 빈 배열로 접지 않을 수 있다 — 폐기 행은 `lot_ids` 가 NULL 이다.
const lotIdsOf = (row: { lot_ids: bigint[] | null }): bigint[] => row.lot_ids ?? [];

/** 최신 먼저. 행의 LOT 번호는 한 번에 모아 찾는다. */
export async function dispositionApprovalViews(
  db: PrismaService | Tx, where: Prisma.disposition_approvalWhereInput,
): Promise<DispositionApprovalView[]> {
  const rows = await db.disposition_approval.findMany({ where, select: SELECT, orderBy: { disposition_approval_id: 'desc' } });
  const lotIds = [...new Set(rows.flatMap((row) => lotIdsOf(row)))];
  const lots = lotIds.length === 0 ? [] : await db.lot.findMany({ where: { lot_id: { in: lotIds } }, select: { lot_id: true, lot_no: true } });
  const lotNos = new Map(lots.map((lot) => [lot.lot_id, lot.lot_no]));
  return rows.map((row) => toView(row, lotNos));
}

function toView(row: Row, lotNos: ReadonlyMap<bigint, string>): DispositionApprovalView {
  const lotIds = lotIdsOf(row);
  return {
    dispositionApprovalId: Number(row.disposition_approval_id),
    nonconformanceId: Number(row.nonconformance_id),
    dispositionTypeCode: row.disposition_type_code,
    decisionQty: num(row.decision_qty),
    uomId: row.uom_id === null ? null : Number(row.uom_id),
    uomCode: row.uom?.uom_code ?? null,
    lotIds: lotIds.map(Number),
    lots: lotIds.map((lotId) => ({ lotId: Number(lotId), lotNo: lotNos.get(lotId) ?? '' })),
    goodQty: num(row.good_qty),
    defectQty: num(row.defect_qty),
    reason: row.reason,
    approvalRequestId: Number(row.approval_request_id),
    approvalStatusCode: row.approval_request.status_code,
    statusCode: row.status_code,
    dispositionDecisionId: row.disposition_decision_id === null ? null : Number(row.disposition_decision_id),
    requestedByName: row.created_by_user.user_name,
    createdAt: row.created_at.toISOString(),
  };
}

/** 계약 `ApprovalNonconformanceSummary` — 결재함(W-03-09) 결재자가 승인 전에 보는 부적합 요약. */
export interface ApprovalNonconformanceSummary {
  nonconformanceId: number;
  nonconformanceNo: string;
  statusCode: string;
  itemCode: string;
  itemName: string;
  inspectionTypeCode: string | null;
  description: string;
  uomCode: string | null;
  affectedQtyTotal: number;
  remainingQty: number;
  lots: { lotId: number; lotNo: string; affectedQty: number }[];
  approvalTypeCode: string;
  dispositionApproval: DispositionApprovalView | null;
  concession: { concessionNos: string[]; approvedQty: number; validFrom: string; validTo: string | null; reason: string } | null;
}

const NONCONFORMANCE = 'NONCONFORMANCE';
const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * ⭐ 결재 대상이 부적합인 요청만(특채·처분) — 그 밖의 결재·없는 결재는 404. 403 게이트는 두지 않는다 — 결재함을 연 사람이면
 * 누구나 본다(omf-all-around#352). 잔량은 처분 화면과 같은 `remainingSummary` 다. 응답 ETag 는 부적합 `version_no`(`:apply` 의 If-Match).
 */
export async function approvalNonconformanceSummary(
  prisma: PrismaService, approvalRequestId: number,
): Promise<{ summary: ApprovalNonconformanceSummary; versionNo: number }> {
  const approval = await prisma.approval_request.findUnique({
    where: { approval_request_id: BigInt(approvalRequestId) },
    select: { approval_request_id: true, approval_type_code: true, target_type_code: true, target_id: true, reason: true },
  });
  if (approval === null || approval.target_type_code !== NONCONFORMANCE) throw new NotFoundException('부적합 결재가 아닙니다.');
  const nc = await prisma.nonconformance.findUnique({
    where: { nonconformance_id: approval.target_id },
    select: {
      nonconformance_id: true, nonconformance_no: true, status_code: true, description: true, version_no: true,
      item: { select: { item_code: true, item_name: true, base_uom_id: true } },
      inspection_request: { select: { inspection_type_code: true } },
      nonconformance_lot: {
        orderBy: { nonconformance_lot_id: 'asc' },
        select: { lot_id: true, affected_qty: true, uom_id: true, lot: { select: { lot_no: true } } },
      },
      disposition_decision: { select: { decision_qty: true } },
    },
  });
  if (nc === null) throw new NotFoundException('없는 부적합입니다.');
  const lots = nc.nonconformance_lot;
  const uomId = lots.length > 0 ? lots[0].uom_id : nc.item.base_uom_id;
  const uom = await prisma.uom.findUnique({ where: { uom_id: uomId }, select: { uom_code: true } });
  const remaining = remainingSummary(
    lots.reduce((sum, lot) => sum.add(lot.affected_qty), new Prisma.Decimal(0)),
    nc.disposition_decision.reduce((sum, row) => sum.add(row.decision_qty), new Prisma.Decimal(0)),
    Number(uomId),
  );
  const [disposition] = await dispositionApprovalViews(prisma, { approval_request_id: approval.approval_request_id });
  const concessions = await prisma.concession.findMany({
    where: { approval_request_id: approval.approval_request_id },
    orderBy: { concession_id: 'asc' },
    select: { concession_no: true, approved_qty: true, valid_from: true, valid_to: true },
  });
  return {
    summary: {
      nonconformanceId: Number(nc.nonconformance_id),
      nonconformanceNo: nc.nonconformance_no,
      statusCode: nc.status_code,
      itemCode: nc.item.item_code,
      itemName: nc.item.item_name,
      inspectionTypeCode: nc.inspection_request?.inspection_type_code ?? null,
      description: nc.description,
      uomCode: uom?.uom_code ?? null,
      affectedQtyTotal: remaining.affectedQtyTotal,
      remainingQty: remaining.remainingQty,
      lots: lots.map((lot) => ({ lotId: Number(lot.lot_id), lotNo: lot.lot.lot_no, affectedQty: lot.affected_qty.toNumber() })),
      approvalTypeCode: approval.approval_type_code,
      dispositionApproval: disposition ?? null,
      concession: concessions.length === 0 ? null : {
        concessionNos: concessions.map((row) => row.concession_no),
        approvedQty: concessions.reduce((sum, row) => sum.add(row.approved_qty), new Prisma.Decimal(0)).toNumber(),
        validFrom: isoDate(concessions[0].valid_from),
        validTo: concessions[0].valid_to === null ? null : isoDate(concessions[0].valid_to),
        reason: approval.reason,
      },
    },
    versionNo: nc.version_no,
  };
}
