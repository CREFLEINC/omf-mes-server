import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { DashboardPlant } from './dashboard-availability.service';
import {
  InspectionType,
  JudgmentRow,
  RecentLot,
  finalResultCte,
  qualityTypeBlock,
} from './dashboard-inspection';
import { DashboardNonconformanceService } from './dashboard-nonconformance.service';
import { DashboardPeriod, coarseRange, localDate, num, plantScope } from './dashboard-scope';
import { DashboardQuality, DefectPhenomenon, EquipmentDefectRate } from './dashboard-sections';

type Tx = Prisma.TransactionClient;

interface RecentRow {
  type: InspectionType;
  inspection_result_id: bigint;
  inspected_at: Date;
  counterpart_name: string | null;
  equipment_code: string | null;
  item_code: string;
  item_name: string;
  lot_no: string | null;
  qty: string;
  judgment: RecentLot['judgmentCode'];
}

interface PhenomenonRow {
  type: InspectionType;
  defect_code_id: bigint;
  defect_code: string;
  defect_name: string;
  qty: string;
}

export interface EquipmentDefectRow {
  equipment_id: bigint;
  equipment_code: string;
  total_qty: string;
  ng_qty: string;
}

const RECENT_LIMIT = 5;
const TOP = 5;
const EQUIPMENT_TOP = 8;

/**
 * 품질 섹션(#118 2차 · 장부 P-59). IQC·PQC·OQC 는 확정 검사 결과의 최종 회차로 센다.
 * ⚠ 불량현상·원인은 불량 기록(defect_record)이 쌓여야 나온다 — 지금은 MES 에 등록 경로가 없어 빈 배열이다.
 */
@Injectable()
export class DashboardQualityService {
  constructor(private readonly nonconformances: DashboardNonconformanceService) {}

  async read(
    tx: Tx,
    plants: readonly DashboardPlant[],
    period: DashboardPeriod,
  ): Promise<DashboardQuality> {
    // 공장이 없어도 섹션은 낸다 — 빈 원천으로 같은 조립을 탄다(0 · 빈 배열 · null).
    const [judgments, recent, phenomena, vendors, items, holds, pending, nonconformance, equipmentRows] =
      plants.length === 0
        ? [[], [], [], [], [], [], [], await this.nonconformances.read(tx, plants, period), []]
        : await this.queries(tx, plants, period);

    const block = (type: InspectionType) =>
      qualityTypeBlock(
        judgments.filter((row) => row.type === type),
        period,
        phenomena.filter((row) => row.type === type).map(phenomenon),
        recent.filter((row) => row.type === type).map(recentLot),
      );
    return {
      iqc: {
        ...block('IQC'),
        vendorDefects: vendors.map((row) => ({
          partnerId: Number(row.partner_id),
          partnerName: row.partner_name,
          rejectedQty: num(row.rejected_qty),
        })),
        itemDefects: items.map((row) => ({
          itemId: Number(row.item_id),
          itemCode: row.item_code,
          itemName: row.item_name,
          qty: num(row.qty),
        })),
        // 양품 복원(C15)을 표시하는 데이터가 없다 — 지어내지 않는다(#118 2차 결정 9).
        fullReinspect: null,
        receiptHoldLotCount: holds[0]?.lot_count ?? 0,
      },
      pqc: {
        ...block('PQC'),
        pendingLotCount: pending[0]?.request_count ?? 0,
        reworkRequestCount: nonconformance.reworkRequestCount,
        equipmentDefectRates: topEquipmentDefectRates(equipmentRows),
      },
      oqc: { ...block('OQC'), customerReturnQty: nonconformance.customerReturnQty },
      nonconformance: nonconformance.block,
    };
  }

