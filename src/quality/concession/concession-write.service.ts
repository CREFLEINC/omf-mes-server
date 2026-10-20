import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService, Tx } from '../../core/lot';
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
  lotId: number;
  approvedQty: number;
  uomId: number;
  validFrom: string;
  validTo?: string | null;
  allowedWorkOrderId?: number | null;
  allowedProcessId?: number | null;
  allowedCustomerId?: number | null;
  reason: string;
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
 * ⭐ 적용이 부적합에 처분 판정(CONCESSION) 1건을 남긴다 — 특채로 정리한 수량을 부적합의 남은 수량에서 빼야
 *    처분 화면에 계속 「판정 대기」로 남지 않는다. 다 차면 기존 규칙대로 부적합을 닫는다.
 * ⛔ 사용 가능 수량은 «기록»한다 — 출고·투입에서 잔량을 넘는지 막는 것은 이번 범위 밖이다(#84 코멘트).
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

  async request(body: ConcessionCreate, appUserId: number): Promise<number> {
    assertCreateShape(body);
    const nc = await this.prisma.nonconformance.findUnique({
      where: { nonconformance_id: BigInt(body.nonconformanceId) },
      select: { status_code: true, nonconformance_lot: { select: { lot_id: true, uom_id: true } } },
    });
    if (nc === null) throw new NotFoundException('없는 부적합입니다.');
    const lot = nc.nonconformance_lot.find((row) => row.lot_id === BigInt(body.lotId));
    if (lot === undefined) throw badRequest([field('lotId', ERROR_CODE.INVALID, '이 부적합의 LOT 이 아닙니다.')]);
    if (Number(lot.uom_id) !== body.uomId) {
      throw badRequest([field('uomId', ERROR_CODE.INVALID, '부적합의 단위와 같아야 합니다.')]);
    }
    const uom = await this.prisma.uom.findUniqueOrThrow({ where: { uom_id: lot.uom_id }, select: { decimal_scale: true } });
    assertQtyPrecision('approvedQty', body.approvedQty, uom.decimal_scale);

    // ⛔ 채번은 트랜잭션을 «열기 전»이다(코어 규약).
    const today = new Date().toISOString().slice(0, 10);
    const concessionNo = await this.numbering.next('CONCESSION', null, today);
    const approvalRequestNo = await this.numbering.next('APPROVAL_REQUEST', null, today);

    return this.prisma.$transaction(async (tx) => {
      const locked = await lockNonconformance(tx, BigInt(body.nonconformanceId));
      if (locked.status_code === DECIDED) throw screen(ERROR_CODE.STATE_LOCKED, '이미 종결된 부적합입니다.');
      const remaining = await remainingOf(tx, BigInt(body.nonconformanceId));
      if (new Prisma.Decimal(body.approvedQty).greaterThan(remaining)) {
        throw badRequest([field('approvedQty', ERROR_CODE.INVALID, `남은 수량(${remaining.toString()})을 넘습니다.`)]);
      }
      const approval = await this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: CONCESSION_APPROVAL_TYPE,
        targetTypeCode: APPROVAL_TARGET_TYPE,
        targetId: BigInt(body.nonconformanceId),
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason: body.reason.trim(),
      });
      const created = await tx.concession.create({
        data: {
          concession_no: concessionNo,
          nonconformance_id: BigInt(body.nonconformanceId),
          lot_id: BigInt(body.lotId),
          approved_qty: new Prisma.Decimal(body.approvedQty),
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
      return Number(created.concession_id);
    });
  }

  /**
   * 적용. 결재가 승인이면 특채 APPROVED · 처분 판정 · LOT 정상(C25) · 수입검사 대기 보류 해제가 한 트랜잭션이다.
   * ⭐ 결재가 반려면 특채를 REJECTED 로 «닫고» 그대로 돌려준다(400 으로 던지면 닫은 것까지 되돌아간다).
   */
  async apply(concessionId: number, appUserId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const concession = await lockConcession(tx, BigInt(concessionId));
      if (concession.status_code !== PENDING) throw screen(ERROR_CODE.STATE_LOCKED, '이미 적용되었거나 반려된 특채입니다.');
      const approval = await tx.approval_request.findUniqueOrThrow({
        where: { approval_request_id: concession.approval_request_id },
        select: { status_code: true },
      });
      const now = new Date();
      const by = BigInt(appUserId);
      if (approval.status_code === PENDING) throw screen(ERROR_CODE.APPROVAL_IN_PROGRESS, '결재가 아직 진행 중입니다.');
      if (approval.status_code !== APPROVED) {
        await this.close(tx, concession.concession_id, REJECTED, by, now);
        return;
      }

      const ncId = concession.nonconformance_id;
      const nc = await lockNonconformance(tx, ncId);
      if (nc.status_code === DECIDED) throw screen(ERROR_CODE.STATE_LOCKED, '이미 종결된 부적합입니다.');
      // ⛔ 남은 수량을 «적용 시점»에 다시 본다 — 요청 뒤 다른 처분·특채가 먼저 수량을 썼을 수 있다. 부적합 행을
      //    `FOR UPDATE` 로 잡은 «뒤»에 읽으므로 처분 등록(같은 잠금)·다른 특채 적용과 겹쳐도 옛 잔량으로 판정하지 않는다.
      const decisions = await tx.disposition_decision.aggregate({
        where: { nonconformance_id: ncId }, _sum: { decision_qty: true }, _count: true,
      });
      const affected = await tx.nonconformance_lot.aggregate({ where: { nonconformance_id: ncId }, _sum: { affected_qty: true } });
      const affectedQty = affected._sum.affected_qty ?? new Prisma.Decimal(0);
      const decidedQty = decisions._sum.decision_qty ?? new Prisma.Decimal(0);
      const remaining = affectedQty.minus(decidedQty);
      if (concession.approved_qty.greaterThan(remaining)) {
        throw badRequest([field('approvedQty', ERROR_CODE.INVALID, `남은 수량을 넘습니다. (남은 수량 ${remaining.toString()})`)]);
      }
      await tx.disposition_decision.create({
        data: {
          nonconformance_id: ncId,
          disposition_type_code: CONCESSION_DISPOSITION,
          decision_qty: concession.approved_qty,
          uom_id: concession.uom_id,
          reason: concession.remarks ?? '특채',
          decided_by: by,
          decided_at: now,
          approval_request_id: concession.approval_request_id,
        },
      });
      const moved = await this.lots.moveWithin(tx, [concession.lot_id], 'concession-apply', {
        changedBy: by, changedAt: now, sourceDocumentTypeCode: SOURCE_TYPE,
        sourceDocumentId: concession.concession_id, reason: concession.remarks ?? undefined,
      });
      if (moved.movedLotIds.length === 0) throw screen(ERROR_CODE.STATE_LOCKED, '지금 LOT 상태에서는 특채를 적용할 수 없습니다.');
      await releaseInspectionHoldsWithin(tx, this.holds, [concession.lot_id], { by, at: now }, RELEASE_REASON);

      const closing = dispositionProgressCode(decisions._count + 1, affectedQty, decidedQty.plus(concession.approved_qty));
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
      await this.close(tx, concession.concession_id, APPROVED, by, now);
    });
  }

  private async close(tx: Tx, concessionId: bigint, statusCode: string, by: bigint, at: Date): Promise<void> {
    await tx.concession.update({
      where: { concession_id: concessionId },
      data: { status_code: statusCode, updated_by: by, updated_at: at, version_no: { increment: 1 } },
    });
  }
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

async function remainingOf(tx: Tx, ncId: bigint): Promise<Prisma.Decimal> {
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

async function lockConcession(tx: Tx, id: bigint): Promise<LockedConcession> {
  const rows = await tx.$queryRaw<LockedConcession[]>`
    SELECT concession_id, nonconformance_id, lot_id, approved_qty, uom_id, approval_request_id, status_code, remarks
      FROM quality.concession WHERE concession_id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 특채입니다.');
  return rows[0];
}
