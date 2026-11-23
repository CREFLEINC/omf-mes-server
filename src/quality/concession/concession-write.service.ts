import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotHoldService, LotQualityStatusService, Tx, assertMaterialLotsUsable } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { releaseInspectionHoldsWithin } from '../disposition/disposition-hold-release';
import { dispositionProgressCode } from '../disposition/disposition-rollup';
import { assertQtyPrecision } from '../nonconformance/nonconformance-rules';

/** 처분 판정에 남는 유형 — 특채로 정리된 수량이 부적합의 «남은 수량»에서 빠진다. */
const CONCESSION_DISPOSITION = 'CONCESSION';
const RELEASE_REASON = 'CONCESSION_APPROVED';
const SOURCE_TYPE = 'CONCESSION';
/** 특채는 저장 때 바로 적용돼 이 상태로 태어난다(omf-all-around#352). */
const APPROVED = 'APPROVED';
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

/** 한 요청으로 함께 태어난 특채 묶음(같은 부적합). */
export interface ConcessionBatch {
  concessionIds: number[];
}

const optionalId = (value: number | null | undefined): bigint | null => (value == null ? null : BigInt(value));
const badRequest = (errors: ErrorItem[]): ContractException => new ContractException(HttpStatus.BAD_REQUEST, errors);
const screen = (code: string, message: string): ContractException =>
  badRequest([{ scope: 'screen', code, message }]);

/**
 * 특채 — 불합격 LOT 을 조건부로 쓴다.
 *
 * ⭐ 저장하면 «바로 적용»한다 — 결재 요청·승인·적용 단계를 두지 않는다(omf-all-around#352 사용자 결정 2026-11-23).
 * ⭐ 특채는 남은 수량 «전부»다(FR-038 — 일부 특채 제거). 부적합 LOT 이 여럿이면 LOT 마다 행을 둔다
 *    (피처 005 D-14 — `lot_id` NOT NULL 그대로라 ERP 빌더·재고 재등록·사용량이 LOT 마다 그대로 읽는다).
 * ⭐ 부적합에 처분 판정(CONCESSION) 1건을 남긴다 — 특채로 정리한 수량을 부적합의 남은 수량에서 빼야 처분 화면에 계속
 *    「판정 대기」로 남지 않는다.
 * ⛔ 사용 가능 수량·허용 조건은 «기록»한다 — 출고·투입에서 막지 않는다(#84 코멘트 · #207 결정).
 */
@Injectable()
export class ConcessionWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
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

    return this.prisma.$transaction(async (tx) => {
      const ncId = BigInt(body.nonconformanceId);
      const locked = await lockNonconformance(tx, ncId);
      if (locked.status_code === DECIDED) throw screen(ERROR_CODE.STATE_LOCKED, '이미 종결된 부적합입니다.');
      // ⛔ 남은 수량은 부적합 행을 `FOR UPDATE` 로 잡은 «뒤»에 읽는다 — 처분 등록(같은 잠금)과 겹쳐도 옛 잔량으로 판정하지 않는다.
      const { affectedQty, decidedQty, decisionCount } = await quantitiesOf(tx, ncId);
      const remaining = affectedQty.minus(decidedQty);
      if (!new Prisma.Decimal(body.approvedQty).equals(remaining)) {
        throw badRequest([field('approvedQty', ERROR_CODE.INVALID, `특채 수량은 남은 수량(${remaining.toString()})과 같아야 합니다 — 일부 특채는 지원하지 않습니다.`)]);
      }
      const qtys = rowQtys(targets, remaining);
      const by = BigInt(appUserId);
      const now = new Date();
      const reason = body.reason.trim();
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
            approval_request_id: null,
            status_code: APPROVED,
            remarks: reason,
            created_by: by,
            updated_by: by,
          },
          select: { concession_id: true },
        });
        concessionIds.push(Number(created.concession_id));
      }
      await tx.disposition_decision.create({
        data: {
          nonconformance_id: ncId,
          disposition_type_code: CONCESSION_DISPOSITION,
          decision_qty: remaining,
          uom_id: BigInt(body.uomId),
          reason,
          decided_by: by,
          decided_at: now,
          approval_request_id: null,
        },
      });
      let moved = 0;
      for (const [index, target] of targets.entries()) {
        const result = await this.lots.moveWithin(tx, [target.lot_id], 'concession-apply', {
          changedBy: by, changedAt: now, sourceDocumentTypeCode: SOURCE_TYPE,
          sourceDocumentId: BigInt(concessionIds[index]), reason,
        });
        moved += result.movedLotIds.length;
      }
      if (moved === 0) throw screen(ERROR_CODE.STATE_LOCKED, '지금 LOT 상태에서는 특채를 적용할 수 없습니다.');
      await releaseInspectionHoldsWithin(tx, this.holds, targets.map((row) => row.lot_id), { by, at: now }, RELEASE_REASON);

      const closing = dispositionProgressCode(decisionCount + 1, affectedQty, decidedQty.plus(remaining));
      const decided = closing === 'COMPLETED'
        ? this.documentState.assertTransition(NC_STATUS_COLUMN, 'nonconformance-decide', locked.status_code)
        : undefined;
      await tx.nonconformance.update({
        where: { nonconformance_id: ncId },
        data: {
          version_no: { increment: 1 }, updated_by: by, updated_at: now,
          ...(decided === undefined ? {} : { status_code: decided.to, closed_at: now }),
        },
      });
      return { concessionIds };
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

async function quantitiesOf(
  tx: Tx, ncId: bigint,
): Promise<{ affectedQty: Prisma.Decimal; decidedQty: Prisma.Decimal; decisionCount: number }> {
  const [affected, decided] = await Promise.all([
    tx.nonconformance_lot.aggregate({ where: { nonconformance_id: ncId }, _sum: { affected_qty: true } }),
    tx.disposition_decision.aggregate({ where: { nonconformance_id: ncId }, _sum: { decision_qty: true }, _count: true }),
  ]);
  return {
    affectedQty: affected._sum.affected_qty ?? new Prisma.Decimal(0),
    decidedQty: decided._sum.decision_qty ?? new Prisma.Decimal(0),
    decisionCount: decided._count,
  };
}
