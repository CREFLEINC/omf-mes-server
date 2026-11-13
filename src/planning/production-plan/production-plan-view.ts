import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';
import { omitEmpty } from '../../common/http/omit-empty';
import { PlanningCalendarDay } from '../../core/calendar/working-day';
import { calendarsOfPlans } from './plan-date-calendar';

/** 계약 `ProductionPlan` 매퍼. ⛔ `splitOfPlanId` 는 응답에 없다(쓰기 전용, A11). */
export type ProductionPlanRow = Prisma.production_planGetPayload<object>;
export type ProductionPlanView = ReturnType<typeof productionPlanView>;

/** 계획일 판정은 응답마다 그때의 캘린더로 다시 한다 — 휴일·판정 불가는 경고 정보다. */
export async function planViews(client: Prisma.TransactionClient, rows: readonly ProductionPlanRow[]): Promise<ProductionPlanView[]> {
  const days = await calendarsOfPlans(client, rows);
  return rows.map((row, index) => productionPlanView(row, days[index]));
}

export function productionPlanView(row: ProductionPlanRow, day: PlanningCalendarDay) {
  return omitEmpty({
    productionPlanId: Number(row.production_plan_id),
    productionOrderId: Number(row.production_order_id),
    planNo: row.plan_no,
    planDate: toDateString(row.plan_date) as string,
    plannedQty: Number(row.planned_qty),
    uomId: Number(row.uom_id),
    bomId: Number(row.bom_id),
    routingId: Number(row.routing_id),
    plannedLineId: id(row.planned_line_id),
    statusCode: row.status_code,
    confirmedAt: at(row.confirmed_at),
    confirmedBy: id(row.confirmed_by),
    remarks: row.remarks ?? undefined,
    versionNo: row.version_no,
    planDateSourceCode: row.plan_date_source_code,
    planDateCalendar: day,
    // 시스템이 고른 날이 그 뒤 휴일이 된 작성중 계획만 — 사용자가 고른 날은 경고만 한다.
    planDateReviewRequired: row.status_code === 'DRAFT' && row.plan_date_source_code === 'SYSTEM' && day.statusCode === 'HOLIDAY',
  });
}

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));
const at = (value: Date | null): string | undefined => (value === null ? undefined : value.toISOString());
