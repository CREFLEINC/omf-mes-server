import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { DocumentStateService } from '../../core/document-state';
import { LotLifecycleService, Tx, WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { IF_WO_CLOSE, OutboxService, outboxMessageKey } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderClose, assertCloseBody, closePayload } from './close-rules';
import { judgeCompletion } from './completion';
import { ACTIVE_RESULT_WHERE } from './work-order-progress';
import { assertVersion, lockWorkOrder } from './work-order-write.service';

const STATUS_COLUMN = 'production.work_order.status_code';
const CLOSE_ACTION = 'work-order-close';
const VARIANCE_REASON_GROUP = 'WORK_ORDER_COMPLETION_VARIANCE_REASON';
/** 아웃박스 대상 유형(승인 다형 축) — 시드 `INTERFACE_TARGET` 이 열려 있다(I-6 §1-6). */
const WORK_ORDER_TARGET = 'WORK_ORDER';
// 계약 LotLifecycleHistoryEvent.sourceDocumentTypeCode enum — L2 는 WORK_ORDER_CLOSING(L3 취소만 WORK_ORDER)
const WORK_ORDER_CLOSING_DOCUMENT = 'WORK_ORDER_CLOSING';

/**
 * W/O 마감 + 미달 슬롯 자동 폐번 + ERP 실적 아웃박스 적재. 순서는 §5-1 그대로다.
 * ⛔ 이월 W/O 를 만들지 않는다 — 계약이 ⌜이월이 잔량 W/O 를 «자동으로» 만드는지는 아직
 *    정해지지 않았다⌝ 라 스스로 적었다. 승인도 부르지 않고(§5-7) `operation_policy` 도
 *    읽지 않는다(미달 경계용 키가 없다 · §5-3).
 */
