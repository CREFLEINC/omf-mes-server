import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { optional } from '../../common/master';
import type { Tx } from './lot-registry.service';

/**
 * LOT 3축의 ③ **작업 홀드**(`server-architecture.md:145-147` — `trace.lot_hold` 가 LOT 세 표 중
 * 하나다). 도메인이 이 표를 직접 쓰지 않게 **쓰기와 잠금만** 진다 —
 * `server-architecture.md:67`(「도메인이 다른 도메인의 service 를 부르지 않는다 — 공유가
 * 필요하면 그것은 `core` 다」).
 *
 * ⛔ **업무 게이트는 여기 없다** — 409 셋(`VERSION_CONFLICT`·`DUPLICATE_HOLD`·
 *    `HOLD_QTY_EXCEEDED`)과 400 갈래는 도메인 몫이다.
 *
 * ⛔ `lot-registry.service.ts` 는 **값 import 를 하지 않는다**(`import type` 뿐) — 등록 코어가
 *    이 서비스를 주입받으므로 값으로 맞물리면 Nest 가 DI 메타데이터를 읽을 때 순환한다.
 */

/**
 * ⚠ `LOT_HOLD_STATUS` 코드 그룹이 시드에 **없다** — 컬럼이 NOT NULL 이라 넣을 뿐이다.
 * ⛔ 해제 판정은 이 값이 아니라 **`released_at IS NULL`** 로만 한다(§Z-3 · 문의 13).
 */
export const HOLD_STATUS = 'HELD';

/** 보류가 남기는 「이 사람·이 시각」 — 한 트랜잭션의 여러 행이 같은 값을 나눠 쓴다. */
export interface LotHoldActor {
  by: bigint;
  at: Date;
}

/** 보류 한 건이 받는 칸 — 계약 `LotHoldCreate.lots[]` 의 전 칸이 여기 담긴다. */
export interface LotHoldInput {
  lotId: bigint;
  reasonCode: string;
  /** ⛔ NULL 이 **전량 보류**다 — 0 이 아니다(열린 전량 판정이 `hold_qty IS NULL`). */
  holdQty?: Prisma.Decimal | null;
  uomId?: bigint | null;
  releaseCondition?: string | null;
  /** 이 보류가 LOT 을 **보낸** 곳. ⛔ 「지금 상태」가 아니다(R-9 · `lot-view.ts:121-132`). */
  targetLotStatusCode?: string | null;
  remarks?: string | null;
}

/** 무엇을 푸나 — 안 좁히면 그 LOT 의 열린 보류 **전건**이다(`:confirm` 은 사유로, `:release` 는 id 로 좁힌다). */
export interface LotHoldReleaseTarget {
  lotId: bigint;
  lotHoldIds?: bigint[];
  reasonCode?: string;
}

/** 해제가 원 행에 남기는 칸 — 계약 `LotHoldRelease` 의 전 칸이 여기 담긴다. */
export interface LotHoldReleaseInput {
  releaseReasonCode: string;
  /** ⭐ **실제로 보낸** 도착만 쓴다 — 안 움직였으면 주지 않는다(R-2). */
  releaseTargetLotStatusCode?: string | null;
  remarks?: string | null;
  /** 부분 해제량. ⛔ 보류 두 건 이상을 한 번에 풀 때는 못 준다(어느 행에서 뺄지가 없다). */
  releaseQty?: Prisma.Decimal | null;
}

export type LotHoldRow = Prisma.lot_holdGetPayload<object>;

declare const lockToken: unique symbol;
/**
 * `lockLotsWithin()` 만 만들 수 있는 표식 — 쓰기가 이 값을 **인자로 요구해** 잠금 없이는
 * 컴파일되지 않는다. R-5 를 주석이 아니라 타입으로 못 박는 자리다.
 */
export interface LockedLot {
  readonly [lockToken]: true;
  lot_id: bigint;
  status_code: string;
  version_no: number;
}

@Injectable()
export class LotHoldService {
  /**
   * ⭐⭐ **R-5 — 이 잠금이 보류 쓰기와 「열린 보류 재계수」보다 «먼저»다.** 밖이면 ⓐ 같은
   * LOT 의 보류 둘을 동시에 풀 때 서로를 열린 것으로 세어 **둘 다 안 옮기고 LOT 이 영원히
   * 갇히고** ⓑ 동시 등록과 겹치면 **열린 보류를 둔 채 `NORMAL` 로 간다**.
   *
   * 0단계 선례 `core/inventory-posting/balance-lock.ts`(I-4 R-1 ② · I-5 R-5) 그대로 —
   * **한 문장에 id 오름차순**으로 잡는다. 나눠 잡으면 두 트랜잭션이 같은 두 LOT 을 반대
   * 순서로 잡아 교착한다.
   */
  async lockLotsWithin(tx: Tx, lotIds: bigint[]): Promise<LockedLot[]> {
    if (lotIds.length === 0) return [];
    return tx.$queryRaw<LockedLot[]>`
      SELECT lot_id, status_code, version_no
        FROM trace.lot
       WHERE lot_id IN (${Prisma.join(lotIds.map((id) => Prisma.sql`${id}::bigint`))})
       ORDER BY lot_id
         FOR UPDATE`;
  }

