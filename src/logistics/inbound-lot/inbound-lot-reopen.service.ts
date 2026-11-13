import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import {
  INBOUND_LOT_DOCUMENT, INBOUND_LOT_RECEIVING, INITIAL_LOT_STATUS, INSPECTION_HOLD_REASON, LotHoldService, LotQualityStatusService,
} from '../../core/lot';
import { localDate } from '../../planning/production-plan/plan-window';
import { recordInspectionRequestEvent } from '../../quality/inspection/inspection-request-event';
import { markIqcSkipVoided } from '../../trace/lot/lot-iqc-skip-execute.service';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { recordInboundLotEvent } from './inbound-lot-event';
import { assertInboundLotMutable } from './inbound-lot-finalizable';
import { ReopenBlockerCode, reopenStatesOf } from './inbound-lot-reopenable';
import { InboundLotView, loadInboundLotViews } from './inbound-lot-view';

/** 계약 `InboundLotReopenReceipt`. */
export interface InboundLotReopenReceipt {
  versionNo: number;
  reason?: string | null;
}

const BLOCKER_MESSAGE: Record<ReopenBlockerCode, string> = {
  IQC_RECORDED: 'IQC 결과가 기록돼 마감을 취소할 수 없습니다.',
  GOODS_RECEIVED: '입고된 자재 관리 LOT 이 있어 마감을 취소할 수 없습니다.',
  SKIP_PENDING: 'IQC 생략 결재가 진행 중이라 마감을 취소할 수 없습니다.',
  INBOUND_LOT_FINALIZED: '최종 마감된 입하 LOT 입니다.',
  LEGACY_INBOUND_LOT: '이전 데이터 입하 LOT 은 마감을 취소할 수 없습니다.',
  OPEN_RECEIPT_EXISTS: '같은 공급사·품목에 입하 중인 입하 LOT 이 있습니다 — 먼저 마감하세요',
};
const REQUEST_COLUMN = 'quality.inspection_request.status_code';
const CANCELLED = 'CANCELLED';

/**
 * 입하 마감 취소(`:reopen-receipt` · R-5a) — 다음 단계 전에만. 배정 해제·받은 양 감소(P/O 부모 오름차순 잠금) → `RECEIVING`·
 * `open_since_date` = 공장 현지 오늘 → IQC 요청 취소 → 긴급 생략 실행 건은 생략 무효(C30·보류 다시). 다시 마감하면 배정·요청을 새로 만든다.
 */
@Injectable()
export class InboundLotReopenService {
  constructor(
    private readonly quality: LotQualityStatusService,
    private readonly holds: LotHoldService,
    private readonly states: DocumentStateService,
  ) {}

