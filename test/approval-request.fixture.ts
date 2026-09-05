import type { PrismaClient } from '@prisma/client';

import type { ApprovalService } from '../src/core/approval';
import { NumberingService } from '../src/core/numbering';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * 결재선 + 단계를 API 없이 직접 심는다 — 등록·단계 치환(쓰기)은 ③a 몫이고 e2e 는
 * API 에 의존하지 않는다(I-1.md R-8).
 */
export async function seedRoute(
  prisma: PrismaClient,
  approvalTypeCode: string,
  approverUserIds: bigint[],
  /** 사업부 지정본. 주면 그 사업부의 상신이 «이 결재선»을 고른다(전 사업부 공통본을 이긴다). */
  businessUnitId?: bigint,
): Promise<bigint> {
  const route = await prisma.approval_route.create({
    data: {
      approval_type_code: approvalTypeCode,
      is_active: true,
      business_unit_id: businessUnitId ?? null,
    },
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
 * 상신 행 + 단계 전개. 코어 `request()` 로 만든다 — 손으로 심으면 전개 규칙이 어긋나도
 * 검사가 통과한다(I-1.md R-8).
 * ⚠ `approval_request_no` 는 채번 코어가 뽑는다 — `$transaction` 을 «열기 전»이라야
 * 한 요청이 커넥션을 둘 쥐지 않는다(I-2.md R-2).
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
  const numbering = new NumberingService(prisma as PrismaService);
  const today = new Date().toISOString().slice(0, 10);
  const approvalRequestNo = await numbering.next('APPROVAL_REQUEST', null, today);
  const { approvalRequestId } = await prisma.$transaction((tx) =>
    service.request(tx, {
      approvalRequestNo,
      approvalTypeCode: opts.approvalTypeCode,
      targetTypeCode: opts.targetTypeCode,
      targetId: opts.targetId,
      businessUnitId: null,
      requestedBy: opts.requestedBy,
      reason: opts.reason ?? 'e2e 결재함 검사',
    }),
  );
  return { approvalRequestId, approvalRequestNo };
}
