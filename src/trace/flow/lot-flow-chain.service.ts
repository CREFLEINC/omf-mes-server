import { Injectable, NotFoundException } from '@nestjs/common';

import { CONSUMED_RELATION, tracedWorkOrders } from '../../core/lot/lot-genealogy';
import { WORK_ORDER_LOT_SOURCE } from '../../core/lot/lot-source';
import { PrismaService } from '../../prisma/prisma.service';
import { GENEALOGY_BASIS, TraceBasis, WORK_ORDER_BASIS } from '../lot/lot-genealogy-query.service';
import { forwardLinksSql } from './flow-sql';
import { LotHead, MaterialSide, Named, ProductSide, lotHeads, materialSides, productSides, pick } from './lot-flow-nodes';

/** 한 호출이 싣는 생산 LOT 의 상한 — 넘으면 `truncated` 와 전체 수를 준다. */
export const PRODUCTION_LOTS_SHOWN = 500;

interface Consumption {
  consumedQty: number;
  firstConsumedAt: string;
  lastConsumedAt: string;
}

interface WorkOrderHead {
  workOrderId: number;
  workOrderNo: string;
  item: Named;
  statusCode: string;
}

export interface ProductionLotNode extends LotHead, ProductSide {
  goodQty: number;
  linkBasis: TraceBasis;
  serialCount: number;
  /** 이 LOT 이 다시 투입된 W/O 수 — 반제품이면 0 보다 크고, 화면이 이 LOT 으로 정방향을 다시 부른다. */
  consumedFurther: number;
  /** 조회한 LOT 자신으로 되돌아왔다. */
  cyclic: boolean;
}

export interface ForwardFlow extends MaterialSide {
  lot: LotHead;
  basis: TraceBasis;
  workOrders: (WorkOrderHead & Consumption & {
    /** 실적이 아직 없어 이은 생산 LOT 이 없으면 null. */
    linkBasis: TraceBasis | null;
    productionLots: ProductionLotNode[];
  })[];
  truncated: boolean;
  totalProductionLotCount: number;
}

export interface InputMaterialNode extends LotHead, MaterialSide, Consumption {
  linkBasis: TraceBasis;
  /** 이 자재 LOT 이 생산 LOT(반제품)이면 그 W/O — 화면이 이 LOT 으로 역방향을 다시 부른다. */
  producedBy: { workOrderId: number; workOrderNo: string } | null;
  cyclic: boolean;
}

export interface BackwardFlow extends ProductSide {
  lot: LotHead;
  goodQty: number;
  basis: TraceBasis;
  /** 원천이 W/O 가 아닌 LOT(자재·분할)이면 null 이고 투입 자재도 없다. */
  workOrder: (WorkOrderHead & {
    results: { count: number; goodQty: number; defectQty: number; firstAt: string | null; lastAt: string | null };
  }) | null;
  inputMaterials: InputMaterialNode[];
}

/** 정정된 원 투입은 빼고 정정 투입을 넣는다 — 계보의 투입 구간(`inputWindows`)과 같은 셈. */
const LIVE_CONSUMPTION = `NOT EXISTS (SELECT 1 FROM production.material_consumption cx WHERE cx.corrects_consumption_id = mc.material_consumption_id)`;

@Injectable()
export class LotFlowChainService {
  constructor(private readonly prisma: PrismaService) {}

  async forward(lotId: number): Promise<ForwardFlow> {
    const id = BigInt(lotId);
    const lot = await this.head(id);
    const [side, consumptions, links] = await Promise.all([
      materialSides(this.prisma, [id]),
      this.consumptions(`mc.lot_id = $1`, [id], 'work_order_id'),
      this.prisma.$queryRawUnsafe<{ target_lot_id: bigint; work_order_id: bigint; basis: TraceBasis }[]>(
        `SELECT DISTINCT target_lot_id, work_order_id, basis FROM (${forwardLinksSql('SELECT $1::bigint')}) k
          ORDER BY work_order_id, target_lot_id`, id,
      ),
    ]);
    const targets = [...new Set(links.map((link) => link.target_lot_id))];
    const shown = targets.slice(0, PRODUCTION_LOTS_SHOWN);
    const nodes = await this.productionLots(shown, id);
    const orders = await this.workOrderHeads([...consumptions.keys()]);
    const workOrders = [...consumptions].map(([workOrderId, consumption]) => {
      const mine = links.filter((link) => link.work_order_id === workOrderId);
      const linkBasis = mine[0]?.basis ?? null;
      return {
        ...pick(orders, workOrderId),
        ...consumption,
        linkBasis,
        productionLots: mine.flatMap((link) => {
          const node = nodes.get(link.target_lot_id);
          return node === undefined ? [] : [{ ...node, linkBasis: link.basis }];
        }),
      };
    });
    return {
      lot,
      ...pick(side, id),
      basis: links.some((link) => link.basis === WORK_ORDER_BASIS) ? WORK_ORDER_BASIS : GENEALOGY_BASIS,
      workOrders,
      truncated: shown.length < targets.length,
      totalProductionLotCount: targets.length,
    };
  }

