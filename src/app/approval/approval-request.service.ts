import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ApprovalService } from '../../core/approval';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ApprovalRequestDetailView,
  ApprovalRequestView,
  toApprovalRequest,
  toApprovalStep,
} from './approval.mapper';

export interface ApprovalRequestQuery {
  assignedToMe?: boolean;
  requestedByMe?: boolean;
  pendingOnly?: boolean;
  myTurnOnly?: boolean;
  approvalTypeCode?: string;
  statusCode?: string;
  targetTypeCode?: string;
  targetId?: number;
  requestedAtFrom?: string;
  requestedAtTo?: string;
  q?: string;
  page?: number;
  size?: number;
}

const INCLUDE = {
  app_user: true,
  approval_step: { include: { app_user: true }, orderBy: { step_no: 'asc' as const } },
};
type RequestRow = Prisma.approval_requestGetPayload<{ include: typeof INCLUDE }>;

/**
 * 결재함 조회 2건. 화면은 `W-CO-09`(결재함) · `W-01-13`·`W-03-09` 가 함께 부른다.
 *
 * ⛔ `:approve`/`:reject`(뒤 PR)와 등록·활성 전이(③a)는 이 서비스에 없다. 「현재 단계」
 * 판정만 코어 `ApprovalService.currentStep` 을 그대로 쓴다 — 결재함의 `currentStepNo`·
 * `isMyTurn`·`isCurrent` 와 `:approve` 의 `NOT_YOUR_TURN` 판정이 같은 함수여야
 * 조용히 어긋나지 않는다(I-1.md R-2).
 */
@Injectable()
export class ApprovalRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalCore: ApprovalService,
  ) {}

  async list(query: ApprovalRequestQuery, actorId: number): Promise<PagedResponse<ApprovalRequestView>> {
    const page = pageRequest(query);
    const where = this.listWhere(query, actorId);

    if (query.myTurnOnly !== true) {
      const [rows, total] = await Promise.all([
        this.prisma.approval_request.findMany({
          where,
          include: INCLUDE,
          orderBy: { requested_at: 'desc' },
          skip: page.skip,
          take: page.take,
        }),
        this.prisma.approval_request.count({ where }),
      ]);
      return pagedResponse(rows.map((row) => this.toView(row, actorId)), total, page);
    }

    // `myTurnOnly` 는 「현재 단계(오름차순 첫 미결) 승인자 = 나」다 — DB where 로 걸러지지
    // 않는 형태라(형제 행 비교) 전건을 불러 메모리에서 쪽을 낸다. 선례: notice.service.ts
    // acknowledgements() 의 kept.slice(...).
    const all = await this.prisma.approval_request.findMany({
      where,
      include: INCLUDE,
      orderBy: { requested_at: 'desc' },
    });
    const mine = all.filter((row) => this.currentStepInfo(row).approverId === actorId);
    const sliced = mine.slice(page.skip, page.skip + page.take);
    return pagedResponse(sliced.map((row) => this.toView(row, actorId)), mine.length, page);
  }

  async get(
    requestId: number,
    actorId: number,
  ): Promise<{ detail: ApprovalRequestDetailView; versionNo: number }> {
    const row = await this.loadRequest(requestId);
    this.assertVisible(row, actorId);
    const info = this.currentStepInfo(row);
    const request = toApprovalRequest(row, {
      currentStepNo: info.stepNo,
      isMyTurn: info.approverId === actorId,
    });
    const steps = row.approval_step.map((step) => toApprovalStep(step, actorId, info.stepNo));
    return { detail: { request, steps }, versionNo: row.version_no };
  }

  private listWhere(query: ApprovalRequestQuery, actorId: number): Prisma.approval_requestWhereInput {
    const conditions: Prisma.approval_requestWhereInput[] = [];
    if (query.approvalTypeCode !== undefined) conditions.push({ approval_type_code: query.approvalTypeCode });
    if (query.statusCode !== undefined) conditions.push({ status_code: query.statusCode });
    if (query.targetTypeCode !== undefined) conditions.push({ target_type_code: query.targetTypeCode });
    if (query.targetId !== undefined) conditions.push({ target_id: query.targetId });
    // 「요청번호 검색」(계약) — 표시명 원천이 없는 결재선 검색(문의 021)과 달리 요청은
    // 고유 번호가 있어 그대로 쓴다.
    if (query.q) conditions.push({ approval_request_no: { contains: query.q, mode: 'insensitive' } });
    if (query.pendingOnly === true) conditions.push({ status_code: 'PENDING' });
    if (query.requestedByMe === true) conditions.push({ requested_by: actorId });
    if (query.assignedToMe === true) {
      conditions.push({ approval_step: { some: { approver_id: actorId } } });
    }
    if (query.requestedAtFrom !== undefined) {
      conditions.push({ requested_at: { gte: dateStart('requestedAtFrom', query.requestedAtFrom) } });
    }
    if (query.requestedAtTo !== undefined) {
      conditions.push({ requested_at: { lt: dateExclusiveEnd('requestedAtTo', query.requestedAtTo) } });
    }
    return conditions.length > 0 ? { AND: conditions } : {};
  }

  /** ApprovalRequest.currentStepNo·isMyTurn·ApprovalStep.isCurrent 가 같이 쓰는 계산 한 곳. */
  private currentStepInfo(row: RequestRow): { stepNo: number | null; approverId: number | null } {
    const steps = row.approval_step.map((step) => ({
      stepNo: step.step_no,
      approverId: step.approver_id,
      decisionCode: step.decision_code,
    }));
    const current = this.approvalCore.currentStep(steps);
    return { stepNo: current?.stepNo ?? null, approverId: current ? Number(current.approverId) : null };
  }

  private toView(row: RequestRow, actorId: number): ApprovalRequestView {
    const info = this.currentStepInfo(row);
    return toApprovalRequest(row, { currentStepNo: info.stepNo, isMyTurn: info.approverId === actorId });
  }

  /**
   * 데이터 축 403 — 승인자(어느 단계든)도 상신자도 아니면 상세를 못 연다(계약 W-CO-09
   * §5-2). 기능 권한 가드와 두 겹이다. 순서: 404(loadRequest) → 403(여기).
   */
  private assertVisible(row: RequestRow, actorId: number): void {
    const isRequester = Number(row.requested_by) === actorId;
    const isApprover = row.approval_step.some((step) => Number(step.approver_id) === actorId);
    if (isRequester || isApprover) return;
    throw new ContractException(HttpStatus.FORBIDDEN, [
      { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '승인자도 상신자도 아닙니다.' },
    ]);
  }

  private async loadRequest(requestId: number): Promise<RequestRow> {
    const row = await this.prisma.approval_request.findUnique({
      where: { approval_request_id: requestId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 승인 요청입니다.');
    return row;
  }
}

/** `requestedAtFrom`(`format: date`) — notice.service.ts:432 `date()` 선례. */
function dateStart(field: string, value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field, code: ERROR_CODE.INVALID, message: 'YYYY-MM-DD 형식입니다.' },
  ]);
}

/** `requestedAtTo` 는 반열림 — 다음날 00:00Z «미만»이다(같은 선례). */
function dateExclusiveEnd(field: string, value: string): Date {
  return new Date(dateStart(field, value).getTime() + 86_400_000);
}
