import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { ApprovalService } from '../../core/approval';
import { Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { assertQtyPrecision } from '../nonconformance/nonconformance-rules';
import { hasApprovalRoute } from './approval-route-check';
import { hasPendingDispositionApproval } from './disposition-approval-pending';
import { DispositionApprovalView, dispositionApprovalViews } from './disposition-approval-view';
import { DispositionSortCreated, chooseLots, lockSortable, sortSourceOf } from './disposition-sort';
import { DispositionDecisionView } from './disposition-view';
import {
  DispositionDecisionCreate, DispositionWriteService, assertShape, assertWithinRemaining, readTarget,
} from './disposition-write.service';

/** 폐기·선별 처분 결재(omf-all-around#352). 대상은 부적합 — 처분 판정은 결재 «뒤»에 생겨 id 가 없다(특채와 같다). */
export const DISPOSITION_APPROVAL_TYPE = 'DISPOSITION';
const TARGET_TYPE = 'NONCONFORMANCE';
const PENDING = 'PENDING';
const APPROVED = 'APPROVED';
const APPLIED = 'APPLIED';
const REJECTED = 'REJECTED';
const SORT = 'SORT';
const INVALID_STATE = 'INVALID_STATE';
const VERSION_CONFLICT = 'VERSION_CONFLICT';

type DecisionView = DispositionDecisionView & Partial<DispositionSortCreated>;

/** 계약 `DispositionApprovalOutcome`. */
export interface DispositionApprovalOutcome {
  outcome: 'APPLIED' | 'REQUESTED';
  decision?: DecisionView;
  dispositionApproval?: DispositionApprovalView;
}

/** 계약 `DispositionApprovalApplied`. */
export interface DispositionApprovalApplied {
  dispositionApproval: DispositionApprovalView;
  decision?: DecisionView;
}

const invalidState = (message: string): ConflictException => new ConflictException('user', message, { code: INVALID_STATE });

/**
 * ⭐ 폐기·선별을 「요청 → 결재(W-03-09) → 반영(`:apply`)」 셋으로 나눈다 — 특채(`concession-write.service.ts`)와 같은 짜임이다.
 * ⭐⭐ 결재선이 없으면(`ROUTE_NOT_FOUND` — 활성 결재선 0 · 단계 0) 오늘처럼 «바로» 판정한다 — 결재선을 두지 않은 공장의 처분 흐름을
 *    바꾸지 않는다. 결재선이 둘 이상(`ROUTE_AMBIGUOUS`)은 그대로 400 이다.
 * ⭐ 반영은 처분 판정 저장(`DispositionWriteService.create`)을 «그대로» 부른다 — LOT 전이·보류 해제·선별 분리가 바로 판정과 한 글자도
 *    다르지 않게. 반영 표시(이 행 APPLIED · 판정의 `approval_request_id`)는 그 트랜잭션 «안»의 hook 이다.
 */
@Injectable()
export class DispositionApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalService,
    private readonly writes: DispositionWriteService,
  ) {}

  async request(
    nonconformanceId: number, version: number, body: DispositionDecisionCreate, appUserId: number,
  ): Promise<{ result: DispositionApprovalOutcome; versionNo: number }> {
    if (!(await this.hasRoute())) {
      const applied = await this.writes.create(nonconformanceId, version, body, appUserId);
      return { result: { outcome: 'APPLIED', decision: applied.view }, versionNo: applied.versionNo };
    }
    if (body.dispositionTypeCode === SORT && body.lotIds === undefined) {
      throw one(field('lotIds', ERROR_CODE.REQUIRED, '선별은 불량 자재 관리 LOT 을 골라 보내세요.'));
    }
    const id = BigInt(nonconformanceId);
    // 선별 대상(404 · 400 — 반품·OQC·선별로 생긴 부적합)은 트랜잭션 «전»에 본다 — 바로 판정의 선별과 같은 순서다.
    if (body.dispositionTypeCode === SORT) await sortSourceOf(this.prisma, id);
    // ⛔ 채번은 트랜잭션을 «열기 전»이다(코어 규약).
    const approvalRequestNo = await this.numbering.next('APPROVAL_REQUEST', null, new Date().toISOString().slice(0, 10));

    return this.prisma.$transaction(async (tx) => {
      const locked = await lockNonconformance(tx, id);
      if (locked.status_code === 'DECIDED') throw invalidState('이미 종결된 부적합이라 처분을 요청할 수 없습니다.');
      // 한 부적합에 결재 진행 중인 처분(폐기·선별·특채)은 하나다 — 승인 뒤 반영할 남은 수량·LOT 이 요청 때와 같아야 한다.
      if (await hasPendingDispositionApproval(tx, id) || await hasPendingConcession(tx, id)) {
        throw invalidState('결재 진행 중인 처분이 있습니다.');
      }
      if (body.dispositionTypeCode === SORT) await assertSortable(tx, id, body);
      else await assertScrappable(tx, id, body);
      const approval = await this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: DISPOSITION_APPROVAL_TYPE,
        targetTypeCode: TARGET_TYPE,
        targetId: id,
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason: body.reason.trim(),
      });
      const by = BigInt(appUserId);
      const created = await tx.disposition_approval.create({
        data: {
          nonconformance_id: id,
          disposition_type_code: body.dispositionTypeCode,
          ...(body.dispositionTypeCode === SORT
            ? { lot_ids: (body.lotIds ?? []).map((lotId) => BigInt(lotId)), good_qty: body.goodQty ?? null, defect_qty: body.defectQty ?? null }
            : { decision_qty: new Prisma.Decimal(body.decisionQty as number), uom_id: BigInt(body.uomId as number) }),
          reason: body.reason,
          approval_request_id: approval.approvalRequestId,
          status_code: PENDING,
          created_by: by,
          updated_by: by,
        },
        select: { disposition_approval_id: true },
      });
      // 요청도 부적합의 판을 올린다 — 같은 화면을 연 다른 사람의 바로 판정·요청이 옛 토큰으로 들어오지 않게.
      const updated = await tx.nonconformance.updateMany({
        where: { nonconformance_id: id, version_no: version },
        data: { version_no: { increment: 1 }, updated_by: by, updated_at: new Date() },
      });
      assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT, currentVersion: String(locked.version_no) });
      const [view] = await dispositionApprovalViews(tx, { disposition_approval_id: created.disposition_approval_id });
      return { result: { outcome: 'REQUESTED' as const, dispositionApproval: view }, versionNo: locked.version_no + 1 };
    });
  }

  /**
   * 반영 — 결재 진행 중이면 400 `APPROVAL_IN_PROGRESS`, 반려(승인 아닌 끝)면 행을 REJECTED 로 «닫고» 200(던지면 닫은 것까지 되돌아간다 ·
   * 특채와 같은 이유). 승인이면 저장한 본문으로 처분 판정을 만들고 행을 APPLIED 로. 이미 반영·반려된 행은 409 `INVALID_STATE`.
   */
  async apply(dispositionApprovalId: number, version: number, appUserId: number): Promise<{ result: DispositionApprovalApplied; versionNo: number }> {
    const id = BigInt(dispositionApprovalId);
    const row = await this.prisma.disposition_approval.findUnique({
      where: { disposition_approval_id: id },
      select: {
        nonconformance_id: true, disposition_type_code: true, decision_qty: true, uom_id: true, lot_ids: true, good_qty: true,
        defect_qty: true, reason: true, approval_request_id: true, status_code: true,
        approval_request: { select: { status_code: true } },
        nonconformance: { select: { version_no: true } },
      },
    });
    if (row === null) throw new NotFoundException('없는 처분 결재입니다.');
    if (row.status_code !== PENDING) throw invalidState('이미 반영되었거나 반려된 처분 결재입니다.');
    const approvalStatus = row.approval_request.status_code;
    if (approvalStatus === PENDING) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.APPROVAL_IN_PROGRESS, message: '결재가 아직 진행 중입니다.' }]);
    }
    const by = BigInt(appUserId);
    if (approvalStatus !== APPROVED) {
      await this.prisma.$transaction(async (tx) => {
        const closed = await tx.disposition_approval.updateMany({
          where: { disposition_approval_id: id, status_code: PENDING },
          data: { status_code: REJECTED, updated_by: by, updated_at: new Date() },
        });
        if (closed.count === 0) throw invalidState('이미 반영되었거나 반려된 처분 결재입니다.');
      });
      return { result: { dispositionApproval: await this.viewOf(id) }, versionNo: row.nonconformance.version_no };
    }

    const lotIds = row.lot_ids ?? [];
    const body: DispositionDecisionCreate = row.disposition_type_code === SORT
      ? {
        dispositionTypeCode: SORT, reason: row.reason, lotIds: lotIds.map(Number),
        ...(row.good_qty === null ? {} : { goodQty: row.good_qty.toNumber() }),
        ...(row.defect_qty === null ? {} : { defectQty: row.defect_qty.toNumber() }),
      }
      : {
        dispositionTypeCode: row.disposition_type_code, reason: row.reason,
        decisionQty: (row.decision_qty as Prisma.Decimal).toNumber(), uomId: Number(row.uom_id),
      };
    const applied = await this.writes.create(Number(row.nonconformance_id), version, body, appUserId, {
      afterDecision: async (tx, decisionId) => {
        // ⛔ 행을 다시 잡아 PENDING 인지 본다 — 두 반영이 겹치면 뒤엣것이 여기서 409 로 되돌아간다.
        const [locked] = await tx.$queryRaw<{ status_code: string }[]>`
          SELECT status_code FROM quality.disposition_approval WHERE disposition_approval_id = ${id} FOR UPDATE`;
        if (locked?.status_code !== PENDING) throw invalidState('이미 반영되었거나 반려된 처분 결재입니다.');
        await tx.disposition_decision.update({ where: { disposition_decision_id: decisionId }, data: { approval_request_id: row.approval_request_id } });
        await tx.disposition_approval.update({
          where: { disposition_approval_id: id },
          data: { status_code: APPLIED, disposition_decision_id: decisionId, updated_by: by, updated_at: new Date() },
        });
      },
    });
    return { result: { dispositionApproval: await this.viewOf(id), decision: applied.view }, versionNo: applied.versionNo };
  }

  list(nonconformanceId: number): Promise<DispositionApprovalView[]> {
    return dispositionApprovalViews(this.prisma, { nonconformance_id: BigInt(nonconformanceId) });
  }

  private async viewOf(id: bigint): Promise<DispositionApprovalView> {
    const [view] = await dispositionApprovalViews(this.prisma, { disposition_approval_id: id });
    return view;
  }

  private hasRoute(): Promise<boolean> {
    return hasApprovalRoute(this.prisma, this.approvals, DISPOSITION_APPROVAL_TYPE);
  }
}

