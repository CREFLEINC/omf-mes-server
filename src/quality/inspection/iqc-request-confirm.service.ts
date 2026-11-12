import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, type ErrorItem, field } from '../../common/errors';
import type { IdempotencyContext } from '../../common/idempotency';
import { IdempotencyService } from '../../common/idempotency';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { INITIAL_LOT_STATUS, INSPECTION_HOLD_REASON, LotHoldService, LotQualityMoveContext, LotQualityStatusService, Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { recordIqcInspectionLevelWithin } from '../inspection-level/inspection-level-switch';
import { InspectionConfirmService } from './inspection-confirm.service';
import { recordInspectionRequestEvent } from './inspection-request-event';
import { INBOUND_LOT_TARGET } from './iqc-inbound-lot-result';
import { confirmCancelBlockers, confirmMadeNonconformanceIds, loadConfirmCancelFacts } from './iqc-confirm-cancel';
import { createIqcNonconformanceWithin } from './iqc-nonconformance';
import { iqcOverallJudgment } from './iqc-overall-judgment';
import { IqcRejectedHandoverNotifier } from './iqc-rejected-handover';

/** 계약 `InspectionRequestConfirm`. */
export interface InspectionRequestConfirm {
  versionNo: number;
}

/** 계약 `InspectionRequestCancelConfirm`. */
export interface InspectionRequestCancelConfirm {
  versionNo: number;
  reason?: string | null;
}

const OPEN_STATUSES = ['REQUESTED', 'IN_PROGRESS'];
const COMPLETED = 'COMPLETED';
const IN_PROGRESS = 'IN_PROGRESS';
const REJECTED = 'REJECTED';
const INVALID_STATE = 'INVALID_STATE';
/** `lot_status_event.source_document_type_code` — 검사 단위 확정·취소가 일으킨 전이(피처 005 R-12). */
const SOURCE_DOCUMENT_TYPE = 'INSPECTION_REQUEST';
const ACTION_BY_JUDGMENT: Record<string, string> = { ACCEPTED: 'inspection-accepted', REJECTED: 'inspection-rejected', HELD: 'inspection-held' };
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

interface LockedRequest {
  inspection_request_id: bigint;
  status_code: string;
  version_no: number;
  item_id: bigint;
  uom_id: bigint;
  work_order_id: bigint | null;
  inbound_lot_id: bigint;
  overall_judgment_code: string | null;
  confirmed_at: Date | null;
  confirmed_by: bigint | null;
}

/** 확정 직전에 불합격이 됐는데 번호를 안 받아 왔다 — 번호를 받고 다시 한다(채번은 트랜잭션 밖 · P-41). */
class NonconformanceNoNeeded extends Error {}

/**
 * 입하 LOT 검사의 판정 확정·확정 취소(피처 005 R-12·R-13 · 권한 W-01-15). 새 흐름(`target_type_code='INBOUND_LOT'`)만 —
 * 이전된 옛 요청·PQC·OQC 는 결과 단위 `:confirm` 이다(FR-051). 잠금 순서는 마감 취소와 같다 — LOT(오름차순) 다음 요청.
 */
@Injectable()
export class IqcRequestConfirmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly numbering: NumberingService,
    private readonly states: DocumentStateService,
    private readonly lots: LotQualityStatusService,
    private readonly holds: LotHoldService,
    private readonly confirms: InspectionConfirmService,
    private readonly rejectedNotices: IqcRejectedHandoverNotifier,
  ) {}

  async confirm(context: IdempotencyContext, inspectionRequestId: number, body: InspectionRequestConfirm, appUserId: number): Promise<void> {
    if ((await this.idempotency.replayExisting(context)) !== undefined) return;
    const id = BigInt(inspectionRequestId);
    let nonconformanceNo = await this.nonconformanceNoIfRejected(id);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.idempotency.run(context, async (tx) => {
          await this.confirmWithin(tx, id, body.versionNo, appUserId, nonconformanceNo);
          return { inspectionRequestId };
        }, TRANSACTION_OPTIONS);
        return;
      } catch (error) {
        if (attempt >= 2 || !(error instanceof NonconformanceNoNeeded)) throw error;
        nonconformanceNo = await this.numbering.next('NONCONFORMANCE', null, new Date().toISOString().slice(0, 10));
      }
    }
  }

  async cancelConfirm(tx: Tx, inspectionRequestId: number, body: InspectionRequestCancelConfirm, appUserId: number): Promise<{ inspectionRequestId: number }> {
    const { request, lots, locked } = await lockRequest(tx, BigInt(inspectionRequestId), this.holds);
    assertVersion(request, body.versionNo);
    if (request.status_code !== COMPLETED || request.confirmed_at === null) {
      throw new ConflictException('user', '판정 확정된 검사만 확정을 취소할 수 있습니다.', { code: INVALID_STATE });
    }
    // INBOUND_LOT_FINALIZED — 최종 마감(S12)의 `assertInboundLotMutable` 이 여기서 막는다.
    const nonconformanceIds = await confirmMadeNonconformanceIds(tx, request.inspection_request_id, request.confirmed_at);
    const blockers = confirmCancelBlockers(await loadConfirmCancelFacts(tx, {
      inspectionRequestId: request.inspection_request_id, lots, confirmedAt: request.confirmed_at, nonconformanceIds,
    }));
    if (blockers.length > 0) throw new ContractException(HttpStatus.CONFLICT, blockers);

    const at = new Date();
    const by = BigInt(appUserId);
    const lotIds = lots.map((lot) => lot.lot_id);
    const settled = locked.filter((lot) => lot.status_code !== INITIAL_LOT_STATUS).map((lot) => lot.lot_id);
    await this.lots.moveWithin(tx, settled, 'iqc-confirm-cancelled', {
      changedBy: by, changedAt: at, sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE, sourceDocumentId: request.inspection_request_id,
    });
    // 합격 확정이 닫은 검사 대기 보류를 다시 건다 — 불합격·보류 확정은 보류를 닫지 않았다.
    const held = await tx.lot_hold.findMany({
      where: { lot_id: { in: lotIds }, reason_code: INSPECTION_HOLD_REASON, released_at: null }, select: { lot_id: true },
    });
    const heldIds = new Set(held.map((hold) => hold.lot_id));
    const rehold = lotIds.filter((lotId) => !heldIds.has(lotId));
    if (rehold.length > 0) {
      await this.holds.holdWithin(tx, locked,
        rehold.map((lotId) => ({ lotId, reasonCode: INSPECTION_HOLD_REASON, targetLotStatusCode: INITIAL_LOT_STATUS })), { at, by });
    }
    for (const nonconformanceId of nonconformanceIds) await this.cancelNonconformance(tx, nonconformanceId, at, by);
    await this.reopenResults(tx, request.inspection_request_id, appUserId);
    await tx.inspection_request.update({
      where: { inspection_request_id: request.inspection_request_id },
      data: {
        // 검사 수준은 확정 때 그때의 품목 수준으로 다시 적는다(`recordIqcInspectionLevelWithin` 은 빈 칸에만 쓴다).
        status_code: IN_PROGRESS, overall_judgment_code: null, confirmed_at: null, confirmed_by: null, inspection_level_code: null,
        confirm_cycle: { increment: 1 }, updated_by: by, version_no: { increment: 1 },
      },
    });
    await recordInspectionRequestEvent(tx, {
      inspectionRequestId: request.inspection_request_id, eventTypeCode: 'CONFIRM_CANCELLED', actor: { appUserId }, at,
      summaryBefore: {
        statusCode: request.status_code, overallJudgmentCode: request.overall_judgment_code, confirmedAt: request.confirmed_at.toISOString(),
        confirmedBy: request.confirmed_by === null ? null : Number(request.confirmed_by),
        nonconformanceIds: nonconformanceIds.map((ncId) => Number(ncId)),
      },
      summaryAfter: { statusCode: IN_PROGRESS },
      reason: body.reason?.trim() || null,
    });
    return { inspectionRequestId };
  }

  private async confirmWithin(tx: Tx, id: bigint, versionNo: number, appUserId: number, nonconformanceNo: string | undefined): Promise<void> {
    const { request, lots } = await lockRequest(tx, id, this.holds);
    assertVersion(request, versionNo);
    if (!OPEN_STATUSES.includes(request.status_code)) {
      throw new ConflictException('user', '판정 확정됐거나 끝난 검사입니다.', { code: INVALID_STATE });
    }
    const results = await tx.inspection_result.findMany({
      where: { inspection_request_id: id }, orderBy: { inspection_round: 'asc' },
      select: { inspection_result_id: true, inspection_round: true, overall_judgment_code: true, inspected_qty: true, accepted_qty: true, rejected_qty: true, held_qty: true },
    });
    assertConfirmable(results);
    const judgment = iqcOverallJudgment(results.map((result) => ({ overallJudgmentCode: result.overall_judgment_code }))).judgmentCode as string;
    if (judgment === REJECTED && nonconformanceNo === undefined) throw new NonconformanceNoNeeded();

    const at = new Date();
    const by = BigInt(appUserId);
    await tx.inspection_result.updateMany({
      where: { inspection_request_id: id, status_code: 'DRAFT' },
      data: { status_code: 'CONFIRMED', confirmed_at: at, updated_by: appUserId, version_no: { increment: 1 } },
    });
    await tx.inspection_request.update({
      where: { inspection_request_id: id },
      data: { status_code: COMPLETED, overall_judgment_code: judgment, confirmed_at: at, confirmed_by: by, updated_by: by, version_no: { increment: 1 } },
    });
    await recordIqcInspectionLevelWithin(tx, { inspectionRequestId: id, inspectionTypeCode: 'IQC', itemId: request.item_id });
    const context: LotQualityMoveContext = { changedBy: by, changedAt: at, sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE, sourceDocumentId: id };
    await this.confirms.moveTargetLots(tx, lots.map((lot) => lot.lot_id), judgment, ACTION_BY_JUDGMENT[judgment], context);
    let nonconformanceId: bigint | null = null;
    if (judgment === REJECTED) {
      const firstRejected = results.find((result) => result.overall_judgment_code === REJECTED);
      nonconformanceId = await createIqcNonconformanceWithin(tx, {
        nonconformanceNo: nonconformanceNo as string,
        inspectionResultId: (firstRejected ?? results[0]).inspection_result_id,
        inspectionRequestId: id,
        request: { inspection_type_code: 'IQC', lot_id: null, inbound_lot_id: request.inbound_lot_id, item_id: request.item_id, uom_id: request.uom_id, work_order_id: request.work_order_id },
        lotIds: lots.map((lot) => lot.lot_id),
        // LOT 하나뿐인 입하 LOT 도 그 LOT 의 초기 수량이 부적합 수량이다(LOT 전체 불합격).
        qty: Number(lots.reduce((sum, lot) => sum.plus(lot.initial_qty), new Prisma.Decimal(0))),
        appUserId,
        at,
      });
      await this.rejectedNotices.rejectedInboundLot(tx, lots);
    }
    await recordInspectionRequestEvent(tx, {
      inspectionRequestId: id, eventTypeCode: 'CONFIRMED', actor: { appUserId }, at,
      summaryAfter: {
        overallJudgmentCode: judgment, resultIds: results.map((result) => Number(result.inspection_result_id)),
        nonconformanceId: nonconformanceId === null ? null : Number(nonconformanceId),
      },
    });
  }

  /** 지금 결과 중 불합격이 있으면 부적합 번호를 미리 받는다. 확정 순간 판정이 달라지면 `confirmWithin` 이 다시 받게 한다. */
  private async nonconformanceNoIfRejected(id: bigint): Promise<string | undefined> {
    const rejected = await this.prisma.inspection_result.count({
      where: { inspection_request_id: id, overall_judgment_code: REJECTED, inspection_request: { target_type_code: INBOUND_LOT_TARGET } },
    });
    return rejected === 0 ? undefined : this.numbering.next('NONCONFORMANCE', null, new Date().toISOString().slice(0, 10));
  }

  private async cancelNonconformance(tx: Tx, nonconformanceId: bigint, at: Date, by: bigint): Promise<void> {
    const row = await tx.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nonconformanceId }, select: { status_code: true } });
    const to = this.states.assertTransition('quality.nonconformance.status_code', 'iqc-confirm-cancelled', row.status_code).to;
    await tx.nonconformance.update({
      where: { nonconformance_id: nonconformanceId },
      data: { status_code: to, closed_at: at, updated_by: by, version_no: { increment: 1 } },
    });
  }

  private async reopenResults(tx: Tx, id: bigint, appUserId: number): Promise<void> {
    const to = this.states.assertTransition('quality.inspection_result.status_code', 'iqc-confirm-cancelled', 'CONFIRMED').to;
    await tx.inspection_result.updateMany({
      where: { inspection_request_id: id, status_code: 'CONFIRMED' },
      data: { status_code: to, confirmed_at: null, updated_by: appUserId, version_no: { increment: 1 } },
    });
  }
}