  /** 보류 N 건 INSERT. 반환 순서가 입력 순서다 — 호출자가 LOT 마다 `lot_hold_id` 를 되짚는다(R-12). */
  async holdWithin(tx: Tx, locked: LockedLot[], inputs: LotHoldInput[], actor: LotHoldActor): Promise<LotHoldRow[]> {
    const rows: LotHoldRow[] = [];
    for (const input of inputs) {
      assertLocked(locked, input.lotId);
      rows.push(
        await tx.lot_hold.create({
          data: {
            lot_id: input.lotId,
            reason_code: input.reasonCode,
            // ⛔ 해제 판정은 이 값이 아니라 `released_at IS NULL` 로만 한다(문의 13 — 시드 0건).
            status_code: HOLD_STATUS,
            hold_qty: input.holdQty ?? null,
            uom_id: input.uomId ?? null,
            release_condition: input.releaseCondition ?? null,
            target_lot_status_code: input.targetLotStatusCode ?? null,
            remarks: input.remarks ?? null,
            held_by: actor.by,
            held_at: actor.at,
            created_by: actor.by,
          },
        }),
      );
    }
    return rows;
  }

  /**
   * 열린 보류를 닫고, 부분이면 **잔량 행**을 세우고, **남은 열린 보류를 다시 센다**.
   *
   * ⭐⭐ 재계수를 «호출자에게 맡기지 않는» 것이 R-5 의 처방이다 — 밖에서 세면 그 한 문장이
   * 잠금 밖으로 새어 나간다. 읽기·쓰기·재계수가 한 함수 안이라 셋이 같은 잠금을 공유한다.
   * ⛔ `status_code` 를 안 건드린다 — `LOT_HOLD_STATUS` 값 목록이 시드에 0건이다(문의 13).
   * `version_no` 는 오늘 읽는 코드가 0줄이지만(R-24) 올려 둔다 — 죽은 칸을 «틀린» 값으로
   * 남기면 나중에 `runVersioned` 류가 집었을 때 조용히 통과한다.
   */
  async releaseWithin(
    tx: Tx,
    locked: LockedLot[],
    target: LotHoldReleaseTarget,
    input: LotHoldReleaseInput,
    actor: LotHoldActor,
  ): Promise<{ released: LotHoldRow[]; openAfter: number }> {
    assertLocked(locked, target.lotId);
    const holds = await tx.lot_hold.findMany({
      where: {
        lot_id: target.lotId,
        released_at: null,
        ...optional('reason_code', target.reasonCode),
        ...optional('lot_hold_id', target.lotHoldIds && { in: target.lotHoldIds }),
      },
      orderBy: { lot_hold_id: 'asc' },
    });
    if (input.releaseQty != null && holds.length !== 1) {
      throw new Error('부분 해제는 보류 한 건에서만 한다 — 어느 행에서 뺄지가 정해지지 않는다');
    }
    const released: LotHoldRow[] = [];
    for (const hold of holds) {
      released.push(
        await tx.lot_hold.update({
          where: { lot_hold_id: hold.lot_hold_id },
          data: {
            released_at: actor.at,
            released_by: actor.by,
            release_reason_code: input.releaseReasonCode,
            release_target_lot_status_code: input.releaseTargetLotStatusCode ?? null,
            ...optional('remarks', input.remarks),
            version_no: { increment: 1 },
          },
        }),
      );
      const rest = remainderQty(hold.hold_qty, input.releaseQty);
      if (rest === null) continue;
      await tx.lot_hold.create({
        data: {
          lot_id: hold.lot_id,
          reason_code: hold.reason_code,
          status_code: hold.status_code,
          uom_id: hold.uom_id,
          release_condition: hold.release_condition,
          target_lot_status_code: hold.target_lot_status_code,
          remarks: hold.remarks,
          hold_qty: rest,
          // 잔량은 «지금·이 사람»이 새로 건 보류다 — 원 행의 시각을 베끼면 이력이 거꾸로 선다(문의 079).
          held_by: actor.by,
          held_at: actor.at,
          created_by: actor.by,
        },
      });
    }
    const openAfter = await tx.lot_hold.count({ where: { lot_id: target.lotId, released_at: null } });
    return { released, openAfter };
  }
}

/**
 * 부분 해제가 남길 잔량. ⭐ **`releaseQty == hold_qty` 면 `null`** — `app.qty_t` 가
 * `CHECK (VALUE >= 0)` 이라 **0 짜리 행이 조용히 INSERT** 되고, 그러면 전량을 풀었는데 열린
 * 보류가 남아 LOT 이 영원히 안 움직인다(R-6).
 */
function remainderQty(holdQty: Prisma.Decimal | null, releaseQty: Prisma.Decimal | null | undefined): Prisma.Decimal | null {
  if (releaseQty === null || releaseQty === undefined || holdQty === null) return null;
  const rest = holdQty.minus(releaseQty);
  return rest.lessThanOrEqualTo(0) ? null : rest;
}

/** 잠근 집합 밖의 LOT 에 쓰면 호출자 버그다 — 400 이 아니라 못 일어날 일이다. */
export function assertLocked(locked: LockedLot[], lotId: bigint): void {
  if (!locked.some((lot) => lot.lot_id === lotId)) {
    throw new Error(`잠그지 않은 LOT 의 보류를 쓴다: ${lotId} (R-5 — lockLotsWithin 이 먼저다)`);
  }
}
