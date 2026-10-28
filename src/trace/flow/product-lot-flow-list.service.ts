import { Injectable } from '@nestjs/common';

import { ERROR_CODE, field, one } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { localPeriodSql, periodUnlessPinned, plantToday, utcMarginSql } from '../../common/period/plant-local-period';
import { WORK_ORDER_LOT_SOURCE } from '../../core/lot/lot-source';
import { PrismaService } from '../../prisma/prisma.service';
import { TraceBasis } from '../lot/lot-genealogy-query.service';
import { BACKWARD_STAGES, stageCaseSql, stageFilter } from './flow-stage';
import { SHIPMENT_CANCELLED, stagedPage, downstreamLateralSql, estimateBasis, inputCountSql, tracedSql } from './flow-sql';
import { LotHead, Named, lotHeads, pick } from './lot-flow-nodes';

/** 역방향 목록 — 실적 배분이 있는 생산 LOT. 기간 축은 첫 실적(기본) 또는 출하일. */
export interface ProductLotFlowQuery {
  itemId?: number;
  lotNo?: string;
  q?: string;
  shipmentNo?: string;
  workOrderNo?: string;
  dateAxis?: 'PRODUCED' | 'SHIPPED';
  dateFrom?: string;
  dateTo?: string;
  plantId?: number;
  customerId?: number;
  currentStageCode?: string[] | string;
  page?: number;
  size?: number;
}

export interface ProductLotFlowRow extends LotHead {
  workOrder: { workOrderId: number; workOrderNo: string; statusCode: string };
  producedQty: number;
  firstProducedAt: string;
  lastProducedAt: string;
  inputMaterialLotCount: number;
  /** 추정 이음이 없으면 null. */
  basis: TraceBasis | null;
  stages: {
    productionReceived: { count: number; qty: number };
    packed: { handlingUnitCount: number; qty: number };
    shipped: { shipmentCount: number; qty: number; lastShippedAt: string | null; customers: Named[]; customerCount: number };
  };
  currentStageCode: string;
}

export type ProductLotFlowList = PagedResponse<ProductLotFlowRow> & { stageCounts: Record<string, number> };

/** 행마다 보이는 고객 수 — 나머지는 `customerCount` 로. */
export const CUSTOMERS_SHOWN = 3;

interface StagedRow {
  lot_id: bigint;
  work_order_id: bigint;
  first_produced_at: Date;
  last_produced_at: Date;
  produced_qty: unknown;
  received_count: bigint;
  received_qty: unknown;
  hu_count: bigint;
  packed_qty: unknown;
  shipment_count: bigint;
  shipped_qty: unknown;
  last_shipped_at: Date | null;
  input_count: bigint;
  traced: boolean;
  stage: string;
}

