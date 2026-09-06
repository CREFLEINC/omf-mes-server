import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PICKING_LINE_INCLUDE,
  PickingOrderDetail,
  PickingOrderView,
  pickSequenceRanks,
  pickingLineView,
  pickingOrderView,
} from './picking-view';

export interface PickingOrderQuery {
  assignedWorkerId?: unknown;
  warehouseId?: unknown;
  statusCode?: string;
  sourceDocumentId?: unknown;
  page?: unknown;
  size?: unknown;
}

/**
 * 피킹 지시 조회 2건. 화면은 `M-01-08`(자재 출고 피킹)이 소유한다.
 * ⛔ 지시·라인을 **만들지 않는다** — 계약에 생성 오퍼레이션이 0건이다(I-8.md §5 · 문의 045).
 */
@Injectable()
export class PickingQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PickingOrderQuery): Promise<PagedResponse<PickingOrderView>> {
    const page = pageRequest({ page: number(query.page), size: number(query.size) });
    const where: Prisma.picking_orderWhereInput = {
      ...filter('assigned_worker_id', numeric('assignedWorkerId', query.assignedWorkerId)),
      ...filter('warehouse_id', numeric('warehouseId', query.warehouseId)),
      // 문자 그대로 건다 — 4값 대조를 걸면 값이 늘 때 목록이 400 을 낸다(출고 목록 선례).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      // ⚠ `sourceDocumentTypeCode` 질의가 계약에 없어 자재 피킹과 제품 피킹이 섞인다 — 계약대로 둔다.
      ...filter('source_document_id', numeric('sourceDocumentId', query.sourceDocumentId)),
    };

    const [rows, total] = await Promise.all([
      // 계약 침묵 — PK 역순이라 페이지 경계가 안정하다(I-8.md §8-1).
      this.prisma.picking_order.findMany({
        where,
        orderBy: { picking_order_id: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.picking_order.count({ where }),
    ]);
    return pagedResponse(rows.map(pickingOrderView), total, page);
  }

  /** 없으면 404 다(계약 선언). 라인은 **`line_no asc`** — 순위 정렬은 널 라인이 섞여 흔들린다(R-21). */
  async get(pickingOrderId: number): Promise<PickingOrderDetail> {
    const order = await this.prisma.picking_order.findUnique({
      where: { picking_order_id: pickingOrderId },
    });
    if (!order) throw new NotFoundException('없는 피킹 지시입니다.');

    const lines = await this.prisma.picking_line.findMany({
      where: { picking_order_id: pickingOrderId },
      orderBy: { line_no: 'asc' },
      include: PICKING_LINE_INCLUDE,
    });
    const holds = await this.holdsOf(lines.map((line) => line.lot_id));
    const ranks = pickSequenceRanks(lines);

    return {
      pickingOrder: pickingOrderView(order),
      lines: lines.map((line) =>
        pickingLineView(line, holds.get(line.lot_id) ?? null, ranks.get(line.picking_line_id) ?? null),
      ),
    };
  }

  /** LOT id 집합으로 **한 번** 판다 — 라인마다 돌면 지시 하나에 질의가 N 개 난다(I-4.md R-7 모양). */
  private async holdsOf(lotIds: bigint[]): Promise<Map<bigint, string>> {
    if (lotIds.length === 0) return new Map();
    const rows = await this.prisma.lot_hold.findMany({
      where: { lot_id: { in: lotIds }, released_at: null },
      orderBy: { held_at: 'desc' },
      select: { lot_id: true, reason_code: true },
    });
    const latest = new Map<bigint, string>();
    for (const row of rows) if (!latest.has(row.lot_id)) latest.set(row.lot_id, row.reason_code);
    return latest;
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다(출고 목록 선례). */
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
