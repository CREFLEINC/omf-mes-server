import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../document-state';

/** 결재선 한 단계 — 전개에 필요한 칸만. */
export interface RouteStep {
  stepNo: number;
  approverTypeCode: string;
  approverUserId: bigint | null;
}

/** 전개된 `approval_step`. 「대기」는 값이 아니라 `decisionCode` 의 부재다(계약). */
export interface StepRow {
  stepNo: number;
  approverId: bigint;
  decisionCode: string | null;
}

/** 상신 한 건. 9 상신 도메인이 같은 칸을 넘긴다 — 대상 표만 다르다. */
export interface ApprovalRequestInput {
  /** ⛔ 코어가 «만들지» 않는다 — 호출자가 `$transaction` 을 열기 «전»에 채번해 넘긴다(I-2.md R-2). */
  approvalRequestNo: string;
  approvalTypeCode: string;
  targetTypeCode: string;
  targetId: bigint;
  /** ⚠ P/O 만 전표 값을 준다. 나머지 8자리는 `null`(공통본) — 설계 미정 · 문의 022. */
  businessUnitId: bigint | null;
  requestedBy: bigint;
  reason: string;
}

/** ⚠ `steps` 는 판정에 쓴 세 칸뿐이다 — 응답 `ApprovalStep` 은 호출자가 다시 읽어 만든다. */
export interface DecisionResult {
  requestId: bigint;
  statusCode: string;
  versionNo: number;
  steps: StepRow[];
}

type Tx = Prisma.TransactionClient;
const STATUS_COLUMN = 'app.approval_request.status_code';

function badRequest(code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code, message }]);
}

/**
 * 결재선 선택 · 단계 전개 · 순차 결재. 도메인이 서로의 service 를 부르지 않으므로 9 상신
 * 도메인이 나눠 쓰는 이 규칙은 코어에 선다. `tx` 는 호출자가 연다(`runIdempotent` 가
 * 자기 트랜잭션을 넘겨주지 않는다).
 *
 * ⛔ 승인은 **자물쇠만 푼다**(공유계약 J-8) — 대상 문서의 어떤 행도 건드리지 않는다.
 * 전기·출고·조정은 대상 화면의 `:post` 가 승인 상태를 «읽고» 따로 한다.
 */
@Injectable()
export class ApprovalService {
  constructor(private readonly documentState: DocumentStateService) {}

  /**
   * 상신. 「진행 중 요청은 하나」를 보고, 결재선을 골라 요청과 단계를 한 트랜잭션으로 만든다.
   *
   * ⛔ 채번을 부르지 않는다 — 번호는 인자로 온다. 카운터가 업무 트랜잭션 «밖»에서 돌아야
   *    롤백이 번호를 되돌리지 않는다(I-2.md R-2).
   * ⛔ 대상 문서의 어떤 행도 건드리지 않는다 — 대상 표의 `approval_request_id` 를 채우는
   *    것은 호출자다. 코어가 9 도메인의 표를 알면 그게 두 번째 라우팅표가 된다.
   * ⚠ `requested_at` 은 서버 시각이다 — `business_date` 축이 아니다(C-8 대상 3표에
   *   `approval_request` 가 없다).
   */
  async request(tx: Tx, input: ApprovalRequestInput): Promise<{ approvalRequestId: bigint }> {
    await this.assertNoOpenRequest(tx, input.targetTypeCode, input.targetId, input.approvalTypeCode);
    const { approvalRouteId } = await this.selectRoute(tx, input.approvalTypeCode, input.businessUnitId);
    // `target_summary`·`decided_at`·`decided_by` 는 비운다 — 계약이 안 받는 칸(I-1.md §2-3).
    const created = await tx.approval_request.create({
      data: {
        approval_request_no: input.approvalRequestNo,
        approval_type_code: input.approvalTypeCode,
        target_type_code: input.targetTypeCode,
        target_id: input.targetId,
        requested_by: input.requestedBy,
        requested_at: new Date(),
        status_code: 'PENDING',
        reason: input.reason,
      },
      select: { approval_request_id: true },
    });
    await this.expandSteps(tx, approvalRouteId, created.approval_request_id);
    return { approvalRequestId: created.approval_request_id };
  }

