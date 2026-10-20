import { HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictExtra, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues, optional } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import {
  INSPECTION_HOLD_REASON,
  LotHoldService,
  LotQualityMoveContext,
  LotQualityStatusService,
  lotsFreeOfOpenHolds,
  pqcAcceptanceExceeded,
  PREISSUED_LIFECYCLE,
  Tx,
  WORK_ORDER_LOT_SOURCE,
} from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordWriteService, InspectionDefectInput } from '../defect/defect-record-write.service';
import type { TerminalWorkerAuditActor } from '../../audit/terminal-worker-audit';
import { INSPECTION_RESULT_JOIN, InspectionResultView, inspectionResultView } from './inspection-result-view';
import { assertAccountWorker, assertIqcJudgmentChange, assertPqcAfterProduction } from './inspection-result-write-rules';
import { prepareConfirmDefects, syncConfirmDefectsWithin } from './inspection-rejection-defects';
import { CONFIRMED, assertConfirmedShape, remarksWithJudgmentChange } from './inspection-rules';
import { allocateIqcNonconformanceNo, createIqcNonconformanceWithin, needsIqcNonconformance } from './iqc-nonconformance';

/** 계약 `InspectionResultConfirm` — required **0** · 프로퍼티 4. 판정을 비우면 저장된 값을 쓴다. */
export interface InspectionResultConfirm {
  overallJudgmentCode?: string;
  remarks?: string;
  /** IQC 불합격 사유 — 확정과 한 트랜잭션에서 그 회차의 불량 기록을 갈아 끼운다(장부 P-47 · omf-all-around#121). */
  defects?: InspectionDefectInput[];
  /** IQC 판정이 합격판정개수 기준 자동 판정과 다를 때의 변경 사유(장부 P-70 · omf-all-around#125). 같으면 버린다. */
  judgmentChangeReason?: string;
}

/** `applyConfirmEffects()` 의 입력 — 확정 경로 둘이 각자 모아 «같은 모양»으로 넘긴다. */
export interface ConfirmEffectsInput {
  inspectionResultId: bigint;
  inspectionRequestId: bigint;
  judgment: string;
  rejectedQty: number;
  appUserId?: number;
  terminalAudit?: TerminalWorkerAuditActor;
  /** `confirmed_at`·`lot_status_event.changed_at`·`lot_hold.released_at` 이 한 시각을 나눠 쓴다. */
  changedAt: Date;
  /** IQC 불합격이면 미리 받은 부적합 번호(트랜잭션 밖 채번 · P-41). 없으면 부적합을 세우지 않는다. */
  nonconformanceNo?: string;
  /** 불합격 수량이 0 인 전량 판정의 부적합 수량. */
  inspectedQty?: number;
}

const VERSION_CONFLICT = 'VERSION_CONFLICT';
const REQUEST_COMPLETED = 'COMPLETED';
const JUDGMENT_GROUP = 'INSPECTION_RESULT_OVERALL_JUDGMENT';
const ACCEPTED = 'ACCEPTED';
const PQC = 'PQC';
const IQC = 'IQC';
const REJECTED = 'REJECTED';
/** `lot_status_event.source_document_type_code` — 이 전이를 일으킨 전표. */
const SOURCE_DOCUMENT_TYPE = 'INSPECTION_RESULT';
/**
 * ⭐ **설계 미정 — 문의 087.** 시드 `LOT_HOLD_RELEASE_REASON` 4값(`RETEST_PASS`·`RETEST_FAIL`·
 * `INVESTIGATION_CLEARED`·`MANAGER_OVERRIDE`)에 「1회차 수입검사 합격」에 맞는 값이 **하나도
 * 없는데** `ck_lot_hold_release_reason` 이 사유를 강제한다. ⛔ `RETEST_PASS`/`RETEST_FAIL` 은
 * 쓸 수 없다 — `W-03-02` §5-4 가 그 둘을 **C7·C8 전용**(`:release`)으로 못박고 「재판정으로
 * 풀린 건」 집계에 쓴다. 기존 4값 중 아무거나 재사용하면 그 집계에 조용히 섞이고 **나중에
 * 우리 행만 골라낼 수 없다** ⇒ 어디에도 없는 값을 넣어 답이 오면 한 문장 UPDATE 로 간다.
 */
