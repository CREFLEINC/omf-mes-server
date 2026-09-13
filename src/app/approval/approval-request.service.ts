import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ApprovalService } from '../../core/approval';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { TerminalApprovalListScope } from '../../auth/terminal-app-read-scope';
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
  requested_worker: true,
  approval_step: { include: { app_user: true }, orderBy: { step_no: 'asc' as const } },
};
type RequestRow = Prisma.approval_requestGetPayload<{ include: typeof INCLUDE }>;

/** 상세 + 새 `version_no`. 컨트롤러가 `runVersioned` 로 ETag 를 내린다. */
export interface ApprovalDecisionResult {
  detail: ApprovalRequestDetailView;
  versionNo: number;
}

/**
 * 결재함 조회 2건 + 결재 2건. 화면은 `W-CO-09`(결재함) · `W-01-13`·`W-03-09` 가 함께 부른다.
 *
 * ⛔ 결재 판정(순차·권한·전이)은 코어 `ApprovalService` 가 통째로 진다 — 이 서비스는
 * 트랜잭션만 열어 넘기고 검사 순서를 다시 짜지 않는다. 조회의 「현재 단계」도 같은
 * `currentStep` 을 쓴다 — 결재함의 `currentStepNo`·`isMyTurn`·`isCurrent` 와
 * `:approve` 의 `NOT_YOUR_TURN` 판정이 같은 함수여야 조용히 어긋나지 않는다(I-1.md R-2).
 * ⛔ 등록·활성 전이(결재선)는 `ApprovalRouteService` 몫이다.
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

  /** 모바일 IQC 상신 조회는 계정 세션 대신 검증된 LOT 또는 현장 작업자로 한정한다. */
  async listForTerminal(
    query: ApprovalRequestQuery,
    scope: TerminalApprovalListScope,
  ): Promise<PagedResponse<ApprovalRequestView>> {
    const page = pageRequest(query);
    let lotIds: bigint[];
    if (scope.lotId !== undefined) {
      lotIds = [scope.lotId];
    } else {
      const ownTargets = await this.prisma.approval_request.findMany({
        where: {
          requested_worker_id: scope.workerId,
          approval_type_code: 'IQC_SKIP',
          target_type_code: 'INBOUND_LOT',
        },
        select: { target_id: true },
        distinct: ['target_id'],
      });
      const lots = ownTargets.length === 0 ? [] : await this.prisma.lot.findMany({
        where: {
          lot_id: { in: ownTargets.map((row) => row.target_id) },
          plant_id: scope.plantId,
          source_type_code: 'INBOUND_RECEIPT_LINE',
        },
        select: { lot_id: true },
      });
      lotIds = lots.map((lot) => lot.lot_id);
    }
    const where: Prisma.approval_requestWhereInput = {
      approval_type_code: 'IQC_SKIP',
      target_type_code: 'INBOUND_LOT',
      target_id: { in: lotIds },
      ...(scope.lotId !== undefined ? { status_code: 'PENDING' } : { requested_worker_id: scope.workerId }),
    };
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
    return pagedResponse(rows.map((row) => toApprovalRequest(row, {
      currentStepNo: this.currentStepInfo(row).stepNo,
      isMyTurn: false,
    })), total, page);
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

  /** 승인. 의견은 선택이다(계약 `ApprovalDecision.required: []`). */
  approve(
    requestId: number,
    version: number,
    actorId: number,
    comment?: string,
  ): Promise<ApprovalDecisionResult> {
    return this.decide(requestId, actorId, (tx) =>
      this.approvalCore.approve(tx, BigInt(requestId), version, BigInt(actorId), comment),
    );
  }

  /** 반려. 의견이 필수다 — 빈 값은 계약 가드가 400 으로 이미 막는다(`minLength: 1`). */
  reject(
    requestId: number,
    version: number,
    actorId: number,
    comment: string,
  ): Promise<ApprovalDecisionResult> {
    return this.decide(requestId, actorId, (tx) =>
      this.approvalCore.reject(tx, BigInt(requestId), version, BigInt(actorId), comment),
    );
  }

  /**
   * 코어에 위임하고 **상세를 다시 읽어** 응답을 만든다. 코어 `DecisionResult.steps` 로
   * 조립하지 않는다 — 그 배열은 판정에 쓴 세 칸뿐이라(코어 주석) 계약 `ApprovalStep` 의
   * `approverName`·`decisionAt` 을 못 채운다.
   * ⛔ 트랜잭션은 여기서 연다 — `runIdempotent` 는 자기 tx 를 work 에 넘기지 않는다
   * (`master-write.ts`). 선례 `approval-route.service.ts replaceSteps`.
   */
  private async decide(
    requestId: number,
    actorId: number,
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<ApprovalDecisionResult> {
    await this.prisma.$transaction((tx) => run(tx));
    return this.get(requestId, actorId);
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
    // myTurnOnly 의 정확한 판정은 메모리(list())에서 하고, 여기서는 그 상위집합
    // 「내가 미결 단계로 걸린 PENDING 요청」으로 스캔 폭만 좁힌다.
    if (query.myTurnOnly === true) {
      conditions.push({ status_code: 'PENDING', approval_step: { some: { approver_id: actorId, decision_code: null } } });
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
    // 반려는 그 단계만 찍고 뒤 단계를 NULL 로 남기므로 코어 currentStep 은 종료된 요청에서도
    // 첫 미결 단계를 돌려준다. 계약은 「종료됐으면 비어 있다」(currentStepNo=null·isMyTurn=false)
    // 라 상태로 먼저 가른다 — 코어를 안 고쳐 :approve 의 NOT_YOUR_TURN 판정과 같은 함수(R-2)다.
    if (row.status_code !== 'PENDING') return { stepNo: null, approverId: null };
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
