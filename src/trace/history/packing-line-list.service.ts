import { Injectable } from '@nestjs/common';

import { pageRequest } from '../../common/pagination';
import { localPeriodSql, periodUnlessPinned, plantToday } from '../../common/period/plant-local-period';
import { WORK_ORDER_LOT_SOURCE } from '../../core/lot/lot-source';
import { BuiltSql, Named, PagedWithTotals, named } from '../../logistics/line-list';
import { PrismaService } from '../../prisma/prisma.service';
import { HU_PACKED } from '../flow/flow-sql';
import { historyLinePage } from './history-line-page';

/** LOT 생산 이력 조회의 기간별 이력 — 포장 결과(장부 P-151). 확정(PACKED)된 취급 단위의 구성 줄 하나가 한 행이다. */
export interface PackingLineListQuery {
  packedDateFrom?: string;
  packedDateTo?: string;
  plantId?: number;
  itemId?: number;
  /** 담긴 LOT 의 번호 정확 일치 — 집는 번호라 기간이 선택이 된다(아래 셋 모두). */
  lotNo?: string;
  /** 담긴 LOT 의 원천 W/O 번호. */
  workOrderNo?: string;
  /** 상자가 담긴 출하 단위의 출하. */
  shipmentNo?: string;
  /** 상자가 담긴 출하 단위의 출하 고객. */
  customerId?: number;
  q?: string;
  page?: number;
  size?: number;
}

export interface PackingLineListItem {
  handlingUnitContentId: number;
  handlingUnitId: number;
  handlingUnitNo: string;
  handlingUnitTypeCode: string;
  /** 취급 단위 상태 — 확정된 상자만 실어 지금은 늘 PACKED 다. */
  handlingUnitStatusCode: string;
  packedAt: string;
  plantId: number;
  item: Named;
  lotId: number;
  lotNo: string;
  qty: number;
  uomId: number;
  uomCode: string;
  /** LOT 원천이 W/O 일 때만. */
  workOrder: { workOrderId: number; workOrderNo: string } | null;
  /** 출하 단위에 담긴 상자만. */
  shippingUnit: { shippingUnitId: number; shippingUnitNo: string } | null;
}

const FROM = `
  FROM inventory.handling_unit_content hc
  JOIN inventory.handling_unit hu ON hu.handling_unit_id = hc.handling_unit_id AND hu.status_code = ${HU_PACKED}
  JOIN trace.lot lt ON lt.lot_id = hc.lot_id
  JOIN mdm.plant p ON p.plant_id = lt.plant_id
  LEFT JOIN production.work_order wo ON lt.source_type_code = '${WORK_ORDER_LOT_SOURCE}' AND wo.work_order_id = lt.source_id`;

/**
 * 포장 시각을 따로 적는 칸이 없어 구성 줄 생성 시각을 쓴다. 확정(`:pack`)과 구성 치환(포장 재구성)이 모두 구성 줄을 지우고
 * 다시 만들므로, 확정된 상자에서는 확정 시각이거나 그 뒤 마지막으로 구성을 고친 시각이다. 공장은 담긴 LOT 의 공장이다.
 */
export function packingLineWhere(query: PackingLineListQuery, today: string): BuiltSql {
  const period = periodUnlessPinned(query.packedDateFrom, query.packedDateTo, { from: 'packedDateFrom', to: 'packedDateTo', label: '포장일' },
    query.lotNo !== undefined || query.workOrderNo !== undefined || query.shipmentNo !== undefined,
    'LOT 번호(lotNo), W/O 번호(workOrderNo), 출하 번호(shipmentNo)', today);
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  const and = period === undefined ? [] : [localPeriodSql('hc.created_at', 'p.timezone_code', period, bind)];
  if (query.plantId !== undefined) and.push(`lt.plant_id = ${bind(query.plantId)}::bigint`);
  if (query.itemId !== undefined) and.push(`hc.item_id = ${bind(query.itemId)}::bigint`);
  if (query.lotNo !== undefined) and.push(`lt.lot_no = ${bind(query.lotNo)}`);
  if (query.workOrderNo !== undefined) and.push(`wo.work_order_no = ${bind(query.workOrderNo)}`);
  const shipped: string[] = [];
  if (query.shipmentNo !== undefined) shipped.push(`xs.shipment_no = ${bind(query.shipmentNo)}`);
  if (query.customerId !== undefined) shipped.push(`xr.customer_id = ${bind(query.customerId)}::bigint`);
  if (shipped.length > 0) {
    and.push(`EXISTS (SELECT 1 FROM logistics.shipping_unit_handling_unit xh
      JOIN logistics.shipping_unit xu ON xu.shipping_unit_id = xh.shipping_unit_id
      JOIN logistics.shipment xs ON xs.shipment_id = xu.shipment_id
      JOIN logistics.shipment_request xr ON xr.shipment_request_id = xs.shipment_request_id
      WHERE xh.handling_unit_id = hu.handling_unit_id AND ${shipped.join(' AND ')})`);
  }
  if (query.q !== undefined && query.q.trim() !== '') {
    const like = bind(`%${query.q.trim()}%`);
    and.push(`(lt.lot_no ILIKE ${like} OR hu.handling_unit_no ILIKE ${like})`);
  }
  return { sql: and.join('\n    AND '), params };
}