  /**
   * 「한 전표에 살아 있는 요청은 하나다」. `PENDING` 하나만 본다 — 반려는 진행 중이 아니라
   * 다시 상신할 수 있고 그때는 새 요청이 선다(공유계약 J-6). 승인도 계약이 막지 않았으므로
   * 막지 않는다. 조회 축은 I-1 A6 이 깐 `ix_approval_request_target` 이다.
   *
   * ⚠ 동시 상신을 막는 것은 «호출자의 대상 행 잠금»이다 — 이 함수의 조회만으로는 같은
   *   순간의 둘이 다 통과한다. 호출자가 트랜잭션 첫 문장에서 대상 행을 잠근다(I-2.md R-4).
   *   부분 유일 인덱스로 되돌리려면 인덱스 한 줄이면 되고 코드는 그대로다.
   */
  async assertNoOpenRequest(
    tx: Tx,
    targetTypeCode: string,
    targetId: bigint,
    approvalTypeCode: string,
  ): Promise<void> {
    const open = await tx.approval_request.findFirst({
      where: {
        target_type_code: targetTypeCode,
        target_id: targetId,
        approval_type_code: approvalTypeCode,
        status_code: 'PENDING',
      },
      select: { approval_request_id: true },
    });
    if (open !== null) {
      throw badRequest(ERROR_CODE.APPROVAL_IN_PROGRESS, '진행 중인 승인 요청이 이미 있습니다.');
    }
  }

  /**
   * 「승인 전이면 400」의 자물쇠. 대상 문서의 `:post` 가 부른다 — 승인은 자물쇠만 풀고(J-8)
   * 실행은 여기서 «읽어» 가른다. `assertNoOpenRequest` 와 대칭이지 반대가 아니다 —
   * 그쪽은 `PENDING` 을 찾아 막고 이쪽은 `APPROVED` 를 찾아 연다. 뜻도 호출자도 달라
   * 한 함수로 합치지 않는다(I-4.md §4-1).
   *
   * ⛔ 대상 표의 `approval_request_id` FK 를 보지 않는다 — 정본은 다형 축이다(plan.md §5 #12).
   *    FK 는 업무 승인 하나만 담아서, I-5 의 취소 품의가 I-4 의 업무 승인을 덮는다.
   * ⛔ `approvalTypeCode` 는 필수다 — 없으면 `GOODS_ISSUE_CANCEL` 승인이
   *    `GOODS_ISSUE_DISPOSAL` 을 대신한다.
   * 요청이 0건이면 통과한다 — 계약 `GoodsIssue.approvalRequestId` 「비어 있으면 승인을
   * 타지 않은 출고다」가 승인을 안 탄 전표의 존재를 인정하고 사후 조회로 가려낸다고 적었다.
   * 서버가 사전에 전건을 막는 축이 아니다.
   * // 계약이 세운 축(reasonCode)의 값이 아직 없어 상신 흔적으로 대신 가른다 — 값이 오면 이 자리를 바꾼다(I-4.md R-4 · 문의 030)
   * ⚠ 시각 순서를 안 본다 — 「승인된 뒤 다시 상신했고 그것이 반려됨」이면 통과한다.
   *   계약이 그 경우를 안 적었고 재판정을 새로 만들지 않는다(I-4.md §8-1 ⓔ).
   * 조회 축은 I-1 A6 이 깐 `ix_approval_request_target` 2칸(`target_type_code`·`target_id`)이고
   * `approval_type_code` 는 그 위의 필터다 — `assertNoOpenRequest` 와 같은 모양이다.
   */
  async assertApproved(
    tx: Tx,
    targetTypeCode: string,
    targetId: bigint,
    approvalTypeCode: string,
  ): Promise<void> {
    const requests = await tx.approval_request.findMany({
      where: {
        target_type_code: targetTypeCode,
        target_id: targetId,
        approval_type_code: approvalTypeCode,
      },
      select: { status_code: true },
    });
    if (requests.length === 0 || requests.some((row) => row.status_code === 'APPROVED')) {
      return;
    }
    // 섞여 있으면 `PENDING` 이 이긴다 — 「기다려라」가 「다시 올려라」보다 정확하다.
    if (requests.some((row) => row.status_code === 'PENDING')) {
      throw badRequest(ERROR_CODE.APPROVAL_IN_PROGRESS, '진행 중인 승인 요청이 이미 있습니다.');
    }
    throw badRequest(ERROR_CODE.APPROVAL_REQUIRED, '승인이 필요합니다. 다시 상신하십시오.');
  }

