import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService, Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { SPLIT_REMAIN_MESSAGE, classifySplitResults, splitInboundLot } from '../../logistics/inbound-lot/inbound-lot-split';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { recordInspectionRequestEvent } from '../inspection/inspection-request-event';
import { assertQtyPrecision } from '../nonconformance/nonconformance-rules';
import { releaseInspectionHoldsWithin } from './disposition-hold-release';
import { dispositionByIdQuery } from './disposition-query';
import { DispositionDecisionRow, DispositionDecisionView, dispositionDecisionView } from './disposition-view';

/** 계약 `DispositionDecisionCreate` 의 선별 모양(R-14b) — 불량 자재 관리 LOT 과 정보 수량. */
export interface DispositionSortCreate {
  dispositionTypeCode: string;
  lotIds: number[];
  goodQty?: number;
  defectQty?: number;
  reason: string;
}

/** 선별 판정 응답에 더하는 칸 — 새 입하 LOT·새 부적합·새 IQC 기록. */
export interface DispositionSortCreated {
  newInboundLotId: number;
  newInboundLotNo: string;
  newNonconformanceId: number;
  newNonconformanceNo: string;
  newInspectionRequestNo: string;
}

interface SortSource {
  inspectionRequestId: bigint;
  inboundLotId: bigint;
  plantId: bigint;
  timezone: string;
}

interface SortNumbers {
  at: Date;
  inboundLotNo: string;
  requestNo: string;
  nonconformanceNo: string;
  resultNos: string[];
}

interface NcLot {
  lot_id: bigint;
  affected_qty: Prisma.Decimal;
  uom_id: bigint;
  quality_status_before_code: string;
  quality_status_after_code: string;
}

/** 복사할 결과 수가 채번 뒤 달라졌다 — 번호를 다시 뽑아 한 번 더 한다(채번은 트랜잭션 밖). */
class SortNumbersStale extends Error {}

const INVALID_STATE = 'INVALID_STATE';
const VERSION_CONFLICT = 'VERSION_CONFLICT';
const SOURCE_TYPE = 'DISPOSITION_DECISION';
const TRANSACTION_OPTIONS = { timeout: 20_000, maxWait: 5_000 };

/**
 * 처분 단계 선별(R-14b · FR-041 · W-03-10) — 새 흐름 자재 입하 IQC 부적합에서 판정이 하나도 없을 때만, 불량 자재 관리 LOT(전부 아님)을
 * 새 입하 LOT 으로 분리(공통 코어)한다. 남은 LOT 은 정상(처분 「정상」과 같은 전이·검사 보류 해제)이 되고 원래 부적합은 `SORT` 판정
 * 1건(수량 = 남은 LOT 의 부적합 수량 합)으로 닫힌다 — 옮긴 LOT 의 부적합 줄은 원래 부적합에서 빼 새 부적합으로 옮긴다(남은 수량이 0 이
 * 되게). 새 입하 LOT 에는 불합격 확정된 IQC 기록(원래 요청과 연결)을 세우고 옮긴 LOT 에만 매칭된 원래 결과를 복사한다 — 원래 판정의
 * 근거를 지우지 않으려고 옮기지 않는다. 측정치는 복사하고 불량 기록은 복사하지 않는다(불량 실적이 두 번 세어진다).
 */
