import { Prisma } from '@prisma/client';

import { unprintedSplitLotIds } from '../../logistics/split-material-lot/split-material-lot-query.service';

/**
 * 「W/O 로 찾기」(피처 019 FR-014·015 · 계약 §2·§3) — 반납 가능 양이 남은 LOT 을 W/O 별로 낸다.
 *
 * ⭐ LOT 하나의 판정(`return-attribution.ts` `latestWorkOrderIssues` · `return-lots.ts`)과 «같은 규칙»을 공장 전체에 SQL 로 건다:
 *    W/O 경로(출고 요청 WORK_ORDER) · 전기·취소 안 됨 · 출고 시각, 같으면 라인 id 가 가장 늦은 라인이 그 LOT 의 귀속 출고이고,
 *    반납 대상은 정상·불량 자재 LOT 이다. 한쪽을 바꾸면 다른 쪽도 바꾼다 — e2e 가 LOT 조회와 목록이 같은 W/O·양을 내는지 본다.
 */
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface OpenReturnLot {
  lot_id: bigint; goods_issue_line_id: bigint; work_order_id: bigint; issued_at: Date;
  issue_qty: Prisma.Decimal; returnable: Prisma.Decimal;
}

/** 반납 가능 양 > 0 인 LOT 과 그 귀속 출고 — `where` 는 `o`(이 CTE 의 줄)에 거는 조건. */
function openLotsSql(plantId: bigint | null, where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    WITH latest AS (
      SELECT DISTINCT ON (gil.lot_id) gil.lot_id, gil.goods_issue_line_id, gil.issue_qty, gi.issued_at, mir.work_order_id
        FROM logistics.goods_issue_line gil
        JOIN logistics.goods_issue gi ON gi.goods_issue_id = gil.goods_issue_id
        JOIN logistics.picking_line pl ON pl.picking_line_id = gil.picking_line_id
        JOIN logistics.material_issue_request_line mirl ON mirl.material_issue_request_line_id = pl.material_issue_request_line_id
        JOIN logistics.material_issue_request mir ON mir.material_issue_request_id = mirl.material_issue_request_id
        JOIN trace.lot l ON l.lot_id = gil.lot_id
       WHERE gi.status_code = 'POSTED' AND gi.cancelled_at IS NULL
         AND mir.request_type_code = 'WORK_ORDER' AND mir.work_order_id IS NOT NULL
         AND l.lot_type_code = 'MATERIAL' AND l.status_code IN ('NORMAL', 'DEFECTIVE')
         ${plantId === null ? Prisma.empty : Prisma.sql`AND l.plant_id = ${plantId}`}
       ORDER BY gil.lot_id, gi.issued_at DESC, gil.goods_issue_line_id DESC
    ), open AS (
      SELECT latest.*, latest.issue_qty - COALESCE((
               SELECT SUM(r.return_qty) FROM production.material_return_line r WHERE r.goods_issue_line_id = latest.goods_issue_line_id
             ), 0) AS returnable
        FROM latest
    )
    SELECT o.* FROM open o WHERE o.returnable > 0 AND ${where}`;
}

export interface WorkOrderRow {
  work_order_id: bigint; work_order_no: string; item_id: bigint; item_code: string; item_name: string;
  process_name: string | null; line_name: string | null; last_issued_at: Date; lot_count: bigint; total: bigint;
}

/** §2 — 반납 남은 LOT 이 있는 W/O, 최근 출고 순(같으면 W/O id 역순). `q` 는 W/O 번호 일부. */
export async function returnWorkOrders(
  db: Db, plantId: bigint | null, q: string | undefined, page: { skip: number; take: number },
): Promise<{ rows: WorkOrderRow[]; unprinted: Map<bigint, number> }> {
  const rows = await db.$queryRaw<WorkOrderRow[]>`
    WITH o AS (${openLotsSql(plantId, Prisma.sql`true`)}),
         wo AS (SELECT work_order_id, MAX(issued_at) AS last_issued_at, COUNT(*) AS lot_count FROM o GROUP BY work_order_id)
    SELECT wo.work_order_id, w.work_order_no, i.item_id, i.item_code, i.item_name, p.process_name, ln.line_name,
           wo.last_issued_at, wo.lot_count, COUNT(*) OVER () AS total
      FROM wo
      JOIN production.work_order w ON w.work_order_id = wo.work_order_id
      JOIN mdm.item i ON i.item_id = w.item_id
      LEFT JOIN planning.routing_operation ro ON ro.routing_operation_id = w.routing_operation_id
      LEFT JOIN mdm.process p ON p.process_id = ro.process_id
      LEFT JOIN mdm.production_line ln ON ln.production_line_id = w.production_line_id
     WHERE ${q === undefined || q === '' ? Prisma.sql`true` : Prisma.sql`w.work_order_no ILIKE ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`}
     ORDER BY wo.last_issued_at DESC, wo.work_order_id DESC
     LIMIT ${page.take} OFFSET ${page.skip}`;
  const ids = rows.map((row) => row.work_order_id);
  const lots = ids.length === 0 ? [] : await db.$queryRaw<OpenReturnLot[]>`${openLotsSql(plantId, Prisma.sql`o.work_order_id = ANY(${ids}::bigint[])`)}`;
  const unprintedLots = await unprintedSplitLotIds(db, lots.map((lot) => lot.lot_id));
  const unprinted = new Map<bigint, number>();
  for (const lot of lots.filter((row) => unprintedLots.has(row.lot_id))) unprinted.set(lot.work_order_id, (unprinted.get(lot.work_order_id) ?? 0) + 1);
  return { rows, unprinted };
}

/** §3 — 그 W/O 가 가장 최근 출고인 반납 가능 LOT. 미발행 먼저, 그 안에서 출고 시각·LOT id 순. */
export async function returnWorkOrderLots(db: Db, plantId: bigint | null, workOrderId: bigint): Promise<{ lots: OpenReturnLot[]; unprinted: Set<bigint> }> {
  const lots = await db.$queryRaw<OpenReturnLot[]>`${openLotsSql(plantId, Prisma.sql`o.work_order_id = ${workOrderId}`)}`;
  const unprinted = await unprintedSplitLotIds(db, lots.map((lot) => lot.lot_id));
  const rank = (lot: OpenReturnLot) => (unprinted.has(lot.lot_id) ? 0 : 1);
  lots.sort((a, b) => rank(a) - rank(b) || a.issued_at.getTime() - b.issued_at.getTime() || (a.lot_id < b.lot_id ? -1 : 1));
  return { lots, unprinted };
}