  /**
   * ① 사업부 지정본이 전 사업부 공통본을 이긴다 ② 그러고도 둘 이상이면 서버가 임의로
   * 고르지 않고 `ROUTE_AMBIGUOUS` 다 — 계약이 선택 규칙의 정본을 갖는다.
   * ⚠ `businessUnitId` 는 P/O 만 전표 값을 준다. 나머지는 `null`(공통본) — 계약이 적은
   * 「reasonCode 로 파생」의 매핑이 없다. 설계 미정 — 문의 022.
   */
  async selectRoute(
    tx: Tx,
    approvalTypeCode: string,
    businessUnitId: bigint | null,
  ): Promise<{ approvalRouteId: bigint; steps: RouteStep[] }> {
    const routes = await tx.approval_route.findMany({
      where: {
        approval_type_code: approvalTypeCode,
        is_active: true,
        OR: [{ business_unit_id: businessUnitId }, { business_unit_id: null }],
      },
      include: { approval_route_step: { orderBy: { step_no: 'asc' } } },
    });
    const specific = routes.filter((route) => route.business_unit_id !== null);
    const layer = specific.length > 0 ? specific : routes;

    if (layer.length > 1) {
      throw badRequest(ERROR_CODE.ROUTE_AMBIGUOUS, '활성 결재선이 둘 이상입니다. 한 벌만 두세요.');
    }
    // 단계 0개인 결재선도 없는 것으로 본다 — 되살려도 상신이 거부된다(계약 `:activate`).
    if (layer.length === 0 || layer[0].approval_route_step.length === 0) {
      throw badRequest(ERROR_CODE.ROUTE_NOT_FOUND, '사용 중인 결재선이 없습니다.');
    }
    const steps = layer[0].approval_route_step.map((s) => ({
      stepNo: s.step_no,
      approverTypeCode: s.approver_type_code,
      approverUserId: s.approver_user_id,
    }));
    return { approvalRouteId: layer[0].approval_route_id, steps };
  }

  /**
   * 결재선 → `approval_step` 전개. `step_no` 는 배열 순서로 1..N 을 다시 매긴다.
   * ⛔ 전개는 상신 시점의 기록이다 — 뒤에 결재선을 고쳐도 소급하지 않는다(공유계약 J-9).
   */
  async expandSteps(tx: Tx, approvalRouteId: bigint, approvalRequestId: bigint): Promise<void> {
    const rows = await tx.approval_route_step.findMany({
      where: { approval_route_id: approvalRouteId },
      orderBy: { step_no: 'asc' },
    });
    // 단계 0개 결재선은 `selectRoute` 가 이미 거른다 — 직접 부르는 픽스처·상신이 빈 요청을
    // 만들면 이후 모든 결재가 403 으로 보여 원인이 권한 문제로 읽힌다.
    if (rows.length === 0) {
      throw badRequest(ERROR_CODE.ROUTE_NOT_FOUND, '단계가 없는 결재선입니다.');
    }
    const data = rows.map((row, index) => {
      // 1차는 USER 만 결재한다 — ROLE·DEPARTMENT 는 누가 결재자인지 풀 규칙이 없다.
      if (row.approver_type_code !== 'USER' || row.approver_user_id === null) {
        throw badRequest(ERROR_CODE.APPROVER_TYPE_NOT_SUPPORTED, '결재자는 사용자만 지원합니다.');
      }
      return {
        approval_request_id: approvalRequestId,
        step_no: index + 1,
        approver_id: row.approver_user_id,
      };
    });
    await tx.approval_step.createMany({ data });
  }