export function stagedSql(query: ProductLotFlowQuery, bind: (value: unknown) => string, today: string): string {
  const axis = query.dateAxis ?? 'PRODUCED';
  if (axis !== 'PRODUCED' && axis !== 'SHIPPED') {
    throw one(field('dateAxis', ERROR_CODE.INVALID, `기간 기준 ${String(axis)} 은 쓸 수 없습니다. PRODUCED(첫 실적) 또는 SHIPPED(출하일)로 보내세요.`));
  }
  const period = periodUnlessPinned(query.dateFrom, query.dateTo,
    { from: 'dateFrom', to: 'dateTo', label: axis === 'PRODUCED' ? '생산일' : '출하일' },
    query.lotNo !== undefined || query.shipmentNo !== undefined || query.workOrderNo !== undefined,
    '생산 LOT 번호(lotNo), 출하 번호(shipmentNo), W/O 번호(workOrderNo)', today);
  const and = [`lt.source_type_code = '${WORK_ORDER_LOT_SOURCE}'`];
  // 생산일 축은 첫 실적(MIN)에 걸려 집계 뒤에야 정확히 거른다. 기간만으로 불러도 공장 전체 생산 LOT 을 모으지 않도록
  // 기간(UTC 여유) 안에 실적 배분이 있는 LOT 만 먼저 고른다. 출하일 축은 아래 출하 EXISTS 가 출하 일시로 좁힌다.
  if (period !== undefined && axis === 'PRODUCED') {
    and.push(`EXISTS (SELECT 1 FROM production.production_result_lot_allocation qa
      JOIN production.production_result qr ON qr.production_result_id = qa.production_result_id
      WHERE qa.lot_id = lt.lot_id AND ${utcMarginSql('qr.occurred_at', period, bind)})`);
  }
  if (query.itemId !== undefined) and.push(`lt.item_id = ${bind(query.itemId)}::bigint`);
  if (query.lotNo !== undefined) and.push(`lt.lot_no = ${bind(query.lotNo)}`);
  if (query.q !== undefined && query.q.trim() !== '') and.push(`lt.lot_no ILIKE ${bind(`%${query.q.trim()}%`)}`);
  if (query.plantId !== undefined) and.push(`lt.plant_id = ${bind(query.plantId)}::bigint`);
  if (query.workOrderNo !== undefined) {
    and.push(`EXISTS (SELECT 1 FROM production.work_order qw WHERE qw.work_order_id = lt.source_id AND qw.work_order_no = ${bind(query.workOrderNo)})`);
  }
  const shipped: string[] = [];
  if (query.shipmentNo !== undefined) shipped.push(`xs.shipment_no = ${bind(query.shipmentNo)}`);
  if (query.customerId !== undefined) shipped.push(`xr.customer_id = ${bind(query.customerId)}::bigint`);
  if (period !== undefined && axis === 'SHIPPED') shipped.push(localPeriodSql('xs.shipped_at', 'xp.timezone_code', period, bind));
  if (shipped.length > 0) {
    and.push(`EXISTS (SELECT 1 FROM logistics.shipment_lot_allocation xa
      JOIN logistics.shipment_line xl ON xl.shipment_line_id = xa.shipment_line_id
      JOIN logistics.shipment xs ON xs.shipment_id = xl.shipment_id AND xs.status_code <> ${SHIPMENT_CANCELLED}
      JOIN logistics.shipment_request xr ON xr.shipment_request_id = xs.shipment_request_id
      JOIN mdm.warehouse xw ON xw.warehouse_id = xs.warehouse_id JOIN mdm.plant xp ON xp.plant_id = xw.plant_id
      WHERE xa.lot_id = lt.lot_id AND ${shipped.join(' AND ')})`);
  }
  const stage = stageCaseSql(BACKWARD_STAGES, {
    PRODUCTION_RECEIVED: 'dr.received_count', PACKED: 'dp.hu_count', SHIPPED: 'dsh.shipment_count',
  });
  return `
    WITH produced AS (
      SELECT lt.lot_id, lt.plant_id, lt.source_id AS work_order_id, MIN(pr.occurred_at) AS first_produced_at,
             MAX(pr.occurred_at) AS last_produced_at, SUM(pa.allocated_qty) AS produced_qty
        FROM trace.lot lt
        JOIN production.production_result_lot_allocation pa ON pa.lot_id = lt.lot_id
        JOIN production.production_result pr ON pr.production_result_id = pa.production_result_id
       WHERE ${and.join(' AND ')}
       GROUP BY lt.lot_id, lt.plant_id, lt.source_id
    ), base AS (
      SELECT f.* FROM produced f JOIN mdm.plant p ON p.plant_id = f.plant_id
       ${period === undefined || axis !== 'PRODUCED' ? '' : `WHERE ${localPeriodSql('f.first_produced_at', 'p.timezone_code', period, bind)}`}
    ), staged AS (
      SELECT b.lot_id, b.work_order_id, b.first_produced_at, b.last_produced_at, b.produced_qty,
             dr.received_count, dr.received_qty, dp.hu_count, dp.packed_qty, dsh.shipment_count, dsh.shipped_qty, dsh.last_shipped_at,
             ${inputCountSql('b.lot_id', 'b.work_order_id')} AS input_count, ${tracedSql('b.work_order_id')} AS traced,
             ${stage} AS stage
        FROM base b ${downstreamLateralSql('b.lot_id')}
    )`;
}

