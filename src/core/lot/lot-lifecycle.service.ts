import { Injectable } from '@nestjs/common';

import { ActionName } from '../document-state/document-state.types';
import { TRANSITIONS } from '../document-state/transitions';
import { Tx } from './lot-registry.service';

/** 생산LOT 생명주기 축 — 품질 축(`status_code`)과 섞지 않는다(`02-SW설계사양서` §4.2). */
const LIFECYCLE_COLUMN = 'trace.lot.lifecycle_status_code';

export interface LotMoveInput {
  /** 여러 슬롯을 한 번에 — `:cancel` 은 그 W/O 의 선발행 슬롯 전건이다. */
  lotIds: bigint[];
  action: ActionName;
  sourceDocumentTypeCode: string;
  sourceDocumentId: bigint;
  changedAt: Date;
}

export interface LotMoveResult {
  movedLotIds: bigint[];
  skippedLotIds: bigint[];
}

/** 생산LOT 생명주기를 옮기고 이력을 남긴다. Prisma 는 안 받는다 — 호출자가 연 `tx` 로만 돈다. */
@Injectable()
export class LotLifecycleService {
  /**
   * ⛔ `DocumentStateService.assertTransition()` 을 쓰지 않는다 — 저쪽은 `from` 밖이면
   *    던지는데 여기는 건너뛰어야 해서 전이표를 직접 읽는다. 미등록 액션만 던진다.
   */
  async moveWithin(tx: Tx, input: LotMoveInput): Promise<LotMoveResult> {
    const moved: bigint[] = [];
    const skipped: bigint[] = [];
    const transition = TRANSITIONS[LIFECYCLE_COLUMN]?.[input.action];
    if (!transition) {
      throw new Error(
        `상태 전이가 등록되지 않았다: ${LIFECYCLE_COLUMN} / ${input.action} — ` +
          '값 목록이 오면 transitions.ts 에 더한다 (공유계약 F-6)',
      );
    }
    // 이력 칸이 NOT NULL 이다 — 코드가 없는 전이는 이 축에 실을 수 없다.
    const transitionCode = transition.transitionCode;
    if (transitionCode === undefined) throw new Error(`transitionCode 가 없다: ${input.action}`);
    // 미등록 액션 가드가 «빈 집합»(마감의 실적 없는 슬롯 0건)에서도 살아 있게 반환은 그 뒤다.
    if (input.lotIds.length === 0) return { movedLotIds: moved, skippedLotIds: skipped };

    const lots = await tx.lot.findMany({
      where: { lot_id: { in: input.lotIds } },
      select: { lot_id: true, lifecycle_status_code: true },
    });
    // 못 찾은 id 도 skipped 에 싣는다 — moved + skipped = 입력 집합이어야 호출자가 이력을 안 겹쳐 쓴다(R-12).
    const found = new Set(lots.map((lot) => lot.lot_id));
    skipped.push(...input.lotIds.filter((id) => !found.has(id)));

    for (const lot of lots) {
      const from = lot.lifecycle_status_code;
      // ⛔ `from` 밖이면 던지지 않고 «건너뛴다» — 대상 집합을 고르는 것은 호출자이고
      //    (마감은 실적 없는 슬롯만, 취소는 전건) 재시도면 이미 옮겨진 슬롯이 섞인다.
      if (from === null || !transition.from.includes(from)) {
        skipped.push(lot.lot_id);
        continue;
      }
      await tx.lot.update({
        where: { lot_id: lot.lot_id },
        // 응답에 실리는 칸이 바뀌므로 ETag(version_no)도 올린다 — 다른 전이 자리와 같다.
        data: { lifecycle_status_code: transition.to, version_no: { increment: 1 } },
      });
      await tx.lot_lifecycle_history.create({
        data: {
          lot_id: lot.lot_id,
          from_lifecycle_status_code: from,
          to_lifecycle_status_code: transition.to,
          transition_code: transitionCode,
          source_document_type_code: input.sourceDocumentTypeCode,
          source_document_id: input.sourceDocumentId,
          changed_at: input.changedAt,
        },
      });
      moved.push(lot.lot_id);
    }
    return { movedLotIds: moved, skippedLotIds: skipped };
  }
}
