import { Prisma } from '@prisma/client';

import { maintenanceDateRange } from '../../maintenance/maintenance-calendar';
import type { DashboardPlant } from './dashboard-availability.service';
import { CONFIRMED_INSPECTION_RECORD, LATEST_RESULT_RECORD } from './dashboard-nonconformance.service';
import type { DashboardRange } from './dashboard-range';
import { LEAF_RESULT } from './dashboard-scope';
import type { ItemGroupRow } from './dashboard-view';

type Tx = Prisma.TransactionClient;

interface ItemGroupSqlRow {
  code: string | null;
  name: string | null;
  total_qty: string;
  good_qty: string;
  ng_qty: string;
}

/** 제품군 하나의 불량 유형 한 줄(공장마다 하나씩 올 수 있다). */
export interface ItemGroupDefectRow {
  readonly code: string | null;
  readonly defectCodeId: bigint;
  readonly defectCode: string;
  readonly defectName: string;
  readonly qty: number;
}

/**
 * 제품군(ERP 품목군)별 생산 합 — 대시보드 일자 생산(`dailyProduction`)과 같은 실적·공장·날짜 규칙이라 합하면 production
 * 섹션 값이 된다. 양품에는 재작업 W/O 합격분을 더한다(총생산·NG 에는 넣지 않는다).
 */
export async function readItemGroupRows(
  tx: Tx,
  plants: readonly DashboardPlant[],
  days: DashboardRange,
): Promise<ItemGroupRow[]> {
  const groups: ItemGroupRow[] = [];
  for (const plant of plants) {
    const range = maintenanceDateRange(days.from, days.to, plant.timezone);
    const rows = await tx.$queryRaw<ItemGroupSqlRow[]>(Prisma.sql`
      SELECT i.erp_item_group_code AS code, MAX(i.erp_item_group_name) AS name,
        COALESCE(SUM(pr.good_qty + pr.defect_qty + pr.hold_qty + pr.scrap_qty + pr.rework_qty)
          FILTER (WHERE wo.work_order_type_code <> 'REWORK'), 0)::text AS total_qty,
        COALESCE(SUM(pr.good_qty), 0)::text AS good_qty,
        COALESCE(SUM(pr.defect_qty + pr.scrap_qty + pr.rework_qty)
          FILTER (WHERE wo.work_order_type_code <> 'REWORK'), 0)::text AS ng_qty
      FROM production.production_result pr
      JOIN production.work_order wo ON wo.work_order_id = pr.work_order_id
      JOIN mdm.production_line l ON l.production_line_id = wo.production_line_id
      JOIN mdm.item i ON i.item_id = wo.item_id
      WHERE l.plant_id = ${plant.plantId}
        AND pr.occurred_at >= ${range.gte} AND pr.occurred_at < ${range.lt}
        AND ${LEAF_RESULT}
      GROUP BY i.erp_item_group_code`);
    groups.push(
      ...rows.map((row) => ({
        code: row.code,
        name: row.name,
        totalQty: Number(row.total_qty),
        goodQty: Number(row.good_qty),
        ngQty: Number(row.ng_qty),
      })),
    );
  }
  return groups;
}

/**
 * 제품군별 불량 유형 — 생산실적에 붙은 불량 기록만, 그 실적이 위 생산 합에 드는 것만 센다(정정 원본 · 재작업 W/O 제외,
 * 날짜는 실적 발생 시각). 그래서 정정된 원본 실적에 붙은 기록은 출처와 무관하게 빠진다(부적합 파레토와 다른 점). 확정 검사
 * 결과 · 정정본 유형별 내역 규칙은 파레토와 같다.
 */
export async function readItemGroupDefectRows(
  tx: Tx,
  plants: readonly DashboardPlant[],
  days: DashboardRange,
): Promise<ItemGroupDefectRow[]> {
  const out: ItemGroupDefectRow[] = [];
  for (const plant of plants) {
    const range = maintenanceDateRange(days.from, days.to, plant.timezone);
    const rows = await tx.$queryRaw<
      { code: string | null; defect_code_id: bigint; defect_code: string; defect_name: string; qty: string }[]
    >(Prisma.sql`
      SELECT i.erp_item_group_code AS code, dc.defect_code_id, dc.defect_code, dc.defect_name, SUM(dr.defect_qty)::text AS qty
      FROM quality.defect_record dr
      JOIN production.production_result pr ON pr.production_result_id = dr.production_result_id
      JOIN production.work_order wo ON wo.work_order_id = pr.work_order_id
      JOIN mdm.production_line l ON l.production_line_id = wo.production_line_id
      JOIN mdm.item i ON i.item_id = wo.item_id
      JOIN quality.defect_code dc ON dc.defect_code_id = dr.defect_code_id
      WHERE l.plant_id = ${plant.plantId} AND wo.work_order_type_code <> 'REWORK'
        AND pr.occurred_at >= ${range.gte} AND pr.occurred_at < ${range.lt}
        AND ${LEAF_RESULT} AND ${CONFIRMED_INSPECTION_RECORD} AND ${LATEST_RESULT_RECORD}
      GROUP BY i.erp_item_group_code, dc.defect_code_id`);
    out.push(
      ...rows.map((row) => ({
        code: row.code,
        defectCodeId: row.defect_code_id,
        defectCode: row.defect_code,
        defectName: row.defect_name,
        qty: Number(row.qty),
      })),
    );
  }
  return out;
}
