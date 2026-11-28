import { Prisma } from '@prisma/client';

import { ATTRIBUTION, AttributionCode } from './material-return.constants';

/**
 * 반납 귀속(피처 019 research R-2) — 반납 LOT 마다 「가장 최근 W/O 출고 라인」과 반납 가능 양.
 *
 * - 출고 → W/O 경로: `goods_issue_line → picking_line → material_issue_request_line → material_issue_request
 *   (request_type_code = 'WORK_ORDER')`(017 R-7 과 같다). 피킹 지시는 출고 요청 하나 = W/O 하나이고 부분 출고는 분할 LOT 이
 *   되므로(008) 현장에 나간 LOT 하나는 W/O 하나의 것이다.
 * - 가장 최근 = 전기된(취소 안 된) W/O 경로 라인 중 출고 시각, 같으면 라인 id 가 가장 늦은 것.
 * - 반납 가능 양 = 그 라인 수량 − `goods_issue_line_id` 가 그 라인인 반납 줄 합(귀속 없음 줄 포함 — 그 출고 뒤의 반납이다).
 */

const POSTED = 'POSTED';
const WORK_ORDER_REQUEST = 'WORK_ORDER';
const ZERO = new Prisma.Decimal(0);

/** 그 LOT 이 실린 출고 라인 하나 — W/O 경로가 아니면 요청 유형·W/O 가 비어 있다. */
export interface IssueCandidate {
  goodsIssueLineId: bigint;
  lotId: bigint;
  issuedAt: Date;
  issueQty: Prisma.Decimal;
  uomId: bigint;
  issueStatusCode: string;
  cancelled: boolean;
  requestTypeCode: string | null;
  workOrderId: bigint | null;
  workOrderNo: string | null;
  /** 출고 생산창고 — 위치 없이 반납하면 이 창고 적치 대기로 들어간다. */
  sourceWarehouseId: bigint;
  /** 출고의 도착 위치(#362 전 출고분만 있다) — 그 LOT 잔액이 남아 있으면 반납이 거기서 뺀다(R-3). */
  destinationLocationId: bigint | null;
}

export type WorkOrderIssue = IssueCandidate & { workOrderId: bigint; workOrderNo: string };

function isWorkOrderIssue(row: IssueCandidate): row is WorkOrderIssue {
  return row.issueStatusCode === POSTED && !row.cancelled && row.requestTypeCode === WORK_ORDER_REQUEST
    && row.workOrderId !== null && row.workOrderNo !== null;
}

function later(a: IssueCandidate, b: IssueCandidate): boolean {
  const at = a.issuedAt.getTime() - b.issuedAt.getTime();
  return at !== 0 ? at > 0 : a.goodsIssueLineId > b.goodsIssueLineId;
}

/** LOT 마다 가장 최근 W/O 출고 라인. W/O 출고 이력이 없는 LOT 은 빠진다(FR-003). */
export function latestWorkOrderIssues(rows: readonly IssueCandidate[]): Map<bigint, WorkOrderIssue> {
  const latest = new Map<bigint, WorkOrderIssue>();
  for (const row of rows) {
    if (!isWorkOrderIssue(row)) continue;
    const seen = latest.get(row.lotId);
    if (seen === undefined || later(row, seen)) latest.set(row.lotId, row);
  }
  return latest;
}

/** 반납 가능 양(FR-003) — 0 아래로 내려가지 않는다. */
export function returnableQty(issueQty: Prisma.Decimal, returned: Prisma.Decimal | undefined): Prisma.Decimal {
  const left = issueQty.minus(returned ?? ZERO);
  return left.isNegative() ? ZERO : left;
}

/** 귀속(FR-010·011·016) — 최종 마감 W/O 는 고른 줄도 귀속 없음이다. */
export function attributionOf(
  workOrderId: bigint, finalized: boolean, picked: boolean,
): { workOrderId: bigint | null; attributionCode: AttributionCode } {
  if (finalized) return { workOrderId: null, attributionCode: ATTRIBUTION.NONE_FINALIZED };
  return { workOrderId, attributionCode: picked ? ATTRIBUTION.WORK_ORDER_PICKED : ATTRIBUTION.AUTO_LATEST_ISSUE };
}

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

interface CandidateRow {
  goods_issue_line_id: bigint; lot_id: bigint; issued_at: Date; issue_qty: Prisma.Decimal; uom_id: bigint;
  status_code: string; cancelled: boolean; request_type_code: string | null; work_order_id: bigint | null;
  work_order_no: string | null; source_warehouse_id: bigint; destination_location_id: bigint | null;
}

/** 그 LOT 들이 실린 출고 라인 전부(경로를 따라 요청 유형·W/O 를 붙인다) — 고르기는 `latestWorkOrderIssues`. */
export async function issueCandidates(db: Db, lotIds: readonly bigint[]): Promise<IssueCandidate[]> {
  if (lotIds.length === 0) return [];
  const rows = await db.$queryRaw<CandidateRow[]>`
    SELECT gil.goods_issue_line_id, gil.lot_id, gi.issued_at, gil.issue_qty, gil.uom_id, gi.status_code,
           (gi.cancelled_at IS NOT NULL) AS cancelled, mir.request_type_code, mir.work_order_id, wo.work_order_no,
           gi.source_warehouse_id,
           CASE WHEN gi.destination_type_code = 'LOCATION' THEN gi.destination_id END AS destination_location_id
      FROM logistics.goods_issue_line gil
      JOIN logistics.goods_issue gi ON gi.goods_issue_id = gil.goods_issue_id
      LEFT JOIN logistics.picking_line pl ON pl.picking_line_id = gil.picking_line_id
      LEFT JOIN logistics.material_issue_request_line mirl
             ON mirl.material_issue_request_line_id = pl.material_issue_request_line_id
      LEFT JOIN logistics.material_issue_request mir ON mir.material_issue_request_id = mirl.material_issue_request_id
      LEFT JOIN production.work_order wo ON wo.work_order_id = mir.work_order_id
     WHERE gil.lot_id = ANY(${[...new Set(lotIds)]}::bigint[])`;
  return rows.map((row) => ({
    goodsIssueLineId: row.goods_issue_line_id, lotId: row.lot_id, issuedAt: row.issued_at,
    issueQty: new Prisma.Decimal(row.issue_qty), uomId: row.uom_id, issueStatusCode: row.status_code, cancelled: row.cancelled,
    requestTypeCode: row.request_type_code, workOrderId: row.work_order_id, workOrderNo: row.work_order_no,
    sourceWarehouseId: row.source_warehouse_id, destinationLocationId: row.destination_location_id,
  }));
}

/** 출고 라인마다 거기 귀속된 반납 줄 합(귀속 없음 줄 포함). */
export async function returnedQtyByIssueLine(db: Db, issueLineIds: readonly bigint[]): Promise<Map<bigint, Prisma.Decimal>> {
  if (issueLineIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ goods_issue_line_id: bigint; returned: Prisma.Decimal }[]>`
    SELECT goods_issue_line_id, SUM(return_qty) AS returned
      FROM production.material_return_line
     WHERE goods_issue_line_id = ANY(${[...new Set(issueLineIds)]}::bigint[])
     GROUP BY goods_issue_line_id`;
  return new Map(rows.map((row) => [row.goods_issue_line_id, new Prisma.Decimal(row.returned)]));
}
