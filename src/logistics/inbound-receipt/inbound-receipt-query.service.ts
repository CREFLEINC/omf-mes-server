import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InboundReceiptDetail,
  InboundReceiptLineView,
  InboundReceiptView,
  inboundReceiptLineView,
  inboundReceiptView,
} from './inbound-receipt-view';

export interface InboundReceiptQuery {
  receiptDateFrom?: string;
  receiptDateTo?: string;
  supplierId?: number;
  plantId?: number;
  statusCode?: string;
  labelIssued?: boolean;
  supplierLotMissing?: boolean;
  supplierLotLabelAttached?: boolean;
  q?: string;
  page?: number;
  size?: number;
}

export interface InboundReceiptLineQuery {
  supplierLotMissing?: boolean;
  supplierLotLabelAttached?: boolean;
  labelIssued?: boolean;
}

/** 라벨 발행 기록 — 라인의 LOT 에 이 문서유형이 찍혀 있는가(A-21 · I-3.md §2-6 주석 ⓑ). */
const LABEL_ISSUED: Prisma.inbound_receipt_lineWhereInput = {
  lot: {
    document_issue_log: { some: { document_type_code: 'MATERIAL_LOT_LABEL' } },
  },
};

/** 입하·차이 조회 4건. 화면은 `W-01-03`·`M-01-06`·`P-01-01` 이 소유한다(등록·수정은 다른 PR). */
@Injectable()
export class InboundReceiptQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InboundReceiptQuery): Promise<PagedResponse<InboundReceiptView>> {
    const page = pageRequest(query);
    // `supplierLotMissing`·`labelIssued` 는 둘 다 `inbound_receipt_line` 관계 필터라 스프레드로
    // 합치면 뒤가 앞을 덮는다 — AND 로 합친다(P/O `itemId`·`openOnly` 선례).
    const headerLineFilters = [
      query.supplierLotMissing === undefined
        ? {}
        : {
            inbound_receipt_line: {
              some: { supplier_lot_missing: query.supplierLotMissing },
            },
          },
      query.supplierLotLabelAttached === undefined
        ? {}
        : {
            inbound_receipt_line: {
              some: {
                supplier_lot_label_attached: query.supplierLotLabelAttached,
              },
            },
          },
      labelIssuedHeaderWhere(query.labelIssued),
    ].filter((clause) => Object.keys(clause).length > 0);
    const where: Prisma.inbound_receiptWhereInput = {
      ...filter('supplier_id', query.supplierId),
      ...filter('plant_id', query.plantId),
      // `statusCode` 는 값 목록 검사를 하지 않는다(계약 description — 값 목록은 조회 전용).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...receiptDateWhere(query.receiptDateFrom, query.receiptDateTo),
      ...(headerLineFilters.length === 0 ? {} : { AND: headerLineFilters }),
      // 「입하번호·거래명세서번호 검색」(계약) — 둘 다 본다.
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              {
                inbound_receipt_no: { contains: query.q, mode: 'insensitive' },
              },
              { delivery_note_no: { contains: query.q, mode: 'insensitive' } },
            ],
          }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.inbound_receipt.findMany({
        where,
        // 계약이 정렬을 안 적었다 — P/O 선례(최신 우선)를 따르고 tie-break 는 PK
        // (`ix_inbound_receipt_supplier_date` 의 방향과 같다).
        orderBy: [{ receipt_datetime: 'desc' }, { inbound_receipt_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inbound_receipt.count({ where }),
    ]);
    return pagedResponse(rows.map(inboundReceiptView), total, page);
  }

  /** 없으면 404 다(계약 선언). */
  async get(inboundReceiptId: number): Promise<{ detail: InboundReceiptDetail; versionNo: number }> {
    const row = await this.prisma.inbound_receipt.findUnique({
      where: { inbound_receipt_id: inboundReceiptId },
    });
    if (!row) throw new NotFoundException('없는 입하입니다.');
    return {
      detail: {
        inboundReceipt: inboundReceiptView(row),
        lines: await this.lines(inboundReceiptId),
      },
      versionNo: row.version_no,
    };
  }

  /** 없는 입하면 빈 배열이다 — 계약이 이 경로에 404 를 선언하지 않았다(P/O `lines()` 선례). */
  async lines(inboundReceiptId: number, query: InboundReceiptLineQuery = {}): Promise<InboundReceiptLineView[]> {
    // 두 필터는 AND 로 합친다 — 객체 스프레드는 뒤가 앞을 덮을 수 있어 배열로 모은다
    // (P/O `itemId`·`openOnly` 선례).
    const lineFilters = [
      query.supplierLotMissing === undefined ? {} : { supplier_lot_missing: query.supplierLotMissing },
      query.supplierLotLabelAttached === undefined
        ? {}
        : { supplier_lot_label_attached: query.supplierLotLabelAttached },
      labelIssuedLineWhere(query.labelIssued),
    ].filter((clause) => Object.keys(clause).length > 0);

    const rows = await this.prisma.inbound_receipt_line.findMany({
      where: {
        inbound_receipt_id: inboundReceiptId,
        ...(lineFilters.length === 0 ? {} : { AND: lineFilters }),
      },
      orderBy: { line_no: 'asc' },
    });
    return rows.map(inboundReceiptLineView);
  }
}

/** `receipt_datetime` 은 `timestamptz` 다 — 공장 없이 로컬 하루 경계를 못 푼다. UTC
 *  경계로 자른다(입고 `goods-receipt.service.ts:receiptDateWhere` 선례 · CLAUDE.md). */
function receiptDateWhere(from?: string, to?: string): Prisma.inbound_receiptWhereInput {
  if (from === undefined && to === undefined) return {};
  const start = from === undefined ? undefined : new Date(`${from}T00:00:00.000Z`);
  const end = to === undefined ? undefined : new Date(`${to}T00:00:00.000Z`);
  if (end) end.setUTCDate(end.getUTCDate() + 1);
  return {
    receipt_datetime: {
      ...(start === undefined ? {} : { gte: start }),
      ...(end === undefined ? {} : { lt: end }),
    },
  };
}

/** 헤더 목록의 `labelIssued` — true 는 그런 라인을 하나 이상 가진 건, false 는 그 부정
 *  (`lotId` 빈 라인만 있는 건도 포함한다 · I-3.md §2-6 주석 ⓑ). */
function labelIssuedHeaderWhere(value: boolean | undefined): Prisma.inbound_receiptWhereInput {
  if (value === undefined) return {};
  return value ? { inbound_receipt_line: { some: LABEL_ISSUED } } : { inbound_receipt_line: { none: LABEL_ISSUED } };
}

/** 라인 목록의 `labelIssued` — 라인 자신의 LOT 을 본다(헤더 축과 관계 깊이가 다르다). */
function labelIssuedLineWhere(value: boolean | undefined): Prisma.inbound_receipt_lineWhereInput {
  if (value === undefined) return {};
  return value ? LABEL_ISSUED : { NOT: LABEL_ISSUED };
}
