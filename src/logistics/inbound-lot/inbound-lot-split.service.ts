import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { idempotencyContextOf } from '../../common/master';
import { NumberingService } from '../../core/numbering';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { recordInspectionRequestEvent } from '../../quality/inspection/inspection-request-event';
import { syncIqcDefectLotWithin } from '../../quality/inspection/iqc-inbound-lot-result';
import { LogisticsWriteActor } from '../logistics-write-actor';
import {
  InboundLotSplitPlan, MovedAllocation, SplitResultClasses, classifySplitResults, planInboundLotSplit, splitInboundLot,
} from './inbound-lot-split';
import { InboundLotView, loadInboundLotViews } from './inbound-lot-view';

type Db = Prisma.TransactionClient;

/** 계약 `InboundLotSplitLots`. */
export interface InboundLotSplitLots {
  lotIds: number[];
  versionNo: number;
  reason?: string | null;
}

export interface MovedAllocationView {
  purchaseOrderLineId: number | null;
  purchaseOrderNo: string | null;
  lineNo: number | null;
  qty: number;
}

/** 계약 `InboundLotSplitPreview`. */
export interface InboundLotSplitPreviewView {
  movedLotCount: number;
  movedQty: number;
  remainingLotCount: number;
  remainingQty: number;
  newInspectionInProgress: boolean;
  movedResults: { inspectionResultId: number; seqNo: number; overallJudgmentCode: string | null }[];
  unmatchedResults: { inspectionResultId: number; seqNo: number; removedLotIds: number[] }[];
  keptResults: { inspectionResultId: number; seqNo: number }[];
  movedAllocations: MovedAllocationView[];
}

/** 계약 `InboundLotSplitResult`. */
export interface InboundLotSplitResultView {
  inboundLot: InboundLotView;
  inspectionRequestId: number | null;
  movedLotIds: number[];
  movedResultIds: number[];
  movedAllocations: MovedAllocationView[];
}

const OPEN_STATUSES = ['REQUESTED', 'IN_PROGRESS'];
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

/**
 * IQC 단계 자재 관리 LOT 분리(`:split-lots`·`split-preview` · 피처 005 §3 · FR-040 · 권한 W-01-01). 원래 IQC 가 판정 확정 전
 * (`REQUESTED`/`IN_PROGRESS`)일 때만 — 새 입하 LOT 에 새 IQC 요청을 세우고, 옮긴 LOT 에만 매칭된 결과는 새 요청으로 옮기고(순번 1부터),
 * 다른 LOT 와 함께 매칭된 결과는 남기고 옮긴 LOT 매칭만 지운다. 두 입하 LOT 은 각각 판정 확정한다.
 */
