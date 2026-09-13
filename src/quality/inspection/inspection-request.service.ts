import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { TerminalQualityReadScope, terminalQualityWorkOrderWhere } from '../../auth/terminal-quality-read-scope';
import { InspectionRequestView, inspectionRequestView } from './inspection-request-view';

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
    const where: Prisma.inspection_requestWhereInput = {
      ...buildWhere(query),
      ...(scope === undefined ? {} : { work_order: terminalQualityWorkOrderWhere(scope) }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inspection_request.findMany({ where, orderBy: ORDER_BY, skip: page.skip, take: page.take }),
      this.prisma.inspection_request.count({ where }),
    ]);
    return pagedResponse(rows.map(inspectionRequestView), total, page);
  }

  async detail(inspectionRequestId: number, scope?: TerminalQualityReadScope): Promise<InspectionRequestView> {
    const row = await this.prisma.inspection_request.findFirst({
      where: { inspection_request_id: inspectionRequestId,
        ...(scope === undefined ? {} : { work_order: terminalQualityWorkOrderWhere(scope) }) },
    });
    if (!row) throw new NotFoundException('없는 검사 의뢰입니다.');
    return inspectionRequestView(row);
  }
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
