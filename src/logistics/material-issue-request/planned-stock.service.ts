import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { availableQty, distributeShortage, pairKey, plannedLines } from '../../core/material-issue/planned-stock';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';

export interface PlannedStockQuery {
  plantId: unknown;
  sourceWarehouseId?: unknown;
  itemId?: unknown;
  onlyShortage?: unknown;
}

const ZERO = new Prisma.Decimal(0);
const CLOSED_WORK_ORDER = ['CANCELLED', 'CLOSED'];

/**
 * 생산 창고 출고 예정 재고와 부족(FR-015·016 · W-02-11 부족 탭 · W-02-10 보충 요청). 행 = (출발 창고, 품목).
 * 부족 = 만들 때 줄인 양(줄 shortage_qty) + 지금 예정이 가용을 넘은 양(동적 — 늦은 출고 작업일부터 배분).
 */
@Injectable()
export class PlannedStockService {
  constructor(private readonly prisma: PrismaService) {}

  async query(query: PlannedStockQuery): Promise<{ items: unknown[]; unsourced?: unknown[] }> {
    const plantId = BigInt(Number(query.plantId));
    const warehouseId = query.sourceWarehouseId === undefined ? undefined : BigInt(Number(query.sourceWarehouseId));
    const itemId = query.itemId === undefined ? undefined : BigInt(Number(query.itemId));
    const onlyShortage = query.onlyShortage === true || query.onlyShortage === 'true';

    const lines = await plannedLines(this.prisma, {
      plantId,
      ...(warehouseId === undefined ? {} : { warehouseIds: [warehouseId] }),
      ...(itemId === undefined ? {} : { itemIds: [itemId] }),
    });
    const lineIds = lines.map((line) => line.requestLineId);
    const [available, stored, requests, warehouses, items] = await Promise.all([
      availableQty(this.prisma, [...new Set(lines.map((l) => l.warehouseId))], [...new Set(lines.map((l) => l.itemId))]),
      this.prisma.material_issue_request_line.findMany({
        where: { material_issue_request_line_id: { in: lineIds } },
        select: { material_issue_request_line_id: true, shortage_qty: true },
      }),
      this.prisma.material_issue_request.findMany({
        where: { material_issue_request_id: { in: [...new Set(lines.map((l) => l.requestId))] } },
        select: { material_issue_request_id: true, issue_request_no: true, work_order_id: true, work_order: { select: { work_order_no: true } } },
      }),
      this.prisma.warehouse.findMany({ where: { warehouse_id: { in: [...new Set(lines.map((l) => l.warehouseId))] } }, select: { warehouse_id: true, warehouse_name: true } }),
      this.prisma.item.findMany({ where: { item_id: { in: [...new Set(lines.map((l) => l.itemId))] } }, select: { item_id: true, item_code: true, item_name: true } }),
    ]);
    const storedOf = new Map(stored.map((row) => [row.material_issue_request_line_id, row.shortage_qty]));
    const requestOf = new Map(requests.map((row) => [row.material_issue_request_id, row]));
    const warehouseName = new Map(warehouses.map((row) => [row.warehouse_id, row.warehouse_name]));
    const itemOf = new Map(items.map((row) => [row.item_id, row]));

    const pairs = new Map<string, typeof lines>();
    for (const line of lines) pairs.set(pairKey(line.warehouseId, line.itemId), [...(pairs.get(pairKey(line.warehouseId, line.itemId)) ?? []), line]);
    const rows = [...pairs.entries()].map(([key, pairLines]) => {
      const planned = pairLines.reduce((sum, l) => sum.plus(l.plannedQty), ZERO);
      const avail = available.get(key) ?? ZERO;
      const excess = Prisma.Decimal.max(planned.minus(avail), ZERO);
      const dynamic = new Map(distributeShortage(excess, pairLines).map((s) => [s.requestLineId, s.shortageQty]));
      const byRequest = new Map<bigint, { planned: Prisma.Decimal; shortage: Prisma.Decimal; issueWorkDate: Date | null }>();
      for (const line of pairLines) {
        const cur = byRequest.get(line.requestId) ?? { planned: ZERO, shortage: ZERO, issueWorkDate: line.issueWorkDate };
        byRequest.set(line.requestId, {
          planned: cur.planned.plus(line.plannedQty),
          shortage: cur.shortage.plus(dynamic.get(line.requestLineId) ?? ZERO).plus(storedOf.get(line.requestLineId) ?? ZERO),
          issueWorkDate: line.issueWorkDate,
        });
      }
      const shortage = [...byRequest.values()].reduce((sum, r) => sum.plus(r.shortage), ZERO);
      const item = itemOf.get(pairLines[0].itemId);
      return {
        sourceWarehouseId: Number(pairLines[0].warehouseId),
        sourceWarehouseName: warehouseName.get(pairLines[0].warehouseId) ?? '',
        itemId: Number(pairLines[0].itemId),
        itemCode: item?.item_code ?? '',
        itemName: item?.item_name ?? '',
        availableQty: avail.toNumber(),
        plannedQty: planned.toNumber(),
        freeQty: Prisma.Decimal.max(avail.minus(planned), ZERO).toNumber(),
        shortageQty: shortage.toNumber(),
        requests: [...byRequest.entries()]
          .sort(([, a], [, b]) => (b.issueWorkDate?.getTime() ?? 0) - (a.issueWorkDate?.getTime() ?? 0))
          .map(([requestId, r]) => {
            const request = requestOf.get(requestId);
            return {
              materialIssueRequestId: Number(requestId),
              issueRequestNo: request?.issue_request_no ?? '',
              workOrderId: Number(request?.work_order_id ?? 0),
              workOrderNo: request?.work_order.work_order_no ?? '',
              issueWorkDate: r.issueWorkDate?.toISOString().slice(0, 10) ?? null,
              plannedQty: r.planned.toNumber(),
              shortageQty: r.shortage.toNumber(),
            };
          }),
      };
    });
    const filtered = rows
      .filter((row) => !onlyShortage || row.shortageQty > 0)
      .sort((a, b) => a.sourceWarehouseId - b.sourceWarehouseId || a.itemCode.localeCompare(b.itemCode));
    return onlyShortage ? { items: filtered, unsourced: await this.unsourced(plantId, itemId) } : { items: filtered };
  }

