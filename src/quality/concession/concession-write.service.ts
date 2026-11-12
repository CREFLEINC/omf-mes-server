import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService, Tx, assertMaterialLotsUsable } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { releaseInspectionHoldsWithin } from '../disposition/disposition-hold-release';
import { dispositionProgressCode } from '../disposition/disposition-rollup';
import { assertQtyPrecision } from '../nonconformance/nonconformance-rules';

/** 특채(omf-all-around#84 · 장부 P-79). 결재 유형·대상 — 대상은 부적합이다(특채 행은 결재 «뒤»에 생겨 id 가 없다). */
export const CONCESSION_APPROVAL_TYPE = 'CONCESSION';
const APPROVAL_TARGET_TYPE = 'NONCONFORMANCE';
/** 처분 판정에 남는 유형 — 특채로 정리된 수량이 부적합의 «남은 수량»에서 빠진다. */
const CONCESSION_DISPOSITION = 'CONCESSION';
const RELEASE_REASON = 'CONCESSION_APPROVED';
const SOURCE_TYPE = 'CONCESSION';
const PENDING = 'PENDING';
const APPROVED = 'APPROVED';
const REJECTED = 'REJECTED';
const DECIDED = 'DECIDED';
const NC_STATUS_COLUMN = 'quality.nonconformance.status_code';
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export interface ConcessionCreate {
  nonconformanceId: number;
  /** 비우면 부적합 LOT 전부 — LOT 마다 특채 행(피처 005 D-14). 주면 LOT 이 하나인 부적합의 그 LOT. */
  lotId?: number;
  approvedQty: number;
  uomId: number;
  validFrom: string;
  validTo?: string | null;
  allowedWorkOrderId?: number | null;
  allowedProcessId?: number | null;
  allowedCustomerId?: number | null;
  reason: string;
}

/** 적용 본문(선택) — 일부 특채가 없어져(FR-038) 쓰지 않는다. 옛 화면이 보내도 받는다. */
export interface ConcessionApply {
  businessDate?: string;
}

/** 한 요청으로 함께 태어난 특채 묶음(같은 부적합·같은 결재). */
export interface ConcessionBatch {
  concessionIds: number[];
  approvalRequestId: number;
}

const optionalId = (value: number | null | undefined): bigint | null => (value == null ? null : BigInt(value));
const badRequest = (errors: ErrorItem[]): ContractException => new ContractException(HttpStatus.BAD_REQUEST, errors);
const screen = (code: string, message: string): ContractException =>
  badRequest([{ scope: 'screen', code, message }]);

/**
 * 특채 — 불합격 LOT 을 관리자 승인을 받아 조건부로 쓴다.
 *
 * ⭐ 「요청 → 결재(W-03-09) → 적용」 셋으로 나눈다 — 결재 코어는 대상 업무를 모른다(IQC 생략 `:skip-iqc`·실적
 *    정정과 같은 방식). 승인자·승인일시는 결재 단계 기록이 갖는다.
 * ⭐ 특채는 남은 수량 «전부»다(FR-038 — 일부 특채 제거). 부적합 LOT 이 여럿이면 LOT 마다 행을 두고 같은 결재로 묶는다
 *    (피처 005 D-14 — `lot_id` NOT NULL 그대로라 ERP 빌더·재고 재등록·사용량이 LOT 마다 그대로 읽는다).
 * ⭐ 적용이 묶음 전부를 한 트랜잭션에서 옮기고 부적합에 처분 판정(CONCESSION) 1건을 남긴다 — 특채로 정리한 수량을
 *    부적합의 남은 수량에서 빼야 처분 화면에 계속 「판정 대기」로 남지 않는다.
 * ⛔ 사용 가능 수량·허용 조건은 «기록»한다 — 출고·투입에서 막지 않는다(#84 코멘트 · #207 결정).
 */
