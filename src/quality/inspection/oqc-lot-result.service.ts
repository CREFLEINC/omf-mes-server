import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { startInspectionRequestWithin } from './inspection-request-reopen';
import { recordInspectionRequestEvent } from './inspection-request-event';
import { INSPECTION_RESULT_JOIN, InspectionResultView, inspectionResultView } from './inspection-result-view';
import { InspectionResultCreate, InspectionResultUpdate, InspectionResultWriteContext } from './inspection-result-write-input';
import { VERSION_CONFLICT, assertCodes, resolveInspector } from './inspection-result-write-rules';
import { replaceMeasurementsWithin, writeMeasurementsWithin } from './inspection-measurement-write';
import { assertMeasurementValues } from './inspection-rules';
import {
  assertReinspectionReason,
  eventActor,
  nextResultSequence,
  reinspectionReasonOf,
  replaceMatchedLotsWithin,
  resultSummaryWithin,
} from './iqc-inbound-lot-result';
import { shipmentOqcConfirmConflict } from './oqc-flow-guard';
import { isShipmentOqc } from './oqc-lot-result';
import { prepareOqcSerials, recordOqcSerialsWithin } from './oqc-serials';

const DRAFT = 'DRAFT';
const PICKED = 'PICKED';
const OPEN = ['REQUESTED', 'IN_PROGRESS'];
const JUDGMENTS = ['ACCEPTED', 'REJECTED', 'HELD'];
const INVALID_STATE = 'INVALID_STATE';
const MATCHED_LOT_REQUIRED = 'MATCHED_LOT_REQUIRED';

interface OqcRequestFacts {
  inspection_request_id: bigint;
  target_id: bigint;
  item_id: bigint;
  uom_id: bigint;
  status_code: string;
}

interface MatchedLots {
  lotIds: bigint[];
  inspectedQty: Prisma.Decimal;
}

/**
 * 출하 OQC 새 흐름의 결과 쓰기(피처 010 · research R-5) — `InspectionResultWriteService` 가 분기 한 줄로 넘긴다.
 * ⭐ 매칭 LOT 1개 이상 필수(그 지시서·품목의 PICKED 피킹 LOT 만), 판정만 받고 수량은 서버가 채운다(검사 = 매칭 LOT 피킹 합,
 *    판정 칸 하나에 같은 값). 결과는 작성중(DRAFT)으로만 서고 확정은 출하 완료가 한다. 순번 = 최대 + 1, 재검 사유는 IQC 규칙 재사용.
 * ⭐ 검사 항목 측정은 지금처럼 받는다(FR-009 · T052) — IQC·PQC·OQC 와 같은 검사·저장 함수. 「판정만」은 수량을 받지 않는다는 뜻이다.
 * ⛔ 불량·4M 은 받지 않는다(계약 설명).
 */
