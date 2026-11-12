import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { INBOUND_RECEIPT_LINE_SOURCE, lotsOfInboundLines, representativeLot } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { receiptDateWhere } from './inbound-receipt-query.service';

/**
 * 입하 건을 가로지르는 입하 줄 목록(장부 P-118) — POP 자재 LOT 라벨 발행(P-01-01)의 공급사 묶음 · 체크 일괄 발행 ·
 * 다시 인쇄가 쓴다. 질의는 입하 목록과 같은 이름이다(`labelIssued`·`supplierLotLabelAttached`·`supplierId`·`plantId`·
 * `receiptDateFrom/To`). 라벨 대기 = 실물 라벨 미부착 + 자재 LOT 라벨 발행 기록 없음(사용자 결정 2026-10-24) —
 * LOT 만 등록하고 인쇄하지 못한 줄도 대기다. 취소(요청) 입하는 뺀다.
 */
export interface InboundReceiptLineListQuery {
  supplierId?: number;
  plantId?: number;
  labelIssued?: boolean;
  supplierLotLabelAttached?: boolean;
  receiptDateFrom?: string;
  receiptDateTo?: string;
  page?: number;
  size?: number;
}

export interface InboundReceiptLineListItem {
  inboundReceiptLineId: number;
  inboundReceiptId: number;
  inboundReceiptNo: string;
  receiptDatetime: string;
  lineNo: number;
  supplierId: number;
  plantId: number;
  itemId: number;
  receivedQty: number;
  uomId: number;
  inspectionRequired: boolean;
  supplierLotLabelAttached: boolean;
  /** LOT 을 등록했으면 값이 있다 — 발행 기록이 없어도(인쇄 실패) 있을 수 있다. */
  lotId: number | null;
  lotNo: string | null;
  lotStatusCode: string | null;
  /** 마지막 자재 LOT 라벨 발행 — 없으면 null. */
  lastLabelIssue: { issueSeq: number; issuedAt: string } | null;
}

export interface SupplierLabelCount {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  pendingCount: number;
  firstReceiptDatetime: string;
}

const CANCEL_STATUSES = ['CANCELLED', 'CANCEL_REQUESTED'];
const LABEL_TYPE = 'MATERIAL_LOT_LABEL';

const LINE_SELECT = {
  inbound_receipt_line_id: true,
  inbound_receipt_id: true,
  line_no: true,
  item_id: true,
  received_qty: true,
  uom_id: true,
  inspection_required: true,
  supplier_lot_label_attached: true,
  lot_id: true,
  inbound_receipt: { select: { inbound_receipt_no: true, receipt_datetime: true, supplier_id: true, plant_id: true } },
} satisfies Prisma.inbound_receipt_lineSelect;
type LineRow = Prisma.inbound_receipt_lineGetPayload<{ select: typeof LINE_SELECT }>;

const LOT_SELECT = {
  lot_no: true,
  status_code: true,
  document_issue_log: {
    where: { document_type_code: LABEL_TYPE },
    orderBy: { issue_seq: 'desc' },
    take: 1,
    select: { issue_seq: true, issued_at: true },
  },
} satisfies Prisma.lotSelect;
type LotRow = Prisma.lotGetPayload<{ select: typeof LOT_SELECT }> & { lot_id: bigint };

/**
 * 줄의 LOT 중 하나라도 라벨을 발행했는가. 옛 줄은 `lot` 칸으로, 새 흐름의 줄(`lot_id` 없음 · LOT 여럿)은 입하 LOT 에
 * 묶인 원천 LOT 으로 본다 — Prisma `where` 는 다형 원천(`source_id`)으로 잇지 못하고, 새 흐름은 줄마다 입하 LOT 을 둔다.
 */
const LABEL_ISSUED = { document_issue_log: { some: { document_type_code: LABEL_TYPE } } } satisfies Prisma.lotWhereInput;
const LINE_LABEL_ISSUED: Prisma.inbound_receipt_lineWhereInput = {
  OR: [
    { lot: LABEL_ISSUED },
    { lot_id: null, inbound_lot: { lot: { some: { source_type_code: INBOUND_RECEIPT_LINE_SOURCE, ...LABEL_ISSUED } } } },
  ],
};

@Injectable()
export class InboundReceiptLineListService {
  constructor(private readonly prisma: PrismaService) {}

