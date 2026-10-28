import { Prisma } from '@prisma/client';
import type { WorklistState } from './production-order-worklist';

import { omitEmpty } from '../../common/http/omit-empty';
import { toDateString } from '../../common/master';
import { AutoPlanView } from './auto-plan';
import { ProductionOrderProgressStatus } from './production-order-progress';

/** 계약 `ProductionOrder` 매퍼. ⛔ 파생 두 칸(expanded/plannedWorkOrderCount)은
 * 행이 없어도 0 을 낸다(키 생략이 아니다 — I-24.md §5-1). 나머지는 `omitEmpty`. */
export type ProductionOrderRow = Prisma.production_orderGetPayload<object>;
export type ProductionOrderChangeFieldRow = Prisma.production_order_change_fieldGetPayload<object>;

/**
 * 서버가 «수량 → 계획 시작일 → 납기 → 상태» 고정 순으로 낸다(§5-4) — 화면이 정렬하지 않는다.
 * `PLANNED_START_DATE` 는 계약 enum 밖이다 — ERP 가 바꾸는 날짜가 시작일뿐이라 서버가 더했다(장부 P-66).
 */
export const CHANGED_FIELD_ORDER = ['ORDER_QTY', 'PLANNED_START_DATE', 'DUE_DATE', 'STATUS_CODE'] as const;
const FIELD_LABEL: Record<(typeof CHANGED_FIELD_ORDER)[number], string> = {
  ORDER_QTY: '수량',
  PLANNED_START_DATE: '계획 시작일',
  DUE_DATE: '납기',
  STATUS_CODE: '상태',
};

export interface ProductionOrderChangedField {
  field: string;
  label: string;
  beforeText: string;
  afterText: string;
  beforeQty: number | null;
}
export interface ProductionOrderLastChange {
  receivedAt: string;
  changedFields: ProductionOrderChangedField[];
}
export interface ProductionOrderAcknowledgement {
  acknowledgedAt: Date;
  acknowledgedBy: bigint | null;
  acknowledgeDecisionCode: string | null;
}
export interface ProductionOrderExtras {
  expandedWorkOrderCount: number;
  plannedWorkOrderCount: number;
  progressStatusCode?: ProductionOrderProgressStatus;
  acknowledgement?: ProductionOrderAcknowledgement;
  lastChange?: ProductionOrderLastChange;
  autoPlan?: AutoPlanView | null;
  worklistState?: WorklistState;
}

export type ProductionOrderView = ReturnType<typeof productionOrderView>;

export function productionOrderView(row: ProductionOrderRow, extras: ProductionOrderExtras) {
  const ack = extras.acknowledgement;
  return omitEmpty({
    productionOrderId: Number(row.production_order_id),
    productionOrderNo: row.production_order_no,
    erpOrderNo: row.erp_order_no ?? undefined,
    parentProductionOrderId: id(row.parent_production_order_id),
    bomLevel: row.bom_level,
    businessUnitId: Number(row.business_unit_id),
    plantId: Number(row.plant_id),
    itemId: Number(row.item_id),
    orderQty: Number(row.order_qty),
    uomId: Number(row.uom_id),
    dueDate: toDateString(row.due_date) ?? undefined,
    // ↓ 계약 밖 칸 넷(장부 P-66·P-75) — ERP 가 보낸 계획 시작일과 생산입고 송신에 돌려줄 원본 값.
    plannedStartDate: toDateString(row.planned_start_date) ?? undefined,
    erpOperationNo: row.erp_operation_no ?? undefined,
    erpStorageLocationCode: row.erp_storage_location_code ?? undefined,
    erpReworkFlag: row.erp_rework_flag ?? undefined,
    statusCode: row.status_code,
    acknowledgedAt: ack?.acknowledgedAt.toISOString(),
    acknowledgedBy: ack === undefined ? undefined : id(ack.acknowledgedBy),
    acknowledgeDecisionCode: ack?.acknowledgeDecisionCode ?? undefined,
    remarks: row.remarks ?? undefined,
    versionNo: row.version_no,
    expandedWorkOrderCount: extras.expandedWorkOrderCount,
    plannedWorkOrderCount: extras.plannedWorkOrderCount,
    // 계약 밖 칸(장부 P-133).
    progressStatusCode: extras.progressStatusCode,
    lastChange: extras.lastChange,
    autoPlan: extras.autoPlan,
    // 「작업지시 목록」 칩 판정(장부 P-142).
    worklistState: extras.worklistState,
  });
}

/** 변경 행 → 계약 `ProductionOrderChangedField[]`. 고정 순으로 «있는 항목만» 낸다.
 * `beforeQty` 는 `ORDER_QTY` 일 때만 값이다. `statusName` 은 페이지 단위 조회 맵을 찾을 뿐이다. */
export function changedFieldsOf(
  rows: readonly ProductionOrderChangeFieldRow[],
  current: Pick<ProductionOrderRow, 'status_code' | 'order_qty' | 'planned_start_date' | 'due_date'>,
  statusName: (code: string) => string,
): ProductionOrderChangedField[] {
  const byCode = new Map(rows.map((row) => [row.field_code, row]));
  return CHANGED_FIELD_ORDER.filter((code) => byCode.has(code)).map((code): ProductionOrderChangedField => {
    const r = byCode.get(code) as ProductionOrderChangeFieldRow;
    const label = FIELD_LABEL[code];
    if (code === 'ORDER_QTY') {
      return {
        field: code,
        label,
        beforeText: r.before_order_qty === null ? '' : r.before_order_qty.toString(),
        afterText: current.order_qty.toString(),
        beforeQty: r.before_order_qty === null ? null : Number(r.before_order_qty),
      };
    }
    if (code === 'PLANNED_START_DATE') {
      return { field: code, label, beforeText: toDateString(r.before_planned_start_date) ?? '', afterText: toDateString(current.planned_start_date) ?? '', beforeQty: null };
    }
    if (code === 'DUE_DATE') {
      return { field: code, label, beforeText: toDateString(r.before_due_date) ?? '', afterText: toDateString(current.due_date) ?? '', beforeQty: null };
    }
    return {
      field: code,
      label,
      beforeText: r.before_status_code === null ? '' : statusName(r.before_status_code),
      afterText: statusName(current.status_code),
      beforeQty: null,
    };
  });
}

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));
