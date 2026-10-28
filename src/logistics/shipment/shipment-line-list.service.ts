import { Injectable } from '@nestjs/common';

import { pageRequest, pagedResponse } from '../../common/pagination';
import { localPeriodSql, periodUnlessPinned, plantToday } from '../../common/period/plant-local-period';
import { PrismaService } from '../../prisma/prisma.service';
import { BuiltSql, Named, PagedWithTotals, UomTotalRow, lineTotals, named } from '../line-list';

/**
 * 출하 건을 가로지르는 출하 줄 목록 — 제품출고 현황(LOT 추적 화면 · 장부 P-119).
 * 출하 목록(`GET /logistics/shipments`)은 머리글 단위라 품목 필터·수량이 없다. 기간 축은 출하 목록과 같은
 * `shipped_at` 이고 공장(출하 창고의 공장) 현지 날짜다.
 */
export interface ShipmentLineListQuery {
  shipDateFrom?: string;
  shipDateTo?: string;
  plantId?: number;
  warehouseId?: number;
  itemId?: number;
  customerId?: number;
  /** 줄에 배분된 LOT 의 번호 정확 일치 — 집는 번호라 기간이 선택이 된다(아래 셋 모두). */
  lotNo?: string;
  shipmentNo?: string;
  /** 줄에 배분된 LOT 의 원천 W/O 번호. */
  workOrderNo?: string;
  statusCode?: string;
  q?: string;
  page?: number;
  size?: number;
}

export interface ShipmentLineListItem {
  shipmentLineId: number;
  shipmentId: number;
  shipmentNo: string;
  lineNo: number;
  shippedAt: string;
  statusCode: string;
  plantId: number;
  warehouse: Named;
  customer: Named;
  item: Named;
  shippedQty: number;
  uomId: number;
  uomCode: string;
  /** 앞에서 몇 개만 — 전부는 `lotCount` 와 출하 LOT 배분 목록으로 본다. */
  lots: { lotId: number; lotNo: string; qty: number }[];
  lotCount: number;
}

/** 줄마다 보이는 LOT 수 — 한 줄에 상자가 많으면 LOT 도 많다. */
export const LOTS_SHOWN = 5;
/** 상태를 고르지 않으면 취소된 출하는 뺀다. */
const CANCELLED = 'CANCELLED';
const WORK_ORDER_LOT_SOURCE = 'WORK_ORDER';

const FROM = `
  FROM logistics.shipment_line sl
  JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
  JOIN mdm.warehouse w ON w.warehouse_id = s.warehouse_id
  JOIN mdm.plant p ON p.plant_id = w.plant_id
  JOIN logistics.shipment_request sr ON sr.shipment_request_id = s.shipment_request_id`;

export function shipmentLineWhere(query: ShipmentLineListQuery, today: string): BuiltSql {
  const period = periodUnlessPinned(query.shipDateFrom, query.shipDateTo,
    { from: 'shipDateFrom', to: 'shipDateTo', label: '출하일' },
    query.lotNo !== undefined || query.shipmentNo !== undefined || query.workOrderNo !== undefined,
    'LOT 번호(lotNo), 출하 번호(shipmentNo), W/O 번호(workOrderNo)', today);
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  // 기간 없이 번호로 집어도 아직 출하하지 않은 출하(출하 일시 없음)는 기간이 있을 때처럼 뺀다.
  const and = [period === undefined ? 's.shipped_at IS NOT NULL' : localPeriodSql('s.shipped_at', 'p.timezone_code', period, bind)];
  and.push(query.statusCode === undefined ? `s.status_code <> ${bind(CANCELLED)}` : `s.status_code = ${bind(query.statusCode)}`);
  if (query.plantId !== undefined) and.push(`w.plant_id = ${bind(query.plantId)}::bigint`);
  if (query.warehouseId !== undefined) and.push(`s.warehouse_id = ${bind(query.warehouseId)}::bigint`);
  if (query.itemId !== undefined) and.push(`sl.item_id = ${bind(query.itemId)}::bigint`);
  if (query.customerId !== undefined) and.push(`sr.customer_id = ${bind(query.customerId)}::bigint`);
  if (query.shipmentNo !== undefined) and.push(`s.shipment_no = ${bind(query.shipmentNo)}`);
  const lot: string[] = [];
  if (query.lotNo !== undefined) lot.push(`la.lot_no = ${bind(query.lotNo)}`);
  if (query.workOrderNo !== undefined) {
    lot.push(`EXISTS (SELECT 1 FROM production.work_order lw
      WHERE la.source_type_code = '${WORK_ORDER_LOT_SOURCE}' AND lw.work_order_id = la.source_id AND lw.work_order_no = ${bind(query.workOrderNo)})`);
  }
  if (lot.length > 0) {
    and.push(`EXISTS (SELECT 1 FROM logistics.shipment_lot_allocation lx JOIN trace.lot la ON la.lot_id = lx.lot_id
      WHERE lx.shipment_line_id = sl.shipment_line_id AND ${lot.join(' AND ')})`);
  }
  if (query.q !== undefined && query.q.trim() !== '') {
    const like = bind(`%${query.q.trim()}%`);
    and.push(`(s.shipment_no ILIKE ${like} OR EXISTS (SELECT 1 FROM logistics.shipment_lot_allocation qa
      JOIN trace.lot ql ON ql.lot_id = qa.lot_id WHERE qa.shipment_line_id = sl.shipment_line_id AND ql.lot_no ILIKE ${like}))`);
  }
  return { sql: and.join('\n    AND '), params };
}

