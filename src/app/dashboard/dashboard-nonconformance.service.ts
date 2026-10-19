import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { DashboardPlant } from './dashboard-availability.service';
import { DashboardPeriod, coarseRange, localDate, num, plantScope } from './dashboard-scope';
import { DashboardQuality } from './dashboard-sections';

type Tx = Prisma.TransactionClient;

interface MonthRow {
  month_qty: string | null;
  scrap_qty: string | null;
  rework_request_count: number;
  open_count: number;
  rework_released_qty: string | null;
  customer_return_qty: string | null;
}

export interface NonconformanceFigures {
  readonly block: DashboardQuality['nonconformance'];
  readonly reworkRequestCount: number;
  readonly customerReturnQty: number;
}

/**
 * 부적합의 공장 — 원천 W/O 라인의 공장, W/O 가 없으면(입하·반품 부적합) 첫 대상 LOT 의 공장.
 * 품목 쪽이 아니라 거래 쪽의 공장이다(같은 품목코드가 두 공장에 있다).
 */
const NONCONFORMANCE_PLANT = Prisma.sql`COALESCE(
  (SELECT pl.plant_id FROM production.work_order wo
   JOIN mdm.production_line pl ON pl.production_line_id = wo.production_line_id
   WHERE wo.work_order_id = nc.work_order_id),
  (SELECT lot.plant_id FROM quality.nonconformance_lot nl JOIN trace.lot lot ON lot.lot_id = nl.lot_id
   WHERE nl.nonconformance_id = nc.nonconformance_id ORDER BY nl.nonconformance_lot_id LIMIT 1))`;

const EMPTY_FIGURES: NonconformanceFigures = {
  block: {
    monthQty: 0,
    phenomena: [],
    causeGroups: [],
    scrapQty: 0,
    reworkReleasedQty: 0,
    openCount: 0,
    overdueCount: null,
  },
  reworkRequestCount: 0,
  customerReturnQty: 0,
};

@Injectable()
export class DashboardNonconformanceService {
  async read(tx: Tx, plants: readonly DashboardPlant[], period: DashboardPeriod): Promise<NonconformanceFigures> {
    if (plants.length === 0) return EMPTY_FIGURES;
    const { from, to } = period;
    const inMonth = (column: Prisma.Sql, timezone?: Prisma.Sql) =>
      Prisma.sql`${coarseRange(column, from, to)}
        AND ${localDate(column, timezone)} BETWEEN ${from}::date AND ${to}::date`;
    const ncTimezone = Prisma.sql`nc.tz`;
    const [row] = await tx.$queryRaw<MonthRow[]>(Prisma.sql`
      WITH ${plantScope(plants)},
      scoped_nc AS (
        SELECT nc.*, ps.tz FROM quality.nonconformance nc
        JOIN plant_scope ps ON ps.plant_id = ${NONCONFORMANCE_PLANT}
      )
      SELECT
        (SELECT SUM(nl.affected_qty) FROM scoped_nc nc
          JOIN quality.nonconformance_lot nl ON nl.nonconformance_id = nc.nonconformance_id
          WHERE ${inMonth(Prisma.sql`nc.opened_at`, ncTimezone)})::text AS month_qty,
        (SELECT SUM(d.decision_qty) FROM scoped_nc nc
          JOIN quality.disposition_decision d ON d.nonconformance_id = nc.nonconformance_id
          WHERE d.disposition_type_code = 'SCRAP' AND ${inMonth(Prisma.sql`d.decided_at`, ncTimezone)})::text AS scrap_qty,
        (SELECT COUNT(*) FROM scoped_nc nc
          JOIN quality.disposition_decision d ON d.nonconformance_id = nc.nonconformance_id
          WHERE d.disposition_type_code = 'REWORK' AND ${inMonth(Prisma.sql`d.decided_at`, ncTimezone)})::int AS rework_request_count,
        (SELECT COUNT(*) FROM scoped_nc nc WHERE nc.closed_at IS NULL)::int AS open_count,
        (SELECT SUM(pr.good_qty) FROM production.production_result pr
          JOIN production.work_order wo ON wo.work_order_id = pr.work_order_id
          JOIN mdm.production_line pl ON pl.production_line_id = wo.production_line_id
          JOIN plant_scope ps ON ps.plant_id = pl.plant_id
          WHERE wo.work_order_type_code = 'REWORK' AND wo.rework_source_nonconformance_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM production.production_result c
              WHERE c.corrects_production_result_id = pr.production_result_id)
            AND ${inMonth(Prisma.sql`pr.occurred_at`)})::text AS rework_released_qty,
        (SELECT SUM(grl.receipt_qty) FROM logistics.goods_receipt gr
          JOIN logistics.goods_receipt_line grl ON grl.goods_receipt_id = gr.goods_receipt_id
          JOIN plant_scope ps ON ps.plant_id = gr.plant_id
          WHERE gr.receipt_type_code = 'RETURN' AND gr.reason_code = 'CUSTOMER_RETURN'
            AND gr.status_code = 'POSTED' AND ${inMonth(Prisma.sql`gr.receipt_datetime`)})::text AS customer_return_qty`);

    const records = await this.defectRecords(tx, plants, period);
    return {
      block: {
        monthQty: num(row?.month_qty),
        phenomena: records.phenomena,
        causeGroups: records.causeGroups,
        scrapQty: num(row?.scrap_qty),
        reworkReleasedQty: num(row?.rework_released_qty),
        openCount: row?.open_count ?? 0,
        overdueCount: null,
      },
      reworkRequestCount: row?.rework_request_count ?? 0,
      customerReturnQty: num(row?.customer_return_qty),
    };
  }

