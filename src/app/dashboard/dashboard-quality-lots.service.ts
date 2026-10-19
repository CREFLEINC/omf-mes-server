import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { finalResultCte } from './dashboard-inspection';
import {
  OPEN_NC_WHERE,
  PQC_PENDING_CTE,
  RECEIPT_HOLD_CTE,
  SCOPED_NC_CTE,
  lotSupplierName,
  pqcEquipmentCode,
} from './dashboard-quality-status';
import { isDate } from './dashboard-range';
import { DashboardScopeQuery, dashboardScope, num, plantScope } from './dashboard-scope';

export const QUALITY_LOT_STATUSES = ['INSPECTION_HELD', 'RECEIPT_HOLD', 'PQC_PENDING', 'NC_OPEN'] as const;
export type QualityLotStatus = (typeof QUALITY_LOT_STATUSES)[number];

export interface DashboardQualityLotItem {
  key: string;
  lotNo: string | null;
  itemCode: string;
  itemName: string;
  qty: number | null;
  unitCode: string | null;
  occurredAt: string;
  refNo: string | null;
  inspectionType: 'IQC' | 'PQC' | 'OQC' | null;
  counterpartName: string | null;
  equipmentCode: string | null;
  detail: string | null;
}

export interface DashboardQualityLots {
  status: QualityLotStatus;
  asOf: string;
  totalCount: number;
  items: DashboardQualityLotItem[];
}

export interface DashboardQualityLotsQuery {
  status?: string;
  plantId?: string;
  baseDate?: string;
  dateFrom?: string;
  dateTo?: string;
}

interface LotRow {
  key: string;
  lot_no: string | null;
  item_code: string;
  item_name: string;
  qty: string | null;
  unit_code: string | null;
  occurred_at: Date;
  ref_no: string | null;
  inspection_type: DashboardQualityLotItem['inspectionType'];
  counterpart_name: string | null;
  equipment_code: string | null;
  detail: string | null;
  total_count: number;
}

const LIMIT = 200;
const INT64_MAX = 2n ** 63n - 1n;

/**
 * 품질 종합 「현재 현황」 상태별 LOT 목록(장부 P-58). 건수(`totalCount`)는 대시보드의 현재 현황 숫자와 같은
 * 조건 조각을 쓴다(dashboard-quality-status.ts). 기간은 「검사 보류」에만 걸리고 나머지는 지금 기준이다.
 * 오래 묵은 것부터 최대 200건. DB 에 없는 값은 null 이다.
 */
@Injectable()
export class DashboardQualityLotsService {
  constructor(private readonly prisma: PrismaService) {}

