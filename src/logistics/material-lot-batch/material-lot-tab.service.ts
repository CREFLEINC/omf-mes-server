import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { localToday } from '../../app/dashboard/dashboard-scope';
import { ContractException } from '../../common/errors';
import { pageRequest, type PageMeta } from '../../common/pagination';
import {
  ensureMaterialLotsWithin,
  lockMaterialLotPlanWithin,
  MATERIAL_LOT_BATCH_SOURCE,
  type MaterialLotBatchActor,
  type MaterialLotDefaultsStatus,
} from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { isDuplicateLotNo } from '../../trace/lot/lot-rules';
import { loadMaterialLotSummaries, type MaterialLotSummaryView } from './material-lot-view';

export type MaterialLotTab = 'UNPRINTED' | 'PRINTED' | 'RECEIVED' | 'VOIDED';

export interface MaterialLotTabQuery {
  plantId: number;
  supplierId: number;
  itemId: number;
  tab: MaterialLotTab;
  page?: number;
  size?: number;
}

/** 계약 `MaterialLotTabRow` — 발행 목록 LOT(`MaterialLotSummary`)에 탭 차례·만든 방식·P/O 라인·받은·폐기 시각을 더한다. */
export interface MaterialLotTabRowView extends MaterialLotSummaryView {
  seq: number;
  uomCode: string;
  creationModeCode: 'AUTO' | 'MANUAL';
  purchaseOrderLine: { purchaseOrderLineId: number; purchaseOrderNo: string; lineNo: number } | null;
  receivedAt: string | null;
  voidedAt: string | null;
}

export interface MaterialLotGeneration {
  status: MaterialLotDefaultsStatus | 'NO_OPEN_PO';
  createdNow: number;
  creatableRemaining: number;
}

const NUMBER_RETRY = 3;
const LABEL = 'MATERIAL_LOT_LABEL';

interface TabIdRow {
  lot_id: bigint;
  received_at: Date | null;
  voided_at: Date | null;
}

/** 오른쪽 탭 넷(피처 014 FR-014) — 「미출력」만 그 쪽까지 모자란 몫을 만들고(R-4) 나머지 탭은 읽기만 한다. */
@Injectable()
export class MaterialLotTabService {
  constructor(private readonly prisma: PrismaService) {}

  async lots(query: MaterialLotTabQuery, actor: MaterialLotBatchActor): Promise<{
    items: MaterialLotTabRowView[]; page: PageMeta; generation: MaterialLotGeneration | null;
  }> {
    const page = pageRequest(query);
    if (query.tab !== 'UNPRINTED') {
      const { rows, total } = await this.tabPage(this.prisma, query, page.skip, page.take);
      return { items: await this.rowViews(rows, page.skip), page: { page: page.page, size: page.size, total }, generation: null };
    }
    const businessDate = await this.plantToday(query.plantId);
    for (let attempt = 1; ; attempt += 1) {
      try {
        // 잠금을 먼저 잡고 미출력을 센다 — 동시에 고른 두 단말이 같은 자리를 두 번 채우지 않는다.
        const result = await this.prisma.$transaction(async (tx) => {
          await lockMaterialLotPlanWithin(tx, query);
          const existing = await this.tabPage(tx, query, 0, 0);
          const ensured = await ensureMaterialLotsWithin(tx, {
            ...query, upTo: page.page * page.size - existing.total, businessDate,
          }, actor);
          const { rows, total } = await this.tabPage(tx, query, page.skip, page.take);
          return { rows, total, ensured };
        }, { timeout: 20_000 });
        const total = result.total + result.ensured.creatableRemaining;
        const status = result.ensured.status === 'OK' && total === 0 ? 'NO_OPEN_PO' : result.ensured.status;
        return {
          items: await this.rowViews(result.rows, page.skip),
          page: { page: page.page, size: page.size, total },
          generation: { status, createdNow: result.ensured.createdLotIds.length, creatableRemaining: result.ensured.creatableRemaining },
        };
      } catch (error) {
        if (!isDuplicateLotNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ContractException(HttpStatus.CONFLICT, [
            { scope: 'screen', code: 'LOT_NO_CONFLICT', message: 'LOT 번호를 매기지 못했습니다. 다시 시도해 주세요.' },
          ]);
        }
      }
    }
  }

  async plantToday(plantId: number): Promise<string> {
    const plant = await this.prisma.plant.findUnique({ where: { plant_id: plantId }, select: { timezone_code: true } });
    return localToday(new Date(), plant?.timezone_code ?? 'Asia/Ho_Chi_Minh');
  }