@Injectable()
export class OqcLotResultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  /** 새 흐름 의뢰가 아니면 `null` — 부르는 쪽이 지금 흐름으로 간다. */
  async create(body: InspectionResultCreate, context: InspectionResultWriteContext): Promise<InspectionResultView | null> {
    const request = await shipmentOqcRequest(this.prisma, BigInt(body.inspectionRequestId));
    if (request === null) return null;
    if (body.statusCode !== DRAFT) throw shipmentOqcConfirmConflict();
    if (body.previousResultId !== undefined) {
      throw one(field('previousResultId', ERROR_CODE.INVALID, '출하 검사는 회차를 쓰지 않습니다 — 그 LOT 을 매칭한 새 결과를 더하세요.'));
    }
    assertOpen(request.status_code);
    const judgment = assertJudgment(body.overallJudgmentCode);
    await assertCodes(this.prisma, undefined, undefined, body.measurements);
    assertMeasurementValues(body.measurements);
    const matched = await matchedLots(this.prisma, request, body.matchedLotIds);
    const seqNo = await nextResultSequence(this.prisma, request.inspection_request_id);
    await assertReinspectionReason(this.prisma, request.inspection_request_id, {
      seqNo, judgmentCode: judgment, lotIds: matched.lotIds, reasonCode: body.reinspectionReasonCode,
    });
    const serials = await prepareOqcSerials(this.prisma, body, matched.lotIds);
    const inspectorId = await resolveInspector(this.prisma, context);
    const inspectedAt = new Date(body.inspectedAt);
    const resultNo = await this.numbering.next('INSPECTION_RESULT', null, inspectedAt.toISOString().slice(0, 10));

    return this.prisma.$transaction(async (tx) => {
      await lockOpen(tx, request.inspection_request_id);
      const created = await tx.inspection_result.create({
        data: {
          inspection_result_no: resultNo,
          inspection_request_id: request.inspection_request_id,
          inspection_round: seqNo,
          ...quantities(judgment, matched.inspectedQty),
          uom_id: request.uom_id,
          overall_judgment_code: judgment,
          inspector_id: inspectorId,
          inspected_at: inspectedAt,
          terminal_id: context.terminalId,
          status_code: DRAFT,
          reinspection_reason_code: body.reinspectionReasonCode ?? null,
          idempotency_key: context.idempotencyKey,
          remarks: body.remarks ?? null,
          created_by: context.appUserId ?? null,
        },
        select: { inspection_result_id: true },
      });
      await replaceMatchedLotsWithin(tx, created.inspection_result_id, matched.lotIds);
      await writeMeasurementsWithin(tx, created.inspection_result_id, body.measurements, context.appUserId);
      // 첫 결과가 의뢰를 «진행»으로 옮긴다(2026-11-18 결정 — 대기 → 진행 → 출하 완료 때 완료).
      await startInspectionRequestWithin(tx, request.inspection_request_id, context.appUserId);
      if (serials !== null) {
        await recordOqcSerialsWithin(tx, serials, {
          inspectionResultId: created.inspection_result_id, inspectedAt, workerId: inspectorId,
          appUserId: context.appUserId === undefined ? null : BigInt(context.appUserId),
        });
      }
      const summaryAfter = await resultSummaryWithin(tx, created.inspection_result_id);
      await recordInspectionRequestEvent(tx, {
        inspectionRequestId: request.inspection_request_id, eventTypeCode: 'RESULT_ADDED', inspectionResultId: created.inspection_result_id,
        actor: eventActor(context, inspectorId), at: new Date(), summaryAfter, reason: reinspectionReasonOf(summaryAfter),
      });
      if (context.terminalAudit !== undefined) {
        await recordTerminalWorkerAudit(tx, {
          actor: context.terminalAudit, targetTypeCode: 'INSPECTION_RESULT', targetId: created.inspection_result_id, eventTypeCode: 'CREATED',
        });
      }
      return reread(tx, created.inspection_result_id);
    });
  }

  /** 작성중 결과만 고친다 — 매칭·판정·재검 사유·측정치. 수량은 고친 뒤 매칭으로 다시 채운다. 새 흐름이 아니면 `null`. */
  async update(
    inspectionResultId: number,
    version: number,
    body: InspectionResultUpdate,
    context: InspectionResultWriteContext,
  ): Promise<{ view: InspectionResultView; versionNo: number } | null> {
    const current = await this.prisma.inspection_result.findUnique({
      where: { inspection_result_id: inspectionResultId },
      select: {
        inspection_request_id: true, inspection_round: true, status_code: true, version_no: true, overall_judgment_code: true,
        reinspection_reason_code: true, inspection_result_lot: { select: { lot_id: true } },
      },
    });
    if (current === null) return null;
    const request = await shipmentOqcRequest(this.prisma, current.inspection_request_id);
    if (request === null) return null;
    if (current.version_no !== version) assertUpdated(0, 'user', { code: VERSION_CONFLICT, currentVersion: String(current.version_no) });
    if (current.status_code !== DRAFT) {
      throw new ConflictException('user', '출하 완료로 확정된 검사 결과는 고칠 수 없습니다.', { code: INVALID_STATE });
    }
    assertOpen(request.status_code);
    const judgment = body.overallJudgmentCode === undefined ? current.overall_judgment_code : assertJudgment(body.overallJudgmentCode);
    await assertCodes(this.prisma, undefined, undefined, body.measurements);
    assertMeasurementValues(body.measurements);
    const matched = await matchedLots(
      this.prisma, request, body.matchedLotIds ?? current.inspection_result_lot.map((match) => Number(match.lot_id)),
    );
    await assertReinspectionReason(this.prisma, request.inspection_request_id, {
      resultId: BigInt(inspectionResultId), seqNo: current.inspection_round, judgmentCode: judgment, lotIds: matched.lotIds,
      reasonCode: body.reinspectionReasonCode ?? current.reinspection_reason_code,
    });
    const workerId = await resolveInspector(this.prisma, context);

    return this.prisma.$transaction(async (tx) => {
      await lockOpen(tx, request.inspection_request_id);
      const before = await resultSummaryWithin(tx, BigInt(inspectionResultId));
      const updated = await tx.inspection_result.updateMany({
        where: { inspection_result_id: inspectionResultId, version_no: version, status_code: DRAFT },
        data: {
          ...quantities(judgment, matched.inspectedQty),
          overall_judgment_code: judgment,
          ...(body.inspectedAt === undefined ? {} : { inspected_at: new Date(body.inspectedAt) }),
          ...(body.remarks === undefined ? {} : { remarks: body.remarks }),
          ...(body.reinspectionReasonCode === undefined ? {} : { reinspection_reason_code: body.reinspectionReasonCode }),
          updated_by: context.appUserId ?? null,
          version_no: { increment: 1 },
        },
      });
      assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT, currentVersion: String(current.version_no) });
      await replaceMatchedLotsWithin(tx, BigInt(inspectionResultId), matched.lotIds);
      await replaceMeasurementsWithin(tx, BigInt(inspectionResultId), body.measurements, context.appUserId);
      await startInspectionRequestWithin(tx, request.inspection_request_id, context.appUserId);
      const after = await resultSummaryWithin(tx, BigInt(inspectionResultId));
      await recordInspectionRequestEvent(tx, {
        inspectionRequestId: request.inspection_request_id, eventTypeCode: 'RESULT_UPDATED', inspectionResultId: BigInt(inspectionResultId),
        actor: eventActor(context, workerId), at: new Date(), summaryBefore: before, summaryAfter: after, reason: reinspectionReasonOf(after),
      });
      return { view: await reread(tx, BigInt(inspectionResultId)), versionNo: current.version_no + 1 };
    });
  }
}