interface LineRow {
  shipment_line_id: bigint;
  shipment_id: bigint;
  shipment_no: string;
  line_no: number;
  shipped_at: Date;
  status_code: string;
  plant_id: bigint;
  warehouse_id: bigint;
  warehouse_code: string;
  warehouse_name: string;
  customer_id: bigint;
  customer_code: string;
  customer_name: string;
  item_id: bigint;
  item_code: string;
  item_name: string;
  shipped_qty: unknown;
  uom_id: bigint;
  uom_code: string;
}

interface LotRow {
  shipment_line_id: bigint;
  lot_id: bigint;
  lot_no: string;
  qty: unknown;
  lot_count: bigint;
}

@Injectable()
export class ShipmentLineListService {
  constructor(private readonly prisma: PrismaService) {}

  /** 출하 일시 내림차순 → 출하 → 줄 번호 — 최근 것부터 본다. */
  async list(query: ShipmentLineListQuery): Promise<PagedWithTotals<ShipmentLineListItem>> {
    const page = pageRequest(query);
    const where = shipmentLineWhere(query, await plantToday(this.prisma, query.plantId));
    const next = where.params.length;
    const [rows, totals] = await Promise.all([
      this.prisma.$queryRawUnsafe<LineRow[]>(
        `SELECT sl.shipment_line_id, sl.shipment_id, s.shipment_no, sl.line_no, s.shipped_at, s.status_code, w.plant_id,
                w.warehouse_id, w.warehouse_code, w.warehouse_name,
                c.partner_id AS customer_id, c.partner_code AS customer_code, c.partner_name AS customer_name,
                i.item_id, i.item_code, i.item_name, sl.shipped_qty, u.uom_id, u.uom_code
         ${FROM}
         JOIN mdm.partner c ON c.partner_id = sr.customer_id
         JOIN mdm.item i ON i.item_id = sl.item_id
         JOIN mdm.uom u ON u.uom_id = sl.uom_id
         WHERE ${where.sql}
         ORDER BY s.shipped_at DESC, sl.shipment_id DESC, sl.line_no ASC
         LIMIT $${next + 1} OFFSET $${next + 2}`,
        ...where.params, page.take, page.skip,
      ),
      this.prisma.$queryRawUnsafe<UomTotalRow[]>(
        `SELECT u.uom_id, u.uom_code, SUM(sl.shipped_qty) AS qty, COUNT(*) AS line_count
         ${FROM}
         JOIN mdm.uom u ON u.uom_id = sl.uom_id
         WHERE ${where.sql}
         GROUP BY u.uom_id, u.uom_code
         ORDER BY u.uom_code`,
        ...where.params,
      ),
    ]);
    const lots = await this.lotsOf(rows.map((row) => row.shipment_line_id));
    const result = lineTotals(totals);
    return { ...pagedResponse(rows.map((row) => itemOf(row, lots.get(row.shipment_line_id) ?? [])), result.lineCount, page), totals: result };
  }

  /** 이 쪽의 줄마다 LOT 앞 몇 개와 전체 수 — LOT 번호순. */
  private async lotsOf(lineIds: bigint[]): Promise<Map<bigint, LotRow[]>> {
    if (lineIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRawUnsafe<(LotRow & { seq: bigint })[]>(
      `SELECT * FROM (
         SELECT a.shipment_line_id, l.lot_id, l.lot_no, SUM(a.allocated_qty) AS qty,
                ROW_NUMBER() OVER (PARTITION BY a.shipment_line_id ORDER BY l.lot_no, l.lot_id) AS seq,
                COUNT(*) OVER (PARTITION BY a.shipment_line_id) AS lot_count
           FROM logistics.shipment_lot_allocation a
           JOIN trace.lot l ON l.lot_id = a.lot_id
          WHERE a.shipment_line_id = ANY($1::bigint[])
          GROUP BY a.shipment_line_id, l.lot_id, l.lot_no
       ) ranked WHERE seq <= $2`,
      lineIds, LOTS_SHOWN,
    );
    const byLine = new Map<bigint, LotRow[]>();
    for (const row of rows) byLine.set(row.shipment_line_id, [...(byLine.get(row.shipment_line_id) ?? []), row]);
    return byLine;
  }
}

function itemOf(row: LineRow, lots: LotRow[]): ShipmentLineListItem {
  return {
    shipmentLineId: Number(row.shipment_line_id),
    shipmentId: Number(row.shipment_id),
    shipmentNo: row.shipment_no,
    lineNo: row.line_no,
    shippedAt: row.shipped_at.toISOString(),
    statusCode: row.status_code,
    plantId: Number(row.plant_id),
    warehouse: named(row.warehouse_id, row.warehouse_code, row.warehouse_name),
    customer: named(row.customer_id, row.customer_code, row.customer_name),
    item: named(row.item_id, row.item_code, row.item_name),
    shippedQty: Number(row.shipped_qty),
    uomId: Number(row.uom_id),
    uomCode: row.uom_code,
    lots: lots.map((lot) => ({ lotId: Number(lot.lot_id), lotNo: lot.lot_no, qty: Number(lot.qty) })),
    lotCount: lots.length === 0 ? 0 : Number(lots[0].lot_count),
  };
}