const HOLD_RELEASE_REASON = 'INCOMING_INSPECTION_PASSED';

/** 종합 판정 3값 ↔ 전이표 액션. 여기 없는 값은 400 `INVALID` — 액션을 지어내지 않는다(F-6). */
const ACTION_BY_JUDGMENT: Record<string, string> = {
  ACCEPTED: 'inspection-accepted',
  REJECTED: 'inspection-rejected',
  HELD: 'inspection-held',
};

interface LockedResult {
  inspection_request_id: bigint;
  status_code: string;
  version_no: number;
  overall_judgment_code: string | null;
  inspected_qty: Prisma.Decimal;
  accepted_qty: Prisma.Decimal;
  rejected_qty: Prisma.Decimal;
  held_qty: Prisma.Decimal;
  remarks: string | null;
}

/**
 * ⭐ 검사 판정 확정(I-19 PR ④) — 한 트랜잭션 안에서 **확정 · LOT 품질 축 전이 · 보류 해제 ·
 * C14 전개**가 함께 일어난다(I-19.md §3-1).
 * ⭐ 그중 **부수효과 절반은 `applyConfirmEffects()` 로 떼 두었다** — `POST …/inspection-results`
 * `statusCode=CONFIRMED`(오프라인 큐)가 같은 함수를 부른다(§12-1 ⓑ 상환).
 *
 * ⛔ 원장을 지나지 않는다 · ⛔ `inventory_balance.quality_status_code` 를 안 건드린다(§9-1 #2) ·
 * ⛔ 관리자 알람을 내지 않는다(알림은 I-28) · ⛔ 다른 도메인 service 호출 0 — LOT 세 표는
 * **코어**(`LotQualityStatusService`·`LotHoldService`)가 쓴다(`server-architecture.md:67`).
 */