@Injectable()
export class DispositionSortService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly documentState: DocumentStateService,
    private readonly lots: LotQualityStatusService,
    private readonly holds: LotHoldService,
  ) {}

  async create(
    nonconformanceId: number, version: number, body: DispositionSortCreate, appUserId: number,
  ): Promise<{ view: DispositionDecisionView & DispositionSortCreated; versionNo: number }> {
    const id = BigInt(nonconformanceId);
    const source = await sortSourceOf(this.prisma, id);
    let numbers = await this.allocate(source, body.lotIds);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.sortWithin(tx, id, version, body, appUserId, source, numbers), TRANSACTION_OPTIONS);
      } catch (error) {
        if (attempt >= 2 || !(error instanceof SortNumbersStale)) throw error;
        numbers = await this.allocate(source, body.lotIds);
      }
    }
  }

  private async allocate(source: SortSource, lotIds: readonly number[]): Promise<SortNumbers> {
    const at = new Date();
    const day = localDate(at, source.timezone);
    const utcDay = at.toISOString().slice(0, 10);
    const copies = await copiedResults(this.prisma as unknown as Tx, source.inspectionRequestId, lotIds.map((lotId) => BigInt(lotId)));
    const resultNos: string[] = [];
    for (let index = 0; index < copies.length; index += 1) resultNos.push(await this.numbering.next('INSPECTION_RESULT', null, utcDay));
    return {
      at,
      inboundLotNo: await this.numbering.next('INBOUND_LOT', source.plantId, day),
      requestNo: await this.numbering.next('INSPECTION_REQUEST', source.plantId, day),
      nonconformanceNo: await this.numbering.next('NONCONFORMANCE', null, utcDay),
      resultNos,
    };
  }

  private async sortWithin(
    tx: Tx, id: bigint, version: number, body: DispositionSortCreate, appUserId: number, source: SortSource, numbers: SortNumbers,
  ): Promise<{ view: DispositionDecisionView & DispositionSortCreated; versionNo: number }> {
    const { at } = numbers;
    const locked = await lockSortable(tx, id);
    const { moved, remaining, scale } = await chooseLots(tx, id, body);
    for (const [name, value] of [['goodQty', body.goodQty], ['defectQty', body.defectQty]] as const) {
      if (value !== undefined) assertQtyPrecision(name, value, scale);
    }
    const { plan, newInboundLotId } = await splitInboundLot(tx, {
      inboundLotId: source.inboundLotId, lotIds: body.lotIds, newInboundLotNo: numbers.inboundLotNo, actor: { appUserId }, at, reason: body.reason,
    });
    await tx.nonconformance_lot.deleteMany({ where: { nonconformance_id: id, lot_id: { in: moved.map((row) => row.lot_id) } } });
    const decision = await tx.disposition_decision.create({
      data: {
        nonconformance_id: id, disposition_type_code: 'SORT', uom_id: remaining[0].uom_id, reason: body.reason,
        decision_qty: remaining.reduce((sum, row) => sum.plus(row.affected_qty), new Prisma.Decimal(0)),
        decided_by: BigInt(appUserId), decided_at: at,
        sort_good_qty: body.goodQty ?? null, sort_defect_qty: body.defectQty ?? null,
      },
      select: { disposition_decision_id: true },
    });
    await this.normalizeRemaining(tx, remaining.map((row) => row.lot_id), decision.disposition_decision_id, body.reason, appUserId, at);
    const to = this.decidable(locked.status_code);
    const updated = await tx.nonconformance.updateMany({
      where: { nonconformance_id: id, version_no: version },
      data: { version_no: { increment: 1 }, updated_by: BigInt(appUserId), updated_at: at, status_code: to, closed_at: at },
    });
    assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT, currentVersion: String(locked.version_no) });

    const record = await copyIqcRecord(tx, {
      sourceRequestId: source.inspectionRequestId, newInboundLotId, movedLotIds: plan.movedLots.map((lot) => lot.lot_id),
      movedQty: plan.movedQty, remainingQty: plan.remainingQty, numbers, appUserId, decisionId: decision.disposition_decision_id,
    });
    const nonconformance = await createSortedNonconformance(tx, { sourceId: id, moved, requestId: record.requestId, resultId: record.firstResultId, numbers, appUserId });
    const built = dispositionByIdQuery(Number(decision.disposition_decision_id));
    const rows = await tx.$queryRawUnsafe<DispositionDecisionRow[]>(built.sql, ...built.params);
    return {
      view: {
        ...dispositionDecisionView(rows[0]).view,
        newInboundLotId: Number(newInboundLotId), newInboundLotNo: numbers.inboundLotNo,
        newNonconformanceId: Number(nonconformance), newNonconformanceNo: numbers.nonconformanceNo, newInspectionRequestNo: numbers.requestNo,
      },
      versionNo: locked.version_no + 1,
    };
  }

  /** 남은 LOT → 정상 — 처분 「정상」과 같은 전이(C19)·수입검사 대기 보류 해제(P-63). */
  private async normalizeRemaining(tx: Tx, lotIds: bigint[], decisionId: bigint, reason: string, appUserId: number, at: Date): Promise<void> {
    const { movedLotIds } = await this.lots.moveWithin(tx, lotIds, 'disposition-normal', {
      changedBy: BigInt(appUserId), changedAt: at, sourceDocumentTypeCode: SOURCE_TYPE, sourceDocumentId: decisionId, reason,
    });
    if (movedLotIds.length === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '지금 LOT 상태에서는 남은 자재 관리 LOT 을 정상으로 옮길 수 없습니다.' },
      ]);
    }
    await releaseInspectionHoldsWithin(tx, this.holds, movedLotIds, { by: BigInt(appUserId), at });
  }

  private decidable(currentStatus: string): string {
    try {
      return this.documentState.assertTransition('quality.nonconformance.status_code', 'nonconformance-decide', currentStatus).to;
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      throw new ConflictException('user', error.conflict.message, { code: INVALID_STATE });
    }
  }
}