  /** 누계 구간(당월 또는 조회 기간) 불량 기록의 현상(파레토)·원인 대분류. 원인은 확정 → 추정 순, 대분류는 상위 원인(없으면 자신). */
  private async defectRecords(tx: Tx, plants: readonly DashboardPlant[], period: DashboardPeriod) {
    const head = Prisma.sql`WITH ${plantScope(plants)},
      scoped_record AS (
        SELECT dr.* FROM quality.defect_record dr
        LEFT JOIN production.work_order wo ON wo.work_order_id = dr.work_order_id
        LEFT JOIN mdm.production_line pl ON pl.production_line_id = wo.production_line_id
        LEFT JOIN trace.lot lot ON lot.lot_id = dr.lot_id
        JOIN plant_scope ps ON ps.plant_id = COALESCE(pl.plant_id, lot.plant_id)
        WHERE ${coarseRange(Prisma.sql`dr.detected_at`, period.from, period.to)}
          AND ${localDate(Prisma.sql`dr.detected_at`)} BETWEEN ${period.from}::date AND ${period.to}::date
      )`;
    const phenomena = await tx.$queryRaw<
      { defect_code_id: bigint; defect_code: string; defect_name: string; qty: string }[]
    >(Prisma.sql`${head}
      SELECT dc.defect_code_id, dc.defect_code, dc.defect_name, SUM(r.defect_qty)::text AS qty
      FROM scoped_record r JOIN quality.defect_code dc ON dc.defect_code_id = r.defect_code_id
      GROUP BY dc.defect_code_id ORDER BY SUM(r.defect_qty) DESC, dc.defect_code_id`);
    const causes = await tx.$queryRaw<{ cause_code_id: bigint; cause_name: string; qty: string }[]>(Prisma.sql`${head}
      SELECT top.cause_code_id, top.cause_name, SUM(r.defect_qty)::text AS qty
      FROM scoped_record r
      JOIN quality.cause_code cc ON cc.cause_code_id = COALESCE(r.confirmed_cause_code_id, r.suspected_cause_code_id)
      JOIN quality.cause_code top ON top.cause_code_id = COALESCE(cc.parent_cause_code_id, cc.cause_code_id)
      GROUP BY top.cause_code_id ORDER BY SUM(r.defect_qty) DESC, top.cause_code_id`);
    return {
      phenomena: phenomena.map((row) => ({
        defectCodeId: Number(row.defect_code_id),
        defectCode: row.defect_code,
        defectName: row.defect_name,
        qty: num(row.qty),
      })),
      causeGroups: causes.map((row) => ({
        causeCodeId: Number(row.cause_code_id),
        causeName: row.cause_name,
        qty: num(row.qty),
      })),
    };
  }
}