  /** `step_no` 오름차순 첫 미결 단계. 결재함의 `isCurrent`·`isMyTurn` 이 같은 함수를 쓴다. */
  currentStep(steps: ReadonlyArray<StepRow>): StepRow | null {
    const ordered = [...steps].sort((a, b) => a.stepNo - b.stepNo);
    return ordered.find((step) => step.decisionCode === null) ?? null;
  }

  /**
   * 마지막 단계 승인에서만 요청이 `APPROVED` 로 간다 — 중간 승인은 전이가 아니다.
   * ⛔ `actorUserId` 는 세션 주체만 넘긴다 — 요청 본문·헤더의 사용자 id 를 그대로 싣지 않는다.
   */
  approve(tx: Tx, id: bigint, version: number, actorUserId: bigint, comment?: string) {
    return this.decide(tx, id, version, actorUserId, 'APPROVED', comment ?? null);
  }

  /** 한 단계라도 반려면 요청이 끝난다 — 번복은 새 요청이다(공유계약 J-6). 주체는 `approve` 와 같다. */
  reject(tx: Tx, id: bigint, version: number, actorUserId: bigint, comment: string) {
    return this.decide(tx, id, version, actorUserId, 'REJECTED', comment);
  }

  private async decide(
    tx: Tx,
    id: bigint,
    version: number,
    actorUserId: bigint,
    decisionCode: 'APPROVED' | 'REJECTED',
    comment: string | null,
  ): Promise<DecisionResult> {
    const request = await tx.approval_request.findUnique({
      where: { approval_request_id: id },
      select: { status_code: true, version_no: true },
    });
    if (!request) throw new NotFoundException('없는 승인 요청입니다.');

    // ⚠ 400 이다 — 409 는 이 자리(STATE_LOCKED)가 아니라 If-Match 저장 충돌이 쓴다.
    const transition = this.documentState.assertTransition(
      STATUS_COLUMN,
      decisionCode === 'APPROVED' ? 'approval-approve' : 'approval-reject',
      request.status_code,
      HttpStatus.BAD_REQUEST,
    );
    // 남의 저장을 덮은 뒤 단계까지 쓰지 않는다. 경합 자체는 아래 조건부 UPDATE 가 받는다.
    if (request.version_no !== version) assertUpdated(0);

    const steps: StepRow[] = (
      await tx.approval_step.findMany({
        where: { approval_request_id: id },
        orderBy: { step_no: 'asc' },
      })
    ).map((r) => ({ stepNo: r.step_no, approverId: r.approver_id, decisionCode: r.decision_code }));

    // 결재선에 아예 없는 사람은 403 이다 — 상세 GET 과 같은 규칙이고 차례 문제가 아니다.
    if (!steps.some((step) => step.approverId === actorUserId)) {
      throw new ContractException(HttpStatus.FORBIDDEN, [
        { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '결재 권한이 없습니다.' },
      ]);
    }
    const current = this.currentStep(steps);
    if (current === null || current.approverId !== actorUserId) {
      throw badRequest(ERROR_CODE.NOT_YOUR_TURN, '아직 결재할 차례가 아닙니다.');
    }

    const decidedAt = new Date();
    await tx.approval_step.updateMany({
      where: { approval_request_id: id, step_no: current.stepNo },
      data: { decision_code: decisionCode, decision_at: decidedAt, decision_comment: comment },
    });

    const closes = decisionCode === 'REJECTED' || current.stepNo === steps[steps.length - 1].stepNo;
    // `decided_at/by` 는 비운다 — 계약 `ApprovalRequest` 가 안 받는 칸을 조용히 채우지 않는다(I-1.md §2-3).
    const decided = { status_code: transition.to };
    const updated = await tx.approval_request.updateMany({
      where: { approval_request_id: id, version_no: version },
      data: { version_no: { increment: 1 }, ...(closes ? decided : {}) },
    });
    assertUpdated(updated.count);

    return {
      requestId: id,
      statusCode: closes ? transition.to : request.status_code,
      versionNo: version + 1,
      steps: steps.map((s) => (s.stepNo === current.stepNo ? { ...s, decisionCode } : s)),
    };
  }
}
