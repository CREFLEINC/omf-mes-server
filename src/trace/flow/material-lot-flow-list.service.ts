import { Injectable } from '@nestjs/common';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { localPeriodSql } from '../../common/period/plant-local-period';
import { PrismaService } from '../../prisma/prisma.service';
import { GENEALOGY_BASIS, TraceBasis, WORK_ORDER_BASIS } from '../lot/lot-genealogy-query.service';
import { FORWARD_STAGES, periodUnlessPinned, requireEntry, stageCaseSql, stageCounts, stageFilter } from './flow-stage';
import { RECEIPT_CANCELLED, SHIPMENT_CANCELLED, downstreamLateralSql, forwardLinksSql } from './flow-sql';
import { LotHead, MaterialSide, lotHeads, materialSides, pick } from './lot-flow-nodes';

/** 정방향 목록 — 자재 LOT(자재입고가 있는 LOT). 기간 축은 첫 자재입고 일시(공장 현지 날짜). */
export interface MaterialLotFlowQuery {
  itemId?: number;
  lotNo?: string;
  q?: string;
  inboundReceiptNo?: string;
  receiptDateFrom?: string;
  receiptDateTo?: string;
  plantId?: number;
  supplierId?: number;
  warehouseId?: number;
  currentStageCode?: string[] | string;
  page?: number;
  size?: number;
}

export interface MaterialLotFlowRow extends LotHead, MaterialSide {
  firstReceivedAt: string;
  stages: {
    received: { count: number };
    consumed: { workOrderCount: number };
    produced: { lotCount: number };
    productionReceived: { lotCount: number };
    packed: { lotCount: number; handlingUnitCount: number };
    shipped: { lotCount: number; shipmentCount: number; lastShippedAt: string | null };
  };
  currentStageCode: string;
  basis: TraceBasis;
}

export type MaterialLotFlowList = PagedResponse<MaterialLotFlowRow> & { stageCounts: Record<string, number> };

interface StagedRow {
  lot_id: bigint;
  first_received_at: Date;
  wo_count: bigint;
  produced: bigint;
  received_lots: bigint;
  packed_lots: bigint;
  hu_count: bigint;
  shipped_lots: bigint;
  shipment_count: bigint;
  last_shipped_at: Date | null;
  legacy: boolean;
  stage: string;
}

export function stagedSql(query: MaterialLotFlowQuery, bind: (value: unknown) => string, today?: Date): string {
  requireEntry(query as Record<string, unknown>, ['itemId', 'lotNo', 'inboundReceiptNo', 'q'],
    '자재 품목(itemId) · 자재 LOT 번호(lotNo) · 입하 번호(inboundReceiptNo) · LOT 번호 일부(q)');
  const period = periodUnlessPinned(query.receiptDateFrom, query.receiptDateTo,
    { from: 'receiptDateFrom', to: 'receiptDateTo', label: '입고일' }, query.lotNo !== undefined || query.inboundReceiptNo !== undefined, today);
  const and = [`gr.receipt_type_code = 'MATERIAL'`, `gr.status_code NOT IN ${RECEIPT_CANCELLED}`];
  if (query.itemId !== undefined) and.push(`lt.item_id = ${bind(query.itemId)}::bigint`);
  if (query.lotNo !== undefined) and.push(`lt.lot_no = ${bind(query.lotNo)}`);
  if (query.q !== undefined && query.q.trim() !== '') and.push(`lt.lot_no ILIKE ${bind(`%${query.q.trim()}%`)}`);
  if (query.plantId !== undefined) and.push(`lt.plant_id = ${bind(query.plantId)}::bigint`);
  if (query.warehouseId !== undefined) and.push(`gr.warehouse_id = ${bind(query.warehouseId)}::bigint`);
  const inbound: string[] = [];
  if (query.inboundReceiptNo !== undefined) inbound.push(`ir.inbound_receipt_no = ${bind(query.inboundReceiptNo)}`);
  if (query.supplierId !== undefined) inbound.push(`ir.supplier_id = ${bind(query.supplierId)}::bigint`);
  if (inbound.length > 0) {
    and.push(`EXISTS (SELECT 1 FROM logistics.inbound_receipt_line irl
      JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
      WHERE irl.lot_id = lt.lot_id AND ${inbound.join(' AND ')})`);
  }
  const stage = stageCaseSql(FORWARD_STAGES, {
    CONSUMED: 'COALESCE(c.wo_count, 0)', PRODUCED: 'COALESCE(a.produced, 0)', PRODUCTION_RECEIVED: 'COALESCE(a.received_lots, 0)',
    PACKED: 'COALESCE(a.packed_lots, 0)', SHIPPED: 'COALESCE(a.shipped_lots, 0)',
  });
  return `
    WITH firsts AS (
      SELECT lt.lot_id, lt.plant_id, MIN(gr.receipt_datetime) AS first_received_at
        FROM trace.lot lt
        JOIN logistics.goods_receipt_line l ON l.lot_id = lt.lot_id
        JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = l.goods_receipt_id
       WHERE ${and.join(' AND ')}
       GROUP BY lt.lot_id, lt.plant_id
    ), base AS (
      SELECT f.lot_id, f.first_received_at FROM firsts f JOIN mdm.plant p ON p.plant_id = f.plant_id
       ${period === undefined ? '' : `WHERE ${localPeriodSql('f.first_received_at', 'p.timezone_code', period, bind)}`}
    ), consumed AS (
      SELECT mc.lot_id, COUNT(DISTINCT mc.work_order_id) AS wo_count
        FROM production.material_consumption mc WHERE mc.lot_id IN (SELECT lot_id FROM base) GROUP BY mc.lot_id
    ), links AS (${forwardLinksSql('SELECT lot_id FROM base')}
    ), down AS (
      SELECT t.lot_id, dr.received_count, dp.hu_count, dsh.shipment_count
        FROM (SELECT DISTINCT target_lot_id AS lot_id FROM links) t ${downstreamLateralSql('t.lot_id')}
    ), agg AS (
      SELECT k.source_lot_id AS lot_id,
             COUNT(DISTINCT k.target_lot_id) AS produced,
             COUNT(DISTINCT k.target_lot_id) FILTER (WHERE d.received_count > 0) AS received_lots,
             COUNT(DISTINCT k.target_lot_id) FILTER (WHERE d.hu_count > 0) AS packed_lots,
             COUNT(DISTINCT k.target_lot_id) FILTER (WHERE d.shipment_count > 0) AS shipped_lots,
             BOOL_OR(k.basis = '${WORK_ORDER_BASIS}') AS legacy
        FROM links k JOIN down d ON d.lot_id = k.target_lot_id GROUP BY k.source_lot_id
    ), units AS (
      SELECT k.source_lot_id AS lot_id, COUNT(DISTINCT hc.handling_unit_id) AS hu_count
        FROM links k JOIN inventory.handling_unit_content hc ON hc.lot_id = k.target_lot_id GROUP BY k.source_lot_id
    ), ships AS (
      SELECT k.source_lot_id AS lot_id, COUNT(DISTINCT s.shipment_id) AS shipment_count, MAX(s.shipped_at) AS last_shipped_at
        FROM links k
        JOIN logistics.shipment_lot_allocation sa ON sa.lot_id = k.target_lot_id
        JOIN logistics.shipment_line ssl ON ssl.shipment_line_id = sa.shipment_line_id
        JOIN logistics.shipment s ON s.shipment_id = ssl.shipment_id AND s.status_code <> ${SHIPMENT_CANCELLED}
       GROUP BY k.source_lot_id
    ), staged AS (
      SELECT b.lot_id, b.first_received_at, COALESCE(c.wo_count, 0) AS wo_count, COALESCE(a.produced, 0) AS produced,
             COALESCE(a.received_lots, 0) AS received_lots, COALESCE(a.packed_lots, 0) AS packed_lots,
             COALESCE(u.hu_count, 0) AS hu_count, COALESCE(a.shipped_lots, 0) AS shipped_lots,
             COALESCE(sh.shipment_count, 0) AS shipment_count, sh.last_shipped_at, COALESCE(a.legacy, false) AS legacy,
             ${stage} AS stage
        FROM base b
        LEFT JOIN consumed c ON c.lot_id = b.lot_id
        LEFT JOIN agg a ON a.lot_id = b.lot_id
        LEFT JOIN units u ON u.lot_id = b.lot_id
        LEFT JOIN ships sh ON sh.lot_id = b.lot_id
    )`;
}

