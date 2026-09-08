/**
 * `GET /quality/lot-status-transitions` — 「갈 수 있는 LOT 상태」. 화면은 전이표를 갖지 않는다
 * (공유계약 G-8) — 여기가 그 판정을 낸다. I-20 §4-2 · `docs/coverage-100/slices/I-20.md`.
 *
 * ⛔ **`transitions.ts` 를 읽기만 한다** — A 소유 파일이고 B·C 와 충돌하는 자리다(`lanes.md` §1-4).
 * ⛔ **검사 확정 넷(C4·C5·C6·C14)과 재등록(stock-reinstate)은 담지 않는다** — 계약 `actionCode`
 *    enum 이 `RELEASE_HOLD`·`CREATE_HOLD` 둘뿐이라 나머지는 액션을 지어내는 것이다(F-6).
 * ⛔ **`DEFECTIVE` 를 한 줄로 묶지 않는다** — C8(RELEASE_HOLD)·C9(CREATE_HOLD)가 같은 목표
 *    상태에 다른 경로로 온다(계약 `:4410` — 「목표 상태만으로는 가를 수 없다」).
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import { Transition, TRANSITIONS } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';

/** LOT 품질 판정 축 — `lot-quality-status.service.ts` 와 같은 키(그 파일의 상수를 다시 만들지 않는다). */
const QUALITY_COLUMN = 'trace.lot.status_code';
/** 이 둘의 `sourceOperation` 만 담는다 — 나머지(검사 확정·재등록)는 actionCode 가 없다. */
const CREATE_HOLD_OP = 'POST /quality/lot-holds';
const RELEASE_HOLD_OP = 'POST /quality/lot-holds/{lotHoldId}:release';

/** 계약 `LotQualityStatus.lotStatusCode` 설명이 준 표시명(NORMAL=정상·INSPECTION_PENDING=검사대기
 * ·DEFECTIVE=불량·SCRAPPED=폐기) — `blockedReason` 문장 하나에만 쓴다. 지어낸 값이 아니다. */
const LOT_STATUS_LABEL: Record<string, string> = {
  NORMAL: '정상',
  INSPECTION_PENDING: '검사대기',
  DEFECTIVE: '불량',
  SCRAPPED: '폐기',
};

/** `W-03-02` §5-5 원문 그대로 — 전건 `allowed=false` 일 때만 싣는다(계약 `:4472` 인접). */
const NO_TRANSITION_NOTE = '이 LOT은 더 전이할 수 없습니다 — 불량 처리는 생산실행에서 합니다.';

/**
 * 「진행 중인 피킹」을 막는 종결 판정 — `picking_order.status_code` 는 계약이 값 목록을 안 줬다
 * (`document-type-registry.ts` 의 `PICKING_ORDER.cancelledStatus: null` 도 같은 이유로 값을
 * 지어내지 않았다). 계약 `PickingOrder.statusCode` 설명이 명시한 `LOGISTICS_DOCUMENT_STATUS`
 * 4값 중 되돌릴 수 없는 하나(`CANCELLED`)만 종결로 본다 — `CANCEL_REQUESTED` 는 아직 뒤집힐 수
 * 있어 «진행 중»에 남긴다.
 * // 결정 — 통보 078
 */
const TERMINAL_PICKING_ORDER_STATUS = 'CANCELLED';

export interface LotStatusTransitionImpact {
  openPickingCount: number;
  shippedQty: number;
}

/** 계약 `LotStatusTransition` 과 동형(required 3: targetLotStatusCode·allowed·actionCode). */
export interface LotStatusTransitionRow {
  targetLotStatusCode: string;
  allowed: boolean;
  actionCode: 'RELEASE_HOLD' | 'CREATE_HOLD';
  blockedReason?: string;
  /** CREATE_HOLD 행에만 채운다 — RELEASE_HOLD 행은 계약이 요구한 `null`이다(빈 객체가 아니다). */
  impact: LotStatusTransitionImpact | null;
}

