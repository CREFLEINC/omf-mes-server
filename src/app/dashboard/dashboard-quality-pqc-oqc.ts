import { Prisma } from '@prisma/client';

import type { DashboardPlant } from './dashboard-availability.service';
import { RecentLot, finalResultCte, pqcReinspectCte } from './dashboard-inspection';
import { PQC_PENDING_CTE, SCOPED_NC_CTE, pqcEquipmentCode } from './dashboard-quality-status';
import { DashboardPeriod, coarseRange, localDate, num, plantScope } from './dashboard-scope';
import { LotRecordCount } from './dashboard-sections';

type Tx = Prisma.TransactionClient;

const TOP = 5;
/** PQC 탭 최근 판정 더 보기 — 기존 `recentLots`(5건)는 그대로 두고 따로 싣는다. */
export const PQC_RECENT_MORE_LIMIT = 15;
/** 공급사 반품 출고를 반품 사유 목록에 섞을 때의 코드 — 입고 사유 코드와 겹치지 않게 따로 둔다. */
export const SUPPLIER_RETURN_OUT = 'SUPPLIER_RETURN_OUT';

export interface PqcExtra {
  fullReinspect: { inputQty: number; restoredQty: number };
  itemDefects: { itemId: number; itemCode: string; itemName: string; qty: number }[];
  oldestPendingSince: string | null;
  reworkRequestCounts: LotRecordCount;
  recentLotsMore: RecentLot[];
}

export interface OqcExtra {
  returnReasons: { reasonCode: string | null; reasonName: string | null; qty: number }[];
  dailyReturnOutQty: { date: string; qty: number | null }[];
  pendingReturnLotCount: LotRecordCount;
  customerDefects: { customerId: number; customerName: string; rejectedQty: number }[];
}

interface ReinspectRow {
  input_qty: string;
  restored_qty: string;
}

interface ReasonRow {
  reason_code: string | null;
  reason_name: string | null;
  qty: string;
}

/**
 * 품질 섹션의 PQC·OQC 추가 칸(#118 사용자 지시 2026-10-19 · 장부 P-59). 기존 칸과 같은 조각(공장·판정 시각·누계 구간)을 쓰고
 * 기존 집계는 건드리지 않는다. 공장이 없으면 0 · 빈 배열 · null(일별은 그날마다 null).
 */
