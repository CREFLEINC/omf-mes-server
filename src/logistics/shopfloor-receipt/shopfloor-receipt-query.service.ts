import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SHOPFLOOR_RECEIPT_INCLUDE,
  ShopfloorReceiptDetail,
  ShopfloorReceiptView,
  shopfloorReceiptView,
} from './shopfloor-receipt-view';

export interface ShopfloorReceiptQuery {
  workOrderId?: unknown;
  goodsIssueId?: unknown;
  statusCode?: string;
  page?: unknown;
  size?: unknown;
}

/**
 * 생산창고 입고 조회 2건. 소유 화면은 **`P-02-03`**(자재 투입 — «계획 대비 수령» 표가 목록
 * 라인을 재료로 쓴다) 다. `M-01-09`(스캔 화면)는 이 조회의 소비자가 아니다(I-9.md R-12).
 * ⛔ 지시·전표를 만들지 않는다 — 생성(`POST`)은 PR ② 몫이다.
 */
@Injectable()
export class ShopfloorReceiptQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ShopfloorReceiptQuery, terminalPlantId?: bigint): Promise<PagedResponse<ShopfloorReceiptView>> {
    const page = pageRequest({ page: number(query.page), size: number(query.size) });
    const where: Prisma.shopfloor_receiptWhereInput = {
      ...filter('work_order_id', numeric('workOrderId', query.workOrderId)),
      ...filter('goods_issue_id', numeric('goodsIssueId', query.goodsIssueId)),
      ...(terminalPlantId === undefined ? {} : { work_order: { production_line: { plant_id: terminalPlantId } } }),
      // 문자 그대로 건다 — 4값 대조를 걸면 값이 늘 때 목록이 400 을 낸다(피킹·출고 목록 선례).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
    };

    const [rows, total] = await Promise.all([
      // 계약 `ShopfloorReceipt.lines` description — 목록도 라인을 함께 싣는다(1+N 회피).
      // `include` 한 번으로 끝낸다 — `MAX_SIZE`(200) × 전 라인이라도 왕복은 하나다(I-9.md §4-2).
      this.prisma.shopfloor_receipt.findMany({
        where,
        orderBy: { shopfloor_receipt_id: 'desc' },
        skip: page.skip,
        take: page.take,
        include: SHOPFLOOR_RECEIPT_INCLUDE,
      }),
      this.prisma.shopfloor_receipt.count({ where }),
    ]);
    return pagedResponse(rows.map(shopfloorReceiptView), total, page);
  }

  /** 없으면 404(계약 선언). 라인은 두 벌 — 바깥과 `shopfloorReceipt.lines` 가 같은 배열(§4-3). */
  async get(shopfloorReceiptId: number): Promise<ShopfloorReceiptDetail> {
    const row = await this.prisma.shopfloor_receipt.findUnique({
      where: { shopfloor_receipt_id: shopfloorReceiptId },
      include: SHOPFLOOR_RECEIPT_INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 생산창고 입고입니다.');

    const view = shopfloorReceiptView(row);
    return { shopfloorReceipt: view, lines: view.lines };
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
