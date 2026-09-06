import { Injectable } from '@nestjs/common';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { CancelEligibilityService } from './cancel-eligibility.service';
import { DOCUMENT_TYPES, DocumentTypeMapping, LogisticsDocumentType } from './document-type-registry';
import { DocumentProgress, DocumentProgressRow, documentProgressView } from './document-progress-view';

/** 계약 파라미터 11 전건 — `documentTypeCode` 만 필수. 나머지는 `@Contract` 가드가 coerce 해 둔다. */
export interface DocumentProgressQuery {
  documentTypeCode: LogisticsDocumentType;
  statusCode?: string;
  documentDateFrom?: string;
  documentDateTo?: string;
  itemId?: number;
  lotId?: number;
  warehouseId?: number;
  cancellableOnly?: boolean;
  q?: string;
  page?: number;
  size?: number;
}

type Row = Record<string, unknown>;

/** 유형별 delegate 를 명시적으로 부르는 자리 하나 — `$queryRawUnsafe`·`UNION ALL` 없이 정적 표로 고른다. */
interface ListableDelegate {
  findMany(args: Row): Promise<Row[]>;
  count(args: Row): Promise<number>;
}

/** `lot_id` 칸 자체가 없는 라인 표 — 있으면 lotId 필터를 그냥 넘길 때 Prisma 가 500 을 던진다. */
const LOT_LESS_LINES = new Set(['purchase_order_line', 'material_issue_request_line']);

