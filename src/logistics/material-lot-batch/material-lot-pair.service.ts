import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { pageRequest, type PageMeta } from '../../common/pagination';
import { loadStockUomTable } from '../../core/bom/stock-uom';
import { MATERIAL_LOT_BATCH_SOURCE, materialLotDefaultsOf, planMaterialLotsWithin, type MaterialLotDefaultsStatus } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterialLotTabService, type MaterialLotTab, type MaterialLotTabRowView } from './material-lot-tab.service';

export interface MaterialLotPairQuery {
  plantId: number;
  q?: string;
  page?: number;
  size?: number;
}

interface PartyView {
  code: string;
  name: string;
}

/** 계약 `MaterialLotPair` — 왼쪽 공급사·품목 한 줄(피처 014 FR-010·011). */
export interface MaterialLotPairView {
  supplier: PartyView & { supplierId: number };
  item: PartyView & { itemId: number; baseUomCode: string };
  unprintedCount: number;
  creatableCount: number;
  defaultsStatus: MaterialLotDefaultsStatus;
  lotDefaults: { lotQty: number; packageUomId: number | null; packageUomCode: string | null; packageCount: number | null } | null;
}

interface PairRow {
  supplier_id: bigint;
  item_id: bigint;
  unprinted: number;
}

const LABEL = 'MATERIAL_LOT_LABEL';

/** 왼쪽 공급사·품목 목록과 LOT 번호 스캔 찾기(피처 014). 만들지 않는다 — 「만들 수 있는 수」는 계산만 한다. */
@Injectable()
export class MaterialLotPairService {
  constructor(private readonly prisma: PrismaService, private readonly tabs: MaterialLotTabService) {}

