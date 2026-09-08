import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ActionName } from '../document-state/document-state.types';
import { TRANSITIONS } from '../document-state/transitions';
import { LotMoveResult } from './lot-lifecycle.service';
import { Tx } from './lot-registry.service';

/** LOT 품질 판정 축 — 생명주기 축(`lifecycle_status_code`)과 섞지 않는다(`02-SW설계사양서` §4.2). */
const QUALITY_COLUMN = 'trace.lot.status_code';

export interface LotQualityMoveContext {
  /** `lot_status_event.changed_by` 는 NOT NULL — 이 축은 사람이 전이시킨다(생명주기 축과 다르다). */
  changedBy: bigint;
  changedAt: Date;
  /** ⛔ `ck_lot_status_event_source` — 원천 문서 두 칸은 둘 다 주거나 둘 다 안 준다. */
  sourceDocumentTypeCode?: string;
  sourceDocumentId?: bigint;
  reasonCode?: string;
  reason?: string;
  /** 전이표에 코드가 없는 자리(재등록)만 채운다 — 설계 미정 · 문의 069+12. */
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
          source_document_id: ctx.sourceDocumentId,
          changed_at: ctx.changedAt,
          changed_by: ctx.changedBy,
          // ⛔ `quality_status_code`·`inventory_status_code`·`location_id` 는 비운다 —
          //    재고 «행»의 차원을 정할 축이 이 전이에 없다(원장을 지나지 않는다).
        },
      });
      moved.push(lot.lot_id);
    }
    return { movedLotIds: moved, skippedLotIds: skipped };
  }
}
