import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';
import { omitEmpty } from '../../common/http/omit-empty';

/** 계약 `ProductionPlan`(14칸) 매퍼. ⛔ `splitOfPlanId` 는 응답에 없다(쓰기 전용, A11). */
export type ProductionPlanRow = Prisma.production_planGetPayload<object>;
export type ProductionPlanView = ReturnType<typeof productionPlanView>;

export function productionPlanView(row: ProductionPlanRow) {
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
  });
}

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));
const at = (value: Date | null): string | undefined => (value === null ? undefined : value.toISOString());