@Injectable()
export class ProductLotFlowListService {
  constructor(private readonly prisma: PrismaService) {}

  /** 첫 실적 시각 내림차순. `stageCounts` 는 단계 조건만 빼고 센다. */
  async list(query: ProductLotFlowQuery): Promise<ProductLotFlowList> {
    const page = pageRequest(query);
    const params: unknown[] = [];
    const bind = (value: unknown): string => `$${params.push(value)}`;
    const withSql = stagedSql(query, bind, await plantToday(this.prisma, query.plantId));
    const { rows, counts, total } = await stagedPage<StagedRow>(this.prisma, withSql, params, {
      stages: BACKWARD_STAGES, filter: stageFilter(query.currentStageCode), orderBy: 'first_produced_at DESC, lot_id DESC', page,
    });
    const ids = rows.map((row) => row.lot_id);
    const [heads, orders, customers] = await Promise.all([lotHeads(this.prisma, ids), this.workOrdersOf(rows), this.customersOf(ids)]);
    const items = rows.map((row) => {
      const lotCustomers = customers.get(row.lot_id) ?? [];
      return {
        ...pick(heads, row.lot_id),
        workOrder: pick(orders, row.work_order_id),
        producedQty: Number(row.produced_qty),
        firstProducedAt: row.first_produced_at.toISOString(),
        lastProducedAt: row.last_produced_at.toISOString(),
        inputMaterialLotCount: Number(row.input_count),
        basis: estimateBasis(Number(row.input_count) > 0, !row.traced),
        stages: {
          productionReceived: { count: Number(row.received_count), qty: Number(row.received_qty) },
          packed: { handlingUnitCount: Number(row.hu_count), qty: Number(row.packed_qty) },
          shipped: {
            shipmentCount: Number(row.shipment_count), qty: Number(row.shipped_qty),
            lastShippedAt: row.last_shipped_at?.toISOString() ?? null,
            customers: lotCustomers.slice(0, CUSTOMERS_SHOWN), customerCount: lotCustomers.length,
          },
        },
        currentStageCode: row.stage,
      } satisfies ProductLotFlowRow;
    });
    return { ...pagedResponse(items, total, page), stageCounts: counts };
  }

  private async workOrdersOf(rows: StagedRow[]) {
    const found = await this.prisma.work_order.findMany({
      where: { work_order_id: { in: [...new Set(rows.map((row) => row.work_order_id))] } },
      select: { work_order_id: true, work_order_no: true, status_code: true },
    });
    return new Map(found.map((wo) => [wo.work_order_id, { workOrderId: Number(wo.work_order_id), workOrderNo: wo.work_order_no, statusCode: wo.status_code }]));
  }

  /** 이 쪽의 LOT 마다 출하된 고객(이름순) — 취소 출하 제외. */
  private async customersOf(lotIds: bigint[]): Promise<Map<bigint, Named[]>> {
    if (lotIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRawUnsafe<{ lot_id: bigint; partner_id: bigint; partner_code: string; partner_name: string }[]>(
      `SELECT DISTINCT a.lot_id, c.partner_id, c.partner_code, c.partner_name
         FROM logistics.shipment_lot_allocation a
         JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
         JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id AND s.status_code <> ${SHIPMENT_CANCELLED}
         JOIN logistics.shipment_request sr ON sr.shipment_request_id = s.shipment_request_id
         JOIN mdm.partner c ON c.partner_id = sr.customer_id
        WHERE a.lot_id = ANY($1::bigint[])
        ORDER BY c.partner_name, c.partner_id`, lotIds,
    );
    const byLot = new Map<bigint, Named[]>();
    for (const row of rows) {
      byLot.set(row.lot_id, [...(byLot.get(row.lot_id) ?? []), { id: Number(row.partner_id), code: row.partner_code, name: row.partner_name }]);
    }
    return byLot;
  }
}
