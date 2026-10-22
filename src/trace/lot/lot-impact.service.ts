import { Injectable, NotFoundException } from '@nestjs/common';

import { CONSUMED_RELATION, WORK_ORDER_LOT_SOURCE, tracedWorkOrders } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { GENEALOGY_BASIS, TraceBasis, WORK_ORDER_BASIS } from './lot-genealogy-query.service';

export interface AffectedProductionLot {
  lotId: number;
  lotNo: string;
  itemId: number;
  statusCode: string;
  workOrderId: number;
  workOrderNo: string;
}

export interface AffectedProductionLots {
  basis: TraceBasis;
  workOrders: { workOrderId: number; workOrderNo: string }[];
  items: AffectedProductionLot[];
}

/**
 * 자재 LOT → 생산 LOT 영향 범위(omf-all-around#108 · 장부 P-52).
 *
 * 계보(`trace.lot_relation` · #166 · P-107)가 있는 W/O 는 그 자재 LOT 이 이어진 생산 LOT 만 낸다 — 투입 시각 기준이라
 * 여전히 「추정」이다. 계보가 없는 W/O(#166 배포 전 실적)는 그 W/O 의 생산 LOT **전부**다(사용자 결정 2026-10-16).
 */
@Injectable()
export class LotImpactService {
  constructor(private readonly prisma: PrismaService) {}

  async affectedProductionLots(lotId: number): Promise<AffectedProductionLots> {
    const lot = await this.prisma.lot.findUnique({ where: { lot_id: BigInt(lotId) }, select: { lot_id: true } });
    if (lot === null) throw new NotFoundException('없는 LOT 입니다.');

    const consumptions = await this.prisma.material_consumption.findMany({
      where: { lot_id: BigInt(lotId) },
      distinct: ['work_order_id'],
      select: { work_order: { select: { work_order_id: true, work_order_no: true } } },
      orderBy: { work_order_id: 'asc' },
    });
    const workOrders = consumptions.map(({ work_order: wo }) => ({
      workOrderId: Number(wo.work_order_id),
      workOrderNo: wo.work_order_no,
    }));
    const noOf = new Map(workOrders.map((wo) => [wo.workOrderId, wo.workOrderNo]));

    const ids = workOrders.map((wo) => BigInt(wo.workOrderId));
    const traced = await tracedWorkOrders(this.prisma, ids);
    const legacy = ids.filter((id) => !traced.has(id));
    const related = traced.size === 0 ? [] : await this.prisma.lot_relation.findMany({
      where: { source_lot_id: BigInt(lotId), relation_type_code: CONSUMED_RELATION },
      distinct: ['target_lot_id'],
      select: { target_lot_id: true },
    });
    const lots = workOrders.length === 0 ? [] : await this.prisma.lot.findMany({
      where: {
        source_type_code: WORK_ORDER_LOT_SOURCE,
        OR: [
          { source_id: { in: legacy } },
          { source_id: { in: [...traced] }, lot_id: { in: related.map((row) => row.target_lot_id) } },
        ],
      },
      orderBy: [{ source_id: 'asc' }, { lot_id: 'asc' }],
      select: { lot_id: true, lot_no: true, item_id: true, status_code: true, source_id: true },
    });

    return {
      basis: legacy.length === 0 ? GENEALOGY_BASIS : WORK_ORDER_BASIS,
      workOrders,
      items: lots.map((row) => ({
        lotId: Number(row.lot_id),
        lotNo: row.lot_no,
        itemId: Number(row.item_id),
        statusCode: row.status_code,
        workOrderId: Number(row.source_id),
        workOrderNo: noOf.get(Number(row.source_id)) ?? '',
      })),
    };
  }
}
