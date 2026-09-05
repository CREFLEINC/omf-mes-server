import type { PrismaClient } from '@prisma/client';

import type { ApprovalService } from '../src/core/approval';

let seq = 0;

/**
 * 결재선 + 단계를 API 없이 직접 심는다 — 등록·단계 치환(쓰기)은 ③a 몫이고 e2e 는
 * API 에 의존하지 않는다(I-1.md R-8).
 */
export async function seedRoute(
  prisma: PrismaClient,
  approvalTypeCode: string,
  approverUserIds: bigint[],
): Promise<bigint> {
  const route = await prisma.approval_route.create({
    data: { approval_type_code: approvalTypeCode, is_active: true },
  });
  await prisma.approval_route_step.createMany({
    data: approverUserIds.map((approverUserId, index) => ({
      approval_route_id: route.approval_route_id,
      step_no: index + 1,
      approver_type_code: 'USER',
      approver_user_id: approverUserId,
    })),
  });
  return route.approval_route_id;
}

/**
 * 상신 행 + 단계 전개. 코어 `selectRoute`+`expandSteps` 로 만든다 — 손으로 단계를
 * 심으면 전개 규칙이 어긋나도 검사가 통과한다(I-1.md R-8).
 * ⚠ `approval_request_no` 는 `AP-E2E-{seq}` 리터럴이다 — 채번은 I-2 코어 몫이라
 * 이 리터럴을 서비스로 옮기지 않는다.
 */
export interface SeededRequest {
  approvalRequestId: bigint;
  approvalRequestNo: string;
}

export async function seedRequest(
  prisma: PrismaClient,
  service: ApprovalService,
  opts: {
    approvalTypeCode: string;
    requestedBy: bigint;
    targetTypeCode: string;
    targetId: bigint;
    reason?: string;
  },
): Promise<SeededRequest> {
  seq += 1;
  const approvalRequestNo = `AP-E2E-${Date.now()}-${seq}`;
  return prisma.$transaction(async (tx) => {
    const { approvalRouteId } = await service.selectRoute(tx, opts.approvalTypeCode, null);
    const request = await tx.approval_request.create({
      data: {
        approval_request_no: approvalRequestNo,
        approval_type_code: opts.approvalTypeCode,
        target_type_code: opts.targetTypeCode,
        target_id: opts.targetId,
        requested_by: opts.requestedBy,
        requested_at: new Date(),
        status_code: 'PENDING',
        reason: opts.reason ?? 'e2e 결재함 검사',
      },
    });
    await service.expandSteps(tx, approvalRouteId, request.approval_request_id);
    return { approvalRequestId: request.approval_request_id, approvalRequestNo };
  });
}