  /** 탭 한 쪽의 LOT id 와 그 탭 전체 수. `take = 0` 이면 수만 센다. */
  async tabPage(db: Prisma.TransactionClient, query: MaterialLotTabQuery, skip: number, take: number): Promise<{ rows: TabIdRow[]; total: number }> {
    const combo = query.tab === 'RECEIVED'
      ? Prisma.sql`l.inbound_lot_id IN (SELECT inbound_lot_id FROM trace.inbound_lot
          WHERE plant_id = ${query.plantId} AND supplier_id = ${query.supplierId} AND item_id = ${query.itemId})`
      : Prisma.sql`l.source_type_code = ${MATERIAL_LOT_BATCH_SOURCE} AND l.source_id IN (SELECT material_lot_batch_id FROM trace.material_lot_batch
          WHERE plant_id = ${query.plantId} AND supplier_id = ${query.supplierId} AND item_id = ${query.itemId})`;
    const tab = {
      UNPRINTED: { where: Prisma.sql`t.lifecycle_status_code = 'WAITING' AND t.issued_at IS NULL`, order: Prisma.sql`t.lot_id` },
      PRINTED: { where: Prisma.sql`t.lifecycle_status_code = 'WAITING' AND t.issued_at IS NOT NULL`, order: Prisma.sql`t.issued_at DESC, t.lot_id DESC` },
      RECEIVED: { where: Prisma.sql`TRUE`, order: Prisma.sql`t.received_at DESC NULLS LAST, t.lot_id DESC` },
      VOIDED: { where: Prisma.sql`t.lifecycle_status_code = 'VOIDED'`, order: Prisma.sql`t.voided_at DESC NULLS LAST, t.lot_id DESC` },
    }[query.tab];
    const filtered = Prisma.sql`
      WITH t AS (
        SELECT l.lot_id, l.lifecycle_status_code,
               (SELECT max(d.issued_at) FROM app.document_issue_log d WHERE d.lot_id = l.lot_id AND d.document_type_code = ${LABEL}) AS issued_at,
               (SELECT max(h.changed_at) FROM trace.lot_lifecycle_history h WHERE h.lot_id = l.lot_id AND h.to_lifecycle_status_code = 'ACTIVE') AS received_at,
               (SELECT max(h.changed_at) FROM trace.lot_lifecycle_history h WHERE h.lot_id = l.lot_id AND h.to_lifecycle_status_code = 'VOIDED') AS voided_at
          FROM trace.lot l
         WHERE l.plant_id = ${query.plantId} AND l.item_id = ${query.itemId} AND l.lot_type_code = 'MATERIAL' AND ${combo})
      SELECT t.lot_id, t.received_at, t.voided_at FROM t WHERE ${tab.where}`;
    const [counted] = await db.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM (${filtered}) f`;
    const total = Number(counted.total);
    if (take === 0 || total <= skip) return { rows: [], total };
    const rows = await db.$queryRaw<TabIdRow[]>`${filtered} ORDER BY ${tab.order} LIMIT ${take} OFFSET ${skip}`;
    return { rows, total };
  }

  /** LOT 하나의 화면 행 — 번호 스캔 찾기가 쓴다. */
  async lotRow(lotId: bigint): Promise<MaterialLotTabRowView> {
    const rows = await this.prisma.$queryRaw<TabIdRow[]>`
      SELECT l.lot_id,
             (SELECT max(h.changed_at) FROM trace.lot_lifecycle_history h WHERE h.lot_id = l.lot_id AND h.to_lifecycle_status_code = 'ACTIVE') AS received_at,
             (SELECT max(h.changed_at) FROM trace.lot_lifecycle_history h WHERE h.lot_id = l.lot_id AND h.to_lifecycle_status_code = 'VOIDED') AS voided_at
        FROM trace.lot l WHERE l.lot_id = ${lotId}`;
    return (await this.rowViews(rows, 0))[0];
  }

  /** id 차례 그대로 화면 행으로 — 요약·만든 방식·P/O 라인을 모아 읽는다. */
  async rowViews(rows: TabIdRow[], skip: number): Promise<MaterialLotTabRowView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.lot_id);
    const [summaries, plans, units] = await Promise.all([
      loadMaterialLotSummaries(this.prisma, { lot_id: { in: ids } }),
      this.prisma.material_lot_po_plan.findMany({
        where: { lot_id: { in: ids } },
        select: { lot_id: true, purchase_order_line: { select: { purchase_order_line_id: true, line_no: true,
          purchase_order: { select: { purchase_order_no: true } } } } },
      }),
      this.prisma.lot.findMany({ where: { lot_id: { in: ids } }, select: { lot_id: true, uom: { select: { uom_code: true } } } }),
    ]);
    const summaryOf = new Map(summaries.map((summary) => [summary.lotId, summary]));
    const planOf = new Map(plans.map((plan) => [plan.lot_id, plan.purchase_order_line]));
    const uomOf = new Map(units.map((unit) => [unit.lot_id, unit.uom.uom_code]));
    return rows.map((row, index) => {
      const line = planOf.get(row.lot_id);
      return {
        ...(summaryOf.get(Number(row.lot_id)) as MaterialLotSummaryView),
        seq: skip + index + 1,
        uomCode: uomOf.get(row.lot_id) ?? '',
        creationModeCode: line === undefined ? 'MANUAL' : 'AUTO',
        purchaseOrderLine: line === undefined ? null : {
          purchaseOrderLineId: Number(line.purchase_order_line_id), purchaseOrderNo: line.purchase_order.purchase_order_no, lineNo: line.line_no,
        },
        receivedAt: row.received_at?.toISOString() ?? null,
        voidedAt: row.voided_at?.toISOString() ?? null,
      };
    });
  }
}
