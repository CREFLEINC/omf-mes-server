import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import type { ApprovalTargetInfo } from './approval-target-name';

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

/** 계약 `ApprovalTarget` 과 동형. */
export interface ApprovalTargetView {
  targetTypeCode: string;
  targetId: number;
  displayName: string;
  openable: boolean;
  /** 대상을 여는 화면 ID — 정한 유형만(출하 취소 → W-04-12). 없으면 키를 싣지 않는다. */
  screenId?: string;
}

/**
 * 다형 참조 대상의 표시명. 호출자가 찾은 이름(`approval-target-name.ts`)이 있으면 그것이고, 없으면
 * `entity_type_registry` 에 표시명 칸이 없어 (설계 미정 — 문의 021) `"{targetTypeCode} #{targetId}"` 로 낸다.
 * `screenId` 원천도 없어 키를 생략하고(`omitEmpty`) `openable` 은 항상 거짓이다
 * (설계 미정 — 문의 019, I-1.md §6-2).
 */
export function toApprovalTarget(targetTypeCode: string, targetId: bigint, info?: ApprovalTargetInfo): ApprovalTargetView {
  const id = Number(targetId);
  return {
    targetTypeCode,
    targetId: id,
    displayName: info?.name ?? `${targetTypeCode} #${id}`,
    openable: false,
  };
}

/** 계약 `ApprovalRequest` 와 동형. `currentStepNo`·`isMyTurn` 은 호출자가 코어 `currentStep` 으로 낸다. */
export interface ApprovalRequestView {
  approvalRequestId: number;
  approvalRequestNo: string;
  approvalTypeCode: string;
  requestedBy: number | null;
  requestedByName: string;
  requestedAt: string;
  statusCode: string;
  reason: string;
  target: ApprovalTargetView;
  currentStepNo: number | null;
  totalStepNo: number;
  isMyTurn: boolean;
}

export interface ApprovalRequestDetailView {
  request: ApprovalRequestView;
  steps: ApprovalStepView[];
}

type RequestRow = Prisma.approval_requestGetPayload<{
  include: { app_user: true; requested_worker: true;
    approval_step: { include: { app_user: true } } };
}>;

export function toApprovalRequest(
  row: RequestRow,
  derived: { currentStepNo: number | null; isMyTurn: boolean },
  target?: ApprovalTargetInfo,
): ApprovalRequestView {
  return {
    approvalRequestId: Number(row.approval_request_id),
    approvalRequestNo: row.approval_request_no,
    approvalTypeCode: row.approval_type_code,
    requestedBy: row.requested_by === null ? null : Number(row.requested_by),
    requestedByName: actorName(row.app_user?.user_name, row.requested_worker?.worker_name),
    requestedAt: row.requested_at.toISOString(),
    statusCode: row.status_code,
    reason: row.reason,
    target: {
      ...toApprovalTarget(row.target_type_code, row.target_id, target),
      ...(OPENABLE_SCREENS[row.approval_type_code] === undefined ? {} : { openable: true, screenId: OPENABLE_SCREENS[row.approval_type_code] }),
    },
    currentStepNo: derived.currentStepNo,
    totalStepNo: row.approval_step.length,
    isMyTurn: derived.isMyTurn,
  };
}

/**
 * 대상을 여는 화면(결재 유형 → 화면 ID). 승인 뒤 실행이 대상 화면에 있는 유형만 둔다.
 * - `SHIPMENT_CANCEL` → W-04-02 출하 예정 목록: 승인된 취소를 그 지시서 상세 「출하」 칸에서 [취소 실행]한다. 결재함은 승인만
 *   하고 실행하지 않는다. 피처 012 R-7 이 출하 내역(W-04-12) 화면을 없애며 옮겼다 — 저장값이 아니라 응답에 싣는 매핑이라
 *   배포 전에 상신한 결재도 W-04-02 로 간다.
 */
const OPENABLE_SCREENS: Readonly<Record<string, string | undefined>> = { SHIPMENT_CANCEL: 'W-04-02' };

/** 2차 정리(#353 마이그레이션) 전에는 PDA 긴급 생략 상신(작업자만 있는 행)이 남는다 — 작업자 이름으로 대신한다. */
function actorName(accountName: string | undefined, workerName: string | undefined): string {
  const name = accountName ?? workerName;
  if (!name) throw new Error('Approval request actor is missing');
  return name;
}

/** 계약 `ApprovalStep` 과 동형. */
export interface ApprovalStepView {
  stepNo: number;
  approverId: number;
  approverName: string;
  decisionCode?: string;
  decisionAt?: string;
  decisionComment?: string;
  isMine: boolean;
  isCurrent: boolean;
}

type ApprovalStepRow = RequestRow['approval_step'][number];

/**
 * ⚠ `ApprovalStep.approverName` 은 계약 required 다 — `ApprovalRouteStep` 과 달리
 * 비-USER 결재자 행이 생길 자리가 없다(`approval_step.approver_id` 는 NOT NULL FK 로
 * `app_user` 를 항상 가리킨다). 그래서 여기는 키를 생략하지 않는다(I-1.md §6-3 은
 * `ApprovalRouteStep.approverIsActive` 얘기이지 이 스키마 얘기가 아니다 — 계약 실측).
 * `decisionCode`/`decisionAt`/`decisionComment` 는 비어 있으면(=아직 결재 전) 키를
 * 생략한다 — 「대기」를 값으로 두지 않는다(계약 「부재로 판정」).
 */
export function toApprovalStep(
  row: ApprovalStepRow,
  actorId: number,
  currentStepNo: number | null,
): ApprovalStepView {
  return omitEmpty({
    stepNo: row.step_no,
    approverId: Number(row.approver_id),
    approverName: row.app_user.user_name,
    decisionCode: row.decision_code ?? undefined,
    decisionAt: row.decision_at?.toISOString(),
    decisionComment: row.decision_comment ?? undefined,
    isMine: Number(row.approver_id) === actorId,
    isCurrent: row.step_no === currentStepNo,
  });
}
