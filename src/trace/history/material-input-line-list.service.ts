import { Injectable } from '@nestjs/common';

import { pageRequest } from '../../common/pagination';
import { localPeriodSql, periodUnlessPinned, plantToday } from '../../common/period/plant-local-period';
import { BuiltSql, Named, PagedWithTotals, named } from '../../logistics/line-list';
import { PrismaService } from '../../prisma/prisma.service';
import { LIVE_CONSUMPTION } from '../flow/flow-sql';
import { historyLinePage } from './history-line-page';

/** LOT 생산 이력 조회의 기간별 이력 — 자재 투입 기록(장부 P-151). 기간 축은 투입 시각(공장 현지 날짜). */
export interface MaterialInputLineListQuery {
  inputDateFrom?: string;
  inputDateTo?: string;
  plantId?: number;
  itemId?: number;
  /** 투입한 LOT 의 번호 정확 일치 — 집는 번호라 기간이 선택이 된다(아래 셋 모두). */
  lotNo?: string;
  workOrderNo?: string;
  /** 투입한 LOT 이 들어온 입하. */
  inboundReceiptNo?: string;
  /** 투입한 LOT 이 들어온 입하의 공급사. */
  supplierId?: number;
  q?: string;
  page?: number;
  size?: number;
}

export interface MaterialInputLineListItem {
  materialConsumptionId: number;
  consumptionNo: string;
  occurredAt: string;
  statusCode: string;
  consumptionTypeCode: string;
  /** 정정 투입이면 그 원 투입. */
  correctsConsumptionId: number | null;
  plantId: number;
  workOrder: { workOrderId: number; workOrderNo: string };
  item: Named;
  lotId: number;
  lotNo: string;
  inputQty: number;
  uomId: number;
  uomCode: string;
}

const FROM = `
  FROM production.material_consumption mc
  JOIN trace.lot lt ON lt.lot_id = mc.lot_id
  JOIN mdm.plant p ON p.plant_id = lt.plant_id
  JOIN production.work_order wo ON wo.work_order_id = mc.work_order_id`;

/**
 * 투입에는 취소 상태가 없다 — 데이터 모델은 정정(`corrects_consumption_id`)뿐이라, 정정된 원 투입은 빼고 정정 투입을 싣는다
 * (정방향 목록의 투입량과 같은 셈). 공장은 투입한 LOT 의 공장이다.
 */
export function materialInputLineWhere(query: MaterialInputLineListQuery, today: string): BuiltSql {
  const period = periodUnlessPinned(query.inputDateFrom, query.inputDateTo, { from: 'inputDateFrom', to: 'inputDateTo', label: '투입일' },
    query.lotNo !== undefined || query.workOrderNo !== undefined || query.inboundReceiptNo !== undefined,
    'LOT 번호(lotNo), W/O 번호(workOrderNo), 입하 번호(inboundReceiptNo)', today);
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  const and = [LIVE_CONSUMPTION];
  if (period !== undefined) and.unshift(localPeriodSql('mc.occurred_at', 'p.timezone_code', period, bind));
  if (query.plantId !== undefined) and.push(`lt.plant_id = ${bind(query.plantId)}::bigint`);
  if (query.itemId !== undefined) and.push(`mc.item_id = ${bind(query.itemId)}::bigint`);
  if (query.lotNo !== undefined) and.push(`lt.lot_no = ${bind(query.lotNo)}`);
  if (query.workOrderNo !== undefined) and.push(`wo.work_order_no = ${bind(query.workOrderNo)}`);
  const inbound: string[] = [];
  if (query.inboundReceiptNo !== undefined) inbound.push(`ir.inbound_receipt_no = ${bind(query.inboundReceiptNo)}`);
  if (query.supplierId !== undefined) inbound.push(`ir.supplier_id = ${bind(query.supplierId)}::bigint`);
  if (inbound.length > 0) {
    and.push(`EXISTS (SELECT 1 FROM logistics.inbound_receipt_line irl
      JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
      WHERE irl.lot_id = mc.lot_id AND ${inbound.join(' AND ')})`);
  }
  if (query.q !== undefined && query.q.trim() !== '') {
    const like = bind(`%${query.q.trim()}%`);
    and.push(`(lt.lot_no ILIKE ${like} OR wo.work_order_no ILIKE ${like})`);
  }
  return { sql: and.join('\n    AND '), params };
}

interface LineRow {
  material_consumption_id: bigint;
  consumption_no: string;
  occurred_at: Date;
  status_code: string;
  consumption_type_code: string;
  corrects_consumption_id: bigint | null;
  plant_id: bigint;
  work_order_id: bigint;
  work_order_no: string;
  item_id: bigint;
  item_code: string;
  item_name: string;
  lot_id: bigint;
  lot_no: string;
  input_qty: unknown;
  uom_id: bigint;
  uom_code: string;
}

@Injectable()
export class MaterialInputLineListService {
  constructor(private readonly prisma: PrismaService) {}

  /** 투입 시각 내림차순 — 최근 것부터 본다. */
  async list(query: MaterialInputLineListQuery): Promise<PagedWithTotals<MaterialInputLineListItem>> {
    const where = materialInputLineWhere(query, await plantToday(this.prisma, query.plantId));
    return historyLinePage<LineRow, MaterialInputLineListItem>(this.prisma, {
      select: `mc.material_consumption_id, mc.consumption_no, mc.occurred_at, mc.status_code, mc.consumption_type_code,
               mc.corrects_consumption_id, lt.plant_id, wo.work_order_id, wo.work_order_no, i.item_id, i.item_code, i.item_name,
               lt.lot_id, lt.lot_no, mc.input_qty, u.uom_id, u.uom_code`,
      from: `${FROM}
        JOIN mdm.item i ON i.item_id = mc.item_id
        JOIN mdm.uom u ON u.uom_id = mc.uom_id`,
      qtyColumn: 'mc.input_qty',
      uomColumn: 'mc.uom_id',
      orderBy: 'mc.occurred_at DESC, mc.material_consumption_id DESC',
    }, where, pageRequest(query), itemOf);
  }
}

function itemOf(row: LineRow): MaterialInputLineListItem {
  return {
    materialConsumptionId: Number(row.material_consumption_id),
    consumptionNo: row.consumption_no,
    occurredAt: row.occurred_at.toISOString(),
    statusCode: row.status_code,
    consumptionTypeCode: row.consumption_type_code,
    correctsConsumptionId: row.corrects_consumption_id === null ? null : Number(row.corrects_consumption_id),
    plantId: Number(row.plant_id),
    workOrder: { workOrderId: Number(row.work_order_id), workOrderNo: row.work_order_no },
    item: named(row.item_id, row.item_code, row.item_name),
    lotId: Number(row.lot_id),
    lotNo: row.lot_no,
    inputQty: Number(row.input_qty),
    uomId: Number(row.uom_id),
    uomCode: row.uom_code,
  };
}