async function shipmentOqcRequest(prisma: PrismaService, inspectionRequestId: bigint): Promise<OqcRequestFacts | null> {
  const request = await prisma.inspection_request.findUnique({
    where: { inspection_request_id: inspectionRequestId },
    select: {
      inspection_request_id: true, inspection_type_code: true, target_type_code: true, lot_id: true,
      target_id: true, item_id: true, uom_id: true, status_code: true,
    },
  });
  return request !== null && isShipmentOqc(request) ? request : null;
}

/** 생략된 의뢰는 400(지금 문구), 출하 완료·취소로 끝난 의뢰는 409. */
function assertOpen(statusCode: string): void {
  if (OPEN.includes(statusCode)) return;
  if (statusCode === 'SKIPPED') {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '검사를 생략한 의뢰입니다. 결과를 저장할 수 없습니다.' },
    ]);
  }
  throw new ConflictException('user', '출하가 완료돼 끝난 검사입니다 — 결과를 더하거나 고칠 수 없습니다.', { code: INVALID_STATE });
}

async function lockOpen(tx: Prisma.TransactionClient, inspectionRequestId: bigint): Promise<void> {
  const [row] = await tx.$queryRaw<{ status_code: string }[]>`
    SELECT status_code FROM quality.inspection_request WHERE inspection_request_id = ${inspectionRequestId} FOR UPDATE`;
  if (row === undefined) throw new NotFoundException('없는 검사 의뢰입니다.');
  assertOpen(row.status_code);
}

function assertJudgment(code: string | undefined | null): string {
  if (code === undefined || code === null) throw one(field('overallJudgmentCode', ERROR_CODE.REQUIRED, '판정을 고르세요.'));
  if (!JUDGMENTS.includes(code)) throw one(field('overallJudgmentCode', ERROR_CODE.INVALID, '판정은 합격·불합격·보류 중 하나입니다.'));
  return code;
}

/** 매칭 LOT — 그 지시서·품목의 PICKED 피킹 LOT 만(교체·출하된 LOT 은 대상 밖). 검사 수량 = 그 LOT 들의 피킹 합. */
async function matchedLots(prisma: PrismaService, request: OqcRequestFacts, matchedLotIds: readonly number[] | undefined): Promise<MatchedLots> {
  if (matchedLotIds === undefined || matchedLotIds.length === 0) {
    throw one(field('matchedLotIds', MATCHED_LOT_REQUIRED, 'LOT 을 하나 이상 고르세요.'));
  }
  const lotIds = matchedLotIds.map((id) => BigInt(id));
  if (new Set(lotIds).size !== lotIds.length) {
    throw one(field('matchedLotIds', ERROR_CODE.INVALID, '한 결과에 같은 LOT 을 두 번 매칭할 수 없습니다.'));
  }
  const picked = await prisma.shipment_request_lot.findMany({
    where: {
      lot_id: { in: lotIds }, status_code: PICKED,
      shipment_request_line: { shipment_request_id: request.target_id, item_id: request.item_id },
    },
    select: { lot_id: true, picked_qty: true },
  });
  if (picked.length !== lotIds.length) {
    throw one(field('matchedLotIds', ERROR_CODE.INVALID, '이 지시서에 피킹된 이 품목의 LOT 만 매칭할 수 있습니다.'));
  }
  return { lotIds, inspectedQty: picked.reduce((sum, row) => sum.plus(row.picked_qty), new Prisma.Decimal(0)) };
}

/** 판정 칸 하나에 검사 수량 그대로 — `ck_inspection_result_qty`(합 = 검사)를 지난다. */
function quantities(judgment: string | null, inspected: Prisma.Decimal) {
  return {
    inspected_qty: inspected,
    accepted_qty: judgment === 'ACCEPTED' ? inspected : 0,
    rejected_qty: judgment === 'REJECTED' ? inspected : 0,
    held_qty: judgment === 'HELD' ? inspected : 0,
  };
}

async function reread(tx: Prisma.TransactionClient, inspectionResultId: bigint): Promise<InspectionResultView> {
  const row = await tx.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: inspectionResultId }, include: INSPECTION_RESULT_JOIN });
  return inspectionResultView(row);
}
