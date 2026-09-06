import { HttpStatus, Injectable } from '@nestjs/common';

import { assertCodeValues, assertNotBlank } from '../../common/master';
import { DocumentStateService } from '../../core/document-state';
import { LotLifecycleService, Tx, WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVersion, lockWorkOrder } from './work-order-write.service';

/** 계약 `WorkOrderCancel` — required 는 `reasonCode` 하나다. */
export interface WorkOrderCancel {
  reasonCode: string;
  /** ⛔ 받되 **버린다** — 담을 칸이 없고 `remarks` 에 덧붙이지도 않는다(§6-1 · 「알려둘 것」). */
  note?: string;
}

const STATUS_COLUMN = 'production.work_order.status_code';
const CANCEL_ACTION = 'work-order-cancel';
const CANCEL_REASON_GROUP = 'WORK_ORDER_CANCEL_REASON';
/** L3 의 `from` — ⌜선발행 슬롯 **전건**⌝(DR-007). 이미 `VOIDED` 인 것은 집합에서 빠진다. */
const PRE_ISSUED = ['WAITING', 'ACTIVE'];
const WORK_ORDER_DOCUMENT = 'WORK_ORDER';

/**
 * W/O 취소 + 선발행 슬롯 전건 폐번. 마감과 «대상 집합이 다르다» — 마감은 실적 없는 슬롯만,
 * 취소는 전건이다(계약이 직접 대비해 적었다).
 * ⛔ `app.document_cancellation` 다형 표를 쓰지 않는다 — 그 표는 `CD-CANCELABLE-DOCUMENT-TYPE`
 *    3값(입하·입고·출고)으로 닫힌 축이고 W/O 는 그 목록에 없다(§6-1).
 * ⛔ 이미 발행된 자재 출고요청을 **건드리지 않는다**(계약도 화면도 침묵 · 문의 038) ·
 *    아웃박스에도 적재하지 않는다(마감만 ERP 로 나간다).
 */
@Injectable()
export class WorkOrderCancelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly lots: LotLifecycleService,
  ) {}

  async cancel(workOrderId: number, version: number, body: WorkOrderCancel, appUserId?: number): Promise<void> {
    assertNotBlank([['reasonCode', body.reasonCode]]);
    await assertCodeValues(this.prisma, [
      { field: 'reasonCode', value: body.reasonCode, groupCode: CANCEL_REASON_GROUP },
    ]);
    await this.prisma.$transaction((tx) => this.commit(tx, workOrderId, version, body, appUserId));
  }

  private async commit(
    tx: Tx,
    workOrderId: number,
    version: number,
    body: WorkOrderCancel,
    appUserId: number | undefined,
  ): Promise<void> {
    const locked = await lockWorkOrder(tx, workOrderId);
    assertVersion(locked, version);
    // ⛔ 400 이다 — `COMPLETED`·`CLOSED` 는 `from` 밖이라 여기서 `STATE_LOCKED` 로 걸린다.
    //    마감된 W/O 가 UPDATE 까지 가면 `trg_work_order_closed_immutable` 이 500 을 낸다.
    const transition = this.documentState.assertTransition(STATUS_COLUMN, CANCEL_ACTION, locked.status_code, HttpStatus.BAD_REQUEST);

    const changedAt = new Date();
    await tx.work_order.update({
      where: { work_order_id: BigInt(workOrderId) },
      // 취소 시각 칸은 없다 — 「누가·언제」는 `updated_by`·`updated_at` 만 남는다(§6-1).
      data: {
        status_code: transition.to,
        cancellation_reason_code: body.reasonCode,
        updated_by: appUserId ?? null,
        version_no: { increment: 1 },
      },
    });

    const slots = await tx.lot.findMany({
      where: {
        source_type_code: WORK_ORDER_LOT_SOURCE,
        source_id: BigInt(workOrderId),
        lifecycle_status_code: { in: PRE_ISSUED },
      },
      select: { lot_id: true },
    });
    if (slots.length === 0) return;
    await this.lots.moveWithin(tx, {
      lotIds: slots.map((slot) => slot.lot_id),
      action: CANCEL_ACTION,
      sourceDocumentTypeCode: WORK_ORDER_DOCUMENT,
      sourceDocumentId: BigInt(workOrderId),
      changedAt,
    });
  }
}