@Injectable()
export class WorkOrderCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly lots: LotLifecycleService,
    private readonly outbox: OutboxService,
  ) {}

  async close(workOrderId: number, version: number, body: WorkOrderClose, appUserId?: number): Promise<void> {
    // 코드값 대조는 트랜잭션 «밖»이다 — 잠글 필요가 없는 마스터 조회다(형제 선례).
    await assertCodeValues(this.prisma, [
      { field: 'reasonCode', value: body.reasonCode, groupCode: VARIANCE_REASON_GROUP },
    ]);
    await this.prisma.$transaction((tx) => this.commit(tx, workOrderId, version, body, appUserId));
  }

  private async commit(
    tx: Tx,
    workOrderId: number,
    version: number,
    body: WorkOrderClose,
    appUserId: number | undefined,
  ): Promise<void> {
    const locked = await lockWorkOrder(tx, workOrderId);
    assertVersion(locked, version);
    // ⭐ 열린 세션 검사가 전이 검사보다 «먼저»다 — 계약이 이 자리에만 409 봉투를 지정했고,
    //    전이가 먼저 걸리면 진행 중인 W/O 가 400 을 받아 화면이 띄울 문구를 잃는다(§5-1).
    await assertNoOpenSession(tx, workOrderId);

    const goodSum = await goodQty(tx, workOrderId);
    const judgment = judgeCompletion(goodSum, locked.order_qty);
    assertCloseBody(judgment, body);
    // ⛔ 400 이다 — 409 는 If-Match 저장 충돌이 쓴다(§1-6).
    const transition = this.documentState.assertTransition(STATUS_COLUMN, CLOSE_ACTION, locked.status_code, HttpStatus.BAD_REQUEST);

    const closedAt = new Date();
    // ⛔ `closed_at` 을 찍는 UPDATE 는 **한 번뿐**이다 — `trg_work_order_closed_immutable` 이
    //    `OLD.closed_at IS NOT NULL` 인 UPDATE 를 막아 두 번째가 500 이 된다. 뒤에 오는
    //    폐번·적재는 다른 표라 괜찮다. `completed_at` 은 실적 축(I-7)이 찍는 칸이라 안 건드린다.
    const row = await tx.work_order.update({
      where: { work_order_id: BigInt(workOrderId) },
      data: {
        status_code: transition.to,
        closed_at: closedAt,
        completion_variance_reason_code: body.reasonCode ?? null,
        close_disposition_code: body.remainderDispositionCode ?? null,
        ...(body.remarks === undefined ? {} : { remarks: body.remarks }),
        updated_by: appUserId ?? null,
        version_no: { increment: 1 },
      },
      select: { work_order_no: true, item_id: true },
    });

    await this.voidEmptySlots(tx, workOrderId, closedAt);
    await this.outbox.enqueue(tx, {
      interfaceCode: IF_WO_CLOSE,
      messageKey: outboxMessageKey(IF_WO_CLOSE, row.work_order_no),
      targetTypeCode: WORK_ORDER_TARGET,
      targetId: BigInt(workOrderId),
      payload: closePayload({
        workOrderId,
        workOrderNo: row.work_order_no,
        itemId: Number(row.item_id),
        orderQty: locked.order_qty.toNumber(),
        goodQty: goodSum.toNumber(),
        completionJudgmentCode: judgment,
        closedAt,
        erpSendItems: body.erpSendItems ?? [],
      }),
    });
  }

  /** L2 — ⌜실적이 없는 슬롯만⌝(R82). `PreIssuedLotSummary.withResultCount` 와 «같은» EXISTS 다. */
  private async voidEmptySlots(tx: Tx, workOrderId: number, changedAt: Date): Promise<void> {
    const slots = await tx.lot.findMany({
      where: {
        source_type_code: WORK_ORDER_LOT_SOURCE,
        source_id: BigInt(workOrderId),
        lifecycle_status_code: 'WAITING',
        production_result_lot_allocation: { none: {} },
      },
      select: { lot_id: true },
    });
    if (slots.length === 0) return;
    await this.lots.moveWithin(tx, {
      lotIds: slots.map((slot) => slot.lot_id),
      action: CLOSE_ACTION,
      sourceDocumentTypeCode: WORK_ORDER_CLOSING_DOCUMENT,
      sourceDocumentId: BigInt(workOrderId),
      changedAt,
    });
  }
}

/**
 * ⭐ 「열린」 세션은 `ended_at IS NULL` 이다 — `status_code` 가 아니다. 계약 `:hold` 가
 * ⌜중단해도 세션은 열려 있다(**ended_at 이 빈 채**)⌝ 로 그 칸을 정의했으므로 `STOPPED`
 * 세션도 열린 것이다(§5-5).
 */
async function assertNoOpenSession(tx: Tx, workOrderId: number): Promise<void> {
  const open = await tx.work_session.findFirst({
    where: { work_order_id: BigInt(workOrderId), ended_at: null },
    select: { work_session_id: true },
  });
  if (open === null) return;
  throw new ConflictException('user', '열린 작업 세션이 있어 마감할 수 없습니다.', { code: ERROR_CODE.OPEN_SESSION_EXISTS });
}

/**
 * 누적 양품. ⛔ `status_code` 로 **거르지 않는다** — `PRODUCTION_RESULT_STATUS` 그룹이
 * 폐기돼 거를 값이 없다. 대신 정정된 원본을 합에서 «뺀다» — 정정본은 대체값이고 잎만
 * 센다(I-7 §5-3). 조회(`progressOf` 의 `goodQty`)와 «같은» `ACTIVE_RESULT_WHERE` 를 써야
 * 마감이 다른 값을 내지 않는다.
 */
async function goodQty(tx: Tx, workOrderId: number): Promise<Prisma.Decimal> {
  const sums = await tx.production_result.aggregate({
    where: { work_order_id: BigInt(workOrderId), ...ACTIVE_RESULT_WHERE },
    _sum: { good_qty: true },
  });
  return sums._sum.good_qty ?? new Prisma.Decimal(0);
}