/** 계약 `LotStatusTransitionSet` 과 동형(required 3: lotId·currentLotStatusCode·transitions). */
export interface LotStatusTransitionSetView {
  lotId: number;
  currentLotStatusCode: string;
  transitions: LotStatusTransitionRow[];
  note?: string;
}

@Injectable()
export class LotStatusTransitionService {
  constructor(private readonly prisma: PrismaService) {}

  async getTransitions(lotId: number): Promise<LotStatusTransitionSetView> {
    const lot = await this.prisma.lot.findUnique({
      where: { lot_id: BigInt(lotId) },
      select: { status_code: true },
    });
    if (!lot) throw new NotFoundException('없는 LOT 입니다.');
    const current = lot.status_code;

    const entries = Object.values(TRANSITIONS[QUALITY_COLUMN] ?? {}).filter(
      (t) => t.sourceOperation === CREATE_HOLD_OP || t.sourceOperation === RELEASE_HOLD_OP,
    );
    const impact = await this.impactOf(BigInt(lotId));
    const transitions = entries.map((t) => rowOf(t, current, impact));

    return {
      lotId,
      currentLotStatusCode: current,
      transitions,
      ...(transitions.every((t) => !t.allowed) ? { note: NO_TRANSITION_NOTE } : {}),
    };
  }

  /**
   * `impact` 원천 — `logistics.picking_line`·`.picking_order`·`.goods_issue_line` **읽기만**
   * 한다(다른 도메인 service 호출 0 · 선례 `balance-query.ts` · `server-architecture.md:67`).
   * ⭐ **R-7 — 「요청」 건수다**(라인이 아니다) — `picking_order_id` 로 «구별해» 센다.
   */
  private async impactOf(lotId: bigint): Promise<LotStatusTransitionImpact> {
    const openOrders = await this.prisma.$queryRaw<{ open_picking_count: number }[]>`
      SELECT count(DISTINCT pl.picking_order_id)::int AS open_picking_count
        FROM logistics.picking_line pl
        JOIN logistics.picking_order po ON po.picking_order_id = pl.picking_order_id
       WHERE pl.lot_id = ${lotId}
         AND pl.picked_qty < pl.planned_qty
         AND po.status_code <> ${TERMINAL_PICKING_ORDER_STATUS}`;
    // ⛔ 예약분(picking_line.picked_qty)을 섞지 않는다 — 「이미 출고된」 원천은 goods_issue_line 뿐이다.
    // `status_code='POSTED'` 만 — 0단계 선례 `shortage.service.ts#issuedByItem`(기출고는 헤더가
    // POSTED 인 것만 센다 · I-8.md R-18). 취소된 출고는 「이미 나간 것」이 아니다. // 결정 — 통보 078
    const shipped = await this.prisma.goods_issue_line.aggregate({
      where: { lot_id: lotId, goods_issue: { status_code: 'POSTED' } },
      _sum: { issue_qty: true },
    });

    return {
      openPickingCount: openOrders[0]?.open_picking_count ?? 0,
      shippedQty: shipped._sum.issue_qty ? Number(shipped._sum.issue_qty) : 0,
    };
  }
}

function rowOf(
  transition: Transition,
  current: string,
  impact: LotStatusTransitionImpact,
): LotStatusTransitionRow {
  // R-13 — `allowed` 는 전이표 `from` 판정만 한다(실행 가능성·열린 보류 개수는 안 본다) —
  // 어느 보류를 쓸지는 이 오퍼레이션이 모른다(계약 `actionCode` 설명 — 그 선택은
  // `GET /quality/lot-holds?open=true` 가 진다). // 결정 — 통보 084
  const allowed = transition.from.includes(current);
  const actionCode = transition.sourceOperation === RELEASE_HOLD_OP ? 'RELEASE_HOLD' : 'CREATE_HOLD';

  return {
    targetLotStatusCode: transition.to,
    allowed,
    actionCode,
    ...(allowed
      ? {}
      : { blockedReason: `지금 상태(${LOT_STATUS_LABEL[current] ?? current})에서는 이 전이를 할 수 없습니다.` }),
    impact: actionCode === 'CREATE_HOLD' ? impact : null,
  };
}