export async function readPqcOqcExtra(
  tx: Tx,
  plants: readonly DashboardPlant[],
  period: DashboardPeriod,
): Promise<{ pqc: PqcExtra; oqc: OqcExtra }> {
  if (plants.length === 0) {
    return {
      pqc: {
        fullReinspect: { inputQty: 0, restoredQty: 0 },
        itemDefects: [],
        oldestPendingSince: null,
        reworkRequestCounts: { lotCount: 0, recordCount: 0 },
        recentLotsMore: [],
      },
      oqc: {
        returnReasons: [],
        dailyReturnOutQty: dailyReturnOut([], period),
        pendingReturnLotCount: { lotCount: 0, recordCount: 0 },
        customerDefects: [],
      },
    };
  }
  const scope = plantScope(plants);
  const inPeriod = Prisma.sql`fr.local_date BETWEEN ${period.from}::date AND ${period.to}::date`;
  const [reinspect] = await tx.$queryRaw<ReinspectRow[]>(Prisma.sql`WITH ${scope}, ${pqcReinspectCte(period)}
    SELECT COALESCE(SUM(inspected_qty), 0)::text AS input_qty, COALESCE(SUM(accepted_qty), 0)::text AS restored_qty
    FROM pqc_reinspect WHERE local_date BETWEEN ${period.from}::date AND ${period.to}::date`);
  // IQC itemDefects 와 같은 식 — 최종 회차 불합격 수량, 0 은 빼고 상위 5.
  const items = await tx.$queryRaw<{ item_id: bigint; item_code: string; item_name: string; qty: string }[]>(
    Prisma.sql`WITH ${scope}, ${finalResultCte(period)}
      SELECT i.item_id, i.item_code, i.item_name, SUM(fr.rejected_qty)::text AS qty
      FROM final_result fr JOIN mdm.item i ON i.item_id = fr.item_id
      WHERE fr.type = 'PQC' AND ${inPeriod}
      GROUP BY i.item_id HAVING SUM(fr.rejected_qty) > 0
      ORDER BY SUM(fr.rejected_qty) DESC, i.item_id LIMIT ${TOP}`,
  );
  const [oldest] = await tx.$queryRaw<{ since: Date | null }[]>(Prisma.sql`WITH ${scope}, ${PQC_PENDING_CTE}
    SELECT MIN(requested_at) AS since FROM pqc_pending`);
  // IQC vendorDefects 와 같은 식 — 고객 = 출하요청의 고객(OQC 의뢰가 출하요청을 가리킬 때).
  const customers = await tx.$queryRaw<{ partner_id: bigint; partner_name: string; rejected_qty: string }[]>(
    Prisma.sql`WITH ${scope}, ${finalResultCte(period)}
      SELECT p.partner_id, p.partner_name, SUM(fr.rejected_qty)::text AS rejected_qty
      FROM final_result fr JOIN mdm.partner p ON p.partner_id = fr.customer_id
      WHERE fr.type = 'OQC' AND ${inPeriod}
      GROUP BY p.partner_id HAVING SUM(fr.rejected_qty) > 0
      ORDER BY SUM(fr.rejected_qty) DESC, p.partner_id LIMIT ${TOP}`,
  );
  return {
    pqc: {
      fullReinspect: { inputQty: num(reinspect?.input_qty), restoredQty: num(reinspect?.restored_qty) },
      itemDefects: items.map((row) => ({
        itemId: Number(row.item_id),
        itemCode: row.item_code,
        itemName: row.item_name,
        qty: num(row.qty),
      })),
      oldestPendingSince: oldest?.since ? oldest.since.toISOString() : null,
      reworkRequestCounts: await reworkRequests(tx, scope, period),
      recentLotsMore: (await pqcRecentRows(tx, scope, period)).map(recentLot),
    },
    oqc: {
      returnReasons: returnReasons(await reasonRows(tx, scope, period)),
      dailyReturnOutQty: dailyReturnOut(await returnOutRows(tx, scope, period), period),
      pendingReturnLotCount: await pendingReturnLots(tx, scope),
      customerDefects: customers.map((row) => ({
        customerId: Number(row.partner_id),
        customerName: row.partner_name,
        rejectedQty: num(row.rejected_qty),
      })),
    },
  };
}

/** 공급사 반품 출고 — 전기된(`POSTED`, 취소되면 `CANCELLED`) `SUPPLIER_RETURN` 출고. 공장 = 출발 창고의 공장. */
function supplierReturnOut(scope: Prisma.Sql, from: string, to: string): Prisma.Sql {
  return Prisma.sql`WITH ${scope}, return_out AS (
    SELECT ${localDate(Prisma.sql`gi.issued_at`)} AS local_date, gil.issue_qty
    FROM logistics.goods_issue gi
    JOIN logistics.goods_issue_line gil ON gil.goods_issue_id = gi.goods_issue_id
    JOIN mdm.warehouse w ON w.warehouse_id = gi.source_warehouse_id
    JOIN plant_scope ps ON ps.plant_id = w.plant_id
    WHERE gi.issue_type_code = 'SUPPLIER_RETURN' AND gi.status_code = 'POSTED'
      AND ${coarseRange(Prisma.sql`gi.issued_at`, from, to)}
  )`;
}

