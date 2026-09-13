import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  StockTransferLineView,
  StockTransferView,
  stockTransferLineView,
  stockTransferView,
} from './stock-transfer-view';

export interface StockTransferQuery {
  inTransitOnly?: unknown;
  fromWarehouseId?: unknown;
  toWarehouseId?: unknown;
  transferTypeCode?: string;
  statusCode?: string;
  requestedAtFrom?: string;
  requestedAtTo?: string;
  page?: unknown;
  size?: unknown;
}

/** 조회 3건. 화면은 `M-01-10` 이 소유한다(등록·도착·라인 치환은 다른 PR). */
@Injectable()
export class StockTransferQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: StockTransferQuery, terminalPlantId?: bigint): Promise<PagedResponse<StockTransferView>> {
    // `page`·`size` 는 형제 목록과 같이 «자른다»(`pagination.ts`) — 400 은 식별자 축에만.
    const page = pageRequest({ page: number(query.page), size: number(query.size) });
    const fromWarehouseId = numeric('fromWarehouseId', query.fromWarehouseId);
    const toWarehouseId = numeric('toWarehouseId', query.toWarehouseId);

    const where: Prisma.stock_transferWhereInput = {
      ...filter('from_warehouse_id', fromWarehouseId),
      ...filter('to_warehouse_id', toWarehouseId),
      ...(terminalPlantId === undefined ? {} : {
        warehouse_stock_transfer_from_warehouse_idTowarehouse: { plant_id: terminalPlantId },
        warehouse_stock_transfer_to_warehouse_idTowarehouse: { plant_id: terminalPlantId },
      }),
      ...(query.transferTypeCode === undefined ? {} : { transfer_type_code: query.transferTypeCode }),
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      // ⭐ 「반출됐으나 도착하지 않은 건만」 — M-01-10 §5-4 의 「미완 이동」 목록이다.
      ...(boolean(query.inTransitOnly) ? { shipped_at: { not: null }, received_at: null } : {}),
      ...requestedAtWhere(query.requestedAtFrom, query.requestedAtTo),
    };

    const [rows, total] = await Promise.all([
      this.prisma.stock_transfer.findMany({
        where,
        // 계약 침묵 — 형제 목록 선례(최신 우선 · tie-break 는 PK).
        orderBy: [{ requested_at: 'desc' }, { stock_transfer_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.stock_transfer.count({ where }),
    ]);
    return pagedResponse(rows.map(stockTransferView), total, page);
  }

  /** 계약 선언 — 없으면 404 다. */
  async get(
    stockTransferId: number,
  ): Promise<{ stockTransfer: StockTransferView; lines: StockTransferLineView[]; versionNo: number }> {
    const row = await this.prisma.stock_transfer.findUnique({
      where: { stock_transfer_id: stockTransferId },
    });
    if (!row) throw new NotFoundException('없는 재고 이동입니다.');
    return {
      stockTransfer: stockTransferView(row),
      lines: await this.linesOf(stockTransferId),
      versionNo: row.version_no,
    };
  }

  /** 계약 미선언이나 404 를 낸다(형제 출고 선례 · I-13.md §7-3). */
  async lines(stockTransferId: number): Promise<StockTransferLineView[]> {
    const exists = await this.prisma.stock_transfer.findUnique({
      where: { stock_transfer_id: stockTransferId },
      select: { stock_transfer_id: true },
    });
    if (!exists) throw new NotFoundException('없는 재고 이동입니다.');
    return this.linesOf(stockTransferId);
  }

  private async linesOf(stockTransferId: number): Promise<StockTransferLineView[]> {
    const rows = await this.prisma.stock_transfer_line.findMany({
      where: { stock_transfer_id: stockTransferId },
      orderBy: { line_no: 'asc' },
    });
    return rows.map(stockTransferLineView);
  }
}

/**
 * `requested_at` 은 `timestamptz` 다 — 공장 축 없이 로컬 하루 경계를 못 푼다. **UTC 경계**로
 * 자른다(형제 목록 `issuedAtWhere` 선례 · CLAUDE.md 날짜 타임존 캐스팅 금지 · I-13.md §7-1).
 */
function requestedAtWhere(from?: string, to?: string): Prisma.stock_transferWhereInput {
  if (from === undefined && to === undefined) return {};
  const start = from === undefined ? undefined : new Date(`${from}T00:00:00.000Z`);
  const end = to === undefined ? undefined : new Date(`${to}T00:00:00.000Z`);
  if (end) end.setUTCDate(end.getUTCDate() + 1);
  return {
    requested_at: {
      ...(start === undefined ? {} : { gte: start }),
      ...(end === undefined ? {} : { lt: end }),
    },
  };
}

/** 숫자 축에 글자가 섞이면 400 이다 — 그냥 넘기면 Prisma 검증 오류가 500 으로 샌다
 *  (형제 목록 선례). */
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

function boolean(value: unknown): boolean {
  return value === true || value === 'true';
}