  async backward(lotId: number): Promise<BackwardFlow> {
    const id = BigInt(lotId);
    const lot = await this.head(id);
    const source = await this.prisma.lot.findUniqueOrThrow({ where: { lot_id: id }, select: { source_type_code: true, source_id: true } });
    const [products, goodQty] = await Promise.all([productSides(this.prisma, [id]), this.goodQty([id])]);
    const base = { lot, goodQty: goodQty.get(id) ?? 0, ...pick(products, id) };
    if (source.source_type_code !== WORK_ORDER_LOT_SOURCE) return { ...base, basis: GENEALOGY_BASIS, workOrder: null, inputMaterials: [] };

    const workOrderId = source.source_id;
    const traced = (await tracedWorkOrders(this.prisma, [workOrderId])).size > 0;
    const sources = traced
      ? (await this.prisma.lot_relation.findMany({
          where: { target_lot_id: id, relation_type_code: CONSUMED_RELATION }, distinct: ['source_lot_id'], select: { source_lot_id: true },
        })).map((row) => row.source_lot_id)
      : (await this.prisma.material_consumption.findMany({
          where: { work_order_id: workOrderId }, distinct: ['lot_id'], select: { lot_id: true },
        })).map((row) => row.lot_id);
    const linkBasis = traced ? GENEALOGY_BASIS : WORK_ORDER_BASIS;
    const [orders, results, heads, sides, consumptions, producers] = await Promise.all([
      this.workOrderHeads([workOrderId]),
      this.results(workOrderId),
      lotHeads(this.prisma, sources),
      materialSides(this.prisma, sources),
      this.consumptions(`mc.work_order_id = $1 AND mc.lot_id = ANY($2::bigint[])`, [workOrderId, sources], 'lot_id'),
      this.producers(sources),
    ]);
    return {
      ...base,
      basis: linkBasis,
      workOrder: { ...pick(orders, workOrderId), results },
      inputMaterials: sources.map((sourceId) => ({
        ...pick(heads, sourceId),
        ...pick(sides, sourceId),
        ...pick(consumptions, sourceId),
        linkBasis,
        producedBy: producers.get(sourceId) ?? null,
        cyclic: sourceId === id,
      })),
    };
  }

  private async head(id: bigint): Promise<LotHead> {
    const lot = (await lotHeads(this.prisma, [id])).get(id);
    if (lot === undefined) throw new NotFoundException('없는 LOT 입니다. LOT 번호를 확인해 다시 조회하세요.');
    return lot;
  }

  /** 투입을 `key`(W/O 또는 LOT)로 묶어 수량·첫/마지막 시각. */
  private async consumptions(where: string, params: unknown[], key: 'work_order_id' | 'lot_id'): Promise<Map<bigint, Consumption>> {
    const rows = await this.prisma.$queryRawUnsafe<{ key: bigint; qty: unknown; first_at: Date; last_at: Date }[]>(
      `SELECT mc.${key} AS key, SUM(mc.input_qty) AS qty, MIN(mc.occurred_at) AS first_at, MAX(mc.occurred_at) AS last_at
         FROM production.material_consumption mc
        WHERE ${where} AND ${LIVE_CONSUMPTION}
        GROUP BY mc.${key} ORDER BY MIN(mc.occurred_at), mc.${key}`, ...params,
    );
    return new Map(rows.map((row) => [row.key, {
      consumedQty: Number(row.qty), firstConsumedAt: row.first_at.toISOString(), lastConsumedAt: row.last_at.toISOString(),
    }]));
  }

