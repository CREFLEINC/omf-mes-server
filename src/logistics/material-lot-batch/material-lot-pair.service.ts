import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { pageRequest, type PageMeta } from '../../common/pagination';
import { loadStockUomTable } from '../../core/bom/stock-uom';
import { MATERIAL_LOT_BATCH_SOURCE, materialLotDefaultsOf, planMaterialLotsWithin, type MaterialLotDefaultsStatus } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterialLotTabService, type MaterialLotTab, type MaterialLotTabRowView } from './material-lot-tab.service';

export interface MaterialLotPairQuery {
  plantId: number;
  /** POP 둘째 칸(품목 표) — 고른 공급사로 거른다(세 칸 맞춤). */
  supplierId?: number;
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
  printedCount: number;
  inspectionRequired: boolean;
  lastIssuedAt: Date | null;
  defaultsStatus: MaterialLotDefaultsStatus;
  lotDefaults: { lotQty: number; packageUomId: number | null; packageUomCode: string | null; packageCount: number | null } | null;
}

/** 계약 `MaterialLotSupplier` — POP 첫째 칸 공급사 한 줄(세 칸 맞춤). 수는 그 공급사 조합들의 합. */
export interface MaterialLotSupplierView {
  supplier: PartyView & { supplierId: number };
  pairCount: number;
  unprintedCount: number;
  creatableCount: number;
}

interface PairRow {
  supplier_id: bigint;
  item_id: bigint;
  unprinted: number;
  printed: number;
  last_issued_at: Date | null;
  inspection_required: boolean;
}

interface SupplierRow {
  supplier_id: bigint;
  pair_count: number;
}

const LABEL = 'MATERIAL_LOT_LABEL';

/** 왼쪽 공급사·품목 목록과 LOT 번호 스캔 찾기(피처 014). 만들지 않는다 — 「만들 수 있는 수」는 계산만 한다. */
@Injectable()
export class MaterialLotPairService {
  constructor(private readonly prisma: PrismaService, private readonly tabs: MaterialLotTabService) {}

