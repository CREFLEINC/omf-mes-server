import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { GOODS_ISSUE_SPLIT_SOURCE, SPLIT_RELATION, inboundLineLotSql } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';

const LABEL = 'MATERIAL_LOT_LABEL';
const FAILED = 'FAILED';
/** 「찍음」 목록의 기본 폭 — 미발행은 기간을 보지 않는다(FR-008 · SC-004). */
const PRINTED_DEFAULT_DAYS = 7;
const LABEL_STATES = ['UNPRINTED', 'PRINTED'] as const;
type LabelState = (typeof LABEL_STATES)[number];

export interface SplitMaterialLotQuery {
  plantId: number;
  labelState?: string;
  issuedFrom?: string;
  issuedTo?: string;
  page?: number;
  size?: number;
}

interface Named { id: number; code: string; name: string }

export interface SplitMaterialLotView {
  lotId: number;
  lotNo: string;
  statusCode: string;
  lifecycleStatusCode: string | null;
  item: { itemId: number; itemCode: string; itemName: string };
  uomId: number;
  uomCode: string;
  qty: number;
  supplier: { supplierId: number; supplierCode: string; supplierName: string } | null;
  parentLot: { lotId: number; lotNo: string };
  splitAt: string;
  goodsIssue: { goodsIssueId: number; goodsIssueNo: string; goodsIssueLineId: number; lineNo: number };
  destination: { warehouseCode: string; locationCode: string } | null;
  labelIssue: { issueCount: number; lastIssueSeq: number; lastPrintOutcomeCode: string | null; lastIssuedAt: string } | null;
}

export type SplitMaterialLotList = PagedResponse<SplitMaterialLotView> & { unprintedCount: number };

interface Row {
  lot_id: bigint; lot_no: string; status_code: string; lifecycle_status_code: string | null;
  item_id: bigint; item_code: string; item_name: string; uom_id: bigint; uom_code: string; initial_qty: Prisma.Decimal;
  parent_lot_id: bigint; parent_lot_no: string; split_at: Date;
  goods_issue_id: bigint; goods_issue_no: string; goods_issue_line_id: bigint; line_no: number;
  warehouse_code: string | null; location_code: string | null;
  issue_count: bigint | null; last_issue_seq: number | null; last_outcome: string | null; last_issued_at: Date | null;
}

/**
 * 분할 LOT 라벨 목록(POP P-01-02 · 피처 008 R-8). 부분 출고가 만든 분할 LOT(원천 `GOODS_ISSUE_SPLIT`)과 그 자재 LOT
 * 라벨 발행 요약을 낸다. 미발행 = 자재 LOT 라벨 발행 기록이 없거나 마지막 인쇄 결과가 실패. 인쇄 대기(PENDING)는
 * 찍은 것으로 본다(출고 QR 화면과 같은 규칙).
 */