  async reopen(tx: Prisma.TransactionClient, inboundLotId: number, body: InboundLotReopenReceipt, actor: LogisticsWriteActor): Promise<InboundLotView> {
    const id = BigInt(inboundLotId);
    // 받기·해제와 같은 순서 — LOT 을 먼저(오름차순), 그다음 입하 LOT.
    const lotIds = (await tx.lot.findMany({ where: { inbound_lot_id: id }, select: { lot_id: true }, orderBy: { lot_id: 'asc' } }))
      .map((row) => row.lot_id);
    const locked = await this.holds.lockLotsWithin(tx, lotIds);
    const [inboundLot] = await tx.$queryRaw<{ status_code: string; version_no: number; inbound_receipt_line_id: bigint; plant_id: bigint }[]>`
      SELECT status_code, version_no, inbound_receipt_line_id, plant_id FROM trace.inbound_lot WHERE inbound_lot_id = ${id} FOR UPDATE`;
    if (inboundLot === undefined) throw new NotFoundException('없는 입하 LOT 입니다.');
    assertUpdated(inboundLot.version_no === body.versionNo ? 1 : 0);
    await assertInboundLotMutable(tx, id);
    const state = (await reopenStatesOf(tx, [id])).get(id);
    if (state === undefined) {
      throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '마감된 입하 LOT 만 마감을 취소할 수 있습니다.' }]);
    }
    if (state.blockers.length > 0) {
      throw new ContractException(HttpStatus.CONFLICT, state.blockers.map((code) => ({
        scope: 'screen' as const, code,
        message: code === 'OPEN_RECEIPT_EXISTS' ? `${BLOCKER_MESSAGE[code]} (${String(state.openInboundLotNo)})` : BLOCKER_MESSAGE[code],
      })), { openInboundLotNo: state.openInboundLotNo });
    }

    const at = new Date();
    const by = actor.appUserId === undefined ? null : BigInt(actor.appUserId);
    const released = await releaseAllocations(tx, inboundLot.inbound_receipt_line_id, by);
    const plant = await tx.plant.findUniqueOrThrow({ where: { plant_id: inboundLot.plant_id }, select: { timezone_code: true } });
    await tx.inbound_lot.update({
      where: { inbound_lot_id: id },
      data: {
        status_code: INBOUND_LOT_RECEIVING, open_since_date: new Date(`${localDate(at, plant.timezone_code)}T00:00:00Z`),
        received_closed_at: null, received_closed_by: null, closed_automatically: false, version_no: { increment: 1 }, updated_by: by,
      },
    }).catch(openReceiptRace);
    const iqcRequestId = await this.cancelRequest(tx, id, lotIds, locked, actor, at);
    // 승인됐지만 아직 실행하지 않은 생략 결재도 무효다 — 남기면 다시 마감한 뒤 새 IQC 요청에 옛 승인으로 생략이 실행된다(R-5a·R-16).
    await markIqcSkipVoided(tx, id, at);
    await recordInboundLotEvent(tx, id, 'RECEIPT_REOPENED', actor, {
      releasedAllocations: released, iqcRequestId: iqcRequestId === null ? null : String(iqcRequestId),
    }, at, body.reason?.trim() || null);
    if (actor.terminalAudit !== undefined) {
      await recordTerminalWorkerAudit(tx, { actor: actor.terminalAudit, targetTypeCode: 'INBOUND_LOT', targetId: id, eventTypeCode: 'RECEIPT_REOPENED' });
    }
    const [view] = await loadInboundLotViews(tx, { inbound_lot_id: id });
    return view;
  }

  /**
   * IQC 요청을 `CANCELLED` 로 — 행과 입하 LOT 칸은 남긴다(유일 색인은 취소된 요청을 빼므로 다시 마감하면 새 요청이 선다).
   * 긴급 생략 실행 건(`SKIPPED`·`APPROVAL`)은 LOT 을 검사 대기로 되돌리고(C30) 검사 대기 보류를 다시 건다.
   */
  private async cancelRequest(
    tx: Prisma.TransactionClient, inboundLotId: bigint, lotIds: bigint[], locked: Awaited<ReturnType<LotHoldService['lockLotsWithin']>>,
    actor: LogisticsWriteActor, at: Date,
  ): Promise<bigint | null> {
    const [request] = await tx.$queryRaw<{ inspection_request_id: bigint; status_code: string; skip_basis_code: string | null }[]>`
      SELECT inspection_request_id, status_code, skip_basis_code FROM quality.inspection_request
       WHERE inbound_lot_id = ${inboundLotId} AND inspection_type_code = 'IQC' AND status_code <> ${CANCELLED} FOR UPDATE`;
    if (request === undefined) return null;
    // 진행 중 요청도 결과 0건이면 취소한다(2026-11-13) — 요청을 잠근 뒤 다시 세어 판정 사이에 들어온 결과(DRAFT 포함)를 놓치지 않는다.
    if (request.status_code !== 'SKIPPED' && (await tx.inspection_result.count({ where: { inspection_request_id: request.inspection_request_id } })) > 0) {
      throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: 'IQC_RECORDED', message: BLOCKER_MESSAGE.IQC_RECORDED }], { openInboundLotNo: null });
    }
    const to = this.states.assertTransition(REQUEST_COLUMN, 'inbound-receipt-reopened', request.status_code).to;
    const person = actor.appUserId === undefined ? { workerId: actor.workerId } : { appUserId: actor.appUserId };
    if (request.status_code === 'SKIPPED' && request.skip_basis_code === 'APPROVAL') {
      await this.quality.moveWithin(tx, lotIds, 'iqc-skip-voided', {
        ...(actor.appUserId === undefined ? { changedWorkerId: actor.workerId } : { changedBy: BigInt(actor.appUserId) }), changedAt: at,
        sourceDocumentTypeCode: INBOUND_LOT_DOCUMENT, sourceDocumentId: inboundLotId,
      });
      await this.holds.holdWithin(tx, locked,
        lotIds.map((lotId) => ({ lotId, reasonCode: INSPECTION_HOLD_REASON, targetLotStatusCode: INITIAL_LOT_STATUS })),
        actor.appUserId === undefined ? { at, workerId: actor.workerId } : { at, by: BigInt(actor.appUserId) });
      await recordInspectionRequestEvent(tx, {
        inspectionRequestId: request.inspection_request_id, eventTypeCode: 'SKIP_VOIDED', actor: person, at,
        summaryBefore: { statusCode: request.status_code, skipBasisCode: request.skip_basis_code },
      });
    }
    await tx.inspection_request.update({
      where: { inspection_request_id: request.inspection_request_id },
      data: {
        status_code: to, version_no: { increment: 1 },
        updated_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId),
      },
    });
    await recordInspectionRequestEvent(tx, {
      inspectionRequestId: request.inspection_request_id, eventTypeCode: 'CANCELLED_BY_REOPEN', actor: person, at,
      summaryBefore: { statusCode: request.status_code, skipBasisCode: request.skip_basis_code }, summaryAfter: { statusCode: to },
    });
    return request.inspection_request_id;
  }
}

