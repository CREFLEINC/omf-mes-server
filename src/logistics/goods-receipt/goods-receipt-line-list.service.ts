import { Injectable } from '@nestjs/common';

import { pageRequest, pagedResponse } from '../../common/pagination';
import { localPeriodSql, periodUnlessPinned, plantToday } from '../../common/period/plant-local-period';
import { PrismaService } from '../../prisma/prisma.service';
import { BuiltSql, LineTotals, Named, PagedResponseWith, UomTotalRow, lineTotals, named } from '../line-list';

/**
 * 입고 건을 가로지르는 입고 줄 목록 — 자재입고·생산입고 현황(LOT 추적 화면 · 장부 P-119).
 * 입고 목록(`GET /logistics/goods-receipts`)은 머리글 단위라 품목·수량이 없다.
 * 기간은 공장 현지 날짜다 — 입고 목록의 `receiptDateFrom/To`(UTC 날짜)와 다르다.
 */
export interface GoodsReceiptLineListQuery {
  receiptTypeCode?: string;
  receiptDateFrom?: string;
  receiptDateTo?: string;
  plantId?: number;
  warehouseId?: number;
  itemId?: number;
  supplierId?: number;
  /** LOT 번호 정확 일치 — 집는 번호라 기간이 선택이 된다(아래 셋 모두). */
  lotNo?: string;
  inboundReceiptNo?: string;
  /** 생산입고의 LOT 원천 W/O 번호. */
  workOrderNo?: string;
  statusCode?: string;
  q?: string;
  page?: number;
  size?: number;
}

export interface GoodsReceiptLineListItem {
  goodsReceiptLineId: number;
  goodsReceiptId: number;
  goodsReceiptNo: string;
  lineNo: number;
  receiptTypeCode: string;
  receiptDatetime: string;
  statusCode: string;
  plantId: number;
  warehouse: Named;
  item: Named;
  lotId: number;
  lotNo: string;
  receiptQty: number;
  uomId: number;
  uomCode: string;
  /** 입하 줄에서 온 입고(자재입고)만 — 그 입하의 공급사. */
  supplier: Named | null;
  /** LOT 원천이 W/O 인 입고(생산입고)만. */
  workOrder: { workOrderId: number; workOrderNo: string } | null;
}

/**
 * 상태를 고르지 않으면 취소 완료만 뺀다. 취소 요청 중인 입고는 재고가 그대로이고 반려되면 그대로 남는다 —
 * ERP 구매입고가 「살아 있는 입고」로 보는 범위(`erp-receipt.ts` 의 POSTED·CANCEL_REQUESTED)와 같다
 * (입고는 생성과 전기가 같은 순간이라 REGISTERED 로 머물지 않는다).
 */
const CANCELLED = 'CANCELLED';
const WORK_ORDER_LOT_SOURCE = 'WORK_ORDER';

const FROM = `
  FROM logistics.goods_receipt_line l
  JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = l.goods_receipt_id
  JOIN mdm.plant p ON p.plant_id = gr.plant_id
  JOIN trace.lot lt ON lt.lot_id = l.lot_id`;

export function goodsReceiptLineWhere(query: GoodsReceiptLineListQuery, today: string): BuiltSql {
  const period = periodUnlessPinned(query.receiptDateFrom, query.receiptDateTo,
    { from: 'receiptDateFrom', to: 'receiptDateTo', label: '입고일' },
    query.lotNo !== undefined || query.inboundReceiptNo !== undefined || query.workOrderNo !== undefined,
    'LOT 번호(lotNo), 입하 번호(inboundReceiptNo), W/O 번호(workOrderNo)', today);
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  const and = period === undefined ? [] : [localPeriodSql('gr.receipt_datetime', 'p.timezone_code', period, bind)];
  and.push(query.statusCode === undefined
    ? `gr.status_code <> ${bind(CANCELLED)}`
    : `gr.status_code = ${bind(query.statusCode)}`);
  if (query.receiptTypeCode !== undefined) and.push(`gr.receipt_type_code = ${bind(query.receiptTypeCode)}`);
  if (query.plantId !== undefined) and.push(`gr.plant_id = ${bind(query.plantId)}::bigint`);
  if (query.warehouseId !== undefined) and.push(`gr.warehouse_id = ${bind(query.warehouseId)}::bigint`);
  if (query.itemId !== undefined) and.push(`l.item_id = ${bind(query.itemId)}::bigint`);
  if (query.supplierId !== undefined) {
    and.push(`EXISTS (SELECT 1 FROM logistics.inbound_receipt_line irl
      JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
      WHERE irl.inbound_receipt_line_id = l.inbound_receipt_line_id AND ir.supplier_id = ${bind(query.supplierId)}::bigint)`);
  }
  if (query.lotNo !== undefined) and.push(`lt.lot_no = ${bind(query.lotNo)}`);
  if (query.inboundReceiptNo !== undefined) {
    and.push(`EXISTS (SELECT 1 FROM logistics.inbound_receipt_line nrl
      JOIN logistics.inbound_receipt nr ON nr.inbound_receipt_id = nrl.inbound_receipt_id
      WHERE nrl.inbound_receipt_line_id = l.inbound_receipt_line_id AND nr.inbound_receipt_no = ${bind(query.inboundReceiptNo)})`);
  }
  if (query.workOrderNo !== undefined) {
    and.push(`EXISTS (SELECT 1 FROM production.work_order qw
      WHERE lt.source_type_code = '${WORK_ORDER_LOT_SOURCE}' AND qw.work_order_id = lt.source_id AND qw.work_order_no = ${bind(query.workOrderNo)})`);
  }
  if (query.q !== undefined && query.q.trim() !== '') {
    const like = bind(`%${query.q.trim()}%`);
    and.push(`(gr.goods_receipt_no ILIKE ${like} OR lt.lot_no ILIKE ${like})`);
  }
  return { sql: and.join('\n    AND '), params };
}

