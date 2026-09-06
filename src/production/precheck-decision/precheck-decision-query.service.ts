import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { PrecheckDecisionView, precheckDecisionView } from './precheck-decision-view';

/** 계약 질의 7 전건 — 필수는 하나도 없다(§1-2). */
export interface PrecheckDecisionListQuery {
  workOrderId?: unknown;
  equipmentId?: unknown;
  decisionCode?: string;
  decidedFrom?: string;
  decidedTo?: string;
  page?: number;
  size?: number;
}

/**
 * ⭐ 기본 정렬이 곧 업무 판정이다 — `P-02-02` §5-5 ⌜여러 건 있음 → 가장 최근 것⌝ 이라
 * `size=1` 이 「가장 최근 한 건」이 된다. 인덱스 둘이 정확히 `(…, decided_at DESC)` 라
 * 같은 방향이다(I-11 §8).
 */
export const PRECHECK_DECISION_ORDER_BY: Prisma.precheck_decisionOrderByWithRelationInput[] = [
  { decided_at: 'desc' },
  { precheck_decision_id: 'desc' },
];

/** 작업 전 점검 통제 판정 조회 1건(I-11 PR ①). ⛔ ETag·403 을 계약이 선언하지 않았다. */
@Injectable()
export class PrecheckDecisionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PrecheckDecisionListQuery): Promise<PagedResponse<PrecheckDecisionView>> {
    const page = pageRequest(query);
    // 반개구간 — From 이상 · To 미만(공유계약 L-3).
    const decidedAt = {
      ...(query.decidedFrom === undefined ? {} : { gte: new Date(query.decidedFrom) }),
      ...(query.decidedTo === undefined ? {} : { lt: new Date(query.decidedTo) }),
    };
    const where: Prisma.precheck_decisionWhereInput = {
      ...filter('work_order_id', numeric('workOrderId', query.workOrderId)),
      ...filter('equipment_id', numeric('equipmentId', query.equipmentId)),
      ...(query.decisionCode === undefined ? {} : { decision_code: query.decisionCode }),
      ...(Object.keys(decidedAt).length === 0 ? {} : { decided_at: decidedAt }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.precheck_decision.findMany({ where, orderBy: PRECHECK_DECISION_ORDER_BY, skip: page.skip, take: page.take }),
      this.prisma.precheck_decision.count({ where }),
    ]);
    return pagedResponse(rows.map(precheckDecisionView), total, page);
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다. */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}
