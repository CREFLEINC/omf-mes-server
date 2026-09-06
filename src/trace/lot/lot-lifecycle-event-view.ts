import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/** `lotNo` 는 계약이 조인으로만 채울 수 있게 적은 한 칸이다. */
export const LOT_LIFECYCLE_EVENT_JOIN = { lot: { select: { lot_no: true } } } as const;

export type LotLifecycleEventRow = Prisma.lot_lifecycle_historyGetPayload<{
  include: typeof LOT_LIFECYCLE_EVENT_JOIN;
}>;
export type LotLifecycleEventView = ReturnType<typeof lotLifecycleEventView>;

/**
 * 계약 `LotLifecycleHistoryEvent`(required 5)로 옮기는 자리.
 * ⛔ 값이 없는 칸은 **키를 생략**한다 — `fromLifecycleStatusCode` 는 최초 전이(L1)에서
 *    비고, 그때 널이 아니라 키가 없다(형제 뷰 관행).
 */
export function lotLifecycleEventView(row: LotLifecycleEventRow) {
  return omitEmpty({
    lotLifecycleHistoryId: Number(row.lot_lifecycle_history_id),
    lotId: Number(row.lot_id),
    lotNo: row.lot.lot_no,
    fromLifecycleStatusCode: row.from_lifecycle_status_code ?? undefined,
    toLifecycleStatusCode: row.to_lifecycle_status_code,
    transitionCode: row.transition_code,
    sourceDocumentTypeCode: row.source_document_type_code ?? undefined,
    sourceDocumentId: row.source_document_id === null ? undefined : Number(row.source_document_id),
    changedAt: row.changed_at.toISOString(),
  });
}