  async pairs(query: MaterialLotPairQuery): Promise<{ items: MaterialLotPairView[]; page: PageMeta; summary: { unprintedCount: number } }> {
    const page = pageRequest(query);
    const plant = query.plantId;
    const needle = query.q?.trim() ? `%${query.q.trim()}%` : null;
    // 조합 = 발행 묶음 ∪ 공급사·품목 기본 정보 ∪ 미마감 P/O 라인(옛 대기 목록과 같은 셋). 할 일(미출력 · 받기 전 자동 LOT 보다 많은 남은 양) 먼저.
    const base = Prisma.sql`
      WITH combos AS (
        SELECT supplier_id, item_id FROM trace.material_lot_batch WHERE plant_id = ${plant}
        UNION SELECT supplier_id, item_id FROM mdm.supplier_item_default WHERE plant_id = ${plant}
        UNION SELECT po.supplier_id, pol.item_id FROM logistics.purchase_order_line pol
                JOIN logistics.purchase_order po ON po.purchase_order_id = pol.purchase_order_id
               WHERE po.plant_id = ${plant} AND po.status_code NOT IN ('CLOSED', 'CANCELLED')
                 AND pol.cancelled_at IS NULL AND pol.received_qty < pol.ordered_qty
      ), unprinted AS (
        SELECT b.supplier_id, b.item_id, count(*)::int AS n
          FROM trace.lot l JOIN trace.material_lot_batch b ON b.material_lot_batch_id = l.source_id
         WHERE b.plant_id = ${plant} AND l.source_type_code = ${MATERIAL_LOT_BATCH_SOURCE} AND l.lifecycle_status_code = 'WAITING'
           AND NOT EXISTS (SELECT 1 FROM app.document_issue_log d WHERE d.lot_id = l.lot_id AND d.document_type_code = ${LABEL})
         GROUP BY 1, 2
      ), remaining AS (
        SELECT po.supplier_id, pol.item_id, sum(pol.ordered_qty - pol.received_qty) AS qty
          FROM logistics.purchase_order_line pol
          JOIN logistics.purchase_order po ON po.purchase_order_id = pol.purchase_order_id
          JOIN mdm.item i ON i.item_id = pol.item_id AND i.base_uom_id = pol.uom_id
         WHERE po.plant_id = ${plant} AND po.status_code NOT IN ('CLOSED', 'CANCELLED')
           AND pol.cancelled_at IS NULL AND pol.received_qty < pol.ordered_qty
         GROUP BY 1, 2
      ), outstanding AS (
        SELECT po.supplier_id, l.item_id, sum(l.initial_qty) AS qty
          FROM trace.material_lot_po_plan p JOIN trace.lot l ON l.lot_id = p.lot_id
          JOIN logistics.purchase_order_line pol ON pol.purchase_order_line_id = p.purchase_order_line_id
          JOIN logistics.purchase_order po ON po.purchase_order_id = pol.purchase_order_id
          LEFT JOIN trace.inbound_lot il ON il.inbound_lot_id = l.inbound_lot_id
         WHERE l.plant_id = ${plant}
           AND (l.lifecycle_status_code = 'WAITING' OR (l.lifecycle_status_code = 'ACTIVE' AND il.status_code = 'RECEIVING'))
         GROUP BY 1, 2
      )
      SELECT c.supplier_id, c.item_id, coalesce(u.n, 0) AS unprinted, p.partner_code, i.item_code,
             (coalesce(u.n, 0) > 0 OR coalesce(r.qty, 0) > coalesce(o.qty, 0)) AS busy
        FROM combos c
        JOIN mdm.partner p ON p.partner_id = c.supplier_id
        JOIN mdm.item i ON i.item_id = c.item_id
        LEFT JOIN unprinted u ON u.supplier_id = c.supplier_id AND u.item_id = c.item_id
        LEFT JOIN remaining r ON r.supplier_id = c.supplier_id AND r.item_id = c.item_id
        LEFT JOIN outstanding o ON o.supplier_id = c.supplier_id AND o.item_id = c.item_id
       WHERE ${needle === null ? Prisma.sql`TRUE` : Prisma.sql`(p.partner_code ILIKE ${needle} OR p.partner_name ILIKE ${needle}
             OR i.item_code ILIKE ${needle} OR i.item_name ILIKE ${needle})`}`;
    const [[counted], rows, [summary]] = await Promise.all([
      this.prisma.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM (${base}) f`,
      this.prisma.$queryRaw<PairRow[]>`SELECT * FROM (${base}) f ORDER BY busy DESC, partner_code, item_code LIMIT ${page.take} OFFSET ${page.skip}`,
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM trace.lot l
         WHERE l.plant_id = ${plant} AND l.source_type_code = ${MATERIAL_LOT_BATCH_SOURCE} AND l.lifecycle_status_code = 'WAITING'
           AND NOT EXISTS (SELECT 1 FROM app.document_issue_log d WHERE d.lot_id = l.lot_id AND d.document_type_code = ${LABEL})`,
    ]);
    return {
      items: await this.pairViews(plant, rows),
      page: { page: page.page, size: page.size, total: Number(counted.total) },
      summary: { unprintedCount: Number(summary.n) },
    };
  }