@Injectable()
export class InspectionConfirmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: DocumentStateService,
    private readonly lots: LotQualityStatusService,
    private readonly holds: LotHoldService,
    private readonly numbering: NumberingService,
    private readonly defects: DefectRecordWriteService,
  ) {}

  async confirm(
    inspectionResultId: number,
    version: number,
    body: InspectionResultConfirm,
    appUserId: number,
  ): Promise<{ view: InspectionResultView; versionNo: number }> {
    // 값 목록 대조는 트랜잭션 밖이다 — 코드 표를 읽는 커넥션을 업무 트랜잭션이 쥐지 않는다.
    await assertCodeValues(this.prisma, [
      { field: 'overallJudgmentCode', value: body.overallJudgmentCode, groupCode: JUDGMENT_GROUP },
    ]);
    const workerId = await assertAccountWorker(this.prisma, appUserId);
    const resultId = BigInt(inspectionResultId);
    const preparedDefects = await prepareConfirmDefects(this.prisma, this.defects, resultId, body);
    // IQC 불합격이면 부적합 번호를 트랜잭션 «밖»에서 받는다(P-41 · 채번 규약). 판정은 본문이 우선이다.
    const stored = await this.prisma.inspection_result.findUnique({
      where: { inspection_result_id: resultId },
      select: { inspection_request_id: true, overall_judgment_code: true },
    });
    // PQC 는 그 W/O 의 생산 실적이 먼저다 — 저장(`POST`)과 같은 판정(장부 P-49).
    if (stored !== null) await assertPqcAfterProduction(this.prisma, stored.inspection_request_id);
    const nonconformanceNo =
      stored === null
        ? undefined
        : await allocateIqcNonconformanceNo(
            this.prisma,
            this.numbering,
            stored.inspection_request_id,
            body.overallJudgmentCode ?? stored.overall_judgment_code ?? undefined,
            new Date(),
          );

    return this.prisma.$transaction(async (tx) => {
      const result = await lockResult(tx, resultId);
      // ⭐ 버전 대조가 상태 게이트보다 «먼저»다 — 형제 `:release`·`:close` 와 같은 순서(§3-2).
      if (result.version_no !== version) {
        assertUpdated(0, 'user', await conflictExtra(tx, result));
      }
      // ⚠ 재확정은 **400** `STATE_LOCKED` 다 — `PUT` 의 확정본 수정(409 `INVALID_STATE`)과 봉투가 다르다.
      this.state.assertTransition(
        'quality.inspection_result.status_code',
        'inspection-confirm',
        result.status_code,
        HttpStatus.BAD_REQUEST,
      );
      const judgment = body.overallJudgmentCode ?? result.overall_judgment_code ?? undefined;
      // ⭐ 조건부 CHECK 둘(`ck_inspection_result_qty`·`ck_inspection_result_judgment`)이 «확정에서
      //    처음» 깨어난다 — 여기서 안 막으면 `prisma-error.ts:23` 이 500 을 낸다.
      assertConfirmedShape({
        statusCode: CONFIRMED,
        inspectedQty: Number(result.inspected_qty),
        acceptedQty: Number(result.accepted_qty),
        rejectedQty: Number(result.rejected_qty),
        heldQty: Number(result.held_qty),
        overallJudgmentCode: judgment,
      });
      // IQC 는 합격판정개수 기준 자동 판정과 다르면 변경 사유가 있어야 한다 — 사유는 비고 맨 앞에 남긴다(P-70 · #125).
      const changeReason = await assertIqcJudgmentChange(tx, result.inspection_request_id, {
        acceptedQty: Number(result.accepted_qty),
        rejectedQty: Number(result.rejected_qty),
        heldQty: Number(result.held_qty),
        judgment: judgment as string,
        reason: body.judgmentChangeReason,
      });
      const remarks =
        changeReason === undefined ? body.remarks : remarksWithJudgmentChange(changeReason, body.remarks ?? result.remarks);
      const changedAt = new Date();
      await syncConfirmDefectsWithin(tx, this.defects, {
        inspectionResultId: resultId,
        inspectionRequestId: result.inspection_request_id,
        judgment,
        prepared: preparedDefects,
        detectedAt: changedAt,
        actor: { appUserId, workerId },
      });
      await assertRejectionRecorded(tx, resultId, result.inspection_request_id, judgment);
      await tx.inspection_result.update({
        where: { inspection_result_id: resultId },
        data: {
          status_code: CONFIRMED,
          confirmed_at: changedAt,
          overall_judgment_code: judgment,
          ...optional('remarks', remarks),
          updated_by: appUserId,
          version_no: { increment: 1 },
        },
      });
      await this.applyConfirmEffects(tx, {
        inspectionResultId: resultId,
        inspectionRequestId: result.inspection_request_id,
        judgment: judgment as string,
        rejectedQty: Number(result.rejected_qty),
        inspectedQty: Number(result.inspected_qty),
        appUserId,
        changedAt,
        nonconformanceNo,
      });

      return { view: await reread(tx, resultId), versionNo: result.version_no + 1 };
    });
  }

  /**
   * ⭐ 확정의 부수효과 — **확정 경로 «둘»이 이 한 함수를 부른다.** `:confirm`(관리웹·온라인)과
   * `POST /quality/inspection-results` `statusCode=CONFIRMED`(오프라인 큐 — 서버가 만든
   * `inspectionResultId` 를 몰라 `:confirm` 을 못 부른다 · `plan-uiux.md:1112` 「큐는 언제나
   * 확정으로 온다」)은 계약 `x-internal-note` 가 「**부수 효과가 같아야 한다**」고 못 박은 짝이다.
   * ⛔ 두 자리에 갈라 적지 않는다 — 갈리면 큐로 들어온 확정만 조용히 LOT 을 안 옮긴다(그것이
   * I-19 §12-1 ⓑ 가 남긴 부채였다).
   * ⛔ 호출자가 연 `tx` 안에서만 돈다 — 결과 행 쓰기와 같은 트랜잭션이어야 부분 확정이 없다.
   */
  async applyConfirmEffects(tx: Tx, input: ConfirmEffectsInput): Promise<void> {
    if ((input.appUserId === undefined) === (input.terminalAudit === undefined))
      throw new UnauthorizedException('검사 확정에는 계정 또는 단말 작업자 주체 하나가 필요합니다.');
    const terminalAudit = input.terminalAudit;
    const action = ACTION_BY_JUDGMENT[input.judgment];
    if (action === undefined) {
      throw one(field('overallJudgmentCode', ERROR_CODE.INVALID, '값 목록 밖의 종합 판정입니다.'));
    }
    const request = await this.completeRequest(tx, input.inspectionRequestId, input.appUserId);
    const actor = input.appUserId !== undefined
      ? { changedBy: BigInt(input.appUserId) }
      : terminalAudit !== undefined
        ? { changedWorkerId: terminalAudit.workerId }
        : (() => { throw new UnauthorizedException('검사 확정 작업자가 필요합니다.'); })();
    const moveContext: LotQualityMoveContext = {
      ...actor,
      changedAt: input.changedAt,
      sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
      sourceDocumentId: input.inspectionResultId,
    };
    await this.moveTargetLot(tx, request, input.judgment, action, moveContext);
    if (input.nonconformanceNo !== undefined && needsIqcNonconformance(request.inspection_type_code, input.judgment, request.lot_id)) {
      await createIqcNonconformanceWithin(tx, {
        nonconformanceNo: input.nonconformanceNo,
        inspectionResultId: input.inspectionResultId,
        request,
        qty: input.rejectedQty > 0 ? input.rejectedQty : (input.inspectedQty ?? input.rejectedQty),
        appUserId: input.appUserId,
        at: input.changedAt,
      });
    }
    const c14 = await this.spreadC14(tx, request, input.rejectedQty, moveContext);
    // ⛔ C14 가 걸린 합격은 정상 전환을 하지 않는다 — 방금 검사 대기로 돌린 LOT 을 같은 트랜잭션에서 되돌린다(#105 리뷰).
    if (!c14) await this.releasePqcLots(tx, request, input.judgment, moveContext);
  }

  /**
   * PQC 합격이면 그 W/O 의 **생산된** 검사대기 생산LOT 을 정상으로 올린다(omf-all-around#105 · C4).
   * PQC 의뢰는 W/O 대상이라(`lot_id` null) `moveTargetLot` 이 LOT 을 옮기지 못한다 — 그대로 두면
   * 생산LOT 이 정상이 되는 길이 없어 다음 공정 투입·출하가 막힌다.
   * ⛔ 아직 실적이 없는 슬롯(`WAITING`)은 옮기지 않는다 — 실물이 없는 LOT 을 정상으로 만들지 않는다.
   */
  private async releasePqcLots(
    tx: Tx,
    request: { inspection_type_code: string; work_order_id: bigint | null },
    judgment: string,
    context: LotQualityMoveContext,
  ): Promise<void> {
    if (request.inspection_type_code !== PQC || request.work_order_id === null || judgment !== ACCEPTED) return;
    const lots = await tx.lot.findMany({
      where: {
        source_type_code: WORK_ORDER_LOT_SOURCE,
        source_id: request.work_order_id,
        work_order_lot_seq: { not: null },
        status_code: 'INSPECTION_PENDING',
        lifecycle_status_code: { not: PREISSUED_LIFECYCLE },
      },
      select: { lot_id: true },
    });
    // 다른 열린 보류(의심자재 등)가 있는 LOT 은 올리지 않는다 — IQC 확정과 같은 규율(#105 리뷰).
    const free = await lotsFreeOfOpenHolds(tx, this.holds, lots.map((lot) => lot.lot_id));
    await this.lots.moveWithin(tx, free, 'inspection-accepted', context);
  }

  /**
   * ⚠ 전이표 «밖»이다 — 계약이 「`:confirm` 이 `COMPLETED` 로 옮긴다」를 **부수 효과**로 적었고
   * 출발이 `REQUESTED`·`IN_PROGRESS` 둘이라 액션 하나로 못 묶는다. 자기 스키마(`quality`)라
   * 서비스가 직접 UPDATE 한다(§7-3 의 유일한 예외).
   */
  private completeRequest(tx: Tx, inspectionRequestId: bigint, appUserId: number | undefined) {
    return tx.inspection_request.update({
      where: { inspection_request_id: inspectionRequestId },
      data: { status_code: REQUEST_COMPLETED, updated_by: appUserId ?? null, version_no: { increment: 1 } },
      select: {
        lot_id: true,
        item_id: true,
        uom_id: true,
        work_order_id: true,
        inspection_type_code: true,
        inspection_plan_version: { select: { acceptance_number: true } },
      },
    });
  }

  /**
   * 대상 LOT — ⭐ **`targetTypeCode` 로 가르지 않는다. `lot_id` 가 있으면 그 1건**(R-10 ·
   * `W-04-03` §5-2·§4-A). 없으면 **전이 없이 확정만** 한다(400 을 내지 않는다 — 계약이
   * 요구하지 않는다 · 미발행 · I-19 §9-2 후보 6).
   *
   * ⭐ 합격은 «다른 열린 보류»가 남아 있으면 `NORMAL` 로 **안 올린다**(R-11) — 중복 보류가
   * 허용되므로(`W-03-02` §4-B) 수입검사 보류만 닫고 올리면 의심자재 보류가 열린 채 출고가 풀린다.
   * ⛔ 불합격·보류 판정은 보류를 **닫지 않는다** — `W-01-01` §5-1 「불합격 = Hold 유지 → 반품」.
   */
  private async moveTargetLot(
    tx: Tx,
    request: { lot_id: bigint | null },
    judgment: string,
    action: string,
    context: LotQualityMoveContext,
  ): Promise<void> {
    const lotId = request.lot_id;
    if (lotId === null) return;
    // ⭐⭐ R-5 — 보류 해제도 그 뒤의 재계수도 이 잠금 «안»이어야 한다(코어가 표식으로 강제한다).
    // ⚠ 판정과 무관하게 «먼저» 잡는다 — 합격 갈래 안으로 옮기면 나머지 갈래의 잠금이
    //    `moveWithin` 안으로 숨어, 뒤에 그 갈래에 보류 읽기를 더하는 사람이 잠금 밖에서 읽는다.
    const locked = await this.holds.lockLotsWithin(tx, [lotId]);
    if (judgment === ACCEPTED) {
      // 입하 LOT 이 태어날 때 걸린 보류만 닫는다. `status_code` 는 코어가 안 건드린다(문의 13).
      const { openAfter } = await this.holds.releaseWithin(
        tx,
        locked,
        { lotId, reasonCode: INSPECTION_HOLD_REASON },
        { releaseReasonCode: HOLD_RELEASE_REASON },
        context.changedBy !== undefined
          ? { by: context.changedBy, at: context.changedAt }
          : { workerId: context.changedWorkerId as bigint, at: context.changedAt },
      );
      if (openAfter > 0) return;
    }
    const { movedLotIds } = await this.lots.moveWithin(tx, [lotId], action, context);
    // ⭐ 코어는 `from` 밖이면 건너뛴다(R-7 — C14 가 집합이라 그렇다). 단건 대상에서 「안
    //    옮겨졌다」를 조용히 200 으로 내면 판정과 LOT 상태가 갈린다(결정 10 「상태 이중 보유
    //    없음」) ⇒ 400 `STATE_LOCKED`. §3-2 ⑥ 이 `SCRAPPED` 에 이미 그 값을 적었다.
    //    ⚠ 그 필연으로 `DEFECTIVE` LOT 의 재검 합격 확정이 막힌다 — 설계 미정 · 문의 088.
    if (movedLotIds.length === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '지금 LOT 상태에서는 이 판정으로 확정할 수 없습니다.',
        },
      ]);
    }
  }

  /**
   * ⭐ C14 — 「PQC 샘플 검사에서 불합격 «수»가 공정별 합격판정개수를 넘으면 같은 W/O 의
   * 생산LOT **전체**를 검사 대기로 일괄 전이한다」(계약 · 도식 C14). 기준값은
   * `inspection_plan_version.acceptance_number`(`W-06-02:106` 이 「C14 의 근거 필드」라 적었다).
   *
   * ⚠ 「불합격 수」를 `rejected_qty`(수량)로 읽는다 — 측정치는 «항목×샘플»이라 개수 축이
   *   다르다(§3-4 · 미발행 · I-19 §9-2 후보 7). 넷 중 하나라도 비면 **판정을 건너뛴다**(0 으로 접지 않는다).
   * ⛔ `from` 밖 LOT(`SCRAPPED`·`DEFECTIVE`)은 코어가 **건너뛴다** — 하나 섞였다고 PQC 확정
   *   전체가 막히면 안 된다(R-7). ⛔ `C15` 를 쓰지 않는다(미발행 · I-19 §9-2 후보 8).
   */
  private async spreadC14(
    tx: Tx,
    request: {
      inspection_type_code: string;
      work_order_id: bigint | null;
      inspection_plan_version: { acceptance_number: number | null } | null;
    },
    rejectedQty: number,
    context: LotQualityMoveContext,
  ): Promise<boolean> {
    const acceptanceNumber = request.inspection_plan_version?.acceptance_number ?? null;
    const workOrderId = request.work_order_id;
    if (request.inspection_type_code !== PQC || workOrderId === null) return false;
    if (!pqcAcceptanceExceeded(rejectedQty, acceptanceNumber)) return false;

    const lots = await tx.lot.findMany({
      // 선발행 슬롯이 생산LOT 이다(`lot-registry.service.ts:145-160`) — 두 칸으로 좁힌다.
      where: {
        source_type_code: WORK_ORDER_LOT_SOURCE,
        source_id: workOrderId,
        work_order_lot_seq: { not: null },
      },
      select: { lot_id: true },
    });
    await this.lots.moveWithin(
      tx,
      lots.map((lot) => lot.lot_id),
      'pqc-acceptance-exceeded',
      context,
    );
    return true;
  }
}

