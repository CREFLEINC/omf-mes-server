import { Injectable } from '@nestjs/common';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { localPeriodSql, plantToday } from '../../common/period/plant-local-period';
import { PrismaService } from '../../prisma/prisma.service';
import { GENEALOGY_BASIS, TraceBasis, WORK_ORDER_BASIS } from '../lot/lot-genealogy-query.service';
import { FORWARD_STAGES, periodUnlessPinned, requireEntry, stageCaseSql, stageFilter } from './flow-stage';
import { HU_PACKED, LIVE_CONSUMPTION, RECEIPT_CANCELLED, SHIPMENT_CANCELLED, stagedPage, downstreamLateralSql, forwardLinksSql } from './flow-sql';
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
  /** 투입량 — 정정된 원 투입은 빼고 정정 투입을 넣는다. 투입은 재고 원장을 거치지 않아 투입 기록으로 센다. */
  consumedQty: number;
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
  consumed_qty: unknown;
  hu_count: bigint;
  shipped_lots: bigint;
  shipment_count: bigint;
  last_shipped_at: Date | null;
  legacy: boolean;
  stage: string;
}

export function stagedSql(query: MaterialLotFlowQuery, bind: (value: unknown) => string, today: string): string {
  requireEntry(query as Record<string, unknown>, ['itemId', 'lotNo', 'inboundReceiptNo', 'q'],
    '자재 품목(itemId) · 자재 LOT 번호(lotNo) · 입하 번호(inboundReceiptNo) · LOT 번호 일부(q)');
  const period = periodUnlessPinned(query.receiptDateFrom, query.receiptDateTo,
    { from: 'receiptDateFrom', to: 'receiptDateTo', label: '입고일' }, query.lotNo !== undefined || query.inboundReceiptNo !== undefined, today);
  const and = [`gr.receipt_type_code = 'MATERIAL'`, `gr.status_code <> ${RECEIPT_CANCELLED}`];
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
    CONSUMED: 'c.wo_count', PRODUCED: 'a.produced', PRODUCTION_RECEIVED: 'a.received_lots', PACKED: 'a.packed_lots', SHIPPED: 'a.shipped_lots',
  });
  // ⛔ 하위 집계는 LOT 마다 LATERAL 로 센다(색인을 탄다). CTE 로 미리 모아 붙이면 기간 조건(MIN 위)의 행 수 추정이 1 로
  //    떨어져 CTE 를 LOT 마다 다시 훑는다.
  const links = forwardLinksSql('SELECT b.lot_id');
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
    ), staged AS (
      SELECT b.lot_id, b.first_received_at, c.wo_count, c.consumed_qty, a.produced, a.received_lots, a.packed_lots, u.hu_count, a.shipped_lots,
             sh.shipment_count, sh.last_shipped_at, COALESCE(a.legacy, false) AS legacy, ${stage} AS stage
        FROM base b
        CROSS JOIN LATERAL (
          SELECT COUNT(DISTINCT mc.work_order_id) AS wo_count, COALESCE(SUM(mc.input_qty) FILTER (WHERE ${LIVE_CONSUMPTION}), 0) AS consumed_qty
            FROM production.material_consumption mc WHERE mc.lot_id = b.lot_id
        ) c
        CROSS JOIN LATERAL (
          SELECT COUNT(DISTINCT k.target_lot_id) AS produced,
                 COUNT(DISTINCT k.target_lot_id) FILTER (WHERE dr.received_count > 0) AS received_lots,
                 COUNT(DISTINCT k.target_lot_id) FILTER (WHERE dp.hu_count > 0) AS packed_lots,
                 COUNT(DISTINCT k.target_lot_id) FILTER (WHERE dsh.shipment_count > 0) AS shipped_lots,
                 BOOL_OR(k.basis = '${WORK_ORDER_BASIS}') AS legacy
            FROM (${links}) k ${downstreamLateralSql('k.target_lot_id')}
        ) a
        CROSS JOIN LATERAL (
          SELECT COUNT(DISTINCT hc.handling_unit_id) AS hu_count
            FROM (${links}) k JOIN inventory.handling_unit_content hc ON hc.lot_id = k.target_lot_id
            JOIN inventory.handling_unit hh ON hh.handling_unit_id = hc.handling_unit_id AND hh.status_code = ${HU_PACKED}
        ) u
        CROSS JOIN LATERAL (
          SELECT COUNT(DISTINCT s.shipment_id) AS shipment_count, MAX(s.shipped_at) AS last_shipped_at
            FROM (${links}) k
            JOIN logistics.shipment_lot_allocation sa ON sa.lot_id = k.target_lot_id
            JOIN logistics.shipment_line ssl ON ssl.shipment_line_id = sa.shipment_line_id
            JOIN logistics.shipment s ON s.shipment_id = ssl.shipment_id AND s.status_code <> ${SHIPMENT_CANCELLED}
        ) sh
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
    const withSql = stagedSql(query, bind, await plantToday(this.prisma, query.plantId));
    const { rows, counts, total } = await stagedPage<StagedRow>(this.prisma, withSql, params, {
      stages: FORWARD_STAGES, filter: stageFilter(query.currentStageCode), orderBy: 'first_received_at DESC, lot_id DESC', page,
    });
    const ids = rows.map((row) => row.lot_id);
    const [heads, sides] = await Promise.all([lotHeads(this.prisma, ids), materialSides(this.prisma, ids)]);
    const items = rows.map((row) => {
      const side = pick(sides, row.lot_id);
      return {
        ...pick(heads, row.lot_id),
        ...side,
        firstReceivedAt: row.first_received_at.toISOString(),
        consumedQty: Number(row.consumed_qty),
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