@Injectable()
export class InboundLotSplitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async preview(inboundLotId: number, lotIds: number[]): Promise<InboundLotSplitPreviewView> {
    const db = this.prisma as unknown as Db;
    const plan = await planInboundLotSplit(db, BigInt(inboundLotId), lotIds);
    const request = await openIqcRequest(db, plan.inboundLot.inbound_lot_id);
    const classes = classifySplitResults(await requestResults(db, request.inspection_request_id), plan.movedLots.map((lot) => lot.lot_id));
    return previewView(plan, classes);
  }

  async split(request: Request, inboundLotId: number, body: InboundLotSplitLots, actor: LogisticsWriteActor): Promise<InboundLotSplitResultView> {
    const context = idempotencyContextOf(request, HttpStatus.CREATED);
    const replay = await this.idempotency.replayExisting<InboundLotSplitResultView>(context);
    if (replay !== undefined) return replay.body;
    const head = await this.prisma.inbound_lot.findUnique({
      where: { inbound_lot_id: BigInt(inboundLotId) }, select: { plant_id: true, plant: { select: { timezone_code: true } } },
    });
    if (head === null) throw new NotFoundException('없는 입하 LOT 입니다.');
    const at = new Date();
    const day = localDate(at, head.plant.timezone_code);
    const newInboundLotNo = await this.numbering.next('INBOUND_LOT', head.plant_id, day);
    const requestNo = await this.numbering.next('INSPECTION_REQUEST', head.plant_id, day);
    const outcome = await this.idempotency.run(context, (tx) => this.splitWithin(tx, inboundLotId, body, actor, { at, newInboundLotNo, requestNo }), TRANSACTION_OPTIONS);
    return outcome.body;
  }

  private async splitWithin(
    tx: Db, inboundLotId: number, body: InboundLotSplitLots, actor: LogisticsWriteActor,
    numbers: { at: Date; newInboundLotNo: string; requestNo: string },
  ): Promise<InboundLotSplitResultView> {
    const { at } = numbers;
    const { plan, newInboundLotId } = await splitInboundLot(tx, {
      inboundLotId: BigInt(inboundLotId), lotIds: body.lotIds, newInboundLotNo: numbers.newInboundLotNo, versionNo: body.versionNo,
      actor, at, reason: body.reason,
    });
    const source = await openIqcRequest(tx, plan.inboundLot.inbound_lot_id, true);
    const movedLotIds = plan.movedLots.map((lot) => lot.lot_id);
    const classes = classifySplitResults(await requestResults(tx, source.inspection_request_id), movedLotIds);
    const by = actor.appUserId === undefined ? null : BigInt(actor.appUserId);
    const created = await tx.inspection_request.create({
      data: {
        inspection_request_no: numbers.requestNo, inspection_type_code: 'IQC', inspection_plan_version_id: source.inspection_plan_version_id,
        target_type_code: 'INBOUND_LOT', target_id: newInboundLotId, inbound_lot_id: newInboundLotId, lot_id: null,
        item_id: source.item_id, target_qty: plan.movedQty, uom_id: source.uom_id,
        status_code: classes.moved.length > 0 ? 'IN_PROGRESS' : 'REQUESTED', requested_at: at, created_by: by,
      },
      select: { inspection_request_id: true },
    });
    const newRequestId = created.inspection_request_id;
    for (const [index, result] of classes.moved.entries()) {
      await tx.inspection_result.update({
        where: { inspection_result_id: result.inspectionResultId },
        data: { inspection_request_id: newRequestId, inspection_round: index + 1, confirm_cycle: 1, updated_by: by, version_no: { increment: 1 } },
      });
    }
    for (const result of classes.unmatched) {
      await tx.inspection_result_lot.deleteMany({ where: { inspection_result_id: result.inspectionResultId, lot_id: { in: result.removedLotIds } } });
      await syncIqcDefectLotWithin(tx, result.inspectionResultId);
    }
    // 4M 변경품 기록은 LOT 에 붙어 그 LOT 의 검사를 따라간다.
    await tx.lot_four_m_change.updateMany({
      where: { lot_id: { in: movedLotIds }, inspection_request_id: source.inspection_request_id }, data: { inspection_request_id: newRequestId },
    });
    await tx.inspection_request.update({
      where: { inspection_request_id: source.inspection_request_id },
      data: { target_qty: plan.remainingQty, updated_by: by, version_no: { increment: 1 } },
    });
    await recordSplitEvents(tx, {
      sourceRequestId: source.inspection_request_id, newRequestId, plan, newInboundLotId, classes, actor, at, reason: body.reason,
    });
    const [inboundLot] = await loadInboundLotViews(tx, { inbound_lot_id: newInboundLotId });
    return {
      inboundLot, inspectionRequestId: Number(newRequestId), movedLotIds: movedLotIds.map(Number),
      movedResultIds: classes.moved.map((result) => Number(result.inspectionResultId)),
      movedAllocations: plan.allocations.map(allocationView),
    };
  }
}

interface OpenRequest {
  inspection_request_id: bigint;
  status_code: string;
  item_id: bigint;
  uom_id: bigint;
  inspection_plan_version_id: bigint | null;
}

/** 입하 LOT 의 IQC 요청 — 판정 확정 전(대기·진행)이 아니면(확정·생략·IQC 없음) 409. `lock` 이면 요청 행을 잠근다. */
async function openIqcRequest(db: Db, inboundLotId: bigint, lock = false): Promise<OpenRequest> {
  const rows = lock
    ? await db.$queryRaw<OpenRequest[]>`
        SELECT inspection_request_id, status_code, item_id, uom_id, inspection_plan_version_id FROM quality.inspection_request
         WHERE inbound_lot_id = ${inboundLotId} AND inspection_type_code = 'IQC' AND target_type_code = 'INBOUND_LOT' AND status_code <> 'CANCELLED'
           FOR UPDATE`
    : await db.inspection_request.findMany({
        where: { inbound_lot_id: inboundLotId, inspection_type_code: 'IQC', target_type_code: 'INBOUND_LOT', status_code: { not: 'CANCELLED' } },
        select: { inspection_request_id: true, status_code: true, item_id: true, uom_id: true, inspection_plan_version_id: true },
      });
  const request = rows[0];
  if (request === undefined || !OPEN_STATUSES.includes(request.status_code)) {
    throw new ContractException(HttpStatus.CONFLICT, [{
      scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: 'IQC 판정 확정 전에만 자재 관리 LOT 을 분리할 수 있습니다 — 확정했으면 확정 취소 뒤 분리하세요.',
    }]);
  }
  return request;
}

