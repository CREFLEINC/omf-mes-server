import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { TerminalQualityReadScope, terminalInspectionRequestWhere } from '../../auth/terminal-quality-read-scope';
import { FOUR_M_CHANGE_INCLUDE, InspectionRequestView, inspectionRequestView } from './inspection-request-view';

/** 조회 2건(I-19 PR ②). */
export interface InspectionRequestListQuery {
  inspectionTypeCode?: string;
  statusCode?: string;
  pendingOnly?: boolean;
  itemId?: number;
  supplierId?: number;
  lotId?: number;
  workOrderId?: number;
  q?: string;
  page?: number;
  size?: number;
}

/** ⭐ 정의를 값으로 못박은 파생 축(계약) — `pendingOnly=true` ⇔ 이 2값. */
const PENDING_STATUS_CODES = ['REQUESTED', 'IN_PROGRESS'];
const IQC = 'IQC';

/** 계약에 `sort` 가 없다 — 검사 대기 큐라 「오래 기다린 것부터」로 서버가 고정한다(§4-1). */
const ORDER_BY: Prisma.inspection_requestOrderByWithRelationInput[] = [
  { requested_at: 'asc' },
  { inspection_request_id: 'asc' },
];

@Injectable()
export class InspectionRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InspectionRequestListQuery, scope?: TerminalQualityReadScope): Promise<PagedResponse<InspectionRequestView>> {
    const page = pageRequest(query);
    const where: Prisma.inspection_requestWhereInput = scope === undefined
      ? buildWhere(query)
      : { AND: [buildWhere(query), await terminalInspectionRequestWhere(this.prisma, scope)] };
    const [rows, total] = await Promise.all([
      this.prisma.inspection_request.findMany({
        where, orderBy: ORDER_BY, skip: page.skip, take: page.take, include: FOUR_M_CHANGE_INCLUDE,
      }),
      this.prisma.inspection_request.count({ where }),
    ]);
    const levels = await iqcInspectionLevels(this.prisma, rows);
    return pagedResponse(rows.map((row, index) => inspectionRequestView(row, levels[index])), total, page);
  }

  async detail(inspectionRequestId: number, scope?: TerminalQualityReadScope): Promise<InspectionRequestView> {
    const byId: Prisma.inspection_requestWhereInput = { inspection_request_id: inspectionRequestId };
    const row = await this.prisma.inspection_request.findFirst({
      where: scope === undefined ? byId : { AND: [byId, await terminalInspectionRequestWhere(this.prisma, scope)] },
      include: FOUR_M_CHANGE_INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 검사 의뢰입니다.');
    const [level] = await iqcInspectionLevels(this.prisma, [row]);
    return inspectionRequestView(row, level);
  }
}

/**
 * IQC 의뢰의 검사 수준(#64 · 장부 P-85). 확정 때 기록한 값이 있으면 그것(그 LOT 을 검사한 수준)이고, 아직 대기·진행이면
 * 품목의 현재 수준이다. 수준 미설정 품목·IQC 밖 의뢰·기록 없이 끝난 의뢰는 비운다 — 지금 수준을 지난 검사에 붙이지 않는다.
 */
async function iqcInspectionLevels(
  prisma: PrismaService,
  rows: readonly { inspection_type_code: string; status_code: string; item_id: bigint; inspection_level_code: string | null }[],
): Promise<(string | undefined)[]> {
  const isCurrent = (row: (typeof rows)[number]) =>
    row.inspection_type_code === IQC && row.inspection_level_code === null && PENDING_STATUS_CODES.includes(row.status_code);
  const itemIds = [...new Set(rows.filter(isCurrent).map((row) => row.item_id))];
  const levels =
    itemIds.length === 0
      ? []
      : await prisma.item_inspection_level.findMany({
          where: { item_id: { in: itemIds } },
          select: { item_id: true, inspection_level_code: true },
        });
  const byItem = new Map(levels.map((level) => [level.item_id, level.inspection_level_code]));
  return rows.map((row) => {
    if (row.inspection_type_code !== IQC) return undefined;
    return row.inspection_level_code ?? (isCurrent(row) ? byItem.get(row.item_id) : undefined);
  });
}

function buildWhere(query: InspectionRequestListQuery): Prisma.inspection_requestWhereInput {
  return {
    ...(query.inspectionTypeCode === undefined ? {} : { inspection_type_code: query.inspectionTypeCode }),
    ...statusWhere(query),
    ...filter('item_id', query.itemId),
    ...filter('lot_id', query.lotId),
    ...filter('work_order_id', query.workOrderId),
    ...supplierWhere(query.supplierId),
    // ⛔ 범위는 `inspection_request_no` «하나»다 — 공급사·품목은 훑지 않는다(계약).
    ...(query.q === undefined ? {} : { inspection_request_no: { contains: query.q, mode: Prisma.QueryMode.insensitive } }),
  };
}

/**
 * ⭐ #286 M-1 — `pendingOnly` 와 `statusCode` 를 **AND** 로 묶는다. 형제
 * `approval-request.service.ts:148,154` 와 같은 모양 — 예전엔 `pendingOnly=true` 가
 * `statusCode` 를 조용히 삼켰다(`pendingOnly=true&statusCode=IN_PROGRESS` 가 `statusCode` 를
 * 무시하고 REQUESTED·IN_PROGRESS 둘 다 돌려줬다).
 */
function statusWhere(query: InspectionRequestListQuery): Prisma.inspection_requestWhereInput {
  const conditions: Prisma.inspection_requestWhereInput[] = [];
  if (query.pendingOnly === true) conditions.push({ status_code: { in: PENDING_STATUS_CODES } });
  if (query.statusCode !== undefined) conditions.push({ status_code: query.statusCode });
  return conditions.length === 0 ? {} : { AND: conditions };
}

/**
 * ⚠ `lot.source_type_code`/`source_id` 다형 참조가 아니라 `inbound_receipt_line.lot_id`
 * 역방향 관계로 잇는다 — 계약이 「2단 조인」이라 적은 자리를 물리가 이 관계로 한 번에 준다
 * (§4-1 · `lot.inbound_receipt_line[]`).
 */
function supplierWhere(supplierId: number | undefined): Prisma.inspection_requestWhereInput {
  if (supplierId === undefined) return {};
  return { lot: { inbound_receipt_line: { some: { inbound_receipt: { supplier_id: supplierId } } } } };
}
