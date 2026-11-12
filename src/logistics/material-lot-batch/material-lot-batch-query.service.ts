import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MATERIAL_LOT_BATCH_SOURCE } from '../../core/lot';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { CLOSED_ORDER_STATUSES, openLineWhere } from '../purchase-order/purchase-order-receipt';
import { invalidQuery } from './material-lot-batch.service';
import { loadMaterialLotSummaries, packageView, type MaterialLotSummaryView, type MaterialPackageView } from './material-lot-view';

const WAITING = 'WAITING';
const VOIDED = 'VOIDED';
const RECEIVING = 'RECEIVING';
/** 대기 목록이 대기 말고도 함께 보이는 「최근」 묶음·폐기의 폭 — 라벨 다시 인쇄·확인용이다. */
const RECENT_DAYS = 7;

export interface MaterialLotBatchQuery {
  plantId: number;
  supplierId?: number;
  itemId?: number;
  createdFrom?: string;
  createdTo?: string;
  hasWaiting?: boolean | string;
  page?: number;
  size?: number;
}

export interface WaitingMaterialLotQuery {
  plantId: number;
  supplierId?: number;
  itemId?: number;
  q?: string;
  hasWaiting?: boolean | string;
}

export interface MaterialLotBatchRowView {
  batchId: number;
  plantId: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  uomId: number;
  uomCode: string;
  lotQty: number;
  package: MaterialPackageView | null;
  supplierLotNo: string | null;
  lotCount: number;
  createdChannelCode: string;
  createdAt: string;
  waitingCount: number;
  receivedCount: number;
  voidedCount: number;
}

export interface MaterialLotBatchSummaryView {
  batchId: number;
  createdAt: string;
  createdChannelCode: string;
  lotCount: number;
  waitingCount: number;
}

export interface WaitingMaterialLotGroupView {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  uomId: number;
  uomCode: string;
  inspectionRequired: boolean;
  waitingCount: number;
  waitingQty: number;
  unprintedCount: number;
  lastIssuedAt: string | null;
  batches: MaterialLotBatchSummaryView[];
  lots: MaterialLotSummaryView[];
}

const BATCH_INCLUDE = {
  supplier: { select: { partner_code: true, partner_name: true } },
  item: { select: { item_code: true, item_name: true, base_uom_id: true, uom: { select: { uom_code: true } } } },
  package_uom: { select: { uom_code: true } },
} as const;