async function requestResults(db: Db, inspectionRequestId: bigint) {
  const rows = await db.inspection_result.findMany({
    where: { inspection_request_id: inspectionRequestId },
    select: { inspection_result_id: true, inspection_round: true, overall_judgment_code: true, inspection_result_lot: { select: { lot_id: true } } },
  });
  return rows.map((row) => ({
    inspectionResultId: row.inspection_result_id, seqNo: row.inspection_round, overallJudgmentCode: row.overall_judgment_code,
    lotIds: row.inspection_result_lot.map((match) => match.lot_id),
  }));
}

async function recordSplitEvents(
  tx: Db,
  input: {
    sourceRequestId: bigint; newRequestId: bigint; plan: InboundLotSplitPlan; newInboundLotId: bigint; classes: SplitResultClasses;
    actor: LogisticsWriteActor; at: Date; reason?: string | null;
  },
): Promise<void> {
  const actor = input.actor.appUserId === undefined ? { workerId: input.actor.workerId } : { appUserId: input.actor.appUserId };
  const movedLotIds = input.plan.movedLots.map((lot) => Number(lot.lot_id));
  const movedResultIds = input.classes.moved.map((result) => Number(result.inspectionResultId));
  const reason = input.reason?.trim() || null;
  await recordInspectionRequestEvent(tx, {
    inspectionRequestId: input.sourceRequestId, eventTypeCode: 'SPLIT_OUT', actor, at: input.at, reason,
    summaryAfter: {
      newInspectionRequestId: Number(input.newRequestId), newInboundLotId: Number(input.newInboundLotId), movedLotIds, movedResultIds,
      unmatchedResults: input.classes.unmatched.map((result) => ({
        inspectionResultId: Number(result.inspectionResultId), removedLotIds: result.removedLotIds.map(Number),
      })),
      targetQty: Number(input.plan.remainingQty),
    },
  });
  await recordInspectionRequestEvent(tx, {
    inspectionRequestId: input.newRequestId, eventTypeCode: 'SPLIT_IN', actor, at: input.at, reason,
    summaryAfter: {
      fromInspectionRequestId: Number(input.sourceRequestId), fromInboundLotId: Number(input.plan.inboundLot.inbound_lot_id),
      movedLotIds, movedResultIds, targetQty: Number(input.plan.movedQty),
    },
  });
}

function previewView(plan: InboundLotSplitPlan, classes: SplitResultClasses): InboundLotSplitPreviewView {
  return {
    movedLotCount: plan.movedLots.length, movedQty: Number(plan.movedQty),
    remainingLotCount: plan.remainingLots.length, remainingQty: Number(plan.remainingQty),
    newInspectionInProgress: classes.moved.length > 0,
    movedResults: classes.moved.map((result) => ({
      inspectionResultId: Number(result.inspectionResultId), seqNo: result.seqNo, overallJudgmentCode: result.overallJudgmentCode,
    })),
    unmatchedResults: classes.unmatched.map((result) => ({
      inspectionResultId: Number(result.inspectionResultId), seqNo: result.seqNo, removedLotIds: result.removedLotIds.map(Number),
    })),
    keptResults: classes.kept.map((result) => ({ inspectionResultId: Number(result.inspectionResultId), seqNo: result.seqNo })),
    movedAllocations: plan.allocations.map(allocationView),
  };
}

export function allocationView(row: MovedAllocation): MovedAllocationView {
  return {
    purchaseOrderLineId: row.purchaseOrderLineId === null ? null : Number(row.purchaseOrderLineId),
    purchaseOrderNo: row.purchaseOrderNo, lineNo: row.lineNo, qty: Number(row.qty),
  };
}
