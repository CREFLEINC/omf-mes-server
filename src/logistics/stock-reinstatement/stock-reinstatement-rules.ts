import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field } from '../../common/errors';

/**
 * 재고 재등록의 «수량 판정» 둘 — HTTP·DB 를 모른다(행은 호출자가 읽어 넘긴다). 전수 변이를 단위로 돌린다.
 */

export const ALREADY_REINSTATED = 'ALREADY_REINSTATED';

/** 보류를 «어떻게» 닫는가 — 코어 `releaseWithin` 의 `releaseQty` 를 줄지 말지. */
export type HoldReleasePlan = { kind: 'full' } | { kind: 'partial'; releaseQty: Prisma.Decimal };

/**
 * ⭐⭐ **부분 재등록**(R-4 · 계약 `qty` 「부분 재등록을 허용한다」 · required `remainingHeldQty`).
 *
 * | 보류 수량 | 재등록 수량 | 판정 |
 * |---|---|---|
 * | 있음 | 그보다 큼 | 400 `RANGE` |
 * | 있음 | 그보다 작음 | **부분** — 코어가 잔량 행을 세우고 `openAfter ≥ 1` 이라 LOT 을 안 옮긴다 |
 * | 있음 | 같음 | 전량 |
 * | **없음(전량 보류)** | 불량 잔액보다 작음 | ⛔ **400 `RANGE`** |
 * | 없음 | 불량 잔액 이상 | 전량 |
 *
 * ⛔ **전량 보류(`hold_qty` NULL)는 부분으로 풀 수 없다** — 코어 `remainderQty` 가 NULL 보류에는 잔량을
 *    «안» 세운다(`lot-hold.service.ts:206-210`). 그대로 닫으면 **재등록 안 한 불량 수량이 보류 없이
 *    풀려** `openAfter` 가 0 이 되고 LOT 이 `NORMAL` 로 간다 — R-4 가 막으려던 바로 그 사고다.
 *    ⇒ 거절한다. 설계가 「전량 보류에도 잔량 행을 세운다」로 오면 코어 한 줄이다(통보 222 ⓔ).
 */
export function planHoldRelease(
  holdQty: Prisma.Decimal | null,
  qty: Prisma.Decimal,
  defectAvailable: Prisma.Decimal,
): HoldReleasePlan {
  if (holdQty === null) {
    if (qty.lessThan(defectAvailable)) {
      throw rangeError('전량 보류는 부분 재등록할 수 없습니다 — 남은 불량 수량이 보류 없이 풀립니다.');
    }
    return { kind: 'full' };
  }
  if (qty.greaterThan(holdQty)) throw rangeError('보류 수량보다 많이 재등록할 수 없습니다.');
  return qty.lessThan(holdQty) ? { kind: 'partial', releaseQty: qty } : { kind: 'full' };
}

/**
 * ⭐ **처분 수량 한도** — 원천은 `stock_transfer.disposition_decision_id` 로 이은 이동들의 도착 합이다
 * (PR ① 마이그의 칸 · 계획서 §2-3 부산물 1).
 * ⛔ 「이미 한 번 했다」로 막지 않는다 — 부분 재등록이 본길이다. 합이 처분 수량에 «닿았을» 때만 409 다.
 */
export function assertWithinDecision(
  alreadyReinstated: Prisma.Decimal,
  decisionQty: Prisma.Decimal,
  qty: Prisma.Decimal,
): void {
  if (alreadyReinstated.greaterThanOrEqualTo(decisionQty)) {
    throw new ConflictException('user', '이 처분 결정은 이미 전량 재등록됐습니다.', { code: ALREADY_REINSTATED });
  }
  if (alreadyReinstated.plus(qty).greaterThan(decisionQty)) {
    throw rangeError('처분 수량을 넘겨 재등록할 수 없습니다.');
  }
}

const rangeError = (message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [field('qty', ERROR_CODE.RANGE, message)]);