@Injectable()
export class ConcessionWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalService,
    private readonly documentState: DocumentStateService,
    private readonly lots: LotQualityStatusService,
    private readonly holds: LotHoldService,
  ) {}

  async request(body: ConcessionCreate, appUserId: number): Promise<ConcessionBatch> {
    assertCreateShape(body);
    const nc = await this.prisma.nonconformance.findUnique({
      where: { nonconformance_id: BigInt(body.nonconformanceId) },
      select: {
        status_code: true,
        nonconformance_lot: {
          orderBy: { lot_id: 'asc' },
          select: { lot_id: true, uom_id: true, affected_qty: true, lot: { select: { lot_no: true, lot_type_code: true, lifecycle_status_code: true } } },
        },
      },
    });
    if (nc === null) throw new NotFoundException('없는 부적합입니다.');
    const targets = targetLotsOf(nc.nonconformance_lot, body.lotId);
    assertMaterialLotsUsable(targets.map((row) => row.lot));
    if (Number(targets[0].uom_id) !== body.uomId) {
      throw badRequest([field('uomId', ERROR_CODE.INVALID, '부적합의 단위와 같아야 합니다.')]);
    }
    const uom = await this.prisma.uom.findUniqueOrThrow({ where: { uom_id: targets[0].uom_id }, select: { decimal_scale: true } });
    assertQtyPrecision('approvedQty', body.approvedQty, uom.decimal_scale);

    // ⛔ 채번은 트랜잭션을 «열기 전»이다(코어 규약) — 특채 번호는 LOT 마다 하나.
    const today = new Date().toISOString().slice(0, 10);
    const concessionNos: string[] = [];
    for (let i = 0; i < targets.length; i += 1) concessionNos.push(await this.numbering.next('CONCESSION', null, today));
    const approvalRequestNo = await this.numbering.next('APPROVAL_REQUEST', null, today);

    return this.prisma.$transaction(async (tx) => {
      const ncId = BigInt(body.nonconformanceId);
      const locked = await lockNonconformance(tx, ncId);
      if (locked.status_code === DECIDED) throw screen(ERROR_CODE.STATE_LOCKED, '이미 종결된 부적합입니다.');
      const remaining = await remainingOf(tx, ncId);
      if (!new Prisma.Decimal(body.approvedQty).equals(remaining)) {
        throw badRequest([field('approvedQty', ERROR_CODE.INVALID, `특채 수량은 남은 수량(${remaining.toString()})과 같아야 합니다 — 일부 특채는 지원하지 않습니다.`)]);
      }
      const qtys = rowQtys(targets, remaining);
      const approval = await this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: CONCESSION_APPROVAL_TYPE,
        targetTypeCode: APPROVAL_TARGET_TYPE,
        targetId: ncId,
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason: body.reason.trim(),
      });
      const concessionIds: number[] = [];
      for (const [index, target] of targets.entries()) {
        const created = await tx.concession.create({
          data: {
            concession_no: concessionNos[index],
            nonconformance_id: ncId,
            lot_id: target.lot_id,
            approved_qty: qtys[index],
            uom_id: BigInt(body.uomId),
            valid_from: new Date(`${body.validFrom}T00:00:00Z`),
            valid_to: body.validTo == null ? null : new Date(`${body.validTo}T00:00:00Z`),
            allowed_work_order_id: optionalId(body.allowedWorkOrderId),
            allowed_process_id: optionalId(body.allowedProcessId),
            allowed_customer_id: optionalId(body.allowedCustomerId),
            approval_request_id: approval.approvalRequestId,
            status_code: PENDING,
            remarks: body.reason.trim(),
            created_by: BigInt(appUserId),
            updated_by: BigInt(appUserId),
          },
          select: { concession_id: true },
        });
        concessionIds.push(Number(created.concession_id));
      }
      return { concessionIds, approvalRequestId: Number(approval.approvalRequestId) };
    });
  }

  /**
   * 적용 — 묶음(같은 부적합·같은 결재)의 `PENDING` 행 전부를 한 트랜잭션에서. 결재가 승인이면 행마다 APPROVED · 처분 판정 1건 ·
   * LOT 정상(C25) · 수입검사 대기 보류 해제. 결재가 반려면 묶음을 REJECTED 로 «닫고» 그대로 돌려준다(400 으로 던지면 닫은 것까지 되돌아간다).
   */
  async apply(concessionId: number, appUserId: number, body: ConcessionApply = {}): Promise<ConcessionBatch> {
    if (body.businessDate !== undefined && !DATE.test(body.businessDate)) {
      throw badRequest([field('businessDate', ERROR_CODE.INVALID, '날짜(YYYY-MM-DD)가 아닙니다.')]);
    }
    return this.prisma.$transaction(async (tx) => {
      const batch = await lockBatch(tx, BigInt(concessionId));
      const head = batch[0];
      const approval = await tx.approval_request.findUniqueOrThrow({
        where: { approval_request_id: head.approval_request_id },
        select: { status_code: true },
      });
      const now = new Date();
      const by = BigInt(appUserId);
      const result = { concessionIds: batch.map((row) => Number(row.concession_id)), approvalRequestId: Number(head.approval_request_id) };
      if (approval.status_code === PENDING) throw screen(ERROR_CODE.APPROVAL_IN_PROGRESS, '결재가 아직 진행 중입니다.');
      if (approval.status_code !== APPROVED) {
        await this.close(tx, batch, REJECTED, by, now);
        return result;
      }

      const ncId = head.nonconformance_id;
      const nc = await lockNonconformance(tx, ncId);
      if (nc.status_code === DECIDED) throw screen(ERROR_CODE.STATE_LOCKED, '이미 종결된 부적합입니다.');
      // ⛔ 남은 수량을 «적용 시점»에 다시 본다 — 요청 뒤 다른 처분이 먼저 수량을 썼을 수 있다. 부적합 행을
      //    `FOR UPDATE` 로 잡은 «뒤»에 읽으므로 처분 등록(같은 잠금)·다른 특채 적용과 겹쳐도 옛 잔량으로 판정하지 않는다.
      const decisions = await tx.disposition_decision.aggregate({
        where: { nonconformance_id: ncId }, _sum: { decision_qty: true }, _count: true,
      });
      const affected = await tx.nonconformance_lot.aggregate({ where: { nonconformance_id: ncId }, _sum: { affected_qty: true } });
      const affectedQty = affected._sum.affected_qty ?? new Prisma.Decimal(0);
      const decidedQty = decisions._sum.decision_qty ?? new Prisma.Decimal(0);
      const remaining = affectedQty.minus(decidedQty);
      const approvedQty = batch.reduce((sum, row) => sum.plus(row.approved_qty), new Prisma.Decimal(0));
      if (approvedQty.greaterThan(remaining)) {
        throw badRequest([field('approvedQty', ERROR_CODE.INVALID, `남은 수량을 넘습니다. (남은 수량 ${remaining.toString()})`)]);
      }
      // 일부 수량으로 요청해 결재를 받은 옛 특채(FR-038 이전) — 반려 뒤 남은 수량 전체로 다시 요청한다(R-14a).
      if (approvedQty.lessThan(remaining)) {
        throw new ContractException(HttpStatus.CONFLICT, [{
          scope: 'screen', code: ERROR_CODE.STATE_LOCKED,
          message: `일부 특채는 지원하지 않습니다 — 반려한 뒤 남은 수량 전체(${remaining.toString()})로 다시 요청하세요.`,
        }]);
      }
      const decision = await tx.disposition_decision.create({
        data: {
          nonconformance_id: ncId,
          disposition_type_code: CONCESSION_DISPOSITION,
          decision_qty: approvedQty,
          uom_id: head.uom_id,
          reason: head.remarks ?? '특채',
          decided_by: by,
          decided_at: now,
          approval_request_id: head.approval_request_id,
        },
        select: { decision_qty: true },
      });
      let moved = 0;
      for (const row of batch) {
        const result = await this.lots.moveWithin(tx, [row.lot_id], 'concession-apply', {
          changedBy: by, changedAt: now, sourceDocumentTypeCode: SOURCE_TYPE,
          sourceDocumentId: row.concession_id, reason: row.remarks ?? undefined,
        });
        moved += result.movedLotIds.length;
      }
      if (moved === 0) throw screen(ERROR_CODE.STATE_LOCKED, '지금 LOT 상태에서는 특채를 적용할 수 없습니다.');
      await releaseInspectionHoldsWithin(tx, this.holds, batch.map((row) => row.lot_id), { by, at: now }, RELEASE_REASON);

      const closing = dispositionProgressCode(decisions._count + 1, affectedQty, decidedQty.plus(decision.decision_qty));
      const decided = closing === 'COMPLETED'
        ? this.documentState.assertTransition(NC_STATUS_COLUMN, 'nonconformance-decide', nc.status_code)
        : undefined;
      await tx.nonconformance.update({
        where: { nonconformance_id: ncId },
        data: {
          version_no: { increment: 1 }, updated_by: by, updated_at: now,
          ...(decided === undefined ? {} : { status_code: decided.to, closed_at: now }),
        },
      });
      await this.close(tx, batch, APPROVED, by, now);
      return result;
    });
  }

  private async close(tx: Tx, batch: readonly LockedConcession[], statusCode: string, by: bigint, at: Date): Promise<void> {
    await tx.concession.updateMany({
      where: { concession_id: { in: batch.map((row) => row.concession_id) } },
      data: { status_code: statusCode, updated_by: by, updated_at: at, version_no: { increment: 1 } },
    });
  }
}