/** 존재(404) → 선별 대상(400) — 반품·OQC·이전 데이터(입하 LOT 검사가 아닌) 부적합에는 선별이 없다. */
async function sortSourceOf(prisma: PrismaService, id: bigint): Promise<SortSource> {
  const nc = await prisma.nonconformance.findUnique({
    where: { nonconformance_id: id },
    select: {
      source_nonconformance_id: true,
      inspection_request: {
        select: {
          inspection_request_id: true, inspection_type_code: true, target_type_code: true,
          inbound_lot: { select: { inbound_lot_id: true, plant_id: true, plant: { select: { timezone_code: true } } } },
        },
      },
    },
  });
  if (nc === null) throw new NotFoundException('없는 부적합입니다.');
  // 선별로 생긴 부적합은 폐기·재작업·특채로만 처분한다(FR-041).
  if (nc.source_nonconformance_id !== null) {
    throw one(field('dispositionTypeCode', ERROR_CODE.INVALID, '선별로 생긴 부적합은 다시 선별할 수 없습니다 — 폐기·재작업·특채로 처분하세요.'));
  }
  const request = nc.inspection_request;
  if (request?.inspection_type_code !== 'IQC') throw one(field('dispositionTypeCode', ERROR_CODE.INVALID, '반품·OQC 부적합에는 선별이 없습니다.'));
  if (request.target_type_code !== 'INBOUND_LOT' || request.inbound_lot === null) {
    throw one(field('dispositionTypeCode', ERROR_CODE.INVALID, '입하 LOT 검사가 아닌(이전 데이터) 부적합에는 선별이 없습니다.'));
  }
  return {
    inspectionRequestId: request.inspection_request_id, inboundLotId: request.inbound_lot.inbound_lot_id,
    plantId: request.inbound_lot.plant_id, timezone: request.inbound_lot.plant.timezone_code,
  };
}

/** 부적합 잠금 → 닫힘·판정 있음·특채 진행은 409 — 선별은 첫 판정으로만 한다. */
async function lockSortable(tx: Tx, id: bigint): Promise<{ status_code: string; version_no: number }> {
  const [locked] = await tx.$queryRaw<{ status_code: string; version_no: number }[]>`
    SELECT status_code, version_no FROM quality.nonconformance WHERE nonconformance_id = ${id} FOR UPDATE`;
  if (locked === undefined) throw new NotFoundException('없는 부적합입니다.');
  if (locked.status_code === 'DECIDED' || locked.status_code === 'CANCELLED') {
    throw new ConflictException('user', '이미 종결된 부적합이라 판정을 저장할 수 없습니다.', { code: INVALID_STATE });
  }
  const [decisions, concessions] = await Promise.all([
    tx.disposition_decision.count({ where: { nonconformance_id: id } }),
    tx.concession.count({ where: { nonconformance_id: id, status_code: { not: 'REJECTED' } } }),
  ]);
  if (decisions > 0 || concessions > 0) {
    throw new ConflictException('user', '판정이나 특채가 이미 있는 부적합은 선별할 수 없습니다.', { code: INVALID_STATE });
  }
  return locked;
}

