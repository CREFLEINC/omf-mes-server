import { Injectable, NotFoundException } from '@nestjs/common';

import { WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';

/** 영향 범위를 무엇으로 셌는가 — 화면이 「추정」이라고 밝히는 근거다. */
export const IMPACT_BASIS = 'WORK_ORDER_ESTIMATE';

export interface AffectedProductionLot {
  lotId: number;
  lotNo: string;
  itemId: number;
  statusCode: string;
  workOrderId: number;
  workOrderNo: string;
}

export interface AffectedProductionLots {
  basis: typeof IMPACT_BASIS;
  workOrders: { workOrderId: number; workOrderNo: string }[];
  items: AffectedProductionLot[];
}

/**
 * 자재 LOT → 생산 LOT 영향 범위(omf-all-around#108 · 장부 P-52).
 *
 * ⚠ **추정이다.** 자재 투입은 LOT 계보(`trace.lot_relation`)를 만들지 않아(I-10 §3-9 · 문의 052) 어느 생산
 * LOT 에 들어갔는지 모른다. 그래서 「그 자재가 투입된 작업지시의 생산 LOT **전부**」를 낸다(사용자 결정
 * 2026-10-16) — 실제보다 넓다. 계보가 서면 이 서비스가 그것으로 바뀐다.
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

    const lots = workOrders.length === 0 ? [] : await this.prisma.lot.findMany({
      where: {
        source_type_code: WORK_ORDER_LOT_SOURCE,
        source_id: { in: workOrders.map((wo) => BigInt(wo.workOrderId)) },
      },
      orderBy: [{ source_id: 'asc' }, { lot_id: 'asc' }],
      select: { lot_id: true, lot_no: true, item_id: true, status_code: true, source_id: true },
    });

    return {
      basis: IMPACT_BASIS,
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
