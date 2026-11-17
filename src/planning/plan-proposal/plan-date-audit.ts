import { Prisma } from '@prisma/client';

import { PlanningCalendarDay } from '../../core/calendar/working-day';
import { PRODUCTION_ORDER_AUDIT_TARGET } from './draft-replace';

export const PLAN_DATE_USER_ON_HOLIDAY = 'PLAN_DATE_USER_ON_HOLIDAY';

export interface UserHolidayDate {
  productionPlanId: number;
  planNo: string;
  planDate: string;
  /** 사람이 바꾸기 전의 시스템 날짜 — 시스템 날짜가 없는 계획이면 null. */
  systemDate: string | null;
  day: PlanningCalendarDay;
}

/**
 * 사람이 휴일 경고를 보고도 직접 정한 계획일(출처 USER)을 남긴다 — 계획마다 한 줄, 확정과 같은 트랜잭션.
 * 저장 규약은 작성중 계획 대체 기록(`draft-replace.ts`)과 같다 — 유형은 시스템 소유 값(UPDATE)이고 사건은 afterValue.eventCode, 내용은 afterValue.detail 이다.
 */
export async function recordUserHolidayDates(
  tx: Prisma.TransactionClient,
  entry: { orderId: bigint; plans: readonly UserHolidayDate[]; actorId: number | undefined; correlationId: string },
): Promise<void> {
  if (entry.plans.length === 0) return;
  const occurredAt = new Date();
  await tx.audit_event.createMany({
    data: entry.plans.map((plan) => ({
      occurred_at: occurredAt,
      target_type_code: PRODUCTION_ORDER_AUDIT_TARGET,
      target_id: entry.orderId,
      event_type_code: 'UPDATE',
      performed_by: entry.actorId === undefined ? null : BigInt(entry.actorId),
      correlation_id: entry.correlationId,
      before_value: { systemDate: plan.systemDate },
      after_value: {
        eventCode: PLAN_DATE_USER_ON_HOLIDAY,
        detail: {
          productionPlanId: plan.productionPlanId,
          planNo: plan.planNo,
          planDate: plan.planDate,
          calendarStatusCode: plan.day.statusCode,
          calendarReasonCode: plan.day.reasonCode,
        },
      },
    })),
  });
}