/** 고른 LOT 은 부적합의 LOT 이어야 하고 전부여서는 안 된다(400). 사유는 공백만이면 안 된다. */
async function chooseLots(tx: Tx, id: bigint, body: DispositionSortCreate): Promise<{ moved: NcLot[]; remaining: NcLot[]; scale: number }> {
  if (body.reason.trim() === '') throw one(field('reason', ERROR_CODE.REQUIRED, '판정 사유를 공백만으로 채울 수 없습니다.'));
  const rows = await tx.nonconformance_lot.findMany({
    where: { nonconformance_id: id }, orderBy: { lot_id: 'asc' },
    select: { lot_id: true, affected_qty: true, uom_id: true, quality_status_before_code: true, quality_status_after_code: true },
  });
  const chosen = new Set(body.lotIds.map((lotId) => BigInt(lotId)));
  const moved = rows.filter((row) => chosen.has(row.lot_id));
  if (chosen.size !== body.lotIds.length || moved.length !== chosen.size) {
    throw one(field('lotIds', ERROR_CODE.INVALID, '이 부적합의 자재 관리 LOT 이 아닌 것이 섞여 있습니다.'));
  }
  const remaining = rows.filter((row) => !chosen.has(row.lot_id));
  if (remaining.length === 0) throw one(field('lotIds', ERROR_CODE.INVALID, SPLIT_REMAIN_MESSAGE));
  const uom = await tx.uom.findUniqueOrThrow({ where: { uom_id: rows[0].uom_id }, select: { decimal_scale: true } });
  return { moved, remaining, scale: uom.decimal_scale };
}

/** 원래 요청의 결과 중 옮긴 LOT 에만 매칭된 것 — 순번 순(분리 분류 규칙). */
async function copiedResults(db: Tx, requestId: bigint, movedLotIds: readonly bigint[]) {
  const results = await db.inspection_result.findMany({
    where: { inspection_request_id: requestId },
    include: { inspection_result_lot: { select: { lot_id: true } }, inspection_measurement: true },
  });
  const classes = classifySplitResults(results.map((row) => ({
    inspectionResultId: row.inspection_result_id, seqNo: row.inspection_round, overallJudgmentCode: row.overall_judgment_code,
    lotIds: row.inspection_result_lot.map((match) => match.lot_id),
  })), movedLotIds);
  const byId = new Map(results.map((row) => [row.inspection_result_id, row]));
  return classes.moved.map((result) => byId.get(result.inspectionResultId) as (typeof results)[number]);
}

/**
 * 새 입하 LOT 의 불합격 확정 IQC 기록 — 요청 `COMPLETED`·종합 불합격·확정 칸(CHECK `ck_inspection_request_iqc_confirmed`)·원래 요청 연결,
 * 옮긴 LOT 에만 매칭된 결과를 확정으로 복사(순번 1부터)·매칭·측정치, 원래 요청 대상 수량 갱신, 이력 `SPLIT_OUT`·`SPLIT_IN`.
 */
