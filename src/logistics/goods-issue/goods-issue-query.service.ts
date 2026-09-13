import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GoodsIssueDetail,
  GoodsIssueLineView,
  GoodsIssueView,
  goodsIssueLineView,
  goodsIssueView,
} from './goods-issue-view';

export interface GoodsIssueQuery {
  issuedAtFrom?: string;
  issuedAtTo?: string;
  issueTypeCode?: string;
  sourceWarehouseId?: unknown;
  statusCode?: string;
  reasonCode?: string;
  supplierId?: unknown;
  goodsIssueLineId?: unknown;
  q?: string;
  page?: unknown;
  size?: unknown;
}

/** `supplierId` 짝 — 물리에 `supplier_id` 칸이 없다(I-4.md §1-2 · §8-3 ⓔ). 도착지를
 *  비운 자체 폐기는 이 필터로 안 잡힌다 — 사실이 그렇다. */
const SUPPLIER_DESTINATION_TYPES = ['PARTNER', 'DISPOSAL_SITE'];

/** 조회 3건. 화면은 `W-01-05`·`W-01-06`·`P-01-02` 가 소유한다(등록·전기·상신은 다른 PR). */
@Injectable()
export class GoodsIssueQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: GoodsIssueQuery, terminalPlantId?: bigint): Promise<PagedResponse<GoodsIssueView>> {
    // `page`·`size` 는 형제 목록과 같이 «자른다»(`pagination.ts`) — 400 은 식별자 축에만.
    const page = pageRequest({ page: number(query.page), size: number(query.size) });
    const sourceWarehouseId = numeric('sourceWarehouseId', query.sourceWarehouseId);
    const supplierId = numeric('supplierId', query.supplierId);
    const goodsIssueLineId = numeric('goodsIssueLineId', query.goodsIssueLineId);

    const where: Prisma.goods_issueWhereInput = {
      ...filter('source_warehouse_id', sourceWarehouseId),
      ...(terminalPlantId === undefined ? {} : { warehouse: { plant_id: terminalPlantId } }),
      ...(query.issueTypeCode === undefined ? {} : { issue_type_code: query.issueTypeCode }),
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...(query.reasonCode === undefined ? {} : { reason_code: query.reasonCode }),
      ...supplierWhere(supplierId),
      ...(goodsIssueLineId === undefined
        ? {}
        : { goods_issue_line: { some: { goods_issue_line_id: goodsIssueLineId } } }),
      // 「출고번호 검색」(계약) — goodsIssueLineId 축과 갈린다(라인 QR 은 이 축으로 안 풀린다).
      ...(query.q === undefined ? {} : { goods_issue_no: { contains: query.q, mode: 'insensitive' } }),
      ...issuedAtWhere(query.issuedAtFrom, query.issuedAtTo),
    };

    const [rows, total] = await Promise.all([
      this.prisma.goods_issue.findMany({
        where,
        // 계약 침묵 — 입고·P/O 선례(최신 우선 · tie-break 는 PK).
        orderBy: [{ issued_at: 'desc' }, { goods_issue_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.goods_issue.count({ where }),
    ]);
    return pagedResponse(rows.map(goodsIssueView), total, page);
  }

  /** 없으면 404 다(계약 선언). */
  async get(goodsIssueId: number): Promise<{ detail: GoodsIssueDetail; versionNo: number }> {
    const row = await this.prisma.goods_issue.findUnique({ where: { goods_issue_id: goodsIssueId } });
    if (!row) throw new NotFoundException('없는 출고입니다.');
    return {
      detail: { goodsIssue: goodsIssueView(row), lines: await this.linesOf(goodsIssueId) },
      versionNo: row.version_no,
    };
  }

  /** 계약 미선언이나 404 를 낸다(I-4.md §6-4 — I-2 R-1·I-3 과 같은 판정). */
  async lines(goodsIssueId: number): Promise<GoodsIssueLineView[]> {
    const exists = await this.prisma.goods_issue.findUnique({
      where: { goods_issue_id: goodsIssueId },
      select: { goods_issue_id: true },
    });
    if (!exists) throw new NotFoundException('없는 출고입니다.');
    return this.linesOf(goodsIssueId);
  }

  private async linesOf(goodsIssueId: number): Promise<GoodsIssueLineView[]> {
    const rows = await this.prisma.goods_issue_line.findMany({
      where: { goods_issue_id: goodsIssueId },
      orderBy: { line_no: 'asc' },
    });
    return rows.map(goodsIssueLineView);
  }
}

function supplierWhere(supplierId: number | undefined): Prisma.goods_issueWhereInput {
  if (supplierId === undefined) return {};
  return { destination_type_code: { in: SUPPLIER_DESTINATION_TYPES }, destination_id: supplierId };
}

/**
 * `issued_at` 은 `timestamptz` 다 — 공장 축 없이 로컬 하루 경계를 못 푼다. **UTC 경계**로
 * 자른다(입고 `receiptDateWhere` 선례 · CLAUDE.md 날짜 타임존 캐스팅 금지 · I-4.md §6-4).
 */
function issuedAtWhere(from?: string, to?: string): Prisma.goods_issueWhereInput {
  if (from === undefined && to === undefined) return {};
  const start = from === undefined ? undefined : new Date(`${from}T00:00:00.000Z`);
  const end = to === undefined ? undefined : new Date(`${to}T00:00:00.000Z`);
  if (end) end.setUTCDate(end.getUTCDate() + 1);
  return {
    issued_at: {
      ...(start === undefined ? {} : { gte: start }),
      ...(end === undefined ? {} : { lt: end }),
    },
  };
}

/** 숫자 축에 글자가 섞이면 400 이다 — 그냥 넘기면 Prisma 검증 오류가 500 으로 샌다
 *  (GR 목록 선례 · 계약은 400 미선언 · I-4.md R-9 ⓒ). */
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
