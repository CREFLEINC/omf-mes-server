import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionResultView, productionResultView } from './production-result-view';

/** 계약 질의 8 전건 — 필수는 하나도 없다. 형·기본값은 `@Contract` 가드가 이미 맞춰 둔다. */
export interface ProductionResultListQuery {
  workOrderId?: number;
  workSessionId?: number;
  shiftId?: number;
  equipmentId?: number;
  occurredFrom?: string;
  occurredTo?: string;
  page?: number;
  size?: number;
}

/**
 * 정렬 키가 계약에 **없다** ⇒ 서버가 고정한다. 동률은 PK 로 닫아 쪽 경계가 흔들리지 않게
 * 한다(형제 `buildOrderBy` 선례). 정렬 질의를 안 받으므로 400 갈래가 없다.
 */
export const PRODUCTION_RESULT_ORDER_BY: Prisma.production_resultOrderByWithRelationInput[] = [
  { occurred_at: 'desc' },
  { production_result_id: 'desc' },
];

/**
 * 질의 6개 → Prisma where(순수 함수). 값이 없는 질의는 **키를 안 넣는다**.
 * ⛔ 기간을 강제하지 않는다 — 계약이 `occurredFrom`·`occurredTo` 를 required 로 적지 않았다
 *    (감사 조회가 아니다). 둘 다 비면 `occurred_at` 조건 자체가 없다.
 * ⚠ `occurredTo` 는 **닫힌 구간(`lte`)**이다 — 계약 파라미터에 반열림을 적은 description 이
 *    없어(실측: description 키 자체가 없다) 이름 그대로 「~까지」로 읽는다.
 * ⛔ 정정본을 거르지 않는다 — 원본·정정본이 목록에 «둘 다» 보여야 한다(§7-1).
 */
export function buildProductionResultWhere(query: ProductionResultListQuery): Prisma.production_resultWhereInput {
  const occurredAt = {
    ...(query.occurredFrom === undefined ? {} : { gte: new Date(query.occurredFrom) }),
    ...(query.occurredTo === undefined ? {} : { lte: new Date(query.occurredTo) }),
  };
  return {
    ...(query.workOrderId === undefined ? {} : { work_order_id: query.workOrderId }),
    ...(query.workSessionId === undefined ? {} : { work_session_id: query.workSessionId }),
    ...(query.shiftId === undefined ? {} : { shift_id: query.shiftId }),
    ...(query.equipmentId === undefined ? {} : { equipment_id: query.equipmentId }),
    ...(Object.keys(occurredAt).length === 0 ? {} : { occurred_at: occurredAt }),
  };
}

/** 조회 2건 — 목록 GET · 단건 GET(I-7 PR ①). ⛔ ETag 를 싣지 않는다(계약 미선언). */
@Injectable()
export class ProductionResultQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ProductionResultListQuery): Promise<PagedResponse<ProductionResultView>> {
    const page = pageRequest(query);
    const where = buildProductionResultWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.production_result.findMany({ where, orderBy: PRODUCTION_RESULT_ORDER_BY, skip: page.skip, take: page.take }),
      this.prisma.production_result.count({ where }),
    ]);
    return pagedResponse(rows.map(productionResultView), total, page);
  }

  async detail(productionResultId: number): Promise<ProductionResultView> {
    const row = await this.prisma.production_result.findUnique({
      where: { production_result_id: BigInt(productionResultId) },
    });
    if (row === null) throw new NotFoundException('없는 생산 실적입니다.');
    return productionResultView(row);
  }
}
