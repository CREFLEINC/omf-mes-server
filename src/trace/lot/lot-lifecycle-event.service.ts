import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  LOT_LIFECYCLE_EVENT_JOIN,
  LotLifecycleEventView,
  lotLifecycleEventView,
} from './lot-lifecycle-event-view';

/** 계약 enum — L1 대기→활성 · L2 대기→폐번 · L3 활성→폐번. 그 밖은 가드가 400 을 낸다. */
export type LotLifecycleTransitionCode = 'L1' | 'L2' | 'L3';

/** 질의 4 — 기간 둘은 계약 **required** 라 `@Contract` 가드가 막는다(코드로 다시 안 막는다). */
export interface LotLifecycleEventQuery {
  occurredFrom: string;
  occurredTo: string;
  lotId?: number;
  transitionCode?: LotLifecycleTransitionCode;
}

/** 인덱스 `ix_lot_lifecycle_history_changed_at`(DESC)를 탄다. 동률은 PK 로 닫는다. */
export const LOT_LIFECYCLE_EVENT_ORDER_BY: Prisma.lot_lifecycle_historyOrderByWithRelationInput[] = [
  { changed_at: 'desc' },
  { lot_lifecycle_history_id: 'desc' },
];

/**
 * 기간(`changed_at`) + `lot_id?` + `transition_code?`.
 * ⛔ enum 밖 값을 **떨어뜨리지 않는다** — 떨어뜨리면 감사 조회가 오히려 «넓어진다».
 *    가드가 이미 400 을 냈고, 여기는 그 값이 와도 좁게 도는 자리다.
 */
export function buildLotLifecycleEventWhere(query: LotLifecycleEventQuery): Prisma.lot_lifecycle_historyWhereInput {
  return {
    changed_at: { gte: new Date(query.occurredFrom), lt: new Date(query.occurredTo) },
    ...(query.lotId === undefined ? {} : { lot_id: query.lotId }),
    ...(query.transitionCode === undefined ? {} : { transition_code: query.transitionCode }),
  };
}

/**
 * LOT 생명주기 변경이력 조회(I-7 PR ①). 응답은 `{ items }` **하나**다 — 계약에 `PageMeta`
 * 가 없고 기간이 유일한 상한이다.
 */
@Injectable()
export class LotLifecycleEventService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: LotLifecycleEventQuery): Promise<{ items: LotLifecycleEventView[] }> {
    const rows = await this.prisma.lot_lifecycle_history.findMany({
      where: buildLotLifecycleEventWhere(query),
      orderBy: LOT_LIFECYCLE_EVENT_ORDER_BY,
      include: LOT_LIFECYCLE_EVENT_JOIN,
    });
    return { items: rows.map(lotLifecycleEventView) };
  }
}