/** 입고 유형이 섞인 목록에서 화면이 자재입고·생산입고 칩의 건수를 따로 부르지 않게 유형별 줄 수도 센다. */
export type GoodsReceiptLineTotals = LineTotals & { lineCountByType: { receiptTypeCode: string; lineCount: number }[] };

interface LineRow {
  goods_receipt_line_id: bigint;
  goods_receipt_id: bigint;
  goods_receipt_no: string;
  line_no: number;
  receipt_type_code: string;
  receipt_datetime: Date;
  status_code: string;
  plant_id: bigint;
  warehouse_id: bigint;
  warehouse_code: string;
  warehouse_name: string;
  item_id: bigint;
  item_code: string;
  item_name: string;
  lot_id: bigint;
  lot_no: string;
  receipt_qty: unknown;
  uom_id: bigint;
  uom_code: string;
  supplier_id: bigint | null;
  supplier_code: string | null;
  supplier_name: string | null;
  work_order_id: bigint | null;
  work_order_no: string | null;
}

@Injectable()
export class GoodsReceiptLineListService {
  constructor(private readonly prisma: PrismaService) {}

  /** 입고 일시 내림차순 → 입고 → 줄 번호 — 최근 것부터 본다. */
  async list(query: GoodsReceiptLineListQuery): Promise<PagedResponseWith<GoodsReceiptLineListItem, GoodsReceiptLineTotals>> {
    const page = pageRequest(query);
    const where = goodsReceiptLineWhere(query, await plantToday(this.prisma, query.plantId));
    const next = where.params.length;
    const [rows, totals, byType] = await Promise.all([
      this.prisma.$queryRawUnsafe<LineRow[]>(
        `SELECT l.goods_receipt_line_id, l.goods_receipt_id, gr.goods_receipt_no, l.line_no, gr.receipt_type_code,
                gr.receipt_datetime, gr.status_code, gr.plant_id, w.warehouse_id, w.warehouse_code, w.warehouse_name,
                i.item_id, i.item_code, i.item_name, lt.lot_id, lt.lot_no, l.receipt_qty, u.uom_id, u.uom_code,
                sp.partner_id AS supplier_id, sp.partner_code AS supplier_code, sp.partner_name AS supplier_name,
                wo.work_order_id, wo.work_order_no
         ${FROM}
         JOIN mdm.warehouse w ON w.warehouse_id = gr.warehouse_id
         JOIN mdm.item i ON i.item_id = l.item_id
         JOIN mdm.uom u ON u.uom_id = l.uom_id
         LEFT JOIN logistics.inbound_receipt_line irl ON irl.inbound_receipt_line_id = l.inbound_receipt_line_id
         LEFT JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
         LEFT JOIN mdm.partner sp ON sp.partner_id = ir.supplier_id
         LEFT JOIN production.work_order wo
                ON lt.source_type_code = '${WORK_ORDER_LOT_SOURCE}' AND wo.work_order_id = lt.source_id
         WHERE ${where.sql}
         ORDER BY gr.receipt_datetime DESC, l.goods_receipt_id DESC, l.line_no ASC
         LIMIT $${next + 1} OFFSET $${next + 2}`,
        ...where.params, page.take, page.skip,
      ),
      this.prisma.$queryRawUnsafe<UomTotalRow[]>(
        `SELECT u.uom_id, u.uom_code, SUM(l.receipt_qty) AS qty, COUNT(*) AS line_count
         ${FROM}
         JOIN mdm.uom u ON u.uom_id = l.uom_id
         WHERE ${where.sql}
         GROUP BY u.uom_id, u.uom_code
         ORDER BY u.uom_code`,
        ...where.params,
      ),
      this.prisma.$queryRawUnsafe<{ receipt_type_code: string; line_count: bigint }[]>(
        `SELECT gr.receipt_type_code, COUNT(*) AS line_count
         ${FROM}
         WHERE ${where.sql}
         GROUP BY gr.receipt_type_code
         ORDER BY gr.receipt_type_code`,
        ...where.params,
      ),
    ]);
    const result = {
      ...lineTotals(totals),
      lineCountByType: byType.map((row) => ({ receiptTypeCode: row.receipt_type_code, lineCount: Number(row.line_count) })),
    };
    return { ...pagedResponse(rows.map(itemOf), result.lineCount, page), totals: result };
  }
}

function itemOf(row: LineRow): GoodsReceiptLineListItem {
  return {
    goodsReceiptLineId: Number(row.goods_receipt_line_id),
    goodsReceiptId: Number(row.goods_receipt_id),
    goodsReceiptNo: row.goods_receipt_no,
    lineNo: row.line_no,
    receiptTypeCode: row.receipt_type_code,
    receiptDatetime: row.receipt_datetime.toISOString(),
    statusCode: row.status_code,
    plantId: Number(row.plant_id),
    warehouse: named(row.warehouse_id, row.warehouse_code, row.warehouse_name),
    item: named(row.item_id, row.item_code, row.item_name),
    lotId: Number(row.lot_id),
    lotNo: row.lot_no,
    receiptQty: Number(row.receipt_qty),
    uomId: Number(row.uom_id),
    uomCode: row.uom_code,
    supplier: row.supplier_id === null ? null : named(row.supplier_id, row.supplier_code ?? '', row.supplier_name ?? ''),
    workOrder: row.work_order_id === null ? null : { workOrderId: Number(row.work_order_id), workOrderNo: row.work_order_no ?? '' },
  };
}