  private async workOrderHeads(ids: bigint[]): Promise<Map<bigint, WorkOrderHead>> {
    const rows = await this.prisma.work_order.findMany({
      where: { work_order_id: { in: ids } },
      select: { work_order_id: true, work_order_no: true, status_code: true, item: { select: { item_id: true, item_code: true, item_name: true } } },
    });
    return new Map(rows.map((row) => [row.work_order_id, {
      workOrderId: Number(row.work_order_id), workOrderNo: row.work_order_no, statusCode: row.status_code,
      item: { id: Number(row.item.item_id), code: row.item.item_code, name: row.item.item_name },
    }]));
  }

  /** 정정된 원 실적은 빼고 정정 실적을 넣는다. */
  private async results(workOrderId: bigint) {
    const [row] = await this.prisma.$queryRawUnsafe<{ count: bigint; good: unknown; defect: unknown; first_at: Date | null; last_at: Date | null }[]>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(pr.good_qty), 0) AS good, COALESCE(SUM(pr.defect_qty), 0) AS defect,
              MIN(pr.occurred_at) AS first_at, MAX(pr.occurred_at) AS last_at
         FROM production.production_result pr
        WHERE pr.work_order_id = $1
          AND NOT EXISTS (SELECT 1 FROM production.production_result cx WHERE cx.corrects_production_result_id = pr.production_result_id)`,
      workOrderId,
    );
    return {
      count: Number(row.count), goodQty: Number(row.good), defectQty: Number(row.defect),
      firstAt: row.first_at?.toISOString() ?? null, lastAt: row.last_at?.toISOString() ?? null,
    };
  }

  private async goodQty(lotIds: bigint[]): Promise<Map<bigint, number>> {
    const rows = await this.prisma.production_result_lot_allocation.groupBy({
      by: ['lot_id'], where: { lot_id: { in: lotIds } }, _sum: { allocated_qty: true },
    });
    return new Map(rows.map((row) => [row.lot_id, Number(row._sum.allocated_qty ?? 0)]));
  }

  private async productionLots(lotIds: bigint[], queried: bigint): Promise<Map<bigint, Omit<ProductionLotNode, 'linkBasis'>>> {
    const [heads, sides, goodQty, serials, further] = await Promise.all([
      lotHeads(this.prisma, lotIds),
      productSides(this.prisma, lotIds),
      this.goodQty(lotIds),
      this.prisma.serial_number.groupBy({ by: ['lot_id'], where: { lot_id: { in: lotIds } }, _count: { _all: true } }),
      this.prisma.$queryRawUnsafe<{ lot_id: bigint; count: bigint }[]>(
        `SELECT lot_id, COUNT(DISTINCT work_order_id) AS count FROM production.material_consumption
          WHERE lot_id = ANY($1::bigint[]) GROUP BY lot_id`, lotIds,
      ),
    ]);
    const serialOf = new Map(serials.map((row) => [row.lot_id, row._count._all]));
    const furtherOf = new Map(further.map((row) => [row.lot_id, Number(row.count)]));
    return new Map(lotIds.map((lotId) => [lotId, {
      ...pick(heads, lotId),
      ...pick(sides, lotId),
      goodQty: goodQty.get(lotId) ?? 0,
      serialCount: serialOf.get(lotId) ?? 0,
      consumedFurther: furtherOf.get(lotId) ?? 0,
      cyclic: lotId === queried,
    }]));
  }

  /** 투입 자재 LOT 중 W/O 가 만든 것(반제품) — 그 W/O. */
  private async producers(lotIds: bigint[]): Promise<Map<bigint, { workOrderId: number; workOrderNo: string }>> {
    const rows = await this.prisma.$queryRawUnsafe<{ lot_id: bigint; work_order_id: bigint; work_order_no: string }[]>(
      `SELECT lt.lot_id, wo.work_order_id, wo.work_order_no FROM trace.lot lt
         JOIN production.work_order wo ON wo.work_order_id = lt.source_id
        WHERE lt.lot_id = ANY($1::bigint[]) AND lt.source_type_code = '${WORK_ORDER_LOT_SOURCE}'`, lotIds,
    );
    return new Map(rows.map((row) => [row.lot_id, { workOrderId: Number(row.work_order_id), workOrderNo: row.work_order_no }]));
  }
}
