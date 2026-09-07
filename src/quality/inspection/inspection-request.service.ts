import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
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

  async list(query: InspectionRequestListQuery): Promise<PagedResponse<InspectionRequestView>> {
    const page = pageRequest(query);
    const where = buildWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.inspection_request.findMany({ where, orderBy: ORDER_BY, skip: page.skip, take: page.take }),
      this.prisma.inspection_request.count({ where }),
    ]);
    return pagedResponse(rows.map(inspectionRequestView), total, page);
  }

  async detail(inspectionRequestId: number): Promise<InspectionRequestView> {
    const row = await this.prisma.inspection_request.findUnique({
      where: { inspection_request_id: inspectionRequestId },
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

function statusWhere(query: InspectionRequestListQuery): Prisma.inspection_requestWhereInput {
  if (query.pendingOnly === true) return { status_code: { in: PENDING_STATUS_CODES } };
  return query.statusCode === undefined ? {} : { status_code: query.statusCode };
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
