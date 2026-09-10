import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
import { releaseReservation } from '../../core/inventory-posting/reservation-qty';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { SHIPMENT_REQUEST_LINE } from '../shipment-request/shipment-progress';
import {
  CANCELLED,
  CANCEL_APPROVAL_TYPE,
  CONFIRMED,
  CONFLICT_CODE,
  LockedShipment,
  SHIPMENT_TARGET,
  STATUS_COLUMN,
  Tx,
  assertVersion,
  hasOpenCancel,
  lockShipment,
} from './shipment-guards';
import { ShipmentQueryService } from './shipment-query.service';
import { ShipmentDetailView } from './shipment-view';

/**
 * 출하 취소 둘 — `:request-cancel`(결재 상신) · `:cancel`(승인 뒤 실행). 화면 `W-04-12`.
 *
 * ⭐ **다형 취소(I-5)와 세 자리가 갈린다**(계획서 §4-5):
 *   ⓐ 취소 흔적은 `app.document_cancellation` 이 아니라 **출하의 자기 칸**(`cancelled_at`·`cancelled_by`)
 *   ⓑ **중간 상태가 없다** — 시드 3값에 `CANCEL_REQUESTED` 가 없어 상신이 상태를 안 옮긴다
 *   ⓒ 409 봉투가 **계열**이다(`ShipmentConflictResponse` · `code` required)
 */

type CancelableDocument = 'GOODS_ISSUE' | 'GOODS_RECEIPT';

const CANCEL_ACTION = 'shipment-cancel';
const APPROVAL_DOCUMENT_TYPE = 'APPROVAL_REQUEST';
const DOCUMENT_CANCELLED = 'CANCELLED';
const RELEASE_FIELD = 'shipmentId';

export interface ShipmentCancelRequestBody {
  reason: string;
}

export interface ShipmentCancelBody {
  businessDate: string;
  occurredAt: string;
  remarks?: string | null;
}