@Injectable()
export class MaterialLotFlowListService {
  constructor(private readonly prisma: PrismaService) {}

  /** 첫 자재입고 일시 내림차순. `stageCounts` 는 단계 조건만 빼고 센다. */
  async list(query: MaterialLotFlowQuery): Promise<MaterialLotFlowList> {
    const page = pageRequest(query);
    const params: unknown[] = [];
    const bind = (value: unknown): string => `$${params.push(value)}`;
    const withSql = stagedSql(query, bind);
    const stages = stageFilter(query.currentStageCode);
    const counts = stageCounts(FORWARD_STAGES, await this.prisma.$queryRawUnsafe<{ stage: string; count: bigint }[]>(
      `${withSql} SELECT stage, COUNT(*) AS count FROM staged GROUP BY stage`, ...params,
    ));
    const total = Object.entries(counts).filter(([stage]) => stages === undefined || stages.includes(stage))
      .reduce((sum, [, count]) => sum + count, 0);
    const n = params.length;
    const rows = await this.prisma.$queryRawUnsafe<StagedRow[]>(
      `${withSql} SELECT * FROM staged
        ${stages === undefined ? '' : `WHERE stage = ANY($${n + 1}::text[])`}
        ORDER BY first_received_at DESC, lot_id DESC
        LIMIT $${n + (stages === undefined ? 1 : 2)} OFFSET $${n + (stages === undefined ? 2 : 3)}`,
      ...params, ...(stages === undefined ? [] : [stages]), page.take, page.skip,
    );
    const ids = rows.map((row) => row.lot_id);
    const [heads, sides] = await Promise.all([lotHeads(this.prisma, ids), materialSides(this.prisma, ids)]);
    const items = rows.map((row) => {
      const side = pick(sides, row.lot_id);
      return {
        ...pick(heads, row.lot_id),
        ...side,
        firstReceivedAt: row.first_received_at.toISOString(),
        stages: {
          received: { count: side.receipts.length },
          consumed: { workOrderCount: Number(row.wo_count) },
          produced: { lotCount: Number(row.produced) },
          productionReceived: { lotCount: Number(row.received_lots) },
          packed: { lotCount: Number(row.packed_lots), handlingUnitCount: Number(row.hu_count) },
          shipped: { lotCount: Number(row.shipped_lots), shipmentCount: Number(row.shipment_count), lastShippedAt: row.last_shipped_at?.toISOString() ?? null },
        },
        currentStageCode: row.stage,
        basis: row.legacy ? WORK_ORDER_BASIS : GENEALOGY_BASIS,
      } satisfies MaterialLotFlowRow;
    });
    return { ...pagedResponse(items, total, page), stageCounts: counts };
  }
}