/** 반품 입고(`RETURN`·`POSTED`)의 사유별 수량 + 공급사 반품 출고 한 줄. 누계 구간 = monthLots 와 같다. */
function reasonRows(tx: Tx, scope: Prisma.Sql, period: DashboardPeriod): Promise<ReasonRow[]> {
  return tx.$queryRaw<ReasonRow[]>(Prisma.sql`${supplierReturnOut(scope, period.from, period.to)}
    SELECT gr.reason_code::text, reason.code_name::text AS reason_name, SUM(grl.receipt_qty)::text AS qty
    FROM logistics.goods_receipt gr
    JOIN logistics.goods_receipt_line grl ON grl.goods_receipt_id = gr.goods_receipt_id
    JOIN plant_scope ps ON ps.plant_id = gr.plant_id
    LEFT JOIN ${codeName('GOODS_RECEIPT_REASON')} reason ON reason.code = gr.reason_code
    WHERE gr.receipt_type_code = 'RETURN' AND gr.status_code = 'POSTED'
      AND ${coarseRange(Prisma.sql`gr.receipt_datetime`, period.from, period.to)}
      AND ${localDate(Prisma.sql`gr.receipt_datetime`)} BETWEEN ${period.from}::date AND ${period.to}::date
    GROUP BY gr.reason_code, reason.code_name
    UNION ALL
    SELECT ${SUPPLIER_RETURN_OUT}::text, (SELECT code_name::text FROM ${codeName('ISSUE_TYPE')} t WHERE t.code = 'SUPPLIER_RETURN'),
      SUM(issue_qty)::text
    FROM return_out WHERE local_date BETWEEN ${period.from}::date AND ${period.to}::date
    HAVING COUNT(*) > 0`);
}

/** 사유별 수량 — 수량 큰 순, 같으면 코드 순(null 은 끝). */
export function returnReasons(rows: readonly ReasonRow[]): OqcExtra['returnReasons'] {
  return rows
    .map((row) => ({ reasonCode: row.reason_code, reasonName: row.reason_name, qty: num(row.qty) }))
    .sort((a, b) => b.qty - a.qty || codeOrder(a.reasonCode, b.reasonCode));
}

function codeOrder(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a.localeCompare(b);
}

function returnOutRows(tx: Tx, scope: Prisma.Sql, period: DashboardPeriod) {
  const first = period.chartDays[0] ?? period.to;
  return tx.$queryRaw<{ local_date: string; qty: string }[]>(Prisma.sql`${supplierReturnOut(scope, first, period.to)}
    SELECT to_char(local_date, 'YYYY-MM-DD') AS local_date, SUM(issue_qty)::text AS qty
    FROM return_out WHERE local_date BETWEEN ${first}::date AND ${period.to}::date GROUP BY local_date`);
}

/** 일별 공급사 반품 출고 — dailyPassRates 와 같은 날짜 목록. 출고 기록이 없는 날은 null(추이와 같은 규칙 · P-60). */
export function dailyReturnOut(
  rows: readonly { local_date: string; qty: string }[],
  period: DashboardPeriod,
): OqcExtra['dailyReturnOutQty'] {
  const byDay = new Map(rows.map((row) => [row.local_date, num(row.qty)]));
  return period.chartDays.map((date) => ({ date, qty: byDay.get(date) ?? null }));
}

/**
 * 처분 대기 반품 LOT(지금 기준, 기간 무관) — 처분 후보(`GET /quality/disposition-candidates`)의 반품 갈래와 같은 모집단:
 * 반품 입고(`RETURN`·`POSTED`)된 LOT 중 불량창고(`is_defect`) 잔액이 남아 있고, 그 LOT 을 대상으로 한 부적합에 처분 판정
 * (`disposition_decision`)이 하나도 없는 것. 기록 = 그 LOT 들의 반품 입고 라인. 공장 = 반품 입고의 공장.
 */
async function pendingReturnLots(tx: Tx, scope: Prisma.Sql): Promise<LotRecordCount> {
  const [row] = await tx.$queryRaw<{ lot_count: number; record_count: number }[]>(Prisma.sql`WITH ${scope}
    SELECT COUNT(DISTINCT grl.lot_id)::int AS lot_count, COUNT(*)::int AS record_count
    FROM logistics.goods_receipt gr
    JOIN logistics.goods_receipt_line grl ON grl.goods_receipt_id = gr.goods_receipt_id
    JOIN plant_scope ps ON ps.plant_id = gr.plant_id
    WHERE gr.receipt_type_code = 'RETURN' AND gr.status_code = 'POSTED'
      AND EXISTS (SELECT 1 FROM inventory.inventory_balance b
        JOIN mdm.warehouse dw ON dw.warehouse_id = b.warehouse_id AND dw.is_defect
        WHERE b.lot_id = grl.lot_id AND b.on_hand_qty <> 0)
      AND NOT EXISTS (SELECT 1 FROM quality.nonconformance_lot nl
        JOIN quality.disposition_decision d ON d.nonconformance_id = nl.nonconformance_id
        WHERE nl.lot_id = grl.lot_id)`);
  return { lotCount: row?.lot_count ?? 0, recordCount: row?.record_count ?? 0 };
}