@Injectable()
export class ShipmentCancelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalService,
    private readonly numbering: NumberingService,
    private readonly documentState: DocumentStateService,
    private readonly posting: InventoryPostingService,
    private readonly queries: ShipmentQueryService,
  ) {}

  /**
   * 취소 결재 상신. ⛔ **상태를 옮기지 않는다** — `SHIPMENT_STATUS` 3값에 `CANCEL_REQUESTED` 가 없다.
   * 「진행 중」은 열린 결재가 말한다(J-7 · 확정이 그것을 보고 막는다).
   * ⭐ 사유 원문은 결재의 `reason` 에 담는다 — `shipment.cancellation_reason_code` 는 «코드» 칸이라 축이
   *   다르고, 그 칸은 NULL 로 둔다(I-5 R-1 과 같은 판정 · 통보 220 ⓐ).
   */
  async requestCancel(
    shipmentId: number,
    version: number,
    body: ShipmentCancelRequestBody,
    appUserId: number,
  ): Promise<{ versionNo: number; shipment: ShipmentDetailView }> {
    // ⛔ 채번은 트랜잭션을 «열기 전»이다 — 롤백이 번호를 되돌리면 재시도가 같은 번호를 뽑는다.
    const approvalRequestNo = await this.numbering.next(
      APPROVAL_DOCUMENT_TYPE,
      null,
      new Date().toISOString().slice(0, 10),
    );
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockShipment(tx, shipmentId);
      if (locked === undefined) throw new NotFoundException('없는 출하입니다.');
      assertUnsettled(locked, '취소를 요청할 수 없습니다');
      // ⭐ 재상신을 코어보다 «먼저» 막는다 — 코어 `assertNoOpenRequest` 는 400 `APPROVAL_IN_PROGRESS` 를
      //    내지만 이 오퍼레이션의 계약은 409 계열 `CANCEL_IN_PROGRESS` 다(통보 220 ⓓ · 확정과 같은 코드).
      if (await hasOpenCancel(tx, locked.shipment_id)) {
        throw new ConflictException('user', '취소 결재가 이미 진행 중입니다.', {
          code: CONFLICT_CODE.CANCEL_IN_PROGRESS,
        });
      }
      assertVersion(locked, version);
      await this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: CANCEL_APPROVAL_TYPE,
        targetTypeCode: SHIPMENT_TARGET,
        targetId: locked.shipment_id,
        // ⚠ 출하에서 사업부를 파생할 축이 계약에 없다 — 공통본이다(문의 022 와 같은 자리).
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason: body.reason,
      });
    });
    const { view, versionNo } = await this.queries.get(shipmentId);
    return { versionNo, shipment: view };
  }

  /**
   * 승인 뒤 실행 — 역전기 · 전표 상태 · 예약 되돌림 · 롤업 되돌림 · 출하 상태가 한 트랜잭션이다.
   *
   * ⭐ **영업일은 원 트랜잭션의 것이다** — 코어 `reverse()` 의 규약이고(PK 가 `(id, business_date)` 복합)
   *   문의 032 의 우리 권고(ⓑ)와 같다. ⛔ 본문 `businessDate` 가 원 영업일과 달라도 «거절하지 않는다» —
   *   결재가 자정을 넘는 본길(상신 1일 · 승인·실행 2일)을 400 으로 죽이게 된다(R-8). 그 칸의 뜻은
   *   문의 032 가 닫을 때까지 받고 쓰지 않는다.
   * ⛔ `remarks` 도 받고 버린다 — 갈 칸이 등록 비고 하나뿐이라 덧붙이면 그것을 조용히 덮는다(통보 220 ⓑ).
   */
  async cancel(
    shipmentId: number,
    version: number,
    body: ShipmentCancelBody,
    appUserId: number,
  ): Promise<{ versionNo: number; shipment: ShipmentDetailView }> {
    const occurredAt = new Date(body.occurredAt);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockShipment(tx, shipmentId);
      if (locked === undefined) throw new NotFoundException('없는 출하입니다.');
      // ⭐ J-8 — 「승인만으로 통과시키지 않는다 — 그 사이 확정됐으면 409」. 상태가 판 번호보다 앞이다.
      assertUnsettled(locked, '취소할 수 없습니다');
      assertVersion(locked, version);
      await assertCancelApproved(tx, locked.shipment_id);
      const transition = this.documentState.assertTransition(STATUS_COLUMN, CANCEL_ACTION, locked.status_code);

      // ⭐⭐ **역전기 순서가 거꾸로다**(§3-6 ⓕ) — 출고 역(+q)이 먼저, 입고 역(−q)이 나중이다.
      //    긴급 직행이면 입고분이 잔액을 세웠고 출고가 그것을 깎았다. 뒤집으면 입고 역이 0 에서 −q 를
      //    내려 코어가 거부한다. 평시는 입고가 없어 출고 역 하나다.
      const issue = await tx.goods_issue.findFirst({
        where: { source_document_type_code: SHIPMENT_TARGET, source_document_id: locked.shipment_id },
        select: { goods_issue_id: true },
      });
      if (issue === null) {
        throw new Error(`출하에 출고 전표가 없다 — 등록이 전기를 안 했다: ${locked.shipment_no}`);
      }
      await this.reverseOne(tx, 'GOODS_ISSUE', issue.goods_issue_id, occurredAt, appUserId);
      const receipt = await tx.goods_receipt.findFirst({
        where: { source_document_type_code: SHIPMENT_TARGET, source_document_id: locked.shipment_id },
        select: { goods_receipt_id: true },
      });
      if (receipt !== null) {
        await this.reverseOne(tx, 'GOODS_RECEIPT', receipt.goods_receipt_id, occurredAt, appUserId);
      }

      // ⛔ 전표 상태를 안 내리면 다형 취소 목록에 «살아 있는» 출고·입고로 남는다.
      await tx.goods_issue.update({
        where: { goods_issue_id: issue.goods_issue_id },
        data: { status_code: DOCUMENT_CANCELLED, version_no: { increment: 1 } },
      });
      if (receipt !== null) {
        await tx.goods_receipt.update({
          where: { goods_receipt_id: receipt.goods_receipt_id },
          data: { status_code: DOCUMENT_CANCELLED, version_no: { increment: 1 } },
        });
      }

      await releaseShipmentReservations(tx, locked);
      await rollBackShippedQty(tx, locked.shipment_id);

      await tx.shipment.update({
        where: { shipment_id: locked.shipment_id },
        data: {
          status_code: transition.to,
          cancelled_at: occurredAt,
          cancelled_by: BigInt(appUserId),
          updated_by: BigInt(appUserId),
          version_no: { increment: 1 },
        },
      });
    });
    const { view, versionNo } = await this.queries.get(shipmentId);
    return { versionNo, shipment: view };
  }

  /**
   * 원 원장 «한 건»을 되돌린다. ⛔ 0행·2행+ 는 조용히 넘기지 않고 500 이다 — 출하 등록은 전표마다
   * 원장을 정확히 하나 세운다. ⛔ `alreadyReversed` 도 던진다 — 취소된 출하는 상태 검사가 막으므로
   * 여기서 이미 되돌려져 있으면 상태 잠금이 뚫린 것이다.
   */
  private async reverseOne(
    tx: Tx,
    typeCode: CancelableDocument,
    documentId: bigint,
    occurredAt: Date,
    appUserId: number,
  ): Promise<void> {
    const rows = await tx.inventory_transaction.findMany({
      where: { source_document_type_code: typeCode, source_document_id: documentId, reversal_of_transaction_id: null },
      select: { inventory_transaction_id: true, business_date: true },
    });
    if (rows.length !== 1) {
      throw new Error(`${typeCode}/${documentId} 의 원장이 ${rows.length} 행이다 — 정확히 하나여야 한다.`);
    }
    const reversed = await this.posting.reverse(tx, {
      inventoryTransactionId: rows[0].inventory_transaction_id,
      businessDate: rows[0].business_date.toISOString().slice(0, 10),
      occurredAt,
      createdBy: appUserId,
    });
    if (reversed.alreadyReversed) {
      throw new Error(`${typeCode}/${documentId} 는 이미 되돌려졌다 — 상태 잠금을 지나쳤다.`);
    }
  }
}

