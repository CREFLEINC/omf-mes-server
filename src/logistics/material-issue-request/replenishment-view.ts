import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { DerivedRow } from './material-issue-request-derived';

/**
 * 창고 보충 요청만의 화면 값(피처 004 · FR-023 · contracts §1) — 상태 다섯·한 품목 수량 합·출고 전표와 수령.
 * W/O 요청은 모두 null 이다. 003 `displayStatus` 는 그대로 둔다(완료·마감이 둘 다 DONE).
 */

export const REPLENISHMENT_STATUSES = ['DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'REMAINDER_CLOSED', 'CANCELLED'] as const;
export type ReplenishmentStatus = (typeof REPLENISHMENT_STATUSES)[number];
const REPLENISHMENT = 'REPLENISHMENT';
const ZERO = new Prisma.Decimal(0);

/** 진행 — 줄에 기출고가 있거나 취소 안 된 피킹에서 집은 양이 있다(003 과 같은 판정). */
const STARTED: Prisma.material_issue_requestWhereInput = {
  material_issue_request_line: {
    some: {
      OR: [
        { issued_qty: { gt: 0 } },
        { picking_line: { some: { picked_qty: { gt: 0 }, picking_order: { status_code: { not: 'CANCELLED' } } } } },
      ],
    },
  },
};

/** 배포 실패로 남은 대기(WAITING)도 「배포」로 보인다 — 보충 요청은 만들자마자 배포한다. */
const STATUS_WHERE: Record<ReplenishmentStatus, Prisma.material_issue_requestWhereInput> = {
  DISPATCHED: { OR: [{ status_code: 'WAITING' }, { status_code: 'REGISTERED', closed_at: null, NOT: STARTED }] },
  IN_PROGRESS: { AND: [{ status_code: 'REGISTERED', closed_at: null }, STARTED] },
  COMPLETED: { status_code: 'POSTED' },
  REMAINDER_CLOSED: { closed_at: { not: null }, close_reason_code: 'REMAINDER_CLOSED' },
  CANCELLED: { status_code: 'CANCELLED' },
};

/** 목록 조건 — 보충 요청에만 건다(여러 값). 쪽 나눔이 맞게 질의에서 거른다. */
export function replenishmentStatusWhere(value: unknown): Prisma.material_issue_requestWhereInput | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  if (raw.length === 0) return undefined;
  const unknown = raw.filter((code) => !(REPLENISHMENT_STATUSES as readonly string[]).includes(String(code)));
  if (unknown.length > 0) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('replenishmentStatus', ERROR_CODE.INVALID, `보충 상태는 ${REPLENISHMENT_STATUSES.join(' · ')} 중에서 고릅니다.`),
    ]);
  }
  return { request_type_code: REPLENISHMENT, OR: (raw as ReplenishmentStatus[]).map((code) => STATUS_WHERE[code]) };
}

export interface GoodsIssueRef {
  goodsIssueId: number;
  goodsIssueNo: string;
  issuedAt: string;
  received: boolean;
  shopfloorReceiptId: number | null;
}

/**
 * 요청마다 그 요청 피킹에서 나온 `POSTED` 출고 전표와 수령 여부 — 목록 한 쪽을 질의 둘로(행마다 묻지 않는다).
 */
export async function replenishmentGoodsIssues(db: Prisma.TransactionClient, requestIds: readonly bigint[]): Promise<Map<bigint, GoodsIssueRef[]>> {
  const result = new Map<bigint, GoodsIssueRef[]>(requestIds.map((id) => [id, []]));
  if (requestIds.length === 0) return result;
  const pickings = await db.picking_order.findMany({
    where: { source_document_type_code: 'MATERIAL_ISSUE_REQUEST', source_document_id: { in: [...requestIds] } },
    select: { picking_order_id: true, source_document_id: true },
  });
  if (pickings.length === 0) return result;
  const requestOf = new Map(pickings.map((p) => [p.picking_order_id, p.source_document_id]));
  const issues = await db.goods_issue.findMany({
    where: { source_document_type_code: 'PICKING_ORDER', source_document_id: { in: [...requestOf.keys()] }, status_code: 'POSTED' },
    select: {
      goods_issue_id: true,
      goods_issue_no: true,
      issued_at: true,
      source_document_id: true,
      shopfloor_receipt: { select: { shopfloor_receipt_id: true }, orderBy: { shopfloor_receipt_id: 'asc' }, take: 1 },
    },
    orderBy: [{ issued_at: 'asc' }, { goods_issue_id: 'asc' }],
  });
  for (const issue of issues) {
    const requestId = requestOf.get(issue.source_document_id) as bigint;
    const receipt = issue.shopfloor_receipt[0];
    result.get(requestId)?.push({
      goodsIssueId: Number(issue.goods_issue_id),
      goodsIssueNo: issue.goods_issue_no,
      issuedAt: issue.issued_at.toISOString(),
      received: receipt !== undefined,
      shopfloorReceiptId: receipt === undefined ? null : Number(receipt.shopfloor_receipt_id),
    });
  }
  return result;
}

/** 응답에 덧붙는 보충 칸. `goodsIssues` 는 상세에만 싣는다. */
export function replenishmentFields(row: DerivedRow, issues: readonly GoodsIssueRef[] | undefined, detail: boolean) {
  if (row.request_type_code !== REPLENISHMENT) {
    return { replenishmentStatus: null, qtySummary: null, receiptSummary: null, ...(detail ? { goodsIssues: null } : {}) };
  }
  const list = issues ?? [];
  return {
    replenishmentStatus: statusOf(row),
    qtySummary: qtySummary(row),
    receiptSummary: { issuedCount: list.length, receivedCount: list.filter((i) => i.received).length },
    ...(detail ? { goodsIssues: list } : {}),
  };
}

function statusOf(row: DerivedRow): ReplenishmentStatus {
  if (row.status_code === 'CANCELLED') return 'CANCELLED';
  if (row.closed_at !== null && row.close_reason_code === 'REMAINDER_CLOSED') return 'REMAINDER_CLOSED';
  if (row.status_code === 'POSTED') return 'COMPLETED';
  const started = row.material_issue_request_line.some(
    (line) => line.issued_qty.gt(0) || line.picking_line.some((p) => p.picked_qty.gt(0)),
  );
  return row.status_code === 'REGISTERED' && started ? 'IN_PROGRESS' : 'DISPATCHED';
}

/** 한 품목 요청만 — 단위가 다른 줄을 더하지 않는다. 마감 = 잔량 마감한 요청의 요청 − 출고. */
function qtySummary(row: DerivedRow) {
  const lines = row.material_issue_request_line;
  if (lines.length === 0 || new Set(lines.map((line) => line.item.item_code)).size > 1) return null;
  const requested = lines.reduce((sum, line) => sum.plus(line.requested_qty), ZERO);
  const issued = lines.reduce((sum, line) => sum.plus(line.issued_qty), ZERO);
  const closed = row.close_reason_code === 'REMAINDER_CLOSED' ? Prisma.Decimal.max(requested.minus(issued), ZERO) : ZERO;
  return { requestedQty: requested.toNumber(), issuedQty: issued.toNumber(), closedQty: closed.toNumber(), uomCode: lines[0].uom.uom_code };
}
