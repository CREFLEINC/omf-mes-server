import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DocumentStateService } from '../document-state';

/**
 * 출고 요청의 진행·피킹 닫기·이력(피처 003 · research R-2·R-11·R-12). 요청 화면의 수정·취소와 W/O 취소·마감이
 * 같은 규칙을 쓴다.
 */

const PICKING_STATUS = 'logistics.picking_order.status_code';
const REQUEST_STATUS = 'logistics.material_issue_request.status_code';
const PICKING_REGISTERED = 'REGISTERED';
const PICKING_CANCELLED = 'CANCELLED';
const SOURCE_MATERIAL_ISSUE_REQUEST = 'MATERIAL_ISSUE_REQUEST';
export const REQUEST_AUDIT_TARGET = 'MATERIAL_ISSUE_REQUEST';
const ZERO = new Prisma.Decimal(0);

/** 이력 사건 — 계약 `MaterialIssueRequestHistoryItem.eventCode`. 문장은 화면이 이 코드로 만든다. */
export type RequestAction =
  | 'CREATED'
  | 'RELEASED'
  | 'RELEASE_FAILED'
  | 'REVERTED_TO_WAITING'
  | 'ISSUE_DATE_CHANGED'
  | 'SOURCE_CHANGED'
  | 'DESTINATION_CHANGED'
  | 'QTY_CHANGED'
  | 'CANCELLED'
  | 'CLOSED'
  | 'PLANNED_OVERRIDE';

/** 계약 `detail` — 바뀐 값·품목·사유·오류. */
export interface RequestEventDetail {
  before?: unknown;
  after?: unknown;
  itemCode?: string;
  reason?: string | null;
  errorText?: string;
}

export interface RequestProgress {
  /** 줄마다 집은 양(취소 안 된 피킹) · 기출고. */
  picked: Map<bigint, Prisma.Decimal>;
  issued: Map<bigint, Prisma.Decimal>;
  /** 집은 양 또는 기출고가 하나라도 있다(R-2). */
  started: boolean;
  /** 집었지만 아직 출고되지 않은 양이 있다 — 수량을 맞추면 그 LOT 이 갈 곳을 잃는다(FR-026). */
  inFlight: boolean;
}

export async function requestProgress(tx: Prisma.TransactionClient, requestId: bigint): Promise<RequestProgress> {
  const lines = await tx.material_issue_request_line.findMany({
    where: { material_issue_request_id: requestId },
    select: {
      material_issue_request_line_id: true,
      issued_qty: true,
      picking_line: { where: { picking_order: { status_code: { not: PICKING_CANCELLED } } }, select: { picked_qty: true } },
    },
  });
  const picked = new Map<bigint, Prisma.Decimal>();
  const issued = new Map<bigint, Prisma.Decimal>();
  let started = false;
  let inFlight = false;
  for (const line of lines) {
    const sum = line.picking_line.reduce((acc, p) => acc.plus(p.picked_qty), ZERO);
    picked.set(line.material_issue_request_line_id, sum);
    issued.set(line.material_issue_request_line_id, line.issued_qty);
    if (sum.gt(0) || line.issued_qty.gt(0)) started = true;
    if (sum.gt(line.issued_qty)) inFlight = true;
  }
  return { picked, issued, started, inFlight };
}

/**
 * 요청의 열린 피킹 지시를 «더 집지 않게» 닫는다. 집은 것이 없는 지시는 취소하고, 집은 지시는 집은 만큼으로
 * 줄인다(집지 않은 줄은 지운다 — 출고 줄이 가리키지 않는다). 집었지만 출고하지 않은 양은 그대로 둔다 — 반납은
 * 범위 밖이다(plan 확정 항목 4).
 */
export async function closePickings(
  tx: Prisma.TransactionClient,
  documentState: DocumentStateService,
  requestId: bigint,
  appUserId: number | null,
): Promise<void> {
  const orders = await tx.picking_order.findMany({
    where: { source_document_type_code: SOURCE_MATERIAL_ISSUE_REQUEST, source_document_id: requestId, status_code: PICKING_REGISTERED },
    select: { picking_order_id: true, status_code: true, picking_line: { select: { picking_line_id: true, picked_qty: true } } },
  });
  for (const order of orders) {
    if (order.picking_line.every((line) => line.picked_qty.lte(0))) {
      const transition = documentState.assertTransition(PICKING_STATUS, 'picking-cancel', order.status_code, HttpStatus.CONFLICT);
      await tx.picking_order.update({
        where: { picking_order_id: order.picking_order_id },
        data: { status_code: transition.to, updated_by: appUserId, version_no: { increment: 1 } },
      });
      continue;
    }
    const untouched = order.picking_line.filter((line) => line.picked_qty.lte(0)).map((line) => line.picking_line_id);
    if (untouched.length > 0) await tx.picking_line.deleteMany({ where: { picking_line_id: { in: untouched } } });
    for (const line of order.picking_line.filter((l) => l.picked_qty.gt(0))) {
      await tx.picking_line.update({ where: { picking_line_id: line.picking_line_id }, data: { planned_qty: line.picked_qty } });
    }
  }
}

