import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { PreIssuedLotSummaryView, WorkOrderProgressView } from './work-order-progress';

/**
 * 계약 `WorkOrder`(40칸) · `WorkOrderResourcePlan` 으로 옮기는 자리. 상세(PR ①)와 목록(PR ②)이
 * 같은 매퍼를 쓴다 — 물리 칸 이름 그대로 camelCase 이고 대조표는 I-6.md §2-1 이다.
 *
 * ⛔ 값이 없는 칸은 **키를 생략**한다 — 널을 내리면 계약의 「선택 필드」와 뜻이 갈린다
 * (`plan.md` §5 규칙 7 · 형제 `document-progress-view.ts` 관행).
 * ⛔ 40칸을 인터페이스로 한 벌 더 적지 않는다 — 두 곳에 두면 갈린다. 매퍼가 정본이다.
 */

/** 표시용 파생 넷의 조인 — 물리에 칸이 없다. P/O 는 계획을 경유해 잇는다(계약이 그렇게 적었다). */
export const DISPLAY_JOIN = {
  production_plan: { select: { production_order_id: true, production_order: { select: { production_order_no: true } } } },
  routing_operation: { select: { operation_name: true } },
  item: { select: { item_code: true } },
} as const;

export type WorkOrderRow = Prisma.work_orderGetPayload<{ include: typeof DISPLAY_JOIN }>;
export type WorkOrderView = ReturnType<typeof workOrderView>;

export function workOrderView(
  row: WorkOrderRow,
  extras: { progress?: WorkOrderProgressView; preIssuedLots?: PreIssuedLotSummaryView; erpMessageQueued: boolean },
) {
  return omitEmpty({
    workOrderId: Number(row.work_order_id),
    workOrderNo: row.work_order_no,
    productionPlanId: id(row.production_plan_id),
    routingOperationId: Number(row.routing_operation_id),
    itemId: Number(row.item_id),
    orderQty: Number(row.order_qty),
    uomId: Number(row.uom_id),
    workOrderTypeCode: row.work_order_type_code,
    parentWorkOrderId: id(row.parent_work_order_id),
    reworkSourceWorkOrderId: id(row.rework_source_work_order_id),
    reworkSourceLotId: id(row.rework_source_lot_id),
    reworkSourceNonconformanceId: id(row.rework_source_nonconformance_id),
    productionLineId: id(row.production_line_id),
    responsibleWorkerId: id(row.responsible_worker_id),
    plannedStartAt: at(row.planned_start_at),
    plannedEndAt: at(row.planned_end_at),
    plannedEquipmentId: id(row.planned_equipment_id),
    plannedMoldId: id(row.planned_mold_id),
    plannedShiftId: id(row.planned_shift_id),
    priorityNo: row.priority_no,
    defaultWipLocationId: id(row.default_wip_location_id),
    defaultFgLocationId: id(row.default_fg_location_id),
    defaultScrapLocationId: id(row.default_scrap_location_id),
    operationSettingsSnapshot: (row.operation_settings_snapshot as object | null) ?? undefined,
    statusCode: row.status_code,
    releasedAt: at(row.released_at),
    completedAt: at(row.completed_at),
    completionVarianceReasonCode: row.completion_variance_reason_code ?? undefined,
    closedAt: at(row.closed_at),
    // 마감 전에는 키가 «없다» — 계약 ⌜마감 전에는 비어 있다⌝. 널·false 를 내리지 않는다.
    erpMessageQueued: extras.erpMessageQueued ? true : undefined,
    remarks: row.remarks ?? undefined,
    productionOrderId: id(row.production_plan?.production_order_id ?? null),
    productionOrderNo: row.production_plan?.production_order.production_order_no,
    routingOperationName: row.routing_operation.operation_name,
    itemCode: row.item.item_code,
    poMismatch: row.po_mismatch,
    versionNo: row.version_no,
    progress: extras.progress,
    preIssuedLots: extras.preIssuedLots,
    // ⛔ 상세에 켤 스위치(`withValidation`)가 없다 — 언제나 키 생략(§7-6).
    validation: undefined,
  });
}

export type ResourcePlanRow = Prisma.work_order_resource_assignmentGetPayload<object>;
export type WorkOrderResourcePlanView = ReturnType<typeof workOrderResourcePlanView>;

/**
 * `resourceId` 는 **`resource_type_code` 로 갈라** 그 칸을 읽는다. ⛔ COALESCE 가 아니다 —
 * 판별자를 안 보면 계약 enum 밖 행(`SHIFT`)이 섞였을 때 조용히 틀린 값을 낸다(§2-2).
 * 그 밖 유형은 `resourceId` 키를 생략한다(지어내지 않는다).
 */
export function workOrderResourcePlanView(row: ResourcePlanRow) {
  const byType: Record<string, bigint | null> = { EQUIPMENT: row.equipment_id, WORKER: row.worker_id, MOLD: row.mold_id };
  return omitEmpty({
    workOrderResourcePlanId: Number(row.work_order_resource_assignment_id),
    workOrderId: Number(row.work_order_id),
    resourceTypeCode: row.resource_type_code,
    resourceId: id(byType[row.resource_type_code] ?? null),
  });
}

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));
const at = (value: Date | null): string | undefined => (value === null ? undefined : value.toISOString());