  private queries(tx: Tx, plants: readonly DashboardPlant[], period: DashboardPeriod) {
    const head = Prisma.sql`WITH ${plantScope(plants)}, ${finalResultCte(period)}`;
    return Promise.all([
      tx.$queryRaw<JudgmentRow[]>(Prisma.sql`${head}
        SELECT type, to_char(local_date, 'YYYY-MM-DD') AS local_date, judgment,
          COUNT(*)::int AS lot_count, SUM(rejected_qty)::text AS rejected_qty
        FROM final_result GROUP BY type, local_date, judgment`),
      this.recent(tx, head, period),
      tx.$queryRaw<PhenomenonRow[]>(Prisma.sql`${head}
        SELECT fr.type, dc.defect_code_id, dc.defect_code, dc.defect_name, SUM(dr.defect_qty)::text AS qty
        FROM final_result fr
        JOIN quality.defect_record dr ON dr.inspection_result_id = fr.inspection_result_id
        JOIN quality.defect_code dc ON dc.defect_code_id = dr.defect_code_id
        WHERE fr.local_date BETWEEN ${period.from}::date AND ${period.to}::date
        GROUP BY fr.type, dc.defect_code_id ORDER BY SUM(dr.defect_qty) DESC`),
      tx.$queryRaw<{ partner_id: bigint; partner_name: string; rejected_qty: string }[]>(Prisma.sql`${head}
        SELECT p.partner_id, p.partner_name, SUM(fr.rejected_qty)::text AS rejected_qty
        FROM final_result fr
        -- LOT 하나에 입하 줄이 여럿이어도 한 번만 센다 — 최근 목록과 같이 첫 줄, 취소된 입하는 뺀다.
        JOIN LATERAL (
          SELECT rc.supplier_id FROM logistics.inbound_receipt_line irl
          JOIN logistics.inbound_receipt rc ON rc.inbound_receipt_id = irl.inbound_receipt_id
          WHERE irl.lot_id = fr.lot_id AND rc.status_code <> 'CANCELLED'
          ORDER BY irl.inbound_receipt_line_id LIMIT 1
        ) supplier ON TRUE
        JOIN mdm.partner p ON p.partner_id = supplier.supplier_id
        WHERE fr.type = 'IQC' AND fr.local_date BETWEEN ${period.from}::date AND ${period.to}::date
        GROUP BY p.partner_id HAVING SUM(fr.rejected_qty) > 0
        ORDER BY SUM(fr.rejected_qty) DESC, p.partner_id LIMIT ${TOP}`),
      tx.$queryRaw<{ item_id: bigint; item_code: string; item_name: string; qty: string }[]>(Prisma.sql`${head}
        SELECT i.item_id, i.item_code, i.item_name, SUM(fr.rejected_qty)::text AS qty
        FROM final_result fr JOIN mdm.item i ON i.item_id = fr.item_id
        WHERE fr.type = 'IQC' AND fr.local_date BETWEEN ${period.from}::date AND ${period.to}::date
        GROUP BY i.item_id HAVING SUM(fr.rejected_qty) > 0
        ORDER BY SUM(fr.rejected_qty) DESC, i.item_id LIMIT ${TOP}`),
      // 「입하 보류」는 LOT 상태가 아니라 풀리지 않은 수입검사 대기 보류다 — LOT 상태에 HOLD 가 없다.
      tx.$queryRaw<{ lot_count: number }[]>(Prisma.sql`WITH ${plantScope(plants)}
        SELECT COUNT(DISTINCT h.lot_id)::int AS lot_count
        FROM trace.lot_hold h JOIN trace.lot l ON l.lot_id = h.lot_id
        JOIN plant_scope ps ON ps.plant_id = l.plant_id
        WHERE h.released_at IS NULL AND h.reason_code = 'INCOMING_INSPECTION_WAIT'`),
      tx.$queryRaw<{ request_count: number }[]>(Prisma.sql`WITH ${plantScope(plants)}
        SELECT COUNT(*)::int AS request_count
        FROM quality.inspection_request req
        JOIN production.work_order wo ON wo.work_order_id = req.work_order_id
        JOIN mdm.production_line pl ON pl.production_line_id = wo.production_line_id
        JOIN plant_scope ps ON ps.plant_id = pl.plant_id
        WHERE req.inspection_type_code = 'PQC' AND req.status_code IN ('REQUESTED', 'IN_PROGRESS')`),
      this.nonconformances.read(tx, plants, period),
      this.equipmentDefects(tx, plants, period),
    ]);
  }

  /**
   * 호기별 불량률의 원천 — 누계 구간(하루면 당월, 기간이면 그 기간)의 생산실적 NG ÷ 총생산(결정 11 · #118 사용자 결정).
   * 검사 의뢰와 설비를 잇는 칸이 없어 PQC 판정이 아니라 실적으로 센다. 설비 범위·실적 규칙은 설비 현황과 같다
   * (생산 설비 · 정정 원본 제외 · 재작업 W/O 실적 제외 · 재작업 합격 이동 없음).
   */
  private equipmentDefects(
    tx: Tx,
    plants: readonly DashboardPlant[],
    period: DashboardPeriod,
  ): Promise<EquipmentDefectRow[]> {
    return tx.$queryRaw<EquipmentDefectRow[]>(Prisma.sql`WITH ${plantScope(plants)}
      SELECT e.equipment_id, e.equipment_code,
        SUM(pr.good_qty + pr.defect_qty + pr.hold_qty + pr.scrap_qty + pr.rework_qty)::text AS total_qty,
        SUM(pr.defect_qty + pr.scrap_qty + pr.rework_qty)::text AS ng_qty
      FROM production.production_result pr
      JOIN production.work_order wo ON wo.work_order_id = pr.work_order_id
      JOIN mdm.equipment e ON e.equipment_id = pr.equipment_id
      JOIN plant_scope ps ON ps.plant_id = e.plant_id
      JOIN mdm.code_group cg ON cg.group_code = 'EQUIPMENT_TYPE'
      JOIN mdm.code_value cv ON cv.code_group_id = cg.code_group_id AND cv.code = e.equipment_type_code
      WHERE e.is_active AND e.status_code = 'IN_SERVICE' AND wo.work_order_type_code <> 'REWORK'
        AND ${coarseRange(Prisma.sql`pr.occurred_at`, period.from, period.to)}
        AND ${localDate(Prisma.sql`pr.occurred_at`)} BETWEEN ${period.from}::date AND ${period.to}::date
        AND NOT EXISTS (SELECT 1 FROM production.production_result c
          WHERE c.corrects_production_result_id = pr.production_result_id)
      GROUP BY e.equipment_id`);
  }

