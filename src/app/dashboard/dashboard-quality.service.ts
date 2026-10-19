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
import { DashboardPeriod, num, plantScope } from './dashboard-scope';
import { DashboardEquipmentItem, DashboardQuality, DefectPhenomenon } from './dashboard-sections';

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
    equipment: readonly DashboardEquipmentItem[],
  ): Promise<DashboardQuality> {
    // 공장이 없어도 섹션은 낸다 — 빈 원천으로 같은 조립을 탄다(0 · 빈 배열 · null).
    const [judgments, recent, phenomena, vendors, items, holds, pending, nonconformance] =
      plants.length === 0
        ? [[], [], [], [], [], [], [], await this.nonconformances.read(tx, plants, period)]
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
        // 생산실적 기준 NG ÷ 총생산 — 검사 의뢰와 설비를 잇는 칸이 없다(결정 11).
        equipmentDefectRates: equipment
          .filter((item) => item.defectRate !== null)
          // 동률은 NG 수 → 설비 코드 자연 정렬(1-2 가 1-10 앞) 순이다.
          .sort(
            (a, b) =>
              (b.defectRate ?? 0) - (a.defectRate ?? 0) ||
              b.todayNgQty - a.todayNgQty ||
              a.equipmentCode.localeCompare(b.equipmentCode, undefined, { numeric: true }),
          )
          .slice(0, EQUIPMENT_TOP)
          .map((item) => ({
            equipmentId: item.equipmentId,
            equipmentCode: item.equipmentCode,
            defectRate: item.defectRate ?? 0,
            ngQty: item.todayNgQty,
          })),
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
        WHERE fr.local_date BETWEEN ${period.monthStart}::date AND ${period.baseDate}::date
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
        WHERE fr.type = 'IQC' AND fr.local_date BETWEEN ${period.monthStart}::date AND ${period.baseDate}::date
        GROUP BY p.partner_id HAVING SUM(fr.rejected_qty) > 0
        ORDER BY SUM(fr.rejected_qty) DESC, p.partner_id LIMIT ${TOP}`),
      tx.$queryRaw<{ item_id: bigint; item_code: string; item_name: string; qty: string }[]>(Prisma.sql`${head}
        SELECT i.item_id, i.item_code, i.item_name, SUM(fr.rejected_qty)::text AS qty
        FROM final_result fr JOIN mdm.item i ON i.item_id = fr.item_id
        WHERE fr.type = 'IQC' AND fr.local_date BETWEEN ${period.monthStart}::date AND ${period.baseDate}::date
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
    ]);
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
        FROM final_result fr WHERE fr.local_date <= ${period.baseDate}::date
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
