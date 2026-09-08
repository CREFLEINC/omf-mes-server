import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { LotHoldRow, LotHoldView, lotHoldView } from './lot-hold-view';

/** `GET /quality/lot-holds` 질의 10칸(§1-2) — 쌍 검사(`heldFrom`/`heldTo`)는 컨트롤러가 먼저 한다. */
export interface LotHoldFilters {
  open?: boolean;
  lotId?: number;
  itemId?: number;
  reasonCode?: string;
  heldBy?: number;
  heldFrom?: string;
  heldTo?: string;
  lotNo?: string;
}

export interface LotHoldListQuery extends LotHoldFilters {
  page?: number;
  size?: number;
}

const INCLUDE_LOT = { lot: true } as const;

/**
 * `lot_hold` 조회 — `GET /quality/lot-holds` · `GET /quality/lot-holds/{lotHoldId}`.
 * ⛔ 원시 SQL 이 아니다 — `lot-status-query.ts` 와 달리 창고·잔액 접기가 없어 Prisma 필터로
 * 충분하다(사용처 하나뿐인 추상화를 선제로 두지 않는다 · `CLAUDE.md`).
 */
@Injectable()
export class LotHoldQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: LotHoldListQuery): Promise<PagedResponse<LotHoldView>> {
    const page = pageRequest(query);
    const where = whereOf(query);
    const [rows, total] = await Promise.all([
      this.prisma.lot_hold.findMany({
        where,
        include: INCLUDE_LOT,
        // ⭐ R-10 계열 — 계약에 `sort` 질의가 없다 ⇒ 기본 고정 + 2차 정렬 키로 동률을 깬다
        //   (`lot_hold_id` 는 물리로 유일함이 보장된다 · I-24 선례 「반환 순서 보장」).
        orderBy: [{ held_at: 'desc' }, { lot_hold_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.lot_hold.count({ where }),
    ]);
    return pagedResponse(rows.map(lotHoldView), total, page);
  }

  /**
   * 상세 — ETag 는 이 보류가 걸린 **LOT** 의 `version_no` 다(`lot_hold.version_no` 가 «아니다»
   * — 근거는 `lot-hold.controller.ts` 의 상세 판정 주석 · 계약 실측).
   */
  async get(lotHoldId: number): Promise<{ view: LotHoldView; lotVersionNo: number }> {
    const row: LotHoldRow | null = await this.prisma.lot_hold.findUnique({
      where: { lot_hold_id: BigInt(lotHoldId) },
      include: INCLUDE_LOT,
    });
    if (!row) throw new NotFoundException('없는 보류입니다.');
    return { view: lotHoldView(row), lotVersionNo: row.lot.version_no };
  }
}

/**
 * ⭐⭐ **§1-2 · R-1 · 계약 `:1725`** — `open` 기본 `true`(`released_at IS NULL`).
 * `open=false` 는 「해제된 것만」이 «아니라» «전체»다 ⇒ **필터를 걸지 않는다**(참·거짓 갈래가
 * 아니라 있음/없음 갈래 — `open=false` 는 `open` 을 «생략한 것과 같다»).
 */
function whereOf(filters: LotHoldFilters): Prisma.lot_holdWhereInput {
  const open = filters.open ?? true;
  const lotFilter: Prisma.lotWhereInput = {
    ...(filters.itemId !== undefined ? { item_id: BigInt(filters.itemId) } : {}),
    // ⭐ `lotNo` 는 «정확히» 일치다(부분 일치 아님) — 화면이 스캔값 하나로 한 건을 집는다.
    ...(filters.lotNo !== undefined ? { lot_no: filters.lotNo } : {}),
  };
  return {
    ...(open ? { released_at: null } : {}),
    ...(filters.lotId !== undefined ? { lot_id: BigInt(filters.lotId) } : {}),
    ...(Object.keys(lotFilter).length > 0 ? { lot: lotFilter } : {}),
    ...(filters.reasonCode !== undefined ? { reason_code: filters.reasonCode } : {}),
    ...(filters.heldBy !== undefined ? { held_by: BigInt(filters.heldBy) } : {}),
    ...heldRangeOf(filters.heldFrom, filters.heldTo),
  };
}

/** 갈래 B — 선택 쌍(컨트롤러가 검증). 끝 경계는 «미만»이다(공유계약 L-3-1 · 반열림). */
function heldRangeOf(heldFrom?: string, heldTo?: string): Prisma.lot_holdWhereInput {
  if (heldFrom === undefined && heldTo === undefined) return {};
  return {
    held_at: {
      ...(heldFrom !== undefined ? { gte: new Date(heldFrom) } : {}),
      ...(heldTo !== undefined ? { lt: new Date(heldTo) } : {}),
    },
  };
}