type NonconformanceLotRow = {
  lot_id: bigint; uom_id: bigint; affected_qty: Prisma.Decimal;
  lot: { lot_no: string; lot_type_code: string; lifecycle_status_code: string | null };
};

/** 특채할 LOT — `lotId` 를 비우면 부적합 LOT 전부, 주면 LOT 이 하나인 부적합의 그 LOT. */
function targetLotsOf(rows: NonconformanceLotRow[], lotId: number | undefined): NonconformanceLotRow[] {
  if (lotId === undefined) {
    if (rows.length === 0) throw badRequest([field('lotId', ERROR_CODE.REQUIRED, 'LOT 이 없는 부적합입니다.')]);
    return rows;
  }
  const lot = rows.find((row) => row.lot_id === BigInt(lotId));
  if (lot === undefined) throw badRequest([field('lotId', ERROR_CODE.INVALID, '이 부적합의 LOT 이 아닙니다.')]);
  if (rows.length > 1) {
    throw badRequest([field('lotId', ERROR_CODE.INVALID, 'LOT 이 여럿인 부적합은 lotId 를 비워 부적합 LOT 전부를 특채합니다.')]);
  }
  return [lot];
}

/**
 * 행마다 승인 수량 — LOT 하나면 남은 수량, 여럿이면 LOT 의 부적합 수량(합 = 남은 수량). 처분 판정이 이미 있어 LOT 수량 합이
 * 남은 수량과 다르면 LOT 마다 나눌 근거가 없다 — 남은 처분으로 마저 처리한다.
 */