/**
 * IQC 불합격 확정은 불합격 사유(불량 기록)가 있어야 한다(omf-all-around#106 · 2026-10-16 결정 ② · 장부 P-42).
 * 화면(W-01-01)이 먼저 막지만 다른 클라이언트가 사유 없이 불합격을 확정하지 못하게 서버도 막는다.
 * ⚠ `:confirm` 경로에만 건다 — 오프라인 큐(`POST …/inspection-results` 확정)는 결과 id 를 몰라 불량 기록을
 *    먼저 붙일 수 없다. PQC·OQC 는 이번 결정 범위가 아니다.
 */
export async function assertRejectionRecorded(
  tx: Tx,
  inspectionResultId: bigint,
  inspectionRequestId: bigint,
  judgment: string | undefined,
): Promise<void> {
  if (judgment !== REJECTED) return;
  const request = await tx.inspection_request.findUnique({
    where: { inspection_request_id: inspectionRequestId },
    select: { inspection_type_code: true },
  });
  if (request?.inspection_type_code !== IQC) return;
  const recorded = await tx.defect_record.count({ where: { inspection_result_id: inspectionResultId } });
  if (recorded > 0) return;
  throw one(field('defectRecords', ERROR_CODE.REQUIRED, '불합격이면 불량 코드와 사유를 먼저 기록해야 합니다.'));
}

