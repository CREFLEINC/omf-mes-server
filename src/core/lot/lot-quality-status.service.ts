import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ActionName } from '../document-state/document-state.types';
import { TRANSITIONS } from '../document-state/transitions';
import { LotMoveResult } from './lot-lifecycle.service';
import { Tx } from './lot-registry.service';

/** LOT 품질 판정 축 — 생명주기 축(`lifecycle_status_code`)과 섞지 않는다(`02-SW설계사양서` §4.2). */
const QUALITY_COLUMN = 'trace.lot.status_code';

export interface LotQualityMoveContext {
  /** Account actor, when the transition is made from an account session. */
  changedBy?: bigint;
  /** Real worker actor for an accountless terminal transition. */
  changedWorkerId?: bigint;
  changedAt: Date;
  /**
   * ⛔ `ck_lot_status_event_source` — 유형과 id 는 **함께 산다**. R-12 로 id 쪽이 두 칸이 되어
   * 불변식은 「유형을 주면 **LOT 전건이** 지도나 배치 값으로 id 를 얻는다」다(아래가 막는다).
   */
  sourceDocumentTypeCode?: string;
  sourceDocumentId?: bigint;
  /**
   * ⭐ **R-12** — 배치의 LOT 마다 원천 문서가 «다를» 때 쓴다(N LOT 보류 등록은 LOT 마다
   * 자기 `lot_hold_id` 를 가리켜야 하는데 위 한 칸으로는 「첫 것」밖에 못 담는다).
   * 없는 LOT 은 위 배치 값으로 떨어진다.
   */
  sourceDocumentIdByLot?: ReadonlyMap<bigint, bigint>;
  reasonCode?: string;
  reason?: string;
  /**
   * 전이표에 코드가 «없는» 축만 채운다. ⛔ **표가 이긴다**(`:62`) — 표가 값을 가진 액션에
   * 넘기면 무시된다. 한 사실을 두 자리에 적지 않기 위해서다(L-2-1).
   * ⚠ 오늘 이 인자를 쓰는 호출부는 **0개**다 — 재등록이 C20 을 갖게 되면서 비었다(통보 218).
   * 갈래를 남겨 둔 이유는 전이표에 코드가 없는 새 축이 열릴 때를 위해서다.
   */
  transitionCode?: string;
}

/**
 * LOT 품질 판정을 옮기고 이력을 남긴다. 형제 코어(생명주기)와 «같은» 반환 규약을 쓴다 —
 * `moved + skipped = 입력 집합`. Prisma 는 안 받는다: 호출자가 연 `tx` 로만 돈다.
 */
@Injectable()
export class LotQualityStatusService {
  /**
   * ⛔ `DocumentStateService.assertTransition()` 을 쓰지 않는다 — 저쪽은 `from` 밖이면
   *    던지는데 여기는 건너뛰어야 한다. `C14` 는 한 W/O 의 생산LOT «전건»을 옮기므로
   *    `SCRAPPED` 하나가 섞였다고 PQC 확정이 통째로 막히면 안 된다. 미등록 액션만 던지고,
   *    단건 액션에서 「안 옮겨졌다」를 400/409 로 낼지는 호출자가 정한다.
   */
  async moveWithin(
    tx: Tx,
    lotIds: bigint[],
    action: ActionName,
    ctx: LotQualityMoveContext,
  ): Promise<LotMoveResult> {
    if ((ctx.changedBy === undefined) === (ctx.changedWorkerId === undefined)) {
      throw new Error('LOT 품질 전이에는 계정 또는 작업자 주체 하나가 필요합니다.');
    }
    const moved: bigint[] = [];
    const skipped: bigint[] = [];
    const transition = TRANSITIONS[QUALITY_COLUMN]?.[action];
    if (!transition) {
      throw new Error(
        `상태 전이가 등록되지 않았다: ${QUALITY_COLUMN} / ${action} — ` +
          '값 목록이 오면 transitions.ts 에 더한다 (공유계약 F-6)',
      );
    }
    // 이력 칸이 NOT NULL 이다. 전이표가 코드를 안 가진 자리는 호출자가 넘겨야 실린다.
    const transitionCode = transition.transitionCode ?? ctx.transitionCode;
    if (transitionCode === undefined) throw new Error(`transitionCode 가 없다: ${action}`);
    // ⛔ 지도가 «부분»이고 배치 값도 없으면 지도 밖 LOT 이 `ck_lot_status_event_source` 를 깨 500 이다.
    const sourceIdOf = (lotId: bigint) => ctx.sourceDocumentIdByLot?.get(lotId) ?? ctx.sourceDocumentId;
    if (ctx.sourceDocumentTypeCode !== undefined && lotIds.some((id) => sourceIdOf(id) === undefined)) {
      throw new Error('원천 문서 유형을 주면 LOT 전건이 문서 id 를 가져야 한다 (ck_lot_status_event_source)');
    }
    // 미등록 액션 가드가 «빈 집합»에서도 살아 있게 반환은 그 뒤다.
    if (lotIds.length === 0) return { movedLotIds: moved, skippedLotIds: skipped };

    // ⛔ `SELECT … FOR UPDATE` — 읽고 판정하고 쓰는 사이에 보류가 걸리면 옛 상태로 판정한다.
    //    생명주기 축은 W/O 하나가 소유해 경합이 없지만 이 축은 검사·보류·재등록이 겹친다.
    const lots = await tx.$queryRaw<{ lot_id: bigint; status_code: string }[]>`
      SELECT lot_id, status_code
        FROM trace.lot
       WHERE lot_id IN (${Prisma.join(lotIds.map((id) => Prisma.sql`${id}::bigint`))})
       ORDER BY lot_id
         FOR UPDATE`;
    // 못 찾은 id 도 skipped 에 싣는다 — moved + skipped = 입력 집합이어야 호출자가 센다.
    const found = new Set(lots.map((lot) => lot.lot_id));
    skipped.push(...lotIds.filter((id) => !found.has(id)));

    for (const lot of lots) {
      if (!transition.from.includes(lot.status_code)) {
        skipped.push(lot.lot_id);
        continue;
      }
      await tx.lot.update({
        where: { lot_id: lot.lot_id },
        // 응답에 실리는 칸이 바뀌므로 ETag(version_no)도 올린다 — 다른 전이 자리와 같다.
        data: { status_code: transition.to, version_no: { increment: 1 } },
      });
      await tx.lot_status_event.create({
        data: {
          lot_id: lot.lot_id,
          previous_status_code: lot.status_code,
          new_status_code: transition.to,
          transition_code: transitionCode,
          reason_code: ctx.reasonCode,
          reason: ctx.reason,
          source_document_type_code: ctx.sourceDocumentTypeCode,
          source_document_id: sourceIdOf(lot.lot_id),
          changed_at: ctx.changedAt,
          changed_by: ctx.changedBy ?? null,
          changed_worker_id: ctx.changedWorkerId ?? null,
          // ⛔ `quality_status_code`·`inventory_status_code`·`location_id` 는 비운다 —
          //    재고 «행»의 차원을 정할 축이 이 전이에 없다(원장을 지나지 않는다).
        },
      });
      moved.push(lot.lot_id);
    }
    return { movedLotIds: moved, skippedLotIds: skipped };
  }
}
