import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

export interface ReplenishmentRunQuery {
  plantId: unknown;
  productionWarehouseId?: unknown;
  runDateFrom?: string;
  runDateTo?: string;
  page?: unknown;
  size?: unknown;
}

const RUN_INCLUDE = {
  warehouse: { select: { warehouse_code: true, warehouse_name: true } },
  replenishment_run_line: {
    orderBy: { replenishment_run_line_id: 'asc' },
    include: { item: { select: { item_code: true, item_name: true } }, material_issue_request: { select: { issue_request_no: true } } },
  },
} satisfies Prisma.replenishment_runInclude;

/**
 * 자동 보충 실행 기록(W-02-12 진행 보기 · 피처 004 · US5-10). 보충 시점 이상 품목은 줄이 없고 머리의 검토 수로만 센다.
 * 실행 날짜는 공장 현지 날짜(`run_date`)로 거른다 — 문자열 날짜를 그대로 비교한다.
 */
@Injectable()
export class ReplenishmentRunService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ReplenishmentRunQuery): Promise<PagedResponse<unknown>> {
    const page = pageRequest({ page: num(query.page), size: num(query.size) });
    const warehouseId = num(query.productionWarehouseId);
    const where: Prisma.replenishment_runWhereInput = {
      warehouse: { plant_id: num(query.plantId) },
      ...(warehouseId === undefined ? {} : { warehouse_id: warehouseId }),
      ...(query.runDateFrom === undefined && query.runDateTo === undefined
        ? {}
        : {
            run_date: {
              ...(query.runDateFrom === undefined ? {} : { gte: new Date(`${query.runDateFrom}T00:00:00.000Z`) }),
              ...(query.runDateTo === undefined ? {} : { lte: new Date(`${query.runDateTo}T00:00:00.000Z`) }),
            },
          }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.replenishment_run.findMany({
        where,
        include: RUN_INCLUDE,
        orderBy: [{ run_date: 'desc' }, { warehouse: { warehouse_code: 'asc' } }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.replenishment_run.count({ where }),
    ]);
    return pagedResponse(
      rows.map((row) => ({
        replenishmentRunId: Number(row.replenishment_run_id),
        productionWarehouseId: Number(row.warehouse_id),
        productionWarehouseCode: row.warehouse.warehouse_code,
        productionWarehouseName: row.warehouse.warehouse_name,
        runDate: row.run_date.toISOString().slice(0, 10),
        status: row.status_code,
        startedAt: row.started_at.toISOString(),
        finishedAt: row.finished_at?.toISOString() ?? null,
        checkedItemCount: row.checked_item_count,
        createdRequestCount: row.created_request_count,
        errorText: row.error_text,
        lines: row.replenishment_run_line.map((line) => ({
          itemId: Number(line.item_id),
          itemCode: line.item.item_code,
          itemName: line.item.item_name,
          resultCode: line.result_code,
          usableQty: line.usable_qty.toNumber(),
          requestedQty: line.requested_qty.toNumber(),
          shortageQty: line.shortage_qty.toNumber(),
          issueRequestNo: line.material_issue_request?.issue_request_no ?? null,
        })),
      })),
      total,
      page,
    );
  }
}

function num(value: unknown): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
}
