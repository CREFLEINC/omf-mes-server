import { Prisma } from '@prisma/client';

import { InspectionType, finalResultCte } from './dashboard-inspection';
import type { DashboardPeriod } from './dashboard-scope';

export const QUALITY_LOT_STATUSES = ['INSPECTION_HELD', 'RECEIPT_HOLD', 'PQC_PENDING', 'NC_OPEN'] as const;
export type QualityLotStatus = (typeof QUALITY_LOT_STATUSES)[number];

/**
 * 품질 종합 「현재 현황」의 상태 정의 — 대시보드 숫자와 상태별 LOT 목록(장부 P-58)이 «같은 조각»을 쓴다.
 * 조건을 한쪽만 고치면 숫자와 목록 건수가 갈라진다. ⚠ 모두 앞에 `plant_scope` CTE 가 있어야 한다.
 * 「검사 보류」는 `final_result`(dashboard-inspection.ts)의 최종 판정 HELD 를 누계 구간으로 센다 — 여기 없다.
 */

/** 입고 보류 — 해제 안 된 수입검사 대기 보류(LOT 상태에 HOLD 가 없다). 숫자는 LOT 수다. */
export const RECEIPT_HOLD_CTE = Prisma.sql`receipt_hold AS (
  SELECT h.lot_hold_id, h.lot_id, h.held_at, h.hold_qty, h.uom_id, h.reason_code, l.lot_no, l.item_id
  FROM trace.lot_hold h
  JOIN trace.lot l ON l.lot_id = h.lot_id
  JOIN plant_scope ps ON ps.plant_id = l.plant_id
  WHERE h.released_at IS NULL AND h.reason_code = 'INCOMING_INSPECTION_WAIT'
)`;

/** 검사 대기 — 판정 전 PQC 의뢰. 공장은 W/O 라인의 공장. */
export const PQC_PENDING_CTE = Prisma.sql`pqc_pending AS (
  SELECT req.*
  FROM quality.inspection_request req
  JOIN production.work_order wo ON wo.work_order_id = req.work_order_id
  JOIN mdm.production_line pl ON pl.production_line_id = wo.production_line_id
  JOIN plant_scope ps ON ps.plant_id = pl.plant_id
  WHERE req.inspection_type_code = 'PQC' AND req.status_code IN ('REQUESTED', 'IN_PROGRESS')
)`;

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

/** 공장 범위의 부적합(`scoped_nc`) — 시간대 `tz` 를 함께 싣는다. */
export const SCOPED_NC_CTE = Prisma.sql`scoped_nc AS (
  SELECT nc.*, ps.tz FROM quality.nonconformance nc
  JOIN plant_scope ps ON ps.plant_id = ${NONCONFORMANCE_PLANT}
)`;

/** 미종결 부적합 — 기간과 무관하다. `scoped_nc nc` 에 건다. */
export const OPEN_NC_WHERE = Prisma.sql`nc.closed_at IS NULL`;

/** 검사 보류 기록 — 누계 구간의 최종 판정 HELD. `final_result fr` 에 건다. 유형이 오면 그 유형만. */
export function heldWhere(period: DashboardPeriod, type?: InspectionType): Prisma.Sql {
  return Prisma.sql`fr.judgment = 'HELD' AND fr.local_date BETWEEN ${period.from}::date AND ${period.to}::date
    AND ${type === undefined ? Prisma.sql`TRUE` : Prisma.sql`fr.type = ${type}`}`;
}

export interface LotRecordRow {
  lot_count: number;
  record_count: number;
}

/**
 * 「n LOT · m건」 — 기록 수와 고유 LOT 수. LOT 없는 기록은 기록 수에만 든다(COUNT DISTINCT 는 null 을 세지 않는다).
 * 기록 = 검사 보류: 최종 판정 HELD 결과 · 입고 보류: 미해제 보류 행 · 검사 대기: 의뢰 · 미종결 부적합: 부적합(LOT = 대상 LOT 전부).
 * 대시보드 `quality.statusCounts` 와 상태별 LOT 목록이 이 한 식을 쓴다. `scope` = `plant_scope` CTE 본문.
 */
export function lotRecordCountSql(
  scope: Prisma.Sql,
  status: QualityLotStatus,
  period: DashboardPeriod,
  type?: InspectionType,
): Prisma.Sql {
  const count = (record: Prisma.Sql, lot: Prisma.Sql) =>
    Prisma.sql`SELECT COUNT(DISTINCT ${lot})::int AS lot_count, COUNT(DISTINCT ${record})::int AS record_count`;
  switch (status) {
    case 'INSPECTION_HELD':
      return Prisma.sql`WITH ${scope}, ${finalResultCte(period)}
        ${count(Prisma.sql`fr.inspection_result_id`, Prisma.sql`fr.lot_id`)} FROM final_result fr WHERE ${heldWhere(period, type)}`;
    case 'RECEIPT_HOLD':
      return Prisma.sql`WITH ${scope}, ${RECEIPT_HOLD_CTE}
        ${count(Prisma.sql`h.lot_hold_id`, Prisma.sql`h.lot_id`)} FROM receipt_hold h`;
    case 'PQC_PENDING':
      return Prisma.sql`WITH ${scope}, ${PQC_PENDING_CTE}
        ${count(Prisma.sql`q.inspection_request_id`, Prisma.sql`q.lot_id`)} FROM pqc_pending q`;
    case 'NC_OPEN':
      return Prisma.sql`WITH ${scope}, ${SCOPED_NC_CTE}
        ${count(Prisma.sql`nc.nonconformance_id`, Prisma.sql`nl.lot_id`)} FROM scoped_nc nc
        LEFT JOIN quality.nonconformance_lot nl ON nl.nonconformance_id = nc.nonconformance_id
        WHERE ${OPEN_NC_WHERE}`;
  }
}

/** IQC LOT 의 공급사 이름 — 그 LOT 을 실은 첫 입하 라인의 공급사. */
export function lotSupplierName(lotId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(SELECT p.partner_name FROM logistics.inbound_receipt_line irl
    JOIN logistics.inbound_receipt rc ON rc.inbound_receipt_id = irl.inbound_receipt_id
    JOIN mdm.partner p ON p.partner_id = rc.supplier_id
    WHERE irl.lot_id = ${lotId} ORDER BY irl.inbound_receipt_line_id LIMIT 1)`;
}

/** PQC 호기 — W/O 의 계획 설비, 없으면 그 W/O 의 마지막 작업세션 설비. */
export function pqcEquipmentCode(workOrderId: Prisma.Sql, plannedEquipmentId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(SELECT e.equipment_code FROM mdm.equipment e
    WHERE e.equipment_id = COALESCE(${plannedEquipmentId}, (
      SELECT ws.equipment_id FROM production.work_session ws
      WHERE ws.work_order_id = ${workOrderId} AND ws.equipment_id IS NOT NULL
      ORDER BY ws.started_at DESC LIMIT 1)))`;
}