  /** 「재고 있는 생산 창고 없음」 — W/O 가 취소·마감이 아닌 것만(FR-007a). */
  private async unsourced(plantId: bigint, itemId: bigint | undefined): Promise<unknown[]> {
    const rows = await this.prisma.material_issue_unsourced_shortage.findMany({
      where: {
        ...(itemId === undefined ? {} : { item_id: itemId }),
        work_order: { status_code: { notIn: CLOSED_WORK_ORDER }, production_plan: { production_order: { plant_id: plantId } } },
      },
      include: {
        item: { select: { item_code: true, item_name: true } },
        uom: { select: { uom_code: true } },
        resolved_request: { select: { issue_request_no: true } },
        work_order: {
          select: {
            work_order_no: true,
            planned_start_at: true,
            production_plan: { select: { production_order: { select: { plant: { select: { timezone_code: true } } } } } },
          },
        },
      },
      orderBy: { material_issue_unsourced_shortage_id: 'asc' },
    });
    return rows.map((row) => {
      const timezone = row.work_order.production_plan?.production_order.plant.timezone_code;
      return {
        unsourcedShortageId: Number(row.material_issue_unsourced_shortage_id),
        workOrderId: Number(row.work_order_id),
        workOrderNo: row.work_order.work_order_no,
        productionDate: row.work_order.planned_start_at === null || timezone === undefined ? null : localDate(row.work_order.planned_start_at, timezone),
        itemId: Number(row.item_id),
        itemCode: row.item.item_code,
        itemName: row.item.item_name,
        shortageQty: row.shortage_qty.toNumber(),
        uomCode: row.uom.uom_code,
        resolvedRequestId: row.resolved_request_id === null ? null : Number(row.resolved_request_id),
        resolvedRequestNo: row.resolved_request?.issue_request_no ?? null,
      };
    });
  }
}
