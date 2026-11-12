import { Prisma } from '@prisma/client';

import { DashboardPeriod, coarseRange, periodStart, requestPlant } from './dashboard-scope';
import { DefectPhenomenon, JudgmentCode, LotCounts, QualityTypeBlock } from './dashboard-sections';

export type InspectionType = 'IQC' | 'PQC' | 'OQC';

/**
 * `final_result` CTE — 확정된 검사 결과 중 의뢰마다 «최종 회차»만(재검사 후 합격 = 합격).
 * 입하 LOT IQC 요청(`target_type_code = INBOUND_LOT` · 피처 005)은 판정이 요청의 종합 판정이다.
 * 공장: IQC = LOT 의 공장 · PQC = W/O 라인의 공장 · OQC = 출하요청의 공장(`requestPlant` — 출하 섹션과 같은 식).
 * 공장 미지정 출하요청의 OQC 는 어느 공장을 골라도 넣는다 — 범위의 첫 공장 시간대로 날짜를 푼다(사용자 결정 2026-10-19).
 * ⚠ 앞에 `plant_scope` CTE 가 있어야 한다.
 */
export function finalResultCte(period: DashboardPeriod): Prisma.Sql {
  return confirmedResultCte(
    Prisma.sql`final_result`,
    period,
    Prisma.sql`ir.inspection_round = (
        SELECT MAX(x.inspection_round) FROM quality.inspection_result x
        WHERE x.inspection_request_id = ir.inspection_request_id AND x.status_code = 'CONFIRMED')`,
    Prisma.sql`CASE WHEN req.target_type_code = 'INBOUND_LOT'
      THEN COALESCE(req.overall_judgment_code, ir.overall_judgment_code) ELSE ir.overall_judgment_code END`,
  );
}

/**
 * `iqc_reinspect` CTE — IQC 「재검사 회차」(`previous_result_id` 가 있는 결과)를 회차마다 모두 싣는다(#118 사용자 결정 2026-10-19).
 * 입하 LOT IQC 결과는 회차 사슬이 없어 확정 주기 2 이상(확정 취소·재작업 재열기 뒤 기록)이 같은 뜻이다(피처 005).
 * 공장·판정 시각·확정 조건은 `final_result` 와 같은 조각이다. ⚠ 앞에 `plant_scope` CTE 가 있어야 한다.
 */
export function iqcReinspectCte(period: DashboardPeriod): Prisma.Sql {
  return confirmedResultCte(
    Prisma.sql`iqc_reinspect`,
    period,
    Prisma.sql`req.inspection_type_code = 'IQC' AND (ir.previous_result_id IS NOT NULL
      OR (req.target_type_code = 'INBOUND_LOT' AND ir.confirm_cycle >= 2))`,
  );
}

/**
 * `pqc_reinspect` CTE — PQC 「재검사 회차」. `iqc_reinspect` 와 같은 본문에 유형만 PQC(공장 = W/O 라인의 공장).
 * ⚠ 앞에 `plant_scope` CTE 가 있어야 한다.
 */
export function pqcReinspectCte(period: DashboardPeriod): Prisma.Sql {
  return confirmedResultCte(
    Prisma.sql`pqc_reinspect`,
    period,
    Prisma.sql`req.inspection_type_code = 'PQC' AND ir.previous_result_id IS NOT NULL`,
  );
}

/**
 * 입하 LOT IQC 요청은 `lot_id` 가 없다 — 표시·공급사용 LOT 은 그 입하 LOT 의 첫 자재 관리 LOT, 공장은 입하 LOT 의 것(피처 005).
 */
function confirmedResultCte(
  name: Prisma.Sql,
  period: DashboardPeriod,
  filter: Prisma.Sql,
  judgment: Prisma.Sql = Prisma.sql`ir.overall_judgment_code`,
): Prisma.Sql {
  return Prisma.sql`${name} AS (
    SELECT ir.inspection_result_id, ir.inspected_at, ir.inspected_qty, ir.accepted_qty, ir.rejected_qty,
      ${judgment} AS judgment, req.inspection_type_code AS type, req.item_id,
      COALESCE(req.lot_id, (SELECT MIN(m.lot_id) FROM trace.lot m WHERE m.inbound_lot_id = req.inbound_lot_id)) AS lot_id,
      req.work_order_id, wo.planned_equipment_id, sr.customer_id,
      (ir.inspected_at AT TIME ZONE ps.tz)::date AS local_date
    FROM quality.inspection_result ir
    JOIN quality.inspection_request req ON req.inspection_request_id = ir.inspection_request_id
    LEFT JOIN trace.lot lot ON lot.lot_id = req.lot_id
    LEFT JOIN trace.inbound_lot il ON il.inbound_lot_id = req.inbound_lot_id
    LEFT JOIN production.work_order wo ON wo.work_order_id = req.work_order_id
    LEFT JOIN mdm.production_line pl ON pl.production_line_id = wo.production_line_id
    LEFT JOIN logistics.shipment_request sr
      ON req.target_type_code = 'SHIPMENT_REQUEST' AND sr.shipment_request_id = req.target_id
    JOIN plant_scope ps ON ps.plant_id = CASE req.inspection_type_code
      WHEN 'IQC' THEN COALESCE(lot.plant_id, il.plant_id) WHEN 'PQC' THEN pl.plant_id
      WHEN 'OQC' THEN CASE WHEN sr.shipment_request_id IS NOT NULL
        THEN COALESCE(${requestPlant(Prisma.sql`sr`)}, (SELECT MIN(plant_id) FROM plant_scope)) END
    END
    WHERE ir.status_code = 'CONFIRMED' AND ${judgment} IN ('ACCEPTED', 'REJECTED', 'HELD')
      AND ${coarseRange(Prisma.sql`ir.inspected_at`, periodStart(period), period.to)}
      AND ${filter}
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
  const { from, to } = period;
  const monthLots = countBetween(rows, from, to);
  return {
    monthPassRate: passRate(monthLots),
    prevMonthPassRate: passRate(countBetween(rows, period.previousFrom, period.previousTo)),
    dailyPassRates: period.chartDays.map((date) => ({
      date,
      passRate: passRate(countBetween(rows, date, date)),
    })),
    todayLots: countBetween(rows, period.range.from, period.range.to),
    monthLots,
    monthDefectQty: rows
      .filter((row) => row.local_date >= from && row.local_date <= to)
      .reduce((sum, row) => sum + Number(row.rejected_qty), 0),
    defectPhenomena: phenomena.slice(0, 5),
    recentLots,
  };
}