/**
 * 위 판정 뒤 같은 조합의 첫 받기가 입하 LOT 을 열면 `uq_inbound_lot_open` 이 걸린다. 트랜잭션이 이미 깨져 그 번호는 못 읽는다 —
 * 번호 없이 같은 막힘으로 알린다(다시 읽으면 목록·상세가 번호를 준다).
 */
function openReceiptRace(error: unknown): never {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
  throw new ContractException(HttpStatus.CONFLICT, [
    { scope: 'screen', code: 'OPEN_RECEIPT_EXISTS', message: BLOCKER_MESSAGE.OPEN_RECEIPT_EXISTS },
  ], { openInboundLotNo: null });
}

/** 배정 행을 지우고 그만큼 P/O 라인 받은 양을 되돌린다 — 부모 P/O 를 오름차순 한 문장으로 먼저 잠근다. 풀린 배정을 돌려준다. */
async function releaseAllocations(tx: Prisma.TransactionClient, lineId: bigint, by: bigint | null): Promise<Prisma.InputJsonArray> {
  const rows = await tx.inbound_receipt_po_allocation.findMany({
    where: { inbound_receipt_line_id: lineId },
    select: { inbound_receipt_po_allocation_id: true, purchase_order_line_id: true, allocated_qty: true, purchase_order_line: { select: { purchase_order_id: true } } },
  });
  if (rows.length === 0) return [];
  const parents = [...new Set(rows.map((row) => row.purchase_order_line.purchase_order_id))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  await tx.$queryRaw`
    SELECT purchase_order_id FROM logistics.purchase_order
     WHERE purchase_order_id IN (${Prisma.join(parents)}) ORDER BY purchase_order_id FOR UPDATE`;
  for (const row of rows) {
    await tx.purchase_order_line.update({
      where: { purchase_order_line_id: row.purchase_order_line_id }, data: { received_qty: { decrement: row.allocated_qty }, updated_by: by },
    });
  }
  await tx.inbound_receipt_po_allocation.deleteMany({ where: { inbound_receipt_line_id: lineId } });
  return rows.map((row) => ({ purchaseOrderLineId: String(row.purchase_order_line_id), qty: row.allocated_qty.toString() }));
}
