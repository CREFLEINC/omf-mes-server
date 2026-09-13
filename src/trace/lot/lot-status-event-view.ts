import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/** `lotNo` 는 계약이 조인으로만 채울 수 있게 적은 한 칸이다 — 형제(`lot-lifecycle-event-view.ts`)와 같다. */
export const LOT_STATUS_EVENT_JOIN = { lot: { select: { lot_no: true } } } as const;

export type LotStatusEventRow = Prisma.lot_status_eventGetPayload<{
  include: typeof LOT_STATUS_EVENT_JOIN;
}>;
export type LotStatusEventView = ReturnType<typeof lotStatusEventView>;

/**
 * 계약 `LotStatusHistoryEvent`(required 6)로 옮기는 자리 — 형제 뷰의 직역 복제.
 *
 * ⭐ R-3 — `sourceDocumentTypeCode` 는 값이 없으면 **키를 생략**한다(널이 «아니다»).
 * 계약이 `[string,null]` + 닫힌 enum 3값으로 적어 널이 그 enum 을 통과하지 못한다
 * (형제 `lot-lifecycle-event-view.ts:19·26` 과 같은 `omitEmpty` + `?? undefined` 관행).
 * 짝인 `sourceDocumentId` 는 `ck_lot_status_event_source` 로 둘이 함께 비거나 함께
 * 차므로 같은 자리에서 같이 뺀다. `fromStatusCode` 도 같은 관행을 따른다 — 최초 등록
 * 전이(C4·C6·C14)는 값이 없다.
 */
export function lotStatusEventView(row: LotStatusEventRow) {
  return omitEmpty({
    lotStatusHistoryId: Number(row.lot_status_event_id),
    lotId: Number(row.lot_id),
    lotNo: row.lot.lot_no,
    fromStatusCode: row.previous_status_code ?? undefined,
    toStatusCode: row.new_status_code,
    transitionCode: row.transition_code,
    reason: row.reason ?? undefined,
    sourceDocumentTypeCode: row.source_document_type_code ?? undefined,
    sourceDocumentId: row.source_document_id === null ? undefined : Number(row.source_document_id),
    changedBy: row.changed_by === null ? null : Number(row.changed_by),
    changedWorkerId: row.changed_worker_id === null ? null : Number(row.changed_worker_id),
    changedAt: row.changed_at.toISOString(),
  });
}