  private async pairViews(plantId: number, rows: PairRow[]): Promise<MaterialLotPairView[]> {
    if (rows.length === 0) return [];
    const businessDate = await this.tabs.plantToday(plantId);
    const [suppliers, items] = await Promise.all([
      this.prisma.partner.findMany({ where: { partner_id: { in: rows.map((row) => row.supplier_id) } },
        select: { partner_id: true, partner_code: true, partner_name: true } }),
      this.prisma.item.findMany({ where: { item_id: { in: rows.map((row) => row.item_id) } },
        select: { item_id: true, item_code: true, item_name: true, default_lot_storage_uom_id: true, default_production_lot_size: true,
          default_package_count: true, default_package_uom_id: true, uom: { select: { uom_code: true } },
          default_package_uom: { select: { uom_code: true } } } }),
    ]);
    const table = await loadStockUomTable(this.prisma, items.map((item) => item.item_id), businessDate);
    const supplierOf = new Map(suppliers.map((row) => [row.partner_id, row]));
    const itemOf = new Map(items.map((row) => [row.item_id, row]));
    return Promise.all(rows.map(async (row) => {
      const supplier = supplierOf.get(row.supplier_id);
      const item = itemOf.get(row.item_id);
      if (supplier === undefined || item === undefined) throw new Error('조합의 공급사·품목이 없다');
      const defaults = materialLotDefaultsOf(item, table);
      const plan = defaults.status === 'OK'
        ? await planMaterialLotsWithin(this.prisma, { plantId, supplierId: Number(row.supplier_id), itemId: Number(row.item_id), businessDate })
        : null;
      return {
        supplier: { supplierId: Number(supplier.partner_id), code: supplier.partner_code, name: supplier.partner_name },
        item: { itemId: Number(item.item_id), code: item.item_code, name: item.item_name, baseUomCode: item.uom.uom_code },
        unprintedCount: Number(row.unprinted),
        creatableCount: plan?.status === 'OK' ? plan.lots.length : 0,
        defaultsStatus: defaults.status,
        lotDefaults: defaults.status !== 'OK' ? null : {
          lotQty: defaults.defaults.lotQty.toNumber(),
          packageUomId: item.default_package_uom_id === null ? null : Number(item.default_package_uom_id),
          packageUomCode: item.default_package_uom?.uom_code ?? null,
          packageCount: defaults.defaults.packageCount,
        },
      };
    }));
  }

  /** 번호 스캔 찾기(FR-021) — 공장 안 자재 관리 LOT 하나와 그 공급사·품목·탭. */
  async lookup(plantId: number, lotNo: string): Promise<{
    lot: MaterialLotTabRowView; supplier: { supplierId: number; code: string; name: string };
    item: { itemId: number; code: string; name: string; baseUomCode: string }; tab: MaterialLotTab;
  }> {
    const lot = await this.prisma.lot.findFirst({
      where: { plant_id: plantId, lot_no: lotNo.trim(), lot_type_code: 'MATERIAL' },
      select: { lot_id: true, item_id: true, source_type_code: true, source_id: true, lifecycle_status_code: true,
        inbound_lot: { select: { supplier_id: true } }, document_issue_log: { where: { document_type_code: LABEL }, select: { issue_seq: true }, take: 1 } },
    });
    const supplierId = lot?.inbound_lot?.supplier_id ?? (lot?.source_type_code === MATERIAL_LOT_BATCH_SOURCE
      ? (await this.prisma.material_lot_batch.findUnique({ where: { material_lot_batch_id: lot.source_id }, select: { supplier_id: true } }))?.supplier_id
      : undefined);
    if (lot === null || supplierId === undefined) throw new NotFoundException('이 공장에 없는 자재 관리 LOT 번호입니다');
    const tab: MaterialLotTab = lot.inbound_lot !== null ? 'RECEIVED'
      : lot.lifecycle_status_code === 'VOIDED' ? 'VOIDED'
        : lot.document_issue_log.length > 0 ? 'PRINTED' : 'UNPRINTED';
    const [rows, supplier, item] = await Promise.all([
      this.tabs.lotRow(lot.lot_id),
      this.prisma.partner.findUniqueOrThrow({ where: { partner_id: supplierId }, select: { partner_code: true, partner_name: true } }),
      this.prisma.item.findUniqueOrThrow({ where: { item_id: lot.item_id }, select: { item_code: true, item_name: true, uom: { select: { uom_code: true } } } }),
    ]);
    return {
      lot: rows,
      supplier: { supplierId: Number(supplierId), code: supplier.partner_code, name: supplier.partner_name },
      item: { itemId: Number(lot.item_id), code: item.item_code, name: item.item_name, baseUomCode: item.uom.uom_code },
      tab,
    };
  }
}