function rowQtys(targets: NonconformanceLotRow[], remaining: Prisma.Decimal): Prisma.Decimal[] {
  if (targets.length === 1) return [remaining];
  const total = targets.reduce((sum, row) => sum.plus(row.affected_qty), new Prisma.Decimal(0));
  if (!total.equals(remaining)) {
    throw screen(ERROR_CODE.STATE_LOCKED, '처분 판정이 시작된 부적합은 LOT 마다 특채할 수 없습니다 — 남은 처분으로 마저 처리하세요.');
  }
  return targets.map((row) => row.affected_qty);
}

function assertCreateShape(body: ConcessionCreate): void {
  const errors: ErrorItem[] = [];
  if (!(body.approvedQty > 0)) errors.push(field('approvedQty', ERROR_CODE.RANGE, '사용 가능 수량은 0 보다 커야 합니다.'));
  if (!DATE.test(body.validFrom)) errors.push(field('validFrom', ERROR_CODE.INVALID, '날짜(YYYY-MM-DD)가 아닙니다.'));
  if (body.validTo != null && (!DATE.test(body.validTo) || body.validTo < body.validFrom)) {
    errors.push(field('validTo', ERROR_CODE.INVALID, '끝 날짜는 시작 날짜 이후여야 합니다.'));
  }
  if (body.reason.trim() === '') errors.push(field('reason', ERROR_CODE.REQUIRED, '특채 사유를 공백만으로 채울 수 없습니다.'));
  if (errors.length > 0) throw badRequest(errors);
}

async function lockNonconformance(tx: Tx, id: bigint): Promise<{ status_code: string }> {
  const rows = await tx.$queryRaw<{ status_code: string }[]>`
    SELECT status_code FROM quality.nonconformance WHERE nonconformance_id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 부적합입니다.');
  return rows[0];
}

async function remainingOf(tx: Tx | PrismaService, ncId: bigint): Promise<Prisma.Decimal> {
  const [affected, decided] = await Promise.all([
    tx.nonconformance_lot.aggregate({ where: { nonconformance_id: ncId }, _sum: { affected_qty: true } }),
    tx.disposition_decision.aggregate({ where: { nonconformance_id: ncId }, _sum: { decision_qty: true } }),
  ]);
  return (affected._sum.affected_qty ?? new Prisma.Decimal(0)).minus(decided._sum.decision_qty ?? new Prisma.Decimal(0));
}

interface LockedConcession {
  concession_id: bigint;
  nonconformance_id: bigint;
  lot_id: bigint;
  approved_qty: Prisma.Decimal;
  uom_id: bigint;
  approval_request_id: bigint;
  status_code: string;
  remarks: string | null;
}

/** 행 하나로 묶음 전체를 잠근다 — 같은 부적합·같은 결재의 `PENDING` 행(오름차순). 이미 적용·반려된 행이면 409. */
async function lockBatch(tx: Tx, id: bigint): Promise<LockedConcession[]> {
  const [head] = await tx.$queryRaw<LockedConcession[]>`
    SELECT concession_id, nonconformance_id, lot_id, approved_qty, uom_id, approval_request_id, status_code, remarks
      FROM quality.concession WHERE concession_id = ${id} FOR UPDATE`;
  if (head === undefined) throw new NotFoundException('없는 특채입니다.');
  if (head.status_code !== PENDING) {
    throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '이미 적용되었거나 반려된 특채입니다.' }]);
  }
  return tx.$queryRaw<LockedConcession[]>`
    SELECT concession_id, nonconformance_id, lot_id, approved_qty, uom_id, approval_request_id, status_code, remarks
      FROM quality.concession
     WHERE nonconformance_id = ${head.nonconformance_id} AND approval_request_id = ${head.approval_request_id} AND status_code = ${PENDING}
     ORDER BY concession_id FOR UPDATE`;
}