/** 자재 관리 LOT 발행 묶음 목록·공급사·품목별 대기 목록(계약 §1). */
@Injectable()
export class MaterialLotBatchQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MaterialLotBatchQuery): Promise<PagedResponse<MaterialLotBatchRowView>> {
    const page = pageRequest(query);
    const where: Prisma.material_lot_batchWhereInput = {
      plant_id: query.plantId,
      ...(query.supplierId === undefined ? {} : { supplier_id: query.supplierId }),
      ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
      created_at: { ...(query.createdFrom ? { gte: instant('createdFrom', query.createdFrom) } : {}),
        ...(query.createdTo ? { lt: instant('createdTo', query.createdTo) } : {}) },
    };
    const hasWaiting = flag(query.hasWaiting);
    if (hasWaiting !== undefined) {
      const waitingIds = await this.waitingBatchIds(query.plantId);
      where.material_lot_batch_id = hasWaiting ? { in: waitingIds } : { notIn: waitingIds };
    }
    const [rows, total] = await Promise.all([
      this.prisma.material_lot_batch.findMany({
        where, include: BATCH_INCLUDE, orderBy: [{ created_at: 'desc' }, { material_lot_batch_id: 'desc' }],
        skip: page.skip, take: page.take,
      }),
      this.prisma.material_lot_batch.count({ where }),
    ]);
    const counts = await this.lifecycleCounts(rows.map((row) => row.material_lot_batch_id));
    return pagedResponse(rows.map((row) => {
      const count = counts.get(row.material_lot_batch_id) ?? { waiting: 0, voided: 0 };
      return {
        batchId: Number(row.material_lot_batch_id),
        plantId: Number(row.plant_id),
        supplierId: Number(row.supplier_id),
        supplierCode: row.supplier.partner_code,
        supplierName: row.supplier.partner_name,
        itemId: Number(row.item_id),
        itemCode: row.item.item_code,
        itemName: row.item.item_name,
        uomId: Number(row.item.base_uom_id),
        uomCode: row.item.uom.uom_code,
        lotQty: Number(row.lot_qty),
        package: packageView(row),
        supplierLotNo: row.supplier_lot_no,
        lotCount: row.lot_count,
        createdChannelCode: row.created_channel_code,
        createdAt: row.created_at.toISOString(),
        waitingCount: count.waiting,
        // 입하되면 원천이 입하 줄로 바뀌어 묶음에서 빠진다 — 남은 것(대기·폐기)을 뺀 나머지가 입하된 수다.
        receivedCount: row.lot_count - count.waiting - count.voided,
        voidedCount: count.voided,
      };
    }), total, page);
  }

  async waiting(query: WaitingMaterialLotQuery): Promise<{ items: WaitingMaterialLotGroupView[] }> {
    const filter = {
      plant_id: query.plantId,
      ...(query.supplierId === undefined ? {} : { supplier_id: query.supplierId }),
      ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
    };
    // 목록에 서는 조합 = 발행 이력이 있거나 기본 정보(W-06-25)가 있거나 그 공장의 미마감 P/O 라인이 있는 공급사·품목.
    const [issued, defaults, ordered] = await Promise.all([
      this.prisma.material_lot_batch.groupBy({ by: ['supplier_id', 'item_id'], where: filter, _max: { created_at: true } }),
      this.prisma.supplier_item_default.findMany({ where: filter, select: { supplier_id: true, item_id: true } }),
      this.prisma.purchase_order_line.findMany({
        where: {
          ...openLineWhere(this.prisma),
          ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
          purchase_order: { plant_id: query.plantId, status_code: { notIn: CLOSED_ORDER_STATUSES },
            ...(query.supplierId === undefined ? {} : { supplier_id: query.supplierId }) },
        },
        select: { item_id: true, purchase_order: { select: { supplier_id: true } } },
        distinct: ['purchase_order_id', 'item_id'],
      }),
    ]);
    const combos = new Map<string, { supplierId: bigint; itemId: bigint; lastIssuedAt: Date | null }>();
    for (const row of ordered) {
      combos.set(key(row.purchase_order.supplier_id, row.item_id), { supplierId: row.purchase_order.supplier_id, itemId: row.item_id, lastIssuedAt: null });
    }
    for (const row of defaults) combos.set(key(row.supplier_id, row.item_id), { supplierId: row.supplier_id, itemId: row.item_id, lastIssuedAt: null });
    for (const row of issued) combos.set(key(row.supplier_id, row.item_id), { supplierId: row.supplier_id, itemId: row.item_id, lastIssuedAt: row._max.created_at });
    if (combos.size === 0) return { items: [] };

    const comboList = [...combos.values()];
    const [suppliers, items] = await Promise.all([
      this.prisma.partner.findMany({ where: { partner_id: { in: comboList.map((c) => c.supplierId) } },
        select: { partner_id: true, partner_code: true, partner_name: true } }),
      this.prisma.item.findMany({ where: { item_id: { in: comboList.map((c) => c.itemId) } },
        select: { item_id: true, item_code: true, item_name: true, base_uom_id: true, inspection_required: true,
          uom: { select: { uom_code: true } } } }),
    ]);
    const supplierById = new Map(suppliers.map((row) => [row.partner_id, row]));
    const itemById = new Map(items.map((row) => [row.item_id, row]));
    const needle = query.q?.trim().toLowerCase();
    const matched = comboList.filter((combo) => {
      if (!needle) return true;
      const supplier = supplierById.get(combo.supplierId);
      const item = itemById.get(combo.itemId);
      return [supplier?.partner_code, supplier?.partner_name, item?.item_code, item?.item_name]
        .some((text) => text?.toLowerCase().includes(needle));
    });

    const groups = await this.groupLots(query.plantId, filter, matched);
    const hasWaiting = flag(query.hasWaiting);
    const views = matched.map((combo): WaitingMaterialLotGroupView => {
      const supplier = supplierById.get(combo.supplierId);
      const item = itemById.get(combo.itemId);
      const group = groups.get(key(combo.supplierId, combo.itemId)) ?? { batches: [], lots: [] };
      const waitingLots = group.lots.filter((lot) => lot.lifecycleStatusCode === WAITING);
      return {
        supplierId: Number(combo.supplierId),
        supplierCode: supplier?.partner_code ?? '',
        supplierName: supplier?.partner_name ?? '',
        itemId: Number(combo.itemId),
        itemCode: item?.item_code ?? '',
        itemName: item?.item_name ?? '',
        uomId: Number(item?.base_uom_id ?? 0),
        uomCode: item?.uom.uom_code ?? '',
        inspectionRequired: item?.inspection_required ?? false,
        waitingCount: waitingLots.length,
        waitingQty: waitingLots.reduce((sum, lot) => sum.plus(lot.lotQty), new Prisma.Decimal(0)).toNumber(),
        unprintedCount: waitingLots.filter((lot) => lot.lastLabelIssue === null).length,
        lastIssuedAt: combo.lastIssuedAt?.toISOString() ?? null,
        batches: group.batches,
        lots: group.lots,
      };
    }).filter((view) => hasWaiting === undefined || (view.waitingCount > 0) === hasWaiting);
    views.sort((a, b) => a.supplierCode.localeCompare(b.supplierCode) || a.itemCode.localeCompare(b.itemCode));
    return { items: views };
  }

  /**
   * 조합마다 묶음과 LOT — 묶음은 대기가 남았거나 최근 것, LOT 은 대기 전부 + 최근 묶음의 폐기 +
   * 열린(`RECEIVING`) 입하 LOT 에 든 것(라벨 다시 인쇄 대상).
   */
  private async groupLots(
    plantId: number,
    filter: Prisma.material_lot_batchWhereInput,
    combos: { supplierId: bigint; itemId: bigint }[],
  ): Promise<Map<string, { batches: MaterialLotBatchSummaryView[]; lots: MaterialLotSummaryView[] }>> {
    const groups = new Map<string, { batches: MaterialLotBatchSummaryView[]; lots: MaterialLotSummaryView[] }>();
    if (combos.length === 0) return groups;
    const recentSince = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
    const waitingIds = await this.waitingBatchIds(plantId);
    const batches = await this.prisma.material_lot_batch.findMany({
      where: { ...filter, OR: [{ material_lot_batch_id: { in: waitingIds } }, { created_at: { gte: recentSince } }] },
      select: { material_lot_batch_id: true, supplier_id: true, item_id: true, created_at: true,
        created_channel_code: true, lot_count: true },
      orderBy: [{ created_at: 'desc' }, { material_lot_batch_id: 'desc' }],
    });
    const wanted = new Set(combos.map((combo) => key(combo.supplierId, combo.itemId)));
    const shown = batches.filter((batch) => wanted.has(key(batch.supplier_id, batch.item_id)));
    const counts = await this.lifecycleCounts(shown.map((batch) => batch.material_lot_batch_id));
    const comboOfBatch = new Map(shown.map((batch) => [batch.material_lot_batch_id, key(batch.supplier_id, batch.item_id)]));
    const group = (k: string) => {
      const found = groups.get(k);
      if (found) return found;
      const created = { batches: [] as MaterialLotBatchSummaryView[], lots: [] as MaterialLotSummaryView[] };
      groups.set(k, created);
      return created;
    };
    for (const batch of shown) {
      group(key(batch.supplier_id, batch.item_id)).batches.push({
        batchId: Number(batch.material_lot_batch_id),
        createdAt: batch.created_at.toISOString(),
        createdChannelCode: batch.created_channel_code,
        lotCount: batch.lot_count,
        waitingCount: counts.get(batch.material_lot_batch_id)?.waiting ?? 0,
      });
    }

    const batchLots = await loadMaterialLotSummaries(this.prisma, {
      plant_id: plantId,
      source_type_code: MATERIAL_LOT_BATCH_SOURCE,
      source_id: { in: shown.map((batch) => batch.material_lot_batch_id) },
      lifecycle_status_code: { in: [WAITING, VOIDED] },
    }, [{ source_id: 'desc' }, { lot_no: 'asc' }]);
    const sourceOf = await this.prisma.lot.findMany({
      where: { lot_id: { in: batchLots.map((lot) => BigInt(lot.lotId)) } }, select: { lot_id: true, source_id: true },
    });
    const batchOfLot = new Map(sourceOf.map((row) => [Number(row.lot_id), row.source_id]));
    for (const lot of batchLots) {
      const k = comboOfBatch.get(batchOfLot.get(lot.lotId) as bigint);
      if (k !== undefined) group(k).lots.push(lot);
    }

    const openInbound = await this.prisma.inbound_lot.findMany({
      where: { plant_id: plantId, status_code: RECEIVING,
        OR: combos.map((combo) => ({ supplier_id: combo.supplierId, item_id: combo.itemId })) },
      select: { inbound_lot_id: true, supplier_id: true, item_id: true },
    });
    if (openInbound.length > 0) {
      const comboOfInbound = new Map(openInbound.map((row) => [row.inbound_lot_id, key(row.supplier_id, row.item_id)]));
      const received = await this.prisma.lot.findMany({
        where: { inbound_lot_id: { in: [...comboOfInbound.keys()] } }, select: { lot_id: true, inbound_lot_id: true },
      });
      const views = await loadMaterialLotSummaries(this.prisma, { lot_id: { in: received.map((row) => row.lot_id) } });
      const inboundOf = new Map(received.map((row) => [Number(row.lot_id), row.inbound_lot_id as bigint]));
      for (const lot of views) group(comboOfInbound.get(inboundOf.get(lot.lotId) as bigint) as string).lots.push(lot);
    }
    return groups;
  }

  private async waitingBatchIds(plantId: number): Promise<bigint[]> {
    const rows = await this.prisma.lot.findMany({
      where: { plant_id: plantId, source_type_code: MATERIAL_LOT_BATCH_SOURCE, lifecycle_status_code: WAITING },
      select: { source_id: true }, distinct: ['source_id'],
    });
    return rows.map((row) => row.source_id);
  }

  private async lifecycleCounts(batchIds: bigint[]): Promise<Map<bigint, { waiting: number; voided: number }>> {
    const counts = new Map<bigint, { waiting: number; voided: number }>();
    if (batchIds.length === 0) return counts;
    const rows = await this.prisma.lot.groupBy({
      by: ['source_id', 'lifecycle_status_code'],
      where: { source_type_code: MATERIAL_LOT_BATCH_SOURCE, source_id: { in: batchIds } },
      _count: { _all: true },
    });
    for (const row of rows) {
      const entry = counts.get(row.source_id) ?? { waiting: 0, voided: 0 };
      if (row.lifecycle_status_code === WAITING) entry.waiting += row._count._all;
      if (row.lifecycle_status_code === VOIDED) entry.voided += row._count._all;
      counts.set(row.source_id, entry);
    }
    return counts;
  }
}

function key(supplierId: bigint, itemId: bigint): string {
  return `${String(supplierId)}:${String(itemId)}`;
}

function flag(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 'true';
}

function instant(name: string, value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalidQuery(name, '시각 형식이 아닙니다.');
  return parsed;
}
