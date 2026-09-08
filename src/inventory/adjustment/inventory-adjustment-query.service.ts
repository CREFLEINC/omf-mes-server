import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InventoryAdjustmentDetail,
  InventoryAdjustmentLineView,
  InventoryAdjustmentView,
  inventoryAdjustmentLineView,
  inventoryAdjustmentView,
} from './inventory-adjustment-view';

export interface InventoryAdjustmentQuery {
  inventoryCountId?: unknown;
  statusCode?: string;
  reasonCode?: string;
  adjustedAtFrom?: string;
  adjustedAtTo?: string;
  page?: unknown;
  size?: unknown;
}

/** 조회 3건. 화면은 `W-01-12` 가 소유한다(등록·치환·상신·전기는 다른 PR). */
@Injectable()
export class InventoryAdjustmentQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InventoryAdjustmentQuery): Promise<PagedResponse<InventoryAdjustmentView>> {
    const page = pageRequest({ page: number(query.page), size: number(query.size) });
    const inventoryCountId = numeric('inventoryCountId', query.inventoryCountId);

    const where: Prisma.inventory_adjustmentWhereInput = {
      ...filter('inventory_count_id', inventoryCountId),
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      // 헤더 사유만 본다 — 라인 사유로는 안 번진다(I-14.md §1-2).
      ...(query.reasonCode === undefined ? {} : { reason_code: query.reasonCode }),
      ...adjustedAtWhere(query.adjustedAtFrom, query.adjustedAtTo),
    };

    const [rows, total] = await Promise.all([
      this.prisma.inventory_adjustment.findMany({
        where,
        // 계약 침묵 — `adjusted_at` 은 미전기 전표가 NULL 이라 정렬축으로 못 쓴다(I-14.md §1-2).
        orderBy: [{ created_at: 'desc' }, { inventory_adjustment_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inventory_adjustment.count({ where }),
    ]);
    return pagedResponse(rows.map(inventoryAdjustmentView), total, page);
  }

  /** 없으면 404 다(계약 선언). */
  async get(
    inventoryAdjustmentId: number,
  ): Promise<{ detail: InventoryAdjustmentDetail; versionNo: number }> {
    const row = await this.prisma.inventory_adjustment.findUnique({
      where: { inventory_adjustment_id: inventoryAdjustmentId },
    });
    if (!row) throw new NotFoundException('없는 재고 조정입니다.');
    return {
      detail: {
        inventoryAdjustment: inventoryAdjustmentView(row),
        lines: await this.linesOf(inventoryAdjustmentId),
      },
      versionNo: row.version_no,
    };
  }

  /** 계약 미선언이나 404 를 낸다(I-4.md §6-4 — I-2 R-1·I-3 과 같은 판정). */
  async lines(inventoryAdjustmentId: number): Promise<InventoryAdjustmentLineView[]> {
    const exists = await this.prisma.inventory_adjustment.findUnique({
      where: { inventory_adjustment_id: inventoryAdjustmentId },
      select: { inventory_adjustment_id: true },
    });
    if (!exists) throw new NotFoundException('없는 재고 조정입니다.');
    return this.linesOf(inventoryAdjustmentId);
  }

  private async linesOf(inventoryAdjustmentId: number): Promise<InventoryAdjustmentLineView[]> {
    const rows = await this.prisma.inventory_adjustment_line.findMany({
      where: { inventory_adjustment_id: inventoryAdjustmentId },
      orderBy: { line_no: 'asc' },
    });
    return rows.map(inventoryAdjustmentLineView);
  }
}

/**
 * `adjusted_at` 은 `timestamptz` 다 — 조정 헤더에 공장 축이 없어 로컬 하루 경계를 못 푼다.
 * **UTC 경계**로 자른다(출고 `issuedAtWhere` 복제 · CLAUDE.md 날짜 타임존 캐스팅 금지).
 */
function adjustedAtWhere(from?: string, to?: string): Prisma.inventory_adjustmentWhereInput {
  if (from === undefined && to === undefined) return {};
  const start = from === undefined ? undefined : new Date(`${from}T00:00:00.000Z`);
  const end = to === undefined ? undefined : new Date(`${to}T00:00:00.000Z`);
  if (end) end.setUTCDate(end.getUTCDate() + 1);
  return {
    adjusted_at: {
      ...(start === undefined ? {} : { gte: start }),
      ...(end === undefined ? {} : { lt: end }),
    },
  };
}

/** 숫자 축에 글자가 섞이면 400 이다 — 그냥 넘기면 Prisma 검증 오류가 500 으로 샌다
 *  (출고 목록 선례 · 계약은 400 미선언 · I-4.md R-9 ⓒ). */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}

function number(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
