import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { LotQualityStatusService, Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { assertOqcPicked, oqcPickedLots } from './shipment-oqc-lots';

/** 승인 다형 축 — `IQC_SKIP`·`INBOUND_LOT` 의 거울(omf-all-around#119 · 장부 P-83). */
const OQC_SKIP_TYPE = 'OQC_SKIP';
const OQC_SKIP_TARGET_TYPE = 'SHIPMENT_REQUEST';
const APPROVED = 'APPROVED';
const SKIPPED = 'SKIPPED';
const OPEN_REQUEST_STATUSES = ['REQUESTED', 'IN_PROGRESS'];
const APPROVAL_SOURCE = 'APPROVAL_REQUEST';

/**
 * 생략할 수 있는 OQC 의뢰 — 그 출하작업지시의 열린 의뢰 중 확정 결과가 «없는» 것.
 * ⛔ 확정 회차가 있는 의뢰(재검사 대기 등)는 건드리지 않는다 — 불합격 판정을 생략으로 덮으면 관문이 «통과»로 읽는다.
 */
const skippableWhere = (shipmentRequestId: bigint): Prisma.inspection_requestWhereInput => ({
  inspection_type_code: 'OQC',
  target_type_code: OQC_SKIP_TARGET_TYPE,
  target_id: shipmentRequestId,
  status_code: { in: OPEN_REQUEST_STATUSES },
  inspection_result: { none: { status_code: 'CONFIRMED' } },
});

/**
 * OQC 생략 — 요청(결재 상신)과 승인 뒤 실행(omf-all-around#119 · 2026-10-20 결정 D3·D4·D6 · 장부 P-83).
 * IQC 생략(`lot-iqc-skip*.service.ts`)과 같은 모양이다: 요청·승인은 아무것도 옮기지 않고(공유계약 J-8), 실행이
 * 의뢰를 `SKIPPED` 로 닫고 집은 LOT 에 C27 이력을 남긴다. 단위는 출하작업지시 하나다(D4 — 그 요청의 OQC 의뢰 전부).
 */
@Injectable()
export class ShipmentOqcSkipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalService,
    private readonly qualities: LotQualityStatusService,
  ) {}

  async requestSkip(shipmentRequestId: number, reason: string, appUserId: number): Promise<{ approvalRequestId: number }> {
    const id = BigInt(shipmentRequestId);
    // 존재·자격을 채번 «전»에 한 번 거른다 — 400 이 될 요청에 AP 번호를 태우면 결번만 남는다(IQC 생략과 같은 순서).
    await assertExists(this.prisma, id);
    await assertSkippable(this.prisma, id, '요청');
    // ⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 커넥션을 둘 쥐어 P2024 로 죽는다.
    const approvalRequestNo = await this.numbering.next('APPROVAL_REQUEST', null, new Date().toISOString().slice(0, 10));

    const created = await this.prisma.$transaction(async (tx) => {
      await lockShipmentRequest(tx, id);
      await assertSkippable(tx, id, '요청');
      // 「진행 중인 요청은 하나」·결재선 선택은 코어가 한다 — `ROUTE_NOT_FOUND`·`APPROVAL_IN_PROGRESS` 를 감싸지 않는다.
      return this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: OQC_SKIP_TYPE,
        targetTypeCode: OQC_SKIP_TARGET_TYPE,
        targetId: id,
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason,
      });
    });
    return { approvalRequestId: Number(created.approvalRequestId) };
  }

  async execute(shipmentRequestId: number, appUserId: number): Promise<void> {
    const id = BigInt(shipmentRequestId);
    await this.prisma.$transaction(async (tx) => {
      await lockShipmentRequest(tx, id);
      // 생략이 의뢰를 SKIPPED 로 닫으므로 같은 승인의 재사용도 여기서 막힌다.
      await assertSkippable(tx, id, '실행');
      const approval = await tx.approval_request.findFirst({
        where: { approval_type_code: OQC_SKIP_TYPE, target_type_code: OQC_SKIP_TARGET_TYPE, target_id: id, status_code: APPROVED },
        select: { approval_request_id: true },
        orderBy: { approval_request_id: 'desc' },
      });
      if (approval === null) throw stateLocked('승인된 OQC 생략 요청이 없습니다.');
      // 피킹이 덜 끝났으면 이력을 남길 LOT 이 모자란다(D6-b) — 판정과 같은 전제다.
      const picked = await oqcPickedLots(tx, id, null);
      assertOqcPicked(picked, '생략을 실행하세요');

      const by = BigInt(appUserId);
      await tx.inspection_request.updateMany({
        where: skippableWhere(id),
        data: { status_code: SKIPPED, skip_basis_code: 'APPROVAL', updated_by: by, version_no: { increment: 1 } },
      });
      await this.qualities.moveWithin(tx, picked.lotIds, 'oqc-skipped', {
        changedBy: by,
        changedAt: new Date(),
        sourceDocumentTypeCode: APPROVAL_SOURCE,
        sourceDocumentId: approval.approval_request_id,
      });
    });
  }
}

async function assertExists(prisma: PrismaService, id: bigint): Promise<void> {
  const found = await prisma.shipment_request.findUnique({ where: { shipment_request_id: id }, select: { shipment_request_id: true } });
  if (found === null) throw new NotFoundException('없는 출하작업지시입니다.');
}

async function assertSkippable(
  prisma: Pick<Prisma.TransactionClient, 'inspection_request'>,
  id: bigint,
  verb: '요청' | '실행',
): Promise<void> {
  const open = await prisma.inspection_request.count({ where: skippableWhere(id) });
  if (open === 0) {
    throw stateLocked(`이 출하작업지시의 OQC 검사가 이미 끝났거나 생략돼 생략을 ${verb}할 수 없습니다.`);
  }
}

/** ⛔ `FOR UPDATE` — 같은 출하작업지시의 상신 둘·실행 둘이 함께 통과하지 않게 한다(코어 `assertNoOpenRequest` 는 조회만 한다). */
async function lockShipmentRequest(tx: Tx, id: bigint): Promise<void> {
  const rows = await tx.$queryRaw<{ shipment_request_id: bigint }[]>`
    SELECT shipment_request_id
      FROM logistics.shipment_request
     WHERE shipment_request_id = ${id}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 출하작업지시입니다.');
}

function stateLocked(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);
}
