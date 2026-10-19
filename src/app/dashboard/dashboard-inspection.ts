import { Prisma } from '@prisma/client';

import { DashboardPeriod, coarseRange } from './dashboard-scope';
import { DefectPhenomenon, JudgmentCode, LotCounts, QualityTypeBlock } from './dashboard-sections';
import { trailingDays } from './dashboard-view';

export type InspectionType = 'IQC' | 'PQC' | 'OQC';
export const DAILY_PASS_DAYS = 9;

/**
 * `final_result` CTE — 확정된 검사 결과 중 의뢰마다 «최종 회차»만(재검사 후 합격 = 합격).
 * 공장: IQC = LOT 의 공장 · PQC = W/O 라인의 공장 · OQC = 출하요청의 출하 공장(비면 빠진다).
 * ⚠ 앞에 `plant_scope` CTE 가 있어야 한다.
 */
export function finalResultCte(period: DashboardPeriod): Prisma.Sql {
  return Prisma.sql`final_result AS (
    SELECT ir.inspection_result_id, ir.inspected_at, ir.inspected_qty, ir.rejected_qty,
      ir.overall_judgment_code AS judgment, req.inspection_type_code AS type, req.item_id, req.lot_id,
      req.work_order_id, wo.planned_equipment_id, sr.customer_id,
      (ir.inspected_at AT TIME ZONE ps.tz)::date AS local_date
    FROM quality.inspection_result ir
    JOIN quality.inspection_request req ON req.inspection_request_id = ir.inspection_request_id
    LEFT JOIN trace.lot lot ON lot.lot_id = req.lot_id
    LEFT JOIN production.work_order wo ON wo.work_order_id = req.work_order_id
    LEFT JOIN mdm.production_line pl ON pl.production_line_id = wo.production_line_id
    LEFT JOIN logistics.shipment_request sr
      ON req.target_type_code = 'SHIPMENT_REQUEST' AND sr.shipment_request_id = req.target_id
    JOIN plant_scope ps ON ps.plant_id = CASE req.inspection_type_code
      WHEN 'IQC' THEN lot.plant_id WHEN 'PQC' THEN pl.plant_id WHEN 'OQC' THEN sr.fulfillment_plant_id END
    WHERE ir.status_code = 'CONFIRMED' AND ir.overall_judgment_code IN ('ACCEPTED', 'REJECTED', 'HELD')
      AND ${coarseRange(Prisma.sql`ir.inspected_at`, period.previousMonthStart, period.baseDate)}
      AND ir.inspection_round = (
        SELECT MAX(x.inspection_round) FROM quality.inspection_result x
        WHERE x.inspection_request_id = ir.inspection_request_id AND x.status_code = 'CONFIRMED')
  )`;
}

/** 유형·현지 날짜·판정별 건수와 불합격 수량. */
export interface JudgmentRow {
  type: InspectionType;
  local_date: string;
  judgment: JudgmentCode;
  lot_count: number;
  rejected_qty: string;
}

export type RecentLot = QualityTypeBlock['recentLots'][number];

const EMPTY: LotCounts = { accepted: 0, rejected: 0, held: 0 };

function add(counts: LotCounts, row: JudgmentRow): LotCounts {
  const key = row.judgment === 'ACCEPTED' ? 'accepted' : row.judgment === 'REJECTED' ? 'rejected' : 'held';
  return { ...counts, [key]: counts[key] + row.lot_count };
}

/** 합격률 = 합격 ÷ (합격 + 불합격) %, 보류는 빼고 모수 0 이면 null. */
export function passRate(counts: LotCounts): number | null {
  const judged = counts.accepted + counts.rejected;
  return judged === 0 ? null : (counts.accepted / judged) * 100;
}

function countBetween(rows: readonly JudgmentRow[], from: string, to: string): LotCounts {
  return rows.filter((row) => row.local_date >= from && row.local_date <= to).reduce(add, EMPTY);
}

export function qualityTypeBlock(
  rows: readonly JudgmentRow[],
  period: DashboardPeriod,
  phenomena: DefectPhenomenon[],
  recentLots: RecentLot[],
): QualityTypeBlock {
  const { baseDate, monthStart } = period;
  const monthLots = countBetween(rows, monthStart, baseDate);
  return {
    monthPassRate: passRate(monthLots),
    prevMonthPassRate: passRate(countBetween(rows, period.previousMonthStart, period.previousMonthEnd)),
    dailyPassRates: trailingDays(baseDate, DAILY_PASS_DAYS).map((date) => ({
      date,
      passRate: passRate(countBetween(rows, date, date)),
    })),
    todayLots: countBetween(rows, baseDate, baseDate),
    monthLots,
    monthDefectQty: rows
      .filter((row) => row.local_date >= monthStart && row.local_date <= baseDate)
      .reduce((sum, row) => sum + Number(row.rejected_qty), 0),
    defectPhenomena: phenomena.slice(0, 5),
    recentLots,
  };
}
