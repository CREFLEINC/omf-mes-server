import { ContractException, ERROR_CODE } from '../../common/errors';
import { ApprovalService, RouteStep } from '../../core/approval';
import { PrismaService } from '../../prisma/prisma.service';

export interface ApprovalRouteStepSummary {
  stepNo: number;
  approverName: string;
}

export interface ApprovalRouteSummary {
  approvalTypeCode: string;
  hasRoute: boolean;
  steps: ApprovalRouteStepSummary[];
}

/**
 * 처분 결재선 확인(omf-all-around#352) — 결재선이 없으면(`ROUTE_NOT_FOUND`) 결재 없이 바로 반영한다. 폐기·선별·특채 요청과
 * 화면의 판정 확인 팝업이 같은 판단을 쓴다. `ROUTE_AMBIGUOUS` 등 다른 거절은 그대로 던진다.
 */
export async function approvalRouteSummary(
  prisma: PrismaService,
  approvals: ApprovalService,
  approvalTypeCode: string,
): Promise<ApprovalRouteSummary> {
  const steps = await routeSteps(prisma, approvals, approvalTypeCode);
  if (steps === null) return { approvalTypeCode, hasRoute: false, steps: [] };
  const ids = steps.flatMap((step) => (step.approverUserId === null ? [] : [step.approverUserId]));
  const users = await prisma.app_user.findMany({ where: { app_user_id: { in: ids } }, select: { app_user_id: true, user_name: true } });
  const names = new Map(users.map((user) => [user.app_user_id, user.user_name]));
  return {
    approvalTypeCode,
    hasRoute: true,
    steps: steps.map((step) => ({
      stepNo: step.stepNo,
      approverName: (step.approverUserId === null ? undefined : names.get(step.approverUserId)) ?? '',
    })),
  };
}

export async function hasApprovalRoute(prisma: PrismaService, approvals: ApprovalService, approvalTypeCode: string): Promise<boolean> {
  return (await routeSteps(prisma, approvals, approvalTypeCode)) !== null;
}

/** 활성 결재선의 단계 — 결재선이 없으면 null. */
async function routeSteps(prisma: PrismaService, approvals: ApprovalService, approvalTypeCode: string): Promise<RouteStep[] | null> {
  try {
    return (await approvals.selectRoute(prisma, approvalTypeCode, null)).steps;
  } catch (error) {
    if (error instanceof ContractException && error.errors.some((item) => item.code === ERROR_CODE.ROUTE_NOT_FOUND)) return null;
    throw error;
  }
}