async function lockNonconformance(tx: Tx, id: bigint): Promise<{ status_code: string; version_no: number }> {
  const [row] = await tx.$queryRaw<{ status_code: string; version_no: number }[]>`
    SELECT status_code, version_no FROM quality.nonconformance WHERE nonconformance_id = ${id} FOR UPDATE`;
  if (row === undefined) throw new NotFoundException('없는 부적합입니다.');
  return row;
}

/** 폐기 — 바로 판정과 같은 검사(본문 모양·단위·자릿수 400 → 남은 수량 409 `DISPOSITION_QTY_EXCEEDED`). */
async function assertScrappable(tx: Tx, id: bigint, body: DispositionDecisionCreate): Promise<void> {
  const target = await readTarget(tx, id);
  assertWithinRemaining(assertShape(body, target), target);
}

/** 선별 — 바로 판정의 선별과 같은 검사(종결·판정·특채 있음 409 → LOT 400 → 정보 수량 자릿수 400). */
async function assertSortable(tx: Tx, id: bigint, body: DispositionDecisionCreate): Promise<void> {
  await lockSortable(tx, id);
  const sortBody = { ...body, lotIds: body.lotIds as number[] };
  const { scale } = await chooseLots(tx, id, sortBody);
  for (const [name, value] of [['goodQty', body.goodQty], ['defectQty', body.defectQty]] as const) {
    if (value !== undefined) assertQtyPrecision(name, value, scale);
  }
}

async function hasPendingConcession(tx: Tx, id: bigint): Promise<boolean> {
  return (await tx.concession.count({ where: { nonconformance_id: id, status_code: PENDING } })) > 0;
}