async function copyIqcRecord(
  tx: Tx,
  input: {
    sourceRequestId: bigint; newInboundLotId: bigint; movedLotIds: bigint[]; movedQty: Prisma.Decimal; remainingQty: Prisma.Decimal;
    numbers: SortNumbers; appUserId: number; decisionId: bigint;
  },
): Promise<{ requestId: bigint; firstResultId: bigint | null }> {
  const { at } = input.numbers;
  const by = BigInt(input.appUserId);
  const source = await tx.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: input.sourceRequestId } });
  const copies = await copiedResults(tx, input.sourceRequestId, input.movedLotIds);
  if (copies.length !== input.numbers.resultNos.length) throw new SortNumbersStale();
  const request = await tx.inspection_request.create({
    data: {
      inspection_request_no: input.numbers.requestNo, inspection_type_code: 'IQC', inspection_plan_version_id: source.inspection_plan_version_id,
      target_type_code: 'INBOUND_LOT', target_id: input.newInboundLotId, inbound_lot_id: input.newInboundLotId, lot_id: null,
      item_id: source.item_id, target_qty: input.movedQty, uom_id: source.uom_id, status_code: 'COMPLETED', requested_at: at,
      inspection_level_code: source.inspection_level_code, overall_judgment_code: 'REJECTED', confirmed_at: at, confirmed_by: by,
      split_from_inspection_request_id: source.inspection_request_id, created_by: by, updated_by: by,
    },
    select: { inspection_request_id: true },
  });
  const pairs: { from: number; to: number }[] = [];
  let firstRejected: bigint | null = null;
  for (const [index, result] of copies.entries()) {
    const copied = await tx.inspection_result.create({
      data: {
        inspection_result_no: input.numbers.resultNos[index], inspection_request_id: request.inspection_request_id, inspection_round: index + 1,
        confirm_cycle: 1, inspected_qty: result.inspected_qty, accepted_qty: result.accepted_qty, rejected_qty: result.rejected_qty,
        held_qty: result.held_qty, uom_id: result.uom_id, overall_judgment_code: result.overall_judgment_code, inspector_id: result.inspector_id,
        inspected_at: result.inspected_at, confirmed_at: at, terminal_id: result.terminal_id, status_code: 'CONFIRMED',
        reinspection_reason_code: result.reinspection_reason_code, remarks: result.remarks,
        idempotency_key: `sort-copy:${String(result.inspection_result_id)}:${input.numbers.requestNo}`.slice(0, 150), created_by: by,
      },
      select: { inspection_result_id: true },
    });
    await tx.inspection_result_lot.createMany({
      data: result.inspection_result_lot.map((match) => ({ inspection_result_id: copied.inspection_result_id, lot_id: match.lot_id })),
    });
    if (result.inspection_measurement.length > 0) {
      await tx.inspection_measurement.createMany({
        data: result.inspection_measurement.map(({ inspection_measurement_id: _id, inspection_result_id: _result, created_at: _at, ...row }) => ({
          ...row, inspection_result_id: copied.inspection_result_id, created_by: by,
        })),
      });
    }
    if (firstRejected === null && result.overall_judgment_code === 'REJECTED') firstRejected = copied.inspection_result_id;
    pairs.push({ from: Number(result.inspection_result_id), to: Number(copied.inspection_result_id) });
  }
  await tx.inspection_request.update({
    where: { inspection_request_id: source.inspection_request_id },
    data: { target_qty: input.remainingQty, updated_by: by, version_no: { increment: 1 } },
  });
  const movedLotIds = input.movedLotIds.map(Number);
  const actor = { appUserId: input.appUserId };
  await recordInspectionRequestEvent(tx, {
    inspectionRequestId: source.inspection_request_id, eventTypeCode: 'SPLIT_OUT', actor, at,
    summaryAfter: {
      newInspectionRequestId: Number(request.inspection_request_id), newInboundLotId: Number(input.newInboundLotId), movedLotIds,
      copiedResults: pairs, dispositionDecisionId: Number(input.decisionId), targetQty: Number(input.remainingQty),
    },
  });
  await recordInspectionRequestEvent(tx, {
    inspectionRequestId: request.inspection_request_id, eventTypeCode: 'SPLIT_IN', actor, at,
    summaryAfter: {
      fromInspectionRequestId: Number(source.inspection_request_id), fromInboundLotId: Number(source.inbound_lot_id), movedLotIds,
      copiedResults: pairs, dispositionDecisionId: Number(input.decisionId), targetQty: Number(input.movedQty),
    },
  });
  return { requestId: request.inspection_request_id, firstResultId: firstRejected ?? (pairs.length > 0 ? BigInt(pairs[0].to) : null) };
}

/** 옮긴 LOT 의 새 부적합(판정 대기) — 원래 부적합과 연결, LOT 은 불량 그대로·수량은 원래 부적합의 그 LOT 수량. */
async function createSortedNonconformance(
  tx: Tx,
  input: { sourceId: bigint; moved: NcLot[]; requestId: bigint; resultId: bigint | null; numbers: SortNumbers; appUserId: number },
): Promise<bigint> {
  const source = await tx.nonconformance.findUniqueOrThrow({
    where: { nonconformance_id: input.sourceId }, select: { item_id: true, severity_code: true, description: true },
  });
  const by = BigInt(input.appUserId);
  const created = await tx.nonconformance.create({
    data: {
      nonconformance_no: input.numbers.nonconformanceNo, item_id: source.item_id, inspection_result_id: input.resultId,
      inspection_request_id: input.requestId, source_nonconformance_id: input.sourceId, severity_code: source.severity_code,
      description: source.description, status_code: 'PENDING_DECISION', opened_at: input.numbers.at, created_by: by, updated_by: by,
    },
    select: { nonconformance_id: true },
  });
  await tx.nonconformance_lot.createMany({
    data: input.moved.map((row) => ({
      nonconformance_id: created.nonconformance_id, lot_id: row.lot_id, affected_qty: row.affected_qty, uom_id: row.uom_id,
      quality_status_before_code: row.quality_status_before_code, quality_status_after_code: row.quality_status_after_code, created_by: by,
    })),
  });
  return created.nonconformance_id;
}