/** 확정·취소된 출하는 어떤 취소도 받지 않는다 — 계약 「미확정 구간에서만 된다」 · J-8. */
function assertUnsettled(locked: LockedShipment, action: string): void {
  if (locked.status_code === CANCELLED) {
    throw new ConflictException('user', `이미 취소된 출하라 ${action}.`, { code: CONFLICT_CODE.INVALID_STATE });
  }
  if (locked.status_code === CONFIRMED) {
    throw new ConflictException('user', `확정된 출하라 ${action} — 확정 취소 경로가 없습니다.`, {
      code: CONFLICT_CODE.ALREADY_CONFIRMED,
    });
  }
}

/**
 * ⭐⭐ **승인 게이트를 자기 손으로 건다.** 코어 `assertApproved` 는 **요청이 0건이면 통과**한다(출고
 * 계약이 승인을 안 탄 전표를 인정해서다). 다형 취소는 `CANCEL_REQUESTED` 상태 자물쇠가 그 빈틈을
 * 막는데, 출하에는 그 상태가 없다 ⇒ 코어를 부르면 **상신도 안 한 취소가 그대로 실행된다.**
 */
async function assertCancelApproved(tx: Tx, shipmentId: bigint): Promise<void> {
  const requests = await tx.approval_request.findMany({
    where: { target_type_code: SHIPMENT_TARGET, target_id: shipmentId, approval_type_code: CANCEL_APPROVAL_TYPE },
    select: { status_code: true },
  });
  if (requests.some((row) => row.status_code === 'APPROVED')) return;
  const code = requests.some((row) => row.status_code === 'PENDING')
    ? ERROR_CODE.APPROVAL_IN_PROGRESS
    : ERROR_CODE.APPROVAL_REQUIRED;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code, message: '승인된 취소 결재가 없습니다.' },
  ]);
}

/**
 * ⭐ **예약 되돌림**(통보 212 · 코어 `releaseReservation` — 소진분을 풀린 것으로 옮긴다).
 * ⚠ 출하 배분 → 예약으로 가는 링크 칸이 물리에 **0개**다(R-13) ⇒ `(지시 라인, LOT)` 로 찾고
 *   `inventory_reservation_id` 순으로 **소진분이 남은 행부터** 배분 수량을 나눠 푼다(한 라인·LOT 에 예약이
 *   둘일 수 있다). ⚠ 예약이 없는 배분(긴급 직행 · 예약 없이 피킹된 재고)은 되돌릴 것이 없다.
 */
async function releaseShipmentReservations(tx: Tx, shipment: LockedShipment): Promise<void> {
  const allocations = await tx.shipment_lot_allocation.findMany({
    where: { shipment_line: { shipment_id: shipment.shipment_id } },
    orderBy: { shipment_lot_allocation_id: 'asc' },
    select: {
      lot_id: true,
      allocated_qty: true,
      shipment_line: { select: { shipment_request_line_id: true, item_id: true } },
    },
  });
  for (const allocation of allocations) {
    let remaining = new Prisma.Decimal(allocation.allocated_qty);
    const reservations = await tx.inventory_reservation.findMany({
      where: {
        source_document_type_code: SHIPMENT_REQUEST_LINE,
        source_document_id: allocation.shipment_line.shipment_request_line_id,
        lot_id: allocation.lot_id,
        consumed_qty: { gt: 0 },
      },
      orderBy: { inventory_reservation_id: 'asc' },
      select: { inventory_reservation_id: true, consumed_qty: true },
    });
    for (const reservation of reservations) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const take = Prisma.Decimal.min(new Prisma.Decimal(reservation.consumed_qty), remaining);
      await releaseReservation(tx, reservation.inventory_reservation_id, allocation.shipment_line.item_id, take, RELEASE_FIELD);
      remaining = remaining.minus(take);
    }
  }
}

/** 등록이 올린 롤업 둘을 같은 양 내린다 — 지시 라인과 (있으면) 수주 라인. */
async function rollBackShippedQty(tx: Tx, shipmentId: bigint): Promise<void> {
  const lines = await tx.shipment_line.findMany({
    where: { shipment_id: shipmentId },
    select: { shipment_request_line_id: true, shipped_qty: true },
  });
  for (const line of lines) {
    const updated = await tx.shipment_request_line.update({
      where: { shipment_request_line_id: line.shipment_request_line_id },
      data: { shipped_qty: { decrement: line.shipped_qty }, version_no: { increment: 1 } },
      select: { sales_order_line_id: true },
    });
    if (updated.sales_order_line_id === null) continue;
    await tx.sales_order_line.update({
      where: { sales_order_line_id: updated.sales_order_line_id },
      data: { shipped_qty: { decrement: line.shipped_qty }, version_no: { increment: 1 } },
    });
  }
}
