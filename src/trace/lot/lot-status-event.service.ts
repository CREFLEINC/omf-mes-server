import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  LOT_STATUS_EVENT_JOIN,
  LotStatusEventView,
  lotStatusEventView,
} from './lot-status-event-view';

/** 계약 enum — 전이 9종(도식스펙03 §1.3). 그 밖은 가드가 400 을 낸다. */
export type LotStatusTransitionCode =
  | 'C4'
  | 'C5'
  | 'C6'
  | 'C7'
  | 'C8'
  | 'C9'
  | 'C10'
  | 'C14'
  | 'C15';

/** 질의 4 — 기간 둘은 계약 **required** 라 `@Contract` 가드가 막는다(코드로 다시 안 막는다). */
export interface LotStatusEventQuery {
  occurredFrom: string;
  occurredTo: string;
  lotId?: number;
  transitionCode?: LotStatusTransitionCode;
}

/** 인덱스 `ix_lot_status_event_changed_at`(DESC)을 탄다. 동률은 PK 로 닫는다. */
export const LOT_STATUS_EVENT_ORDER_BY: Prisma.lot_status_eventOrderByWithRelationInput[] = [
  { changed_at: 'desc' },
  { lot_status_event_id: 'desc' },
];

/**
 * 기간(`changed_at`) + `lot_id?` + `transition_code?`.
 * ⛔ R-4 — enum 밖 값을 **떨어뜨리지 않는다** — 떨어뜨리면 감사 조회가 오히려 «넓어진다».
 *    가드가 이미 400 을 냈고(질의 파라미터), 응답 쪽은 런타임 검증이 없어 형제와 같은
 *    판정으로 닫는다(`lot-lifecycle-event.service.ts:33-36`). 레인 C 의 I-23 이 병합되면
 *    enum 밖 `transitionCode` 가 이 조회로 새어 나올 수 있다 — 통보 154(필터를 여기서
 *    지어내지 않는다).
 */
export function buildLotStatusEventWhere(query: LotStatusEventQuery): Prisma.lot_status_eventWhereInput {
  return {
    changed_at: { gte: new Date(query.occurredFrom), lt: new Date(query.occurredTo) },
    ...(query.lotId === undefined ? {} : { lot_id: query.lotId }),
    ...(query.transitionCode === undefined ? {} : { transition_code: query.transitionCode }),
  };
}

/**
 * LOT 상태 변경이력 조회(I-18 PR ①) — 형제 `LotLifecycleEventService` 의 직역 복제.
 * 응답은 `{ items }` 하나다 — 계약에 `PageMeta` 가 없고 기간이 유일한 상한이다.
 */
@Injectable()
export class LotStatusEventService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: LotStatusEventQuery): Promise<{ items: LotStatusEventView[] }> {
    const rows = await this.prisma.lot_status_event.findMany({
      where: buildLotStatusEventWhere(query),
      orderBy: LOT_STATUS_EVENT_ORDER_BY,
      include: LOT_STATUS_EVENT_JOIN,
    });
    return { items: rows.map(lotStatusEventView) };
  }
}
