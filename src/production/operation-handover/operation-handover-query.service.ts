import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  OPERATION_HANDOVER_LINE_INCLUDE,
  OperationHandoverView,
  operationHandoverView,
} from './operation-handover-view';

/** 계약 질의 5 전건 + 페이지 2 — 필수는 하나도 없다(I-25 §1-2). */
export interface OperationHandoverListQuery {
  fromWorkOrderId?: unknown;
  toWorkOrderId?: unknown;
  statusCode?: string;
  handedOverFrom?: string;
  handedOverTo?: string;
  page?: number;
  size?: number;
}

/** 정렬 키가 계약에 **없다** ⇒ 서버가 고정한다(동률은 PK 로 닫는다 · `material-return-query.service.ts` 사본). */
export const OPERATION_HANDOVER_ORDER_BY: Prisma.operation_handoverOrderByWithRelationInput[] = [
  { handed_over_at: 'desc' },
  { operation_handover_id: 'desc' },
];

/** 공정 인계 조회 2건 — 목록·단건(I-25 PR ①). ⛔ ETag·403 을 계약이 선언하지 않았다. */
@Injectable()
export class OperationHandoverQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: OperationHandoverListQuery): Promise<PagedResponse<OperationHandoverView>> {
    const page = pageRequest(query);
    // 반개구간 — From 이상 · To 미만(공유계약 L-3).
    const handedOverAt = {
      ...(query.handedOverFrom === undefined ? {} : { gte: new Date(query.handedOverFrom) }),
      ...(query.handedOverTo === undefined ? {} : { lt: new Date(query.handedOverTo) }),
    };
    const where: Prisma.operation_handoverWhereInput = {
      ...filter('from_work_order_id', numeric('fromWorkOrderId', query.fromWorkOrderId)),
      ...filter('to_work_order_id', numeric('toWorkOrderId', query.toWorkOrderId)),
      // 문자 그대로 건다 — `x-no-code-key` 라 대조할 값 목록이 아예 없다(§1-5).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...(Object.keys(handedOverAt).length === 0 ? {} : { handed_over_at: handedOverAt }),
    };

    const [rows, total] = await Promise.all([
      // ⭐ 목록에도 라인을 싣는다 — 목록·상세가 같은 `OperationHandover` 스키마라 비우면
      //    자리마다 모양이 갈린다(§3-1).
      this.prisma.operation_handover.findMany({
        where,
        orderBy: OPERATION_HANDOVER_ORDER_BY,
        skip: page.skip,
        take: page.take,
        include: OPERATION_HANDOVER_LINE_INCLUDE,
      }),
      this.prisma.operation_handover.count({ where }),
    ]);
    return pagedResponse(rows.map(operationHandoverView), total, page);
  }

  /** 없으면 404(계약 선언). 라인은 `line_no` 오름차순 — 칸이 물리에 실재한다(§3-1). */
  async detail(operationHandoverId: number): Promise<OperationHandoverView> {
    const row = await this.prisma.operation_handover.findUnique({
      where: { operation_handover_id: BigInt(operationHandoverId) },
      include: OPERATION_HANDOVER_LINE_INCLUDE,
    });
    if (row === null) throw new NotFoundException('없는 공정 인계입니다.');
    return operationHandoverView(row);
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다(`material-return-query.service.ts` 사본). */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}