@Injectable()
export class SplitMaterialLotQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: SplitMaterialLotQuery, now = new Date()): Promise<SplitMaterialLotList> {
    const page = pageRequest({ page: query.page, size: query.size });
    const state = labelState(query.labelState);
    const unprinted = Prisma.sql`(x.issue_count IS NULL OR x.last_outcome = ${FAILED})`;
    const where = state === 'UNPRINTED'
      ? unprinted
      : Prisma.sql`NOT ${unprinted} AND ${issuedWindow(query.issuedFrom, query.issuedTo, now)}`;
    const base = Prisma.sql`
      SELECT l.lot_id, l.lot_no, l.status_code, l.lifecycle_status_code, i.item_id, i.item_code, i.item_name,
             u.uom_id, u.uom_code, l.initial_qty, p.lot_id AS parent_lot_id, p.lot_no AS parent_lot_no,
             COALESCE(r.occurred_at, l.created_at) AS split_at,
             gi.goods_issue_id, gi.goods_issue_no, gil.goods_issue_line_id, gil.line_no, gi.issued_at,
             w.warehouse_code, loc.location_code,
             x.issue_count, x.last_issue_seq, x.last_outcome, x.last_issued_at
        FROM trace.lot l
        JOIN mdm.item i ON i.item_id = l.item_id
        JOIN mdm.uom u ON u.uom_id = l.uom_id
        JOIN trace.lot p ON p.lot_id = l.parent_lot_id
        JOIN logistics.goods_issue_line gil ON gil.goods_issue_line_id = l.source_id
        JOIN logistics.goods_issue gi ON gi.goods_issue_id = gil.goods_issue_id
        LEFT JOIN mdm.location loc ON gi.destination_type_code = 'LOCATION' AND loc.location_id = gi.destination_id
        LEFT JOIN mdm.warehouse w ON w.warehouse_id = loc.warehouse_id
        LEFT JOIN LATERAL (
          SELECT r.occurred_at FROM trace.lot_relation r
           WHERE r.target_lot_id = l.lot_id AND r.relation_type_code = ${SPLIT_RELATION} LIMIT 1
        ) r ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) OVER () AS issue_count, d.issue_seq AS last_issue_seq,
                 d.print_outcome_code AS last_outcome, d.issued_at AS last_issued_at
            FROM app.document_issue_log d
           WHERE d.target_type_code = 'LOT' AND d.target_id = l.lot_id AND d.document_type_code = ${LABEL}
           ORDER BY d.issued_at DESC, d.document_issue_log_id DESC LIMIT 1
        ) x ON true
       WHERE l.source_type_code = ${GOODS_ISSUE_SPLIT_SOURCE} AND l.plant_id = ${BigInt(query.plantId)}`;
    const order = state === 'UNPRINTED' ? Prisma.sql`split_at ASC, lot_id ASC` : Prisma.sql`split_at DESC, lot_id DESC`;
    const [rows, [counts]] = await Promise.all([
      this.prisma.$queryRaw<Row[]>`
        SELECT * FROM (${base}) x WHERE ${where} ORDER BY ${order} LIMIT ${page.take} OFFSET ${page.skip}`,
      this.prisma.$queryRaw<{ total: bigint; unprinted: bigint }[]>`
        SELECT COUNT(*) FILTER (WHERE ${where}) AS total, COUNT(*) FILTER (WHERE ${unprinted}) AS unprinted
          FROM (${base}) x`,
    ]);
    const suppliers = await this.suppliersOf(rows.map((row) => row.lot_id));
    return {
      ...pagedResponse(rows.map((row) => view(row, suppliers.get(row.lot_id) ?? null)), Number(counts.total), page),
      unprintedCount: Number(counts.unprinted),
    };
  }

  /**
   * 공급사는 원조 LOT 의 입하에서 — 분할 LOT 은 입하 LOT 칸이 비어 있다(FR-003). 원조의 입하 LOT 이 있으면 그 공급사,
   * 없으면(옛 입하) 원조를 등록한 입하 줄의 공급사다.
   */
  private async suppliersOf(lotIds: bigint[]): Promise<Map<bigint, Named>> {
    if (lotIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ lot_id: bigint; partner_id: bigint; partner_code: string; partner_name: string }[]>`
      WITH RECURSIVE up(lot_id, ancestor_id) AS (
        SELECT l.lot_id, l.lot_id FROM trace.lot l WHERE l.lot_id = ANY(${lotIds}::bigint[])
        UNION
        SELECT up.lot_id, a.parent_lot_id FROM up JOIN trace.lot a ON a.lot_id = up.ancestor_id WHERE a.parent_lot_id IS NOT NULL
      )
      SELECT DISTINCT ON (up.lot_id) up.lot_id, sp.partner_id, sp.partner_code, sp.partner_name
        FROM up
        JOIN trace.lot rt ON rt.lot_id = up.ancestor_id AND rt.parent_lot_id IS NULL
        LEFT JOIN trace.inbound_lot il ON il.inbound_lot_id = rt.inbound_lot_id
        LEFT JOIN LATERAL (
          SELECT ir.supplier_id FROM logistics.inbound_receipt_line irl
            JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
           WHERE ${Prisma.raw(inboundLineLotSql('rt', 'irl'))}
           ORDER BY ir.receipt_datetime, irl.inbound_receipt_line_id LIMIT 1
        ) ir ON true
        JOIN mdm.partner sp ON sp.partner_id = COALESCE(il.supplier_id, ir.supplier_id)
       ORDER BY up.lot_id`;
    return new Map(rows.map((row) => [row.lot_id, { id: Number(row.partner_id), code: row.partner_code, name: row.partner_name }]));
  }
}

function view(row: Row, supplier: Named | null): SplitMaterialLotView {
  return {
    lotId: Number(row.lot_id),
    lotNo: row.lot_no,
    statusCode: row.status_code,
    lifecycleStatusCode: row.lifecycle_status_code,
    item: { itemId: Number(row.item_id), itemCode: row.item_code, itemName: row.item_name },
    uomId: Number(row.uom_id),
    uomCode: row.uom_code,
    qty: Number(row.initial_qty),
    supplier: supplier === null ? null : { supplierId: supplier.id, supplierCode: supplier.code, supplierName: supplier.name },
    parentLot: { lotId: Number(row.parent_lot_id), lotNo: row.parent_lot_no },
    splitAt: row.split_at.toISOString(),
    goodsIssue: {
      goodsIssueId: Number(row.goods_issue_id), goodsIssueNo: row.goods_issue_no,
      goodsIssueLineId: Number(row.goods_issue_line_id), lineNo: row.line_no,
    },
    destination: row.warehouse_code === null || row.location_code === null
      ? null : { warehouseCode: row.warehouse_code, locationCode: row.location_code },
    labelIssue: row.issue_count === null || row.last_issued_at === null ? null : {
      issueCount: Number(row.issue_count),
      lastIssueSeq: row.last_issue_seq ?? 0,
      lastPrintOutcomeCode: row.last_outcome,
      lastIssuedAt: row.last_issued_at.toISOString(),
    },
  };
}

function labelState(value: string | undefined): LabelState {
  if (value === undefined) return 'UNPRINTED';
  if ((LABEL_STATES as readonly string[]).includes(value)) return value as LabelState;
  throw new ContractException(HttpStatus.BAD_REQUEST, [field('labelState', ERROR_CODE.INVALID, 'UNPRINTED·PRINTED 중 하나입니다.')]);
}

/** 「찍음」의 출고일 폭 — UTC 하루 경계(출고 목록 `issuedAtWhere` 와 같다). 기본은 오늘까지 최근 7일이다. */
function issuedWindow(from: string | undefined, to: string | undefined, now: Date): Prisma.Sql {
  const end = to === undefined ? startOfUtcDay(now) : new Date(`${to}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = from === undefined ? new Date(end.getTime() - PRINTED_DEFAULT_DAYS * 86_400_000) : new Date(`${from}T00:00:00.000Z`);
  return Prisma.sql`x.issued_at >= ${start} AND x.issued_at < ${end}`;
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