/**
 * 요청을 읽고(새 흐름만), 입하 LOT 의 자재 관리 LOT 을 오름차순으로 잠근 뒤 요청 행을 잠근다.
 * 이전된 옛 요청·PQC·OQC 는 409 — 결과 단위 확정으로 끝까지 간다(FR-051).
 */
async function lockRequest(tx: Tx, id: bigint, holds: LotHoldService) {
  const head = await tx.inspection_request.findUnique({
    where: { inspection_request_id: id }, select: { target_type_code: true, inspection_type_code: true, inbound_lot_id: true },
  });
  if (head === null) throw new NotFoundException('없는 검사 의뢰입니다.');
  if (head.target_type_code !== INBOUND_LOT_TARGET || head.inspection_type_code !== 'IQC' || head.inbound_lot_id === null) {
    throw new ConflictException('user', '이전 데이터 검사는 결과 단위로 확정합니다.', { code: INVALID_STATE });
  }
  const lots = await tx.lot.findMany({
    where: { inbound_lot_id: head.inbound_lot_id }, orderBy: { lot_id: 'asc' }, select: { lot_id: true, lot_no: true, initial_qty: true },
  });
  const locked = await holds.lockLotsWithin(tx, lots.map((lot) => lot.lot_id));
  const [request] = await tx.$queryRaw<LockedRequest[]>`
    SELECT inspection_request_id, status_code, version_no, item_id, uom_id, work_order_id, inbound_lot_id,
           overall_judgment_code, confirmed_at, confirmed_by
      FROM quality.inspection_request WHERE inspection_request_id = ${id} FOR UPDATE`;
  return { request, lots, locked };
}

