import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import {
  LotHoldService,
  LotQualityStatusService,
  lotsFreeOfOpenHolds,
  PREISSUED_LIFECYCLE,
  VOIDED_LIFECYCLE,
  Tx,
  WORK_ORDER_LOT_SOURCE,
} from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';

/** 승인 다형 축 — `IQC_SKIP`·`INBOUND_LOT` · `OQC_SKIP`·`SHIPMENT_REQUEST` 의 거울(omf-all-around#212 · 장부 P-152). */
const PQC_SKIP_TYPE = 'PQC_SKIP';
const PQC_SKIP_TARGET_TYPE = 'WORK_ORDER';
const APPROVED = 'APPROVED';
const SKIPPED = 'SKIPPED';
const OPEN_REQUEST_STATUSES = ['REQUESTED', 'IN_PROGRESS'];
const APPROVAL_SOURCE = 'APPROVAL_REQUEST';

/**
 * 생략할 수 있는 PQC 의뢰 — 그 W/O 의 열린 의뢰 중 확정 결과가 «없는» 것.
 * ⛔ 확정 회차가 있는 의뢰(재검사 대기 등)는 건드리지 않는다 — 불합격 판정을 생략으로 덮으면 실적이 정상으로 읽는다(OQC 생략과 같은 규칙).
 */
const skippableWhere = (workOrderId: bigint): Prisma.inspection_requestWhereInput => ({
  inspection_type_code: 'PQC',
  work_order_id: workOrderId,
  status_code: { in: OPEN_REQUEST_STATUSES },
  inspection_result: { none: { status_code: 'CONFIRMED' } },
});

/**
 * PQC 건별 생략 — 요청(결재 상신)과 승인 뒤 실행(omf-all-around#212 · 장부 P-152). OQC 생략(`shipment-oqc-skip.service.ts`)과
 * 같은 모양이다: 요청·승인은 아무것도 옮기지 않고(공유계약 J-8), 실행이 의뢰를 `SKIPPED`(근거 APPROVAL)로 닫는다. 단위는 W/O 하나다.
 *
 * ⭐ 실행 «뒤»의 실적은 배포 기본 생략과 같은 길(C26)로 정상이 된다 — 실적 등록이 「PQC 의뢰가 생략뿐」을 본다.
 *    실행 «전»에 실적이 나 검사 대기로 남은 생산LOT 만 여기서 C28 로 올린다.
 */
@Injectable()
export class WorkOrderPqcSkipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalService,
    private readonly holds: LotHoldService,
    private readonly qualities: LotQualityStatusService,
  ) {}

  async requestSkip(workOrderId: number, reason: string, appUserId: number): Promise<{ approvalRequestId: number }> {
    const id = BigInt(workOrderId);
    // 존재·자격을 채번 «전»에 한 번 거른다 — 400 이 될 요청에 AP 번호를 태우면 결번만 남는다(IQC·OQC 생략과 같은 순서).
    await assertExists(this.prisma, id);
    await assertSkippable(this.prisma, id, '요청');
    // ⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 커넥션을 둘 쥐어 P2024 로 죽는다.
    const approvalRequestNo = await this.numbering.next('APPROVAL_REQUEST', null, new Date().toISOString().slice(0, 10));

    const created = await this.prisma.$transaction(async (tx) => {
      await lockWorkOrder(tx, id);
      await assertSkippable(tx, id, '요청');
      return this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: PQC_SKIP_TYPE,
        targetTypeCode: PQC_SKIP_TARGET_TYPE,
        targetId: id,
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason,
      });
    });
    return { approvalRequestId: Number(created.approvalRequestId) };
  }

  async execute(workOrderId: number, appUserId: number): Promise<void> {
    const id = BigInt(workOrderId);
    await this.prisma.$transaction(async (tx) => {
      await lockWorkOrder(tx, id);
      // 생략이 의뢰를 SKIPPED 로 닫으므로 같은 승인의 재사용도 여기서 막힌다.
      await assertSkippable(tx, id, '실행');
      const approval = await tx.approval_request.findFirst({
        where: { approval_type_code: PQC_SKIP_TYPE, target_type_code: PQC_SKIP_TARGET_TYPE, target_id: id, status_code: APPROVED },
        select: { approval_request_id: true },
        orderBy: { approval_request_id: 'desc' },
      });
      if (approval === null) throw stateLocked('승인된 PQC 생략 요청이 없습니다.');

      const by = BigInt(appUserId);
      await tx.inspection_request.updateMany({
        where: skippableWhere(id),
        data: { status_code: SKIPPED, skip_basis_code: 'APPROVAL', updated_by: by, version_no: { increment: 1 } },
      });
      // ⛔ 실적이 없는 슬롯(WAITING)과 W/O 취소로 폐번된 LOT(VOIDED)은 옮기지 않는다 — PQC 합격 확정(`releasePqcLots`)과 같은 모집단이다(#213).
      const lots = await tx.lot.findMany({
        where: {
          source_type_code: WORK_ORDER_LOT_SOURCE,
          source_id: id,
          work_order_lot_seq: { not: null },
          status_code: 'INSPECTION_PENDING',
          lifecycle_status_code: { notIn: [PREISSUED_LIFECYCLE, VOIDED_LIFECYCLE] },
        },
        select: { lot_id: true },
      });
      // 다른 열린 보류(의심자재 등)가 있는 LOT 은 올리지 않는다 — 합격 확정과 같은 규율.
      const free = await lotsFreeOfOpenHolds(tx, this.holds, lots.map((lot) => lot.lot_id));
      await this.qualities.moveWithin(tx, free, 'pqc-skip-approved', {
        changedBy: by,
        changedAt: new Date(),
        sourceDocumentTypeCode: APPROVAL_SOURCE,
        sourceDocumentId: approval.approval_request_id,
      });
    });
  }
}

async function assertExists(prisma: PrismaService, id: bigint): Promise<void> {
  const found = await prisma.work_order.findUnique({ where: { work_order_id: id }, select: { work_order_id: true } });
  if (found === null) throw new NotFoundException('없는 작업지시입니다.');
}

async function assertSkippable(
  prisma: Pick<Prisma.TransactionClient, 'inspection_request'>,
  id: bigint,
  verb: '요청' | '실행',
): Promise<void> {
  const open = await prisma.inspection_request.count({ where: skippableWhere(id) });
  if (open === 0) {
    throw stateLocked(`이 작업지시의 PQC 검사가 없거나 이미 끝났거나 생략돼 생략을 ${verb}할 수 없습니다.`);
  }
}

/** ⛔ `FOR UPDATE` — 같은 W/O 의 상신 둘·실행 둘이 함께 통과하지 않게 한다(코어 `assertNoOpenRequest` 는 조회만 한다). */
async function lockWorkOrder(tx: Tx, id: bigint): Promise<void> {
  const rows = await tx.$queryRaw<{ work_order_id: bigint }[]>`
    SELECT work_order_id
      FROM production.work_order
     WHERE work_order_id = ${id}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 작업지시입니다.');
}

function stateLocked(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);
}