/** 요청 상태를 전이표대로 옮긴다. */
export function requestTransition(documentState: DocumentStateService, action: string, from: string): string {
  return documentState.assertTransition(REQUEST_STATUS, action, from, HttpStatus.CONFLICT).to;
}

/**
 * 이력 한 줄 — `audit.audit_event`(target MATERIAL_ISSUE_REQUEST). 감사 유형 코드는 시스템 소유 5값이라 CREATE·UPDATE 만
 * 쓰고, 사건은 `after_value.eventCode`, 내용은 `after_value.detail` 에 둔다. 한 저장이 여러 칸을 바꾸면 칸마다 한 줄이다.
 */
export async function recordRequestAudit(
  tx: Prisma.TransactionClient,
  entry: { requestId: bigint; action: RequestAction; actorId: number | null; detail?: RequestEventDetail; at?: Date },
): Promise<void> {
  await tx.audit_event.create({
    data: {
      occurred_at: entry.at ?? new Date(),
      target_type_code: REQUEST_AUDIT_TARGET,
      target_id: entry.requestId,
      event_type_code: entry.action === 'CREATED' ? 'CREATE' : 'UPDATE',
      performed_by: entry.actorId === null ? null : BigInt(entry.actorId),
      after_value: { eventCode: entry.action, detail: entry.detail ?? {} } as unknown as Prisma.InputJsonValue,
      reason: entry.detail?.reason ?? null,
    },
  });
}

/**
 * W/O 취소·마감(FR-028 · research R-12) — 그 W/O 의 활성 새 규칙 요청을 정리한다. 진행 없음 → 취소(피킹 지시도),
 * 진행 있음 → `closed_at`·사유를 남기고(예정에서 빠짐) 더 집지 않게 피킹을 닫는다. 지금 방식 요청(출발 창고 없음)은
 * 건드리지 않는다(FR-009a · 문의 038).
 */
export async function settleWorkOrderRequests(
  tx: Prisma.TransactionClient,
  documentState: DocumentStateService,
  input: { workOrderId: bigint; reason: 'WO_CANCELLED' | 'WO_CLOSED'; appUserId: number | null },
): Promise<void> {
  const open = await tx.material_issue_request.findMany({
    where: { work_order_id: input.workOrderId, source_warehouse_id: { not: null }, status_code: { in: ['WAITING', 'REGISTERED'] }, closed_at: null },
    select: { material_issue_request_id: true },
    orderBy: { material_issue_request_id: 'asc' },
  });
  if (open.length === 0) return;
  // 러너·요청 화면과 같은 행을 다룬다 — 잠근 뒤 상태를 다시 읽는다.
  const requests = await tx.$queryRaw<{ id: bigint; status_code: string }[]>`
    SELECT material_issue_request_id AS id, status_code FROM logistics.material_issue_request
     WHERE material_issue_request_id = ANY(${open.map((row) => row.material_issue_request_id)}::bigint[])
       AND status_code IN ('WAITING', 'REGISTERED') AND closed_at IS NULL
     ORDER BY material_issue_request_id FOR UPDATE`;
  const now = new Date();
  for (const request of requests) {
    const progress = await requestProgress(tx, request.id);
    await closePickings(tx, documentState, request.id, input.appUserId);
    const data: Prisma.material_issue_requestUpdateInput = progress.started
      ? { closed_at: now, close_reason_code: input.reason }
      : {
          status_code: requestTransition(documentState, 'material-issue-request-cancel', request.status_code),
          cancelled_at: now,
          cancelled_by: input.appUserId === null ? null : BigInt(input.appUserId),
        };
    await tx.material_issue_request.update({
      where: { material_issue_request_id: request.id },
      data: { ...data, updated_at: now, updated_by: input.appUserId === null ? null : BigInt(input.appUserId), version_no: { increment: 1 } },
    });
    await recordRequestAudit(tx, {
      requestId: request.id,
      action: progress.started ? 'CLOSED' : 'CANCELLED',
      actorId: input.appUserId,
      detail: { reason: input.reason },
      at: now,
    });
  }
}