  async pairs(query: MaterialLotPairQuery): Promise<{ items: MaterialLotPairView[]; page: PageMeta; summary: { unprintedCount: number } }> {
    const page = pageRequest(query);
    const plant = query.plantId;
    const base = this.pairSql(plant, query.q, query.supplierId);
    // POP 품목 표(공급사로 거름)는 최근 발행이 오래된 품목부터, 발행 이력 없는 품목은 맨 뒤(사용자 2026-11-24 · 시안 6판).
    // 전체 기준으로 줄 세운 뒤 쪽을 나눈다. W-01-14(공급사 거르기 없음)는 할 일 있는 조합 먼저 그대로.
    const order = query.supplierId === undefined
      ? Prisma.sql`busy DESC, partner_code, item_code`
      : Prisma.sql`last_issued_at ASC NULLS LAST, item_code`;
    const [[counted], rows, [summary]] = await Promise.all([
      this.prisma.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM (${base}) f`,
      this.prisma.$queryRaw<PairRow[]>`SELECT * FROM (${base}) f ORDER BY ${order} LIMIT ${page.take} OFFSET ${page.skip}`,
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

  /**
   * POP 첫째 칸 공급사(세 칸 맞춤, 계약 §1a) — pairs 와 같은 조합 셋(같은 `q`)을 공급사로 묶는다.
   * 수는 쪽 안 공급사들의 조합을 pairs 와 같은 계산으로 더한다(만들지 않는다). 정렬은 할 일 있는 조합이 있는 공급사 먼저, 그다음 공급사 코드.
   */
  async suppliers(query: Omit<MaterialLotPairQuery, 'supplierId'>): Promise<{ items: MaterialLotSupplierView[]; page: PageMeta }> {
    const page = pageRequest(query);
    const plant = query.plantId;
    const base = this.pairSql(plant, query.q);
    const [[counted], suppliers] = await Promise.all([
      this.prisma.$queryRaw<{ total: bigint }[]>`SELECT count(DISTINCT supplier_id) AS total FROM (${base}) f`,
      this.prisma.$queryRaw<SupplierRow[]>`
        SELECT supplier_id, count(*)::int AS pair_count FROM (${base}) f
         GROUP BY supplier_id, partner_code ORDER BY bool_or(busy) DESC, partner_code LIMIT ${page.take} OFFSET ${page.skip}`,
    ]);
    const supplierIds = suppliers.map((row) => row.supplier_id);
    const rows = supplierIds.length === 0 ? []
      : await this.prisma.$queryRaw<PairRow[]>`SELECT * FROM (${base}) f WHERE supplier_id IN (${Prisma.join(supplierIds)})`;
    const views = await this.pairViews(plant, rows);
    const total = new Map<number, { unprinted: number; creatable: number; supplier: MaterialLotPairView['supplier'] }>();
    for (const view of views) {
      const sum = total.get(view.supplier.supplierId) ?? { unprinted: 0, creatable: 0, supplier: view.supplier };
      sum.unprinted += view.unprintedCount;
      sum.creatable += view.creatableCount;
      total.set(view.supplier.supplierId, sum);
    }
    return {
      items: suppliers.map((row) => {
        const sum = total.get(Number(row.supplier_id));
        if (sum === undefined) throw new Error('공급사 조합이 없다');
        return { supplier: sum.supplier, pairCount: row.pair_count, unprintedCount: sum.unprinted, creatableCount: sum.creatable };
      }),
      page: { page: page.page, size: page.size, total: Number(counted.total) },
    };
  }

  /**
   * 조합 셋 SQL(pairs·suppliers 공용) — 발행 묶음 ∪ 공급사·품목 기본 정보 ∪ 미마감 P/O 라인(옛 대기 목록과 같은 셋).
   * 행마다 미출력·출력됨(대기, 라벨 있음/없음)·최근 발행·수입검사·할 일(미출력 · 받기 전 자동 LOT 보다 많은 남은 양).
   */
  private pairSql(plant: number, q: string | undefined, supplierId?: number): Prisma.Sql {
    const needle = q?.trim() ? `%${q.trim()}%` : null;
    return Prisma.sql`
      WITH combos AS (
        SELECT supplier_id, item_id FROM trace.material_lot_batch WHERE plant_id = ${plant}
        UNION SELECT supplier_id, item_id FROM mdm.supplier_item_default WHERE plant_id = ${plant}
        UNION SELECT po.supplier_id, pol.item_id FROM logistics.purchase_order_line pol
                JOIN logistics.purchase_order po ON po.purchase_order_id = pol.purchase_order_id
               WHERE po.plant_id = ${plant} AND po.status_code NOT IN ('CLOSED', 'CANCELLED')
                 AND pol.cancelled_at IS NULL AND pol.received_qty < pol.ordered_qty
      ), batch_lots AS (
        SELECT b.supplier_id, b.item_id, l.lifecycle_status_code,
               (SELECT max(d.issued_at) FROM app.document_issue_log d WHERE d.lot_id = l.lot_id AND d.document_type_code = ${LABEL}) AS issued_at
          FROM trace.lot l JOIN trace.material_lot_batch b ON b.material_lot_batch_id = l.source_id
         WHERE b.plant_id = ${plant} AND l.source_type_code = ${MATERIAL_LOT_BATCH_SOURCE}
      ), stats AS (
        SELECT supplier_id, item_id,
               count(*) FILTER (WHERE lifecycle_status_code = 'WAITING' AND issued_at IS NULL)::int AS unprinted,
               count(*) FILTER (WHERE lifecycle_status_code = 'WAITING' AND issued_at IS NOT NULL)::int AS printed
          FROM batch_lots GROUP BY 1, 2
      ), last_issue AS (
        -- 최근 발행은 받은 LOT 도 센다 — 받으면 원천이 입하 줄로 바뀌어 공급사는 입하 LOT 에서 읽는다(「입하된」 탭과 같은 짝).
        SELECT coalesce(b.supplier_id, il.supplier_id) AS supplier_id, l.item_id, max(d.issued_at) AS last_issued_at
          FROM app.document_issue_log d JOIN trace.lot l ON l.lot_id = d.lot_id
          LEFT JOIN trace.material_lot_batch b ON l.source_type_code = ${MATERIAL_LOT_BATCH_SOURCE} AND b.material_lot_batch_id = l.source_id
          LEFT JOIN trace.inbound_lot il ON il.inbound_lot_id = l.inbound_lot_id
         WHERE d.document_type_code = ${LABEL} AND l.plant_id = ${plant} AND l.lot_type_code = 'MATERIAL'
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
      SELECT c.supplier_id, c.item_id, coalesce(s.unprinted, 0) AS unprinted, coalesce(s.printed, 0) AS printed,
             li.last_issued_at, i.inspection_required, p.partner_code, i.item_code,
             (coalesce(s.unprinted, 0) > 0 OR coalesce(r.qty, 0) > coalesce(o.qty, 0)) AS busy
        FROM combos c
        JOIN mdm.partner p ON p.partner_id = c.supplier_id
        JOIN mdm.item i ON i.item_id = c.item_id
        LEFT JOIN stats s ON s.supplier_id = c.supplier_id AND s.item_id = c.item_id
        LEFT JOIN last_issue li ON li.supplier_id = c.supplier_id AND li.item_id = c.item_id
        LEFT JOIN remaining r ON r.supplier_id = c.supplier_id AND r.item_id = c.item_id
        LEFT JOIN outstanding o ON o.supplier_id = c.supplier_id AND o.item_id = c.item_id
       WHERE ${supplierId === undefined ? Prisma.sql`TRUE` : Prisma.sql`c.supplier_id = ${supplierId}`}
         AND ${needle === null ? Prisma.sql`TRUE` : Prisma.sql`(p.partner_code ILIKE ${needle} OR p.partner_name ILIKE ${needle}
             OR i.item_code ILIKE ${needle} OR i.item_name ILIKE ${needle})`}`;
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
        printedCount: Number(row.printed),
        inspectionRequired: row.inspection_required,
        lastIssuedAt: row.last_issued_at,
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