/** ⛔ `SELECT … FOR UPDATE` — 읽고 판정하고 쓰는 사이에 같은 결과가 확정되면 두 번 전이한다. */
async function lockResult(tx: Tx, inspectionResultId: bigint): Promise<LockedResult> {
  const rows = await tx.$queryRaw<LockedResult[]>`
    SELECT inspection_request_id, status_code, version_no, overall_judgment_code,
           inspected_qty, accepted_qty, rejected_qty, held_qty, remarks
      FROM quality.inspection_result
     WHERE inspection_result_id = ${inspectionResultId}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 검사 결과입니다.');
  return rows[0];
}

/**
 * 409 봉투에 **LOT 의 현재 상태**를 함께 싣는다 — 계약이 「⛔ `message` 자유 텍스트에서
 * 파싱하지 않는다 — 이 구조화 필드가 정본이다」(`QualityConflictResponse.currentLotStatusCode`)
 * 라 못박았다. 대상 LOT 이 없는 의뢰(PQC·출하지시)면 칸을 **생략**한다(널 금지 · §5-7).
 */
async function conflictExtra(tx: Tx, result: LockedResult): Promise<ConflictExtra> {
  const request = await tx.inspection_request.findUnique({
    where: { inspection_request_id: result.inspection_request_id },
    select: { lot: { select: { status_code: true } } },
  });
  return {
    code: VERSION_CONFLICT,
    currentVersion: String(result.version_no),
    ...optional('currentLotStatusCode', request?.lot?.status_code),
  };
}

/** 응답은 조회·저장과 **같은 매퍼**를 탄다 — 확정 직후 화면이 목록과 다른 모양을 보면 안 된다. */
async function reread(tx: Tx, inspectionResultId: bigint): Promise<InspectionResultView> {
  const row = await tx.inspection_result.findUniqueOrThrow({
    where: { inspection_result_id: inspectionResultId },
    include: INSPECTION_RESULT_JOIN,
  });
  return inspectionResultView(row);
}