/** 목록 1건 — PR ③a. 필터·정렬·페이징 + 유형별 한 형태로 맞추기(I-5.md §5). */
@Injectable()
export class DocumentProgressQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: CancelEligibilityService,
  ) {}

  async list(query: DocumentProgressQuery): Promise<PagedResponse<DocumentProgress>> {
    const typeCode = query.documentTypeCode;
    const mapping = DOCUMENT_TYPES[typeCode];
    const page = pageRequest({ page: query.page, size: query.size });

    // itemId·lotId 축이 없는 유형에 그 필터를 주면 400 이 아니라 결과 0 이다(계약이 유형별로
    // 필터를 안 갈랐다 · I-5.md §5-3).
    if (this.lineFilterImpossible(mapping, query.itemId, query.lotId)) {
      return pagedResponse([], 0, page);
    }

    const where = this.buildWhere(mapping, query);
    const delegate = this.delegateOf(mapping.delegate);
    const [rows, total] = await Promise.all([
      delegate.findMany({
        where,
        orderBy: this.orderBy(mapping),
        skip: page.skip,
        take: page.take,
        include: this.includeOf(mapping),
      }),
      delegate.count({ where }),
    ]);

    const eligibilities = await Promise.all(
      rows.map((row) => this.eligibility.evaluate(this.prisma, typeCode, this.idOf(mapping, row))),
    );
    let items = rows.map((row, i) => documentProgressView(typeCode, this.toRow(mapping, row), eligibilities[i]));

    // cancellableOnly 는 뒤에서 거른다 — 판정이 후속 조회를 품어 SQL 로 못 민다 ·
    // totalElements 는 거르기 전 수다(I-5.md §5-3).
    if (query.cancellableOnly === true) items = items.filter((item) => item.cancellable);

    return pagedResponse(items, total, page);
  }

  private delegateOf(name: string): ListableDelegate {
    return (this.prisma as unknown as Record<string, ListableDelegate>)[name];
  }

  private idOf(mapping: DocumentTypeMapping, row: Row): bigint {
    return row[mapping.idColumn] as bigint;
  }

  /** `derivedFrom`(`'goods_issue'|'goods_receipt'`)이 가리키는 그 유형의 매핑 — 짝 전표 판을 대신 읽는다. */
  private sourceOf(mapping: DocumentTypeMapping): DocumentTypeMapping {
    if (mapping.derivedFrom === null) return mapping;
    return mapping.derivedFrom === 'goods_issue' ? DOCUMENT_TYPES.GOODS_ISSUE : DOCUMENT_TYPES.GOODS_RECEIPT;
  }

  private includeOf(mapping: DocumentTypeMapping): Row {
    if (mapping.derivedFrom !== null) {
      const source = this.sourceOf(mapping);
      return { [source.delegate]: source.lineDelegate === null ? true : { include: { [source.lineDelegate]: true } } };
    }
    // 비파생 7종은 전부 lineDelegate 를 가진다(표 실측) — null 가지는 도달 불가(Prisma 가 include:{} 를 던진다).
    return { [mapping.lineDelegate as string]: true };
  }

  private orderBy(mapping: DocumentTypeMapping): Row[] {
    // 일자 칸이 없는 둘(MATERIAL_ISSUE_REQUEST·PICKING_ORDER)은 표에서 이미 `created_at` 이다.
    return [{ [mapping.dateColumn]: 'desc' }, { [mapping.idColumn]: 'desc' }];
  }

  /** 행 하나를 매퍼가 먹을 공통 모양으로 맞춘다. 외주 2종은 짝 전표(`derivedFrom`)에서 판다(§5-2). */
  private toRow(mapping: DocumentTypeMapping, row: Row): DocumentProgressRow {
    const source = this.sourceOf(mapping);
    const paired = mapping.derivedFrom === null ? row : (row[source.delegate] as Row);
    const lines = source.lineDelegate === null ? [] : (paired[source.lineDelegate] as Row[]);
    return {
      documentId: row[mapping.idColumn] as bigint,
      // 외주 2종은 noColumn 이 없다 — source(GOODS_ISSUE·GOODS_RECEIPT)는 언제나 있다.
      documentNo: paired[source.noColumn as string] as string,
      documentDate: row[mapping.dateColumn] as Date,
      documentSubTypeCode: mapping.subTypeColumn === null ? null : (row[mapping.subTypeColumn] as string | null),
      statusCode: row.status_code as string,
      plannedQty: source.plannedColumn === null ? null : this.sumNullable(lines, source.plannedColumn),
      processedQty: source.processedColumn === null ? 0 : this.sumOf(lines, source.processedColumn),
    };
  }

  /** 라인 합계. ⚠ SUM 이 NULL(전부 미기입)일 수 있어 `null` 을 구분한다 — R-7 ⓐ 가 먹는다. */
  private sumNullable(lines: Row[], column: string): number | null {
    const present = lines.filter((line) => line[column] !== null && line[column] !== undefined);
    return present.length === 0 ? null : this.sumOf(present, column);
  }

  private sumOf(lines: Row[], column: string): number {
    return lines.reduce((sum, line) => sum + Number(line[column]), 0);
  }

  private lineFilterImpossible(mapping: DocumentTypeMapping, itemId?: number, lotId?: number): boolean {
    if (mapping.lineDelegate === null) return itemId !== undefined || lotId !== undefined;
    return lotId !== undefined && LOT_LESS_LINES.has(mapping.lineDelegate);
  }

  /**
   * 외주 2종은 `noWhere`·`warehouseWhere` 가 «같은» 관계 키(`goods_issue`·`goods_receipt`)를
   * 낸다 — 객체 스프레드로 합치면 뒤가 앞을 조용히 덮는다(`q` 유실). `AND` 배열로 묶어 조각을
   * 살린다(빈 조각은 안 넣는다).
   */
  private buildWhere(mapping: DocumentTypeMapping, query: DocumentProgressQuery): Row {
    const clauses = [
      query.statusCode === undefined ? {} : { status_code: query.statusCode },
      this.dateWhere(mapping.dateColumn, query.documentDateFrom, query.documentDateTo),
      this.noWhere(mapping, query.q),
      this.lineWhere(mapping, query.itemId, query.lotId),
      this.warehouseWhere(mapping, query.warehouseId),
    ].filter((clause) => Object.keys(clause).length > 0);
    return clauses.length === 0 ? {} : { AND: clauses };
  }

  /**
   * `@db.Date` 하나(P/O)를 빼면 전부 `timestamptz` 다 — **UTC 경계**로 자른다(CLAUDE.md 타임존
   * 캐스팅 금지 · I-4 `issuedAtWhere` 선례). `From` 은 그날 00:00Z 부터, `To` 는 다음날 00:00Z 전.
   */
  private dateWhere(column: string, from?: string, to?: string): Row {
    if (from === undefined && to === undefined) return {};
    const start = from === undefined ? undefined : new Date(`${from}T00:00:00.000Z`);
    const end = to === undefined ? undefined : new Date(`${to}T00:00:00.000Z`);
    if (end) end.setUTCDate(end.getUTCDate() + 1);
    return { [column]: { ...(start === undefined ? {} : { gte: start }), ...(end === undefined ? {} : { lt: end }) } };
  }

  private noWhere(mapping: DocumentTypeMapping, q?: string): Row {
    if (q === undefined) return {};
    if (mapping.derivedFrom === null) return { [mapping.noColumn as string]: { contains: q, mode: 'insensitive' } };
    const source = this.sourceOf(mapping);
    return { [source.delegate]: { [source.noColumn as string]: { contains: q, mode: 'insensitive' } } };
  }

  private lineWhere(mapping: DocumentTypeMapping, itemId?: number, lotId?: number): Row {
    const some: Row = {};
    if (itemId !== undefined) some.item_id = itemId;
    if (lotId !== undefined) some.lot_id = lotId;
    if (Object.keys(some).length === 0) return {};
    // lineFilterImpossible 이 이미 걸렀다 — 여기 오면 lineDelegate 가 있고 lotId 도 안전하다.
    return { [mapping.lineDelegate as string]: { some } };
  }

  private warehouseWhere(mapping: DocumentTypeMapping, warehouseId?: number): Row {
    if (warehouseId === undefined) return {};
    // 그 축이 없는 유형(P/O·입하)은 결과 0 — 존재하지 않는 id 로 닫는다(itemId·lotId 와 같은 갈래).
    if (mapping.warehouseFilter === null) return { [mapping.idColumn]: { in: [] } };
    return mapping.warehouseFilter(warehouseId);
  }
}