/**
 * 재작업 요청 LOT · 건수 — 기존 `pqc.reworkRequestCount`(부적합 서비스)와 같은 조건: 공장 범위 부적합의 `REWORK` 처분 판정,
 * 판정 시각(`decided_at`)이 부적합 공장 현지 날짜로 누계 구간 안. recordCount = 판정 수(= reworkRequestCount),
 * lotCount = 그 부적합의 대상 LOT 고유 수(대상 LOT 없는 판정은 건수에만).
 */
async function reworkRequests(tx: Tx, scope: Prisma.Sql, period: DashboardPeriod): Promise<LotRecordCount> {
  const [row] = await tx.$queryRaw<{ lot_count: number; record_count: number }[]>(Prisma.sql`WITH ${scope}, ${SCOPED_NC_CTE}
    SELECT COUNT(DISTINCT nl.lot_id)::int AS lot_count, COUNT(DISTINCT d.disposition_decision_id)::int AS record_count
    FROM scoped_nc nc
    JOIN quality.disposition_decision d ON d.nonconformance_id = nc.nonconformance_id
    LEFT JOIN quality.nonconformance_lot nl ON nl.nonconformance_id = nc.nonconformance_id
    WHERE d.disposition_type_code = 'REWORK' AND ${coarseRange(Prisma.sql`d.decided_at`, period.from, period.to)}
      AND ${localDate(Prisma.sql`d.decided_at`, Prisma.sql`nc.tz`)} BETWEEN ${period.from}::date AND ${period.to}::date`);
  return { lotCount: row?.lot_count ?? 0, recordCount: row?.record_count ?? 0 };
}

interface RecentRow {
  inspection_result_id: bigint;
  inspected_at: Date;
  equipment_code: string | null;
  item_code: string;
  item_name: string;
  lot_no: string | null;
  qty: string;
  judgment: RecentLot['judgmentCode'];
}

/**
 * PQC 최근 판정 최대 15건 — 기존 `recentLots`(dashboard-quality.service.ts `recent`)의 PQC 갈래와 같은 조건·정렬·형태:
 * 최종 회차 · 현지 날짜 ≤ 조회 종료일 · 판정 시각 → 결과 id 내림차순. 상대는 없고(null), 호기 = 계획 설비 또는 마지막 세션 설비.
 */
function pqcRecentRows(tx: Tx, scope: Prisma.Sql, period: DashboardPeriod): Promise<RecentRow[]> {
  return tx.$queryRaw<RecentRow[]>(Prisma.sql`WITH ${scope}, ${finalResultCte(period)}
    SELECT fr.inspection_result_id, fr.inspected_at, fr.inspected_qty::text AS qty, fr.judgment,
      i.item_code, i.item_name, lot.lot_no,
      ${pqcEquipmentCode(Prisma.sql`fr.work_order_id`, Prisma.sql`fr.planned_equipment_id`)} AS equipment_code
    FROM final_result fr
    JOIN mdm.item i ON i.item_id = fr.item_id
    LEFT JOIN trace.lot lot ON lot.lot_id = fr.lot_id
    WHERE fr.type = 'PQC' AND fr.local_date <= ${period.to}::date
    ORDER BY fr.inspected_at DESC, fr.inspection_result_id DESC
    LIMIT ${PQC_RECENT_MORE_LIMIT}`);
}

export function recentLot(row: RecentRow): RecentLot {
  return {
    inspectionResultId: Number(row.inspection_result_id),
    inspectedAt: row.inspected_at.toISOString(),
    counterpartName: null,
    equipmentCode: row.equipment_code,
    itemCode: row.item_code,
    itemName: row.item_name,
    lotNo: row.lot_no,
    qty: num(row.qty),
    judgmentCode: row.judgment,
  };
}

function codeName(groupCode: string): Prisma.Sql {
  return Prisma.sql`(SELECT cv.code, cv.code_name FROM mdm.code_value cv
    JOIN mdm.code_group cg ON cg.code_group_id = cv.code_group_id WHERE cg.group_code = ${groupCode})`;
}