  /**
   * 유형마다 최근 5건. 상대: IQC = 공급사(입하) · OQC = 고객(출하요청).
   * PQC 호기 = W/O 의 계획 설비, 없으면 그 W/O 의 마지막 작업세션 설비. PQC·OQC 의뢰에는 LOT 이 없다.
   */
  private recent(tx: Tx, head: Prisma.Sql, period: DashboardPeriod): Promise<RecentRow[]> {
    return tx.$queryRaw<RecentRow[]>(Prisma.sql`${head},
      ranked AS (
        SELECT fr.*, ROW_NUMBER() OVER (PARTITION BY fr.type ORDER BY fr.inspected_at DESC,
          fr.inspection_result_id DESC) AS rank
        FROM final_result fr WHERE fr.local_date <= ${period.to}::date
      )
      SELECT r.type, r.inspection_result_id, r.inspected_at, r.inspected_qty::text AS qty, r.judgment,
        i.item_code, i.item_name, lot.lot_no,
        CASE r.type
          WHEN 'IQC' THEN (SELECT p.partner_name FROM logistics.inbound_receipt_line irl
            JOIN logistics.inbound_receipt rc ON rc.inbound_receipt_id = irl.inbound_receipt_id
            JOIN mdm.partner p ON p.partner_id = rc.supplier_id
            WHERE irl.lot_id = r.lot_id ORDER BY irl.inbound_receipt_line_id LIMIT 1)
          WHEN 'OQC' THEN (SELECT p.partner_name FROM mdm.partner p WHERE p.partner_id = r.customer_id)
        END AS counterpart_name,
        CASE WHEN r.type = 'PQC' THEN (SELECT e.equipment_code FROM mdm.equipment e
          WHERE e.equipment_id = COALESCE(r.planned_equipment_id, (
            SELECT ws.equipment_id FROM production.work_session ws
            WHERE ws.work_order_id = r.work_order_id AND ws.equipment_id IS NOT NULL
            ORDER BY ws.started_at DESC LIMIT 1)))
        END AS equipment_code
      FROM ranked r
      JOIN mdm.item i ON i.item_id = r.item_id
      LEFT JOIN trace.lot lot ON lot.lot_id = r.lot_id
      WHERE r.rank <= ${RECENT_LIMIT}
      ORDER BY r.type, r.rank`);
  }
}

/** 호기별 불량률 — 불량률 내림차순 → NG 수 내림차순 → 설비 코드 자연 정렬(1-2 가 1-10 앞), 상위 8. 총생산 0 은 뺀다. */
export function topEquipmentDefectRates(rows: readonly EquipmentDefectRow[]): EquipmentDefectRate[] {
  return rows
    .filter((row) => num(row.total_qty) > 0)
    .map((row) => ({
      equipmentId: Number(row.equipment_id),
      equipmentCode: row.equipment_code,
      defectRate: (num(row.ng_qty) / num(row.total_qty)) * 100,
      ngQty: num(row.ng_qty),
    }))
    .sort(
      (a, b) =>
        b.defectRate - a.defectRate ||
        b.ngQty - a.ngQty ||
        a.equipmentCode.localeCompare(b.equipmentCode, undefined, { numeric: true }),
    )
    .slice(0, EQUIPMENT_TOP);
}

function phenomenon(row: PhenomenonRow): DefectPhenomenon {
  return {
    defectCodeId: Number(row.defect_code_id),
    defectCode: row.defect_code,
    defectName: row.defect_name,
    qty: num(row.qty),
  };
}

function recentLot(row: RecentRow): RecentLot {
  return {
    inspectionResultId: Number(row.inspection_result_id),
    inspectedAt: row.inspected_at.toISOString(),
    counterpartName: row.counterpart_name,
    equipmentCode: row.equipment_code,
    itemCode: row.item_code,
    itemName: row.item_name,
    lotNo: row.lot_no,
    qty: num(row.qty),
    judgmentCode: row.judgment,
  };
}
