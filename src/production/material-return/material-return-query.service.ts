import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MATERIAL_RETURN_LINE_INCLUDE,
  MaterialReturnView,
  materialReturnView,
} from './material-return-view';

/** 계약 질의 6 전건 — 필수는 하나도 없다. 형·기본값은 `@Contract` 가드가 이미 맞춰 둔다. */
export interface MaterialReturnListQuery {
  workOrderId?: unknown;
  statusCode?: string;
  requestedFrom?: string;
  requestedTo?: string;
  page?: number;
  size?: number;
}

/** 정렬 키가 계약에 **없다** ⇒ 서버가 고정한다(§5-1 과 같은 근거 · 동률은 PK 로 닫는다). */
export const MATERIAL_RETURN_ORDER_BY: Prisma.material_returnOrderByWithRelationInput[] = [
  { requested_at: 'desc' },
  { material_return_id: 'desc' },
];

/** 자재 반출 조회 2건 — 목록·단건(I-10 PR ①). ⛔ ETag·403 을 계약이 선언하지 않았다. */
@Injectable()
export class MaterialReturnQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MaterialReturnListQuery): Promise<PagedResponse<MaterialReturnView>> {
    const page = pageRequest(query);
    // 반개구간 — From 이상 · To 미만(공유계약 L-3).
    const requestedAt = {
      ...(query.requestedFrom === undefined ? {} : { gte: new Date(query.requestedFrom) }),
      ...(query.requestedTo === undefined ? {} : { lt: new Date(query.requestedTo) }),
    };
    const where: Prisma.material_returnWhereInput = {
      ...filter('work_order_id', numeric('workOrderId', query.workOrderId)),
      // 문자 그대로 건다 — `x-no-code-key` 라 대조할 값 목록이 아예 없다(I-10 §5-3).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...(Object.keys(requestedAt).length === 0 ? {} : { requested_at: requestedAt }),
    };

    const [rows, total] = await Promise.all([
      // ⭐ 목록에도 라인을 싣는다 — 목록·상세가 같은 `MaterialReturn` 스키마라 비우면 자리마다
      //    모양이 갈린다(I-10 §5-3).
      this.prisma.material_return.findMany({
        where,
        orderBy: MATERIAL_RETURN_ORDER_BY,
        skip: page.skip,
        take: page.take,
        include: MATERIAL_RETURN_LINE_INCLUDE,
      }),
      this.prisma.material_return.count({ where }),
    ]);
    return pagedResponse(rows.map(materialReturnView), total, page);
  }

  /** 없으면 404(계약 선언). 라인은 `line_no` 오름차순 — 칸이 물리에 실재한다(§5-4). */
  async detail(materialReturnId: number): Promise<MaterialReturnView> {
    const row = await this.prisma.material_return.findUnique({
      where: { material_return_id: BigInt(materialReturnId) },
      include: MATERIAL_RETURN_LINE_INCLUDE,
    });
    if (row === null) throw new NotFoundException('없는 자재 반출입니다.');
    return materialReturnView(row);
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다(`shopfloor-receipt-query.service.ts:70` 사본). */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}
