import { Prisma } from '@prisma/client';

/** IQC 변경 이력(`quality.inspection_request_event` · `INSPECTION_REQUEST_EVENT_TYPE`). S8 이 결과 추가·수정·삭제·확정을 더한다. */
export type InspectionRequestEventCode = 'SKIP_VOIDED' | 'CANCELLED_BY_REOPEN';

/** 행위자는 하나 — 계정 또는 작업자(CHECK `num_nonnulls = 1`). */
export type InspectionRequestEventActor = { appUserId: number; workerId?: never } | { appUserId?: never; workerId: bigint };

export async function recordInspectionRequestEvent(
  tx: Prisma.TransactionClient,
  input: {
    inspectionRequestId: bigint;
    eventTypeCode: InspectionRequestEventCode;
    actor: InspectionRequestEventActor;
    at: Date;
    summaryBefore?: Prisma.InputJsonObject;
    summaryAfter?: Prisma.InputJsonObject;
    reason?: string | null;
  },
): Promise<void> {
  await tx.inspection_request_event.create({
    data: {
      inspection_request_id: input.inspectionRequestId,
      event_type_code: input.eventTypeCode,
      summary_before: input.summaryBefore,
      summary_after: input.summaryAfter,
      reason: input.reason ?? null,
      occurred_at: input.at,
      actor_user_id: input.actor.appUserId === undefined ? null : BigInt(input.actor.appUserId),
      actor_worker_id: input.actor.workerId ?? null,
    },
  });
}
