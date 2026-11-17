import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';
import { PlanningCalendarDay } from '../../core/calendar/working-day';
import { ExistingDraft } from './proposal-builder';

/**
 * 계획 제안 확정이 남기는 감사 기록 — 사람이 «알고 허용한 것»만 남긴다(작성중 계획 대체 · 입고 창고 수동 변경 · 휴일인 직접 지정 계획일).
 * 대상은 ERP W/O(`GET /audit/events?targetTypeCode=PRODUCTION_ORDER`)이고 확정 요청의 Idempotency-Key 를 correlationId 로 묶는다.
 * ⛔ 확정과 같은 트랜잭션에서 부른다 — 롤백되면 기록도 없고, 같은 키 재전송은 처음 응답을 재생해 다시 기록하지 않는다.
 * 저장 규약은 다른 업무 기록(`request-lifecycle.ts`)과 같다 — 유형은 시스템 소유 값(CREATE·UPDATE·DELETE)이고 사건은 afterValue.eventCode,
 * 내용은 afterValue.detail 이다.
 */
export const PRODUCTION_ORDER_AUDIT_TARGET = 'PRODUCTION_ORDER';
export const PLAN_DRAFT_REPLACED = 'PLAN_DRAFT_REPLACED';
export const PLAN_DATE_USER_ON_HOLIDAY = 'PLAN_DATE_USER_ON_HOLIDAY';
export const FG_WAREHOUSE_OVERRIDDEN = 'FG_WAREHOUSE_OVERRIDDEN';

export interface AuditContext {
  orderId: bigint;
  actorId: number | undefined;
  correlationId: string;
}

interface AuditEntry {
  eventTypeCode: 'UPDATE' | 'DELETE';
  before: Prisma.InputJsonObject;
  eventCode: string;
  detail: Prisma.InputJsonObject;
}

async function record(tx: Prisma.TransactionClient, context: AuditContext, entries: readonly AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const occurredAt = new Date();
  await tx.audit_event.createMany({
    data: entries.map((entry) => ({
      occurred_at: occurredAt,
      target_type_code: PRODUCTION_ORDER_AUDIT_TARGET,
      target_id: context.orderId,
      event_type_code: entry.eventTypeCode,
      performed_by: context.actorId === undefined ? null : BigInt(context.actorId),
      correlation_id: context.correlationId,
      before_value: entry.before,
      after_value: { eventCode: entry.eventCode, detail: entry.detail },
    })),
  });
}

/** 「새로 한다」로 지운 작성중 계획과 그 자리에 확정한 새 계획. */
export function recordDraftsReplaced(tx: Prisma.TransactionClient, context: AuditContext, drafts: readonly ExistingDraft[], newPlanIds: readonly bigint[]): Promise<void> {
  if (drafts.length === 0) return Promise.resolve();
  return record(tx, context, [{
    eventTypeCode: 'DELETE',
    before: {
      drafts: drafts.map(({ row }) => ({
        productionPlanId: Number(row.production_plan_id),
        planNo: row.plan_no,
        versionNo: row.version_no,
        planDate: toDateString(row.plan_date),
        plannedQty: row.planned_qty.toNumber(),
      })),
    },
    eventCode: PLAN_DRAFT_REPLACED,
    detail: { newPlanIds: newPlanIds.map(Number) },
  }]);
}

export interface UserHolidayDate {
  productionPlanId: number;
  planNo: string;
  planDate: string;
  /** 사람이 바꾸기 전의 시스템 날짜 — 시스템 날짜가 없는 계획이면 null. */
  systemDate: string | null;
  day: PlanningCalendarDay;
}

/** 휴일 경고를 보고도 직접 정한 계획일(출처 USER) — 계획마다 한 줄. */
export function recordUserHolidayDates(tx: Prisma.TransactionClient, context: AuditContext, plans: readonly UserHolidayDate[]): Promise<void> {
  return record(tx, context, plans.map((plan) => ({
    eventTypeCode: 'UPDATE',
    before: { systemDate: plan.systemDate },
    eventCode: PLAN_DATE_USER_ON_HOLIDAY,
    detail: {
      productionPlanId: plan.productionPlanId,
      planNo: plan.planNo,
      planDate: plan.planDate,
      calendarStatusCode: plan.day.statusCode,
      calendarReasonCode: plan.day.reasonCode,
    },
  })));
}

export interface FgOverride {
  productionPlanId: number;
  planNo: string;
  erpStorageLocationCode: string;
  erp: { warehouseId: number; warehouseCode: string; locationId: number };
  applied: { warehouseId: number; warehouseCode: string };
  workOrders: { workOrderId: number; defaultFgLocationId: number }[];
}

/**
 * ERP 입고 창고(SL_CD)와 다르게 고른 완제품 입고 창고 — 계획마다 한 줄. ERP 는 SL_CD 창고로 입고하고 MES 생산입고 송신은 창고를
 * 싣지 않으므로 MES 와 ERP 의 재고 위치가 달라진다 — 사람이 확인 메시지에 동의했다(erpMismatchAcknowledged).
 */
export function recordFgOverrides(tx: Prisma.TransactionClient, context: AuditContext, overrides: readonly FgOverride[]): Promise<void> {
  return record(tx, context, overrides.map((override) => ({
    eventTypeCode: 'UPDATE',
    before: { erpStorageLocationCode: override.erpStorageLocationCode, warehouseId: override.erp.warehouseId, warehouseCode: override.erp.warehouseCode, locationId: override.erp.locationId },
    eventCode: FG_WAREHOUSE_OVERRIDDEN,
    detail: {
      productionPlanId: override.productionPlanId,
      planNo: override.planNo,
      warehouseId: override.applied.warehouseId,
      warehouseCode: override.applied.warehouseCode,
      workOrders: override.workOrders,
      erpMismatchAcknowledged: true,
    },
  })));
}
