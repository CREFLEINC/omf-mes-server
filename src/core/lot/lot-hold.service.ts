import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
}

/** 잠근 집합 밖의 LOT 에 쓰면 호출자 버그다 — 400 이 아니라 못 일어날 일이다. */
export function assertLocked(locked: LockedLot[], lotId: bigint): void {
  if (!locked.some((lot) => lot.lot_id === lotId)) {
    throw new Error(`잠그지 않은 LOT 의 보류를 쓴다: ${lotId} (R-5 — lockLotsWithin 이 먼저다)`);
  }
}
