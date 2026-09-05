import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/** 계약 `ApprovalRoute` 와 동형. `stepCount`·`inProgressCount` 는 파생(호출자가 센다). */
export interface ApprovalRouteView {
  approvalRouteId: number;
  approvalTypeCode: string;
  businessUnitId: number | null;
  minValue: number | null;
  maxValue: number | null;
  isActive: boolean;
  stepCount: number;
  inProgressCount: number;
}

type RouteRow = Prisma.approval_routeGetPayload<object>;

export function toApprovalRoute(
  row: RouteRow,
  counts: { stepCount: number; inProgressCount: number },
): ApprovalRouteView {
  return {
    approvalRouteId: Number(row.approval_route_id),
    approvalTypeCode: row.approval_type_code,
    businessUnitId: row.business_unit_id === null ? null : Number(row.business_unit_id),
    minValue: row.min_value === null ? null : Number(row.min_value),
    maxValue: row.max_value === null ? null : Number(row.max_value),
    isActive: row.is_active,
    stepCount: counts.stepCount,
    inProgressCount: counts.inProgressCount,
  };
}

/** 계약 `ApprovalRouteStep` 과 동형. */
export interface ApprovalRouteStepView {
  approvalRouteStepId: number;
  stepNo: number;
  approverTypeCode: string;
  approverUserId: number | null;
  approverRoleId: number | null;
  approverDepartmentId: number | null;
  approverName?: string;
  approverDepartmentName?: string;
  approverIsActive: boolean;
}

type StepRow = Prisma.approval_route_stepGetPayload<{
  include: { app_user: { include: { department: true } } };
}>;

/**
 * ⚠ 비-USER 행에는 사용자가 없다 — 1차는 `PUT …/steps` 가 USER 외를 400 으로 막아
 * 생길 수 없는 행이다(I-1.md §6-3). 그런 행이 있어도 `approverIsActive=false` 를
 * 낸다 — 결재가 실제로 멈추는 사실을 가리지 않는 쪽(거부하는 쪽)을 골랐다.
 */
export function toApprovalRouteStep(row: StepRow): ApprovalRouteStepView {
  return omitEmpty({
    approvalRouteStepId: Number(row.approval_route_step_id),
    stepNo: row.step_no,
    approverTypeCode: row.approver_type_code,
    approverUserId: row.approver_user_id === null ? null : Number(row.approver_user_id),
    approverRoleId: row.approver_role_id === null ? null : Number(row.approver_role_id),
    approverDepartmentId:
      row.approver_department_id === null ? null : Number(row.approver_department_id),
    approverName: row.app_user?.user_name,
    approverDepartmentName: row.app_user?.department?.department_name,
    approverIsActive: row.app_user?.is_active ?? false,
  });
}
