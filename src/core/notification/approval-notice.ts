import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { approvalTypeName } from './approval-type-names';
import { resolveByUser } from './department-resolver';
import { NotificationEmitter } from './notification-emitter';

type Tx = Prisma.TransactionClient;

/**
 * 결재 도착 알림 — 상신 직후의 1단계와 중간 승인 뒤의 다음 단계, «그 차례» 결재자 한 명에게 보낸다.
 * 부서는 결재자 본인의 부서다(research R-7). core 한 곳이라 9 상신 경로를 모두 덮는다(research R-6).
 */
@Injectable()
export class ApprovalNotifier {
  constructor(private readonly emitter: NotificationEmitter) {}

  /** `arrivedAt` = 단계 도착 시각 — 상신 시각이거나 앞 단계 결재 시각이다. */
  async notifyCurrentStep(tx: Tx, approvalRequestId: bigint, arrivedAt: Date): Promise<void> {
    const request = await tx.approval_request.findUniqueOrThrow({
      where: { approval_request_id: approvalRequestId },
      select: {
        approval_request_no: true,
        approval_type_code: true,
        reason: true,
        app_user: { select: { user_name: true } },
        requested_worker: { select: { worker_name: true } },
        approval_step: { select: { step_no: true, approver_id: true, decision_code: true }, orderBy: { step_no: 'asc' } },
      },
    });
    const current = request.approval_step.find((step) => step.decision_code === null);
    if (current === undefined) return;

    const requester = request.app_user?.user_name ?? request.requested_worker?.worker_name;
    await this.emitter.emit(tx, {
      eventCode: 'APPROVAL_ACTION_REQUIRED',
      aggregateTypeCode: 'APPROVAL_REQUEST',
      aggregateId: approvalRequestId,
      occurredAt: arrivedAt,
      departmentId: await resolveByUser(tx, current.approver_id),
      approverUserId: current.approver_id,
      values: {
        approval_type: approvalTypeName(request.approval_type_code),
        request_no: request.approval_request_no,
        requester,
        reason: request.reason,
        step: `${current.step_no}/${request.approval_step.length}`,
        actor: requester,
      },
    });
  }
}