  async read(query: DashboardQualityLotsQuery): Promise<DashboardQualityLots> {
    const { status, scopeQuery } = parseQuery(query);
    const now = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        const { plants, period } = await dashboardScope(tx, scopeQuery, now);
        if (plants.length === 0) return { status, asOf: now.toISOString(), totalCount: 0, items: [] };
        const scope = plantScope(plants);
        const rows = await tx.$queryRaw<LotRow[]>(listSql(status, scope, period));
        return {
          status,
          asOf: now.toISOString(),
          totalCount: rows[0]?.total_count ?? 0,
          items: rows.map(item),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

/** 상태마다 목록 SQL — `total_count` 는 LIMIT 전 건수(창 함수)다. */
function listSql(
  status: QualityLotStatus,
  scope: Prisma.Sql,
  period: Parameters<typeof finalResultCte>[0],
): Prisma.Sql {
  const tail = Prisma.sql`ORDER BY occurred_at, key LIMIT ${LIMIT}`;
  switch (status) {
    case 'INSPECTION_HELD':
      // 대시보드 숫자 = IQC·PQC·OQC 의 누계 구간 monthLots.held 합(qualityTypeBlock 과 같은 날짜 경계).
      return Prisma.sql`WITH ${scope}, ${finalResultCte(period)}
        SELECT * FROM (
          SELECT 'IR-' || fr.inspection_result_id AS key, lot.lot_no, i.item_code, i.item_name,
            ir.held_qty::text AS qty, u.uom_code AS unit_code, fr.inspected_at AS occurred_at,
            ir.inspection_result_no AS ref_no, fr.type AS inspection_type,
            CASE fr.type WHEN 'IQC' THEN ${lotSupplierName(Prisma.sql`fr.lot_id`)}
              WHEN 'OQC' THEN (SELECT p.partner_name FROM mdm.partner p WHERE p.partner_id = fr.customer_id) END
              AS counterpart_name,
            CASE WHEN fr.type = 'PQC' THEN ${pqcEquipmentCode(Prisma.sql`fr.work_order_id`, Prisma.sql`fr.planned_equipment_id`)}
              END AS equipment_code,
            ir.remarks AS detail, (COUNT(*) OVER ())::int AS total_count
          FROM final_result fr
          JOIN quality.inspection_result ir ON ir.inspection_result_id = fr.inspection_result_id
          JOIN mdm.item i ON i.item_id = fr.item_id
          LEFT JOIN trace.lot lot ON lot.lot_id = fr.lot_id
          LEFT JOIN mdm.uom u ON u.uom_id = ir.uom_id
          WHERE fr.judgment = 'HELD' AND fr.local_date BETWEEN ${period.from}::date AND ${period.to}::date
        ) held ${tail}`;
    case 'RECEIPT_HOLD':
      // 숫자는 LOT 수(COUNT DISTINCT) — 한 LOT 에 보류가 둘이면 먼저 걸린 것 한 줄.
      return Prisma.sql`WITH ${scope}, ${RECEIPT_HOLD_CTE}
        SELECT * FROM (
          SELECT 'HOLD-' || h.lot_hold_id AS key, h.lot_no, i.item_code, i.item_name,
            COALESCE(h.hold_qty, irl.received_qty)::text AS qty,
            CASE WHEN h.hold_qty IS NOT NULL THEN hu.uom_code ELSE ru.uom_code END AS unit_code,
            h.held_at AS occurred_at, rc.inbound_receipt_no AS ref_no, NULL AS inspection_type,
            ${lotSupplierName(Prisma.sql`h.lot_id`)} AS counterpart_name, NULL AS equipment_code,
            reason.code_name AS detail, (COUNT(*) OVER ())::int AS total_count
          FROM (SELECT DISTINCT ON (lot_id) * FROM receipt_hold ORDER BY lot_id, held_at, lot_hold_id) h
          JOIN mdm.item i ON i.item_id = h.item_id
          LEFT JOIN mdm.uom hu ON hu.uom_id = h.uom_id
          LEFT JOIN LATERAL (SELECT * FROM logistics.inbound_receipt_line x WHERE x.lot_id = h.lot_id
            ORDER BY x.inbound_receipt_line_id LIMIT 1) irl ON true
          LEFT JOIN logistics.inbound_receipt rc ON rc.inbound_receipt_id = irl.inbound_receipt_id
          LEFT JOIN mdm.uom ru ON ru.uom_id = irl.uom_id
          LEFT JOIN ${codeName('LOT_HOLD_REASON')} reason ON reason.code = h.reason_code
        ) hold ${tail}`;
    case 'PQC_PENDING':
      return Prisma.sql`WITH ${scope}, ${PQC_PENDING_CTE}
        SELECT * FROM (
          SELECT 'REQ-' || q.inspection_request_id AS key, lot.lot_no, i.item_code, i.item_name,
            q.target_qty::text AS qty, u.uom_code AS unit_code, q.requested_at AS occurred_at,
            q.inspection_request_no AS ref_no, NULL AS inspection_type, NULL AS counterpart_name,
            ${pqcEquipmentCode(Prisma.sql`q.work_order_id`, Prisma.sql`wo.planned_equipment_id`)} AS equipment_code,
            st.code_name AS detail, (COUNT(*) OVER ())::int AS total_count
          FROM pqc_pending q
          JOIN production.work_order wo ON wo.work_order_id = q.work_order_id
          JOIN mdm.item i ON i.item_id = q.item_id
          LEFT JOIN trace.lot lot ON lot.lot_id = q.lot_id
          LEFT JOIN mdm.uom u ON u.uom_id = q.uom_id
          LEFT JOIN ${codeName('INSPECTION_REQUEST_STATUS')} st ON st.code = q.status_code
        ) pending ${tail}`;
    case 'NC_OPEN':
      return Prisma.sql`WITH ${scope}, ${SCOPED_NC_CTE}
        SELECT * FROM (
          SELECT 'NC-' || nc.nonconformance_id AS key, first_lot.lot_no, i.item_code, i.item_name,
            affected.qty::text AS qty, first_lot.uom_code AS unit_code, nc.opened_at AS occurred_at,
            nc.nonconformance_no AS ref_no, NULL AS inspection_type, NULL AS counterpart_name,
            NULL AS equipment_code, st.code_name AS detail, (COUNT(*) OVER ())::int AS total_count
          FROM scoped_nc nc
          JOIN mdm.item i ON i.item_id = nc.item_id
          LEFT JOIN LATERAL (SELECT lot.lot_no, u.uom_code FROM quality.nonconformance_lot nl
            JOIN trace.lot lot ON lot.lot_id = nl.lot_id LEFT JOIN mdm.uom u ON u.uom_id = nl.uom_id
            WHERE nl.nonconformance_id = nc.nonconformance_id ORDER BY nl.nonconformance_lot_id LIMIT 1) first_lot ON true
          LEFT JOIN LATERAL (SELECT SUM(nl.affected_qty) AS qty FROM quality.nonconformance_lot nl
            WHERE nl.nonconformance_id = nc.nonconformance_id) affected ON true
          LEFT JOIN ${codeName('NONCONFORMANCE_STATUS')} st ON st.code = nc.status_code
          WHERE ${OPEN_NC_WHERE}
        ) open_nc ${tail}`;
  }
}

/** 공통코드 이름 표 — 표시 문구를 서버가 만들지 않고 코드 이름 그대로 싣는다. */
function codeName(groupCode: string): Prisma.Sql {
  return Prisma.sql`(SELECT cv.code, cv.code_name FROM mdm.code_value cv
    JOIN mdm.code_group cg ON cg.code_group_id = cv.code_group_id WHERE cg.group_code = ${groupCode})`;
}

function item(row: LotRow): DashboardQualityLotItem {
  return {
    key: row.key,
    lotNo: row.lot_no,
    itemCode: row.item_code,
    itemName: row.item_name,
    qty: row.qty === null ? null : num(row.qty),
    unitCode: row.unit_code,
    occurredAt: row.occurred_at.toISOString(),
    refNo: row.ref_no,
    inspectionType: row.inspection_type,
    counterpartName: row.counterpart_name,
    equipmentCode: row.equipment_code,
    detail: row.detail,
  };
}

/**
 * ⛔ 이 경로는 계약 사본에 없어 계약 검증 가드가 질의를 보지 않는다(장부 P-58) — 여기서 같은 오류 모양으로 막는다.
 * 기간 순서·길이·미래는 `dashboardRange` 가 대시보드와 같은 규칙으로 막는다.
 */
export function parseQuery(query: DashboardQualityLotsQuery): {
  status: QualityLotStatus;
  scopeQuery: DashboardScopeQuery;
} {
  const errors: ErrorItem[] = [];
  const status = QUALITY_LOT_STATUSES.find((value) => value === query.status);
  if (query.status === undefined || query.status === '') {
    errors.push(field('status', ERROR_CODE.REQUIRED, 'status 는 필수입니다.'));
  } else if (status === undefined) {
    errors.push(field('status', ERROR_CODE.INVALID, `status 는 ${QUALITY_LOT_STATUSES.join(' · ')} 중 하나여야 합니다.`));
  }
  const plantId = query.plantId;
  const validPlant = plantId === undefined || (/^[1-9]\d{0,18}$/.test(plantId) && BigInt(plantId) <= INT64_MAX);
  if (!validPlant) errors.push(field('plantId', ERROR_CODE.INVALID, '양의 정수여야 합니다.'));
  if (query.baseDate !== undefined && !isDate(query.baseDate)) {
    errors.push(field('baseDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 날짜여야 합니다.'));
  }
  if (errors.length > 0 || status === undefined) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return {
    status,
    scopeQuery: {
      plantId: plantId === undefined ? undefined : BigInt(plantId),
      baseDate: query.baseDate,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
  };
}

function field(name: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field: name, code, message };
}
