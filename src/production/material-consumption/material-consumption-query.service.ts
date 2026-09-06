import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterialConsumptionView, materialConsumptionView } from './material-consumption-view';

/** 계약 질의 8 전건 — 필수는 하나도 없다. 형·기본값은 `@Contract` 가드가 이미 맞춰 둔다. */
export interface MaterialConsumptionListQuery {
  workOrderId?: unknown;
  workSessionId?: unknown;
  lotId?: unknown;
  consumptionTypeCode?: string;
  occurredFrom?: string;
  occurredTo?: string;
  page?: number;
  size?: number;
}

/**
 * 정렬 키가 계약에 **없다** ⇒ 서버가 고정한다. 형제 `production_result` 와 같은 축이고
 * (`production-result-query.service.ts:24-27`) 인덱스 둘이 `(…, occurred_at DESC)` 라 그대로 탄다.
 */
export const MATERIAL_CONSUMPTION_ORDER_BY: Prisma.material_consumptionOrderByWithRelationInput[] = [
  { occurred_at: 'desc' },
  { material_consumption_id: 'desc' },
];

/** 자재 투입 조회 2건 — 목록·단건(I-10 PR ①). ⛔ ETag·403 을 계약이 선언하지 않았다. */
@Injectable()
export class MaterialConsumptionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MaterialConsumptionListQuery): Promise<PagedResponse<MaterialConsumptionView>> {
    const page = pageRequest(query);
    // 반개구간 — From 이상 · To 미만(공유계약 L-3 · `production-result-query.service.ts:37-49`).
    const occurredAt = {
      ...(query.occurredFrom === undefined ? {} : { gte: new Date(query.occurredFrom) }),
      ...(query.occurredTo === undefined ? {} : { lt: new Date(query.occurredTo) }),
    };
    const where: Prisma.material_consumptionWhereInput = {
      ...filter('work_order_id', numeric('workOrderId', query.workOrderId)),
      ...filter('work_session_id', numeric('workSessionId', query.workSessionId)),
      ...filter('lot_id', numeric('lotId', query.lotId)),
      // 문자 그대로 건다 — `x-no-code-key` 라 대조할 값 목록이 아예 없다(I-10 §5-1).
      ...(query.consumptionTypeCode === undefined ? {} : { consumption_type_code: query.consumptionTypeCode }),
      ...(Object.keys(occurredAt).length === 0 ? {} : { occurred_at: occurredAt }),
    };

    const [rows, total] = await Promise.all([
      // ⛔ `include` 를 쓰지 않는다 — `MaterialConsumption` 에 표시 라벨 칸이 0개다(I-10 §5-1).
      this.prisma.material_consumption.findMany({
        where,
        orderBy: MATERIAL_CONSUMPTION_ORDER_BY,
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.material_consumption.count({ where }),
    ]);
    return pagedResponse(rows.map(materialConsumptionView), total, page);
  }

  /** 없으면 404(계약 선언). 목록과 **같은 매퍼**를 쓴다 — 상세 전용 스키마가 없다(§5-2). */
  async detail(materialConsumptionId: number): Promise<MaterialConsumptionView> {
    const row = await this.prisma.material_consumption.findUnique({
      where: { material_consumption_id: BigInt(materialConsumptionId) },
    });
    if (row === null) throw new NotFoundException('없는 자재 투입입니다.');
    return materialConsumptionView(row);
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다(`shopfloor-receipt-query.service.ts:70` 사본). */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}
