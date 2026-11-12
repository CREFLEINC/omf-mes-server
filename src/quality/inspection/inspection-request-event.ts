import { Prisma } from '@prisma/client';

/** IQC 변경 이력(`quality.inspection_request_event` · `INSPECTION_REQUEST_EVENT_TYPE`). */
export type InspectionRequestEventCode =
  | 'SKIP_VOIDED' | 'CANCELLED_BY_REOPEN' | 'RESULT_ADDED' | 'RESULT_UPDATED' | 'RESULT_DELETED' | 'CONFIRMED' | 'CONFIRM_CANCELLED'
  | 'SKIPPED' | 'REOPENED_BY_REWORK' | 'SPLIT_OUT' | 'SPLIT_IN';

/** 행위자는 하나 — 계정 또는 작업자(CHECK `num_nonnulls = 1`). */
export type InspectionRequestEventActor = { appUserId: number; workerId?: never } | { appUserId?: never; workerId: bigint };

export async function recordInspectionRequestEvent(
  tx: Prisma.TransactionClient,
  input: {
    inspectionRequestId: bigint;
    eventTypeCode: InspectionRequestEventCode;
    /** 결과 이벤트만 — 지운 결과도 id 를 남긴다(FK 없음). */
    inspectionResultId?: bigint;
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
      inspection_result_id: input.inspectionResultId ?? null,
      summary_before: input.summaryBefore,
      summary_after: input.summaryAfter,
      reason: input.reason ?? null,
      occurred_at: input.at,
      actor_user_id: input.actor.appUserId === undefined ? null : BigInt(input.actor.appUserId),
      actor_worker_id: input.actor.workerId ?? null,
    },
  });
}