  /** 입하 일시 오름차순 → 입하 → 줄 번호 — 먼저 들어온 것부터 발행한다. */
  async list(query: InboundReceiptLineListQuery): Promise<PagedResponse<InboundReceiptLineListItem>> {
    const page = pageRequest(query);
    const where = whereOf(query);
    const [rows, total] = await Promise.all([
      this.prisma.inbound_receipt_line.findMany({
        where,
        select: LINE_SELECT,
        orderBy: [{ inbound_receipt: { receipt_datetime: 'asc' } }, { inbound_receipt_id: 'asc' }, { line_no: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inbound_receipt_line.count({ where }),
    ]);
    const lotsOf = await lotsOfInboundLines(this.prisma, rows, LOT_SELECT);
    return pagedResponse(
      rows.map((row) => itemOf(row, lotsOf.get(row.inbound_receipt_line_id) ?? [])),
      total,
      page,
    );
  }

  /** 같은 조건의 줄을 공급사로 묶는다 — 먼저 입하된 공급사부터(같으면 공급사 id). 쪽은 보지 않는다. */
  async supplierCounts(query: InboundReceiptLineListQuery): Promise<{ items: SupplierLabelCount[] }> {
    const rows = await this.prisma.inbound_receipt_line.findMany({
      where: whereOf(query),
      select: { inbound_receipt: { select: { supplier_id: true, receipt_datetime: true } } },
    });
    const bySupplier = new Map<bigint, { count: number; first: Date }>();
    for (const { inbound_receipt: receipt } of rows) {
      const entry = bySupplier.get(receipt.supplier_id);
      if (entry === undefined) bySupplier.set(receipt.supplier_id, { count: 1, first: receipt.receipt_datetime });
      else {
        entry.count += 1;
        if (receipt.receipt_datetime < entry.first) entry.first = receipt.receipt_datetime;
      }
    }
    const partners = await this.prisma.partner.findMany({
      where: { partner_id: { in: [...bySupplier.keys()] } },
      select: { partner_id: true, partner_code: true, partner_name: true },
    });
    const names = new Map(partners.map((row) => [row.partner_id, row]));
    const items = [...bySupplier]
      .sort(([leftId, left], [rightId, right]) => left.first.getTime() - right.first.getTime() || (leftId < rightId ? -1 : 1))
      .map(([supplierId, entry]) => ({
        supplierId: Number(supplierId),
        supplierCode: names.get(supplierId)?.partner_code ?? '',
        supplierName: names.get(supplierId)?.partner_name ?? '',
        pendingCount: entry.count,
        firstReceiptDatetime: entry.first.toISOString(),
      }));
    return { items };
  }
}

function whereOf(query: InboundReceiptLineListQuery): Prisma.inbound_receipt_lineWhereInput {
  return {
    inbound_receipt: {
      status_code: { notIn: CANCEL_STATUSES },
      ...(query.supplierId === undefined ? {} : { supplier_id: query.supplierId }),
      ...(query.plantId === undefined ? {} : { plant_id: query.plantId }),
      ...receiptDateWhere(query.receiptDateFrom, query.receiptDateTo),
    },
    ...(query.supplierLotLabelAttached === undefined ? {} : { supplier_lot_label_attached: query.supplierLotLabelAttached }),
    ...(query.labelIssued === undefined ? {} : query.labelIssued ? LINE_LABEL_ISSUED : { NOT: LINE_LABEL_ISSUED }),
  };
}

/** `lotId`·`lotNo`·`lotStatusCode` 는 대표 LOT, 마지막 발행은 줄의 LOT 전부에서 가장 늦은 것이다. */
function itemOf(row: LineRow, lots: LotRow[]): InboundReceiptLineListItem {
  const receipt = row.inbound_receipt;
  const lot = representativeLot(lots);
  const issue = lots
    .flatMap((each) => each.document_issue_log)
    .reduce<LotRow['document_issue_log'][number] | undefined>(
      (last, each) => (last === undefined || each.issued_at > last.issued_at ? each : last),
      undefined,
    );
  return {
    inboundReceiptLineId: Number(row.inbound_receipt_line_id),
    inboundReceiptId: Number(row.inbound_receipt_id),
    inboundReceiptNo: receipt.inbound_receipt_no,
    receiptDatetime: receipt.receipt_datetime.toISOString(),
    lineNo: row.line_no,
    supplierId: Number(receipt.supplier_id),
    plantId: Number(receipt.plant_id),
    itemId: Number(row.item_id),
    receivedQty: Number(row.received_qty),
    uomId: Number(row.uom_id),
    inspectionRequired: row.inspection_required,
    supplierLotLabelAttached: row.supplier_lot_label_attached,
    lotId: lot === null ? null : Number(lot.lot_id),
    lotNo: lot?.lot_no ?? null,
    lotStatusCode: lot?.status_code ?? null,
    lastLabelIssue: issue === undefined ? null : { issueSeq: issue.issue_seq, issuedAt: issue.issued_at.toISOString() },
  };
}