function assertVersion(request: LockedRequest, versionNo: number): void {
  if (request.version_no !== versionNo) {
    assertUpdated(0, 'user', { code: 'VERSION_CONFLICT', currentVersion: String(request.version_no) });
  }
}

/** 결과 1건 이상·모든 결과에 판정·결과마다 수량 합 = 검사 수량(R-12 ①) — CHECK 가 500 을 내기 전에 400 으로. 칸 이름의 n 은 순번. */
function assertConfirmable(
  results: readonly { inspection_round: number; overall_judgment_code: string | null; inspected_qty: Prisma.Decimal; accepted_qty: Prisma.Decimal; rejected_qty: Prisma.Decimal; held_qty: Prisma.Decimal }[],
): void {
  if (results.length === 0) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [field('results', ERROR_CODE.REQUIRED, '확정할 검사 결과가 없습니다 — 결과를 먼저 기록하세요.')]);
  }
  const errors: ErrorItem[] = [];
  for (const result of results) {
    const at = `results[${String(result.inspection_round)}]`;
    if (result.overall_judgment_code === null) {
      errors.push(field(`${at}.overallJudgmentCode`, ERROR_CODE.REQUIRED, `결과 ${String(result.inspection_round)} 에 판정이 없습니다.`));
    }
    if (!result.accepted_qty.plus(result.rejected_qty).plus(result.held_qty).equals(result.inspected_qty)) {
      errors.push(field(`${at}.inspectedQty`, ERROR_CODE.INVALID, `결과 ${String(result.inspection_round)} 의 합격·불합격·보류 수량 합이 검사 수량과 다릅니다.`));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