interface LineRow {
  handling_unit_content_id: bigint;
  handling_unit_id: bigint;
  handling_unit_no: string;
  handling_unit_type_code: string;
  status_code: string;
  created_at: Date;
  plant_id: bigint;
  item_id: bigint;
  item_code: string;
  item_name: string;
  lot_id: bigint;
  lot_no: string;
  qty: unknown;
  uom_id: bigint;
  uom_code: string;
  work_order_id: bigint | null;
  work_order_no: string | null;
  shipping_unit_id: bigint | null;
  shipping_unit_no: string | null;
}

@Injectable()
export class PackingLineListService {
  constructor(private readonly prisma: PrismaService) {}

  /** 포장 시각 내림차순 → 취급 단위 번호 — 최근 것부터 본다. */
  async list(query: PackingLineListQuery): Promise<PagedWithTotals<PackingLineListItem>> {
    const where = packingLineWhere(query, await plantToday(this.prisma, query.plantId));
    return historyLinePage<LineRow, PackingLineListItem>(this.prisma, {
      select: `hc.handling_unit_content_id, hu.handling_unit_id, hu.handling_unit_no, hu.handling_unit_type_code, hu.status_code, hc.created_at,
               lt.plant_id, i.item_id, i.item_code, i.item_name, lt.lot_id, lt.lot_no, hc.qty, u.uom_id, u.uom_code,
               wo.work_order_id, wo.work_order_no, su.shipping_unit_id, su.shipping_unit_no`,
      from: `${FROM}
        JOIN mdm.item i ON i.item_id = hc.item_id
        JOIN mdm.uom u ON u.uom_id = hc.uom_id
        LEFT JOIN logistics.shipping_unit_handling_unit suh ON suh.handling_unit_id = hu.handling_unit_id
        LEFT JOIN logistics.shipping_unit su ON su.shipping_unit_id = suh.shipping_unit_id`,
      qtyColumn: 'hc.qty',
      uomColumn: 'hc.uom_id',
      orderBy: 'hc.created_at DESC, hu.handling_unit_no ASC, hc.handling_unit_content_id ASC',
    }, where, pageRequest(query), itemOf);
  }
}

function itemOf(row: LineRow): PackingLineListItem {
  return {
    handlingUnitContentId: Number(row.handling_unit_content_id),
    handlingUnitId: Number(row.handling_unit_id),
    handlingUnitNo: row.handling_unit_no,
    handlingUnitTypeCode: row.handling_unit_type_code,
    handlingUnitStatusCode: row.status_code,
    packedAt: row.created_at.toISOString(),
    plantId: Number(row.plant_id),
    item: named(row.item_id, row.item_code, row.item_name),
    lotId: Number(row.lot_id),
    lotNo: row.lot_no,
    qty: Number(row.qty),
    uomId: Number(row.uom_id),
    uomCode: row.uom_code,
    workOrder: row.work_order_id === null ? null : { workOrderId: Number(row.work_order_id), workOrderNo: row.work_order_no ?? '' },
    shippingUnit: row.shipping_unit_id === null ? null : { shippingUnitId: Number(row.shipping_unit_id), shippingUnitNo: row.shipping_unit_no ?? '' },
  };
}
