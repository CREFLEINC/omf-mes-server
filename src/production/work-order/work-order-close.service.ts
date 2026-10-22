import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, OpenSessionView } from '../../common/errors';
import { assertCodeValues, resolveWorkerId } from '../../common/master';
import { DocumentStateService } from '../../core/document-state';
import { LotLifecycleService, Tx, WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { IF_WO_CLOSE, OutboxService, outboxMessageKey } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderClose, assertCloseBody, closePayload } from './close-rules';
import { judgeCompletion } from './completion';
import { WorkOrderNotifier } from './work-order-notice';
import { WORK_SESSION_DISPLAY_INCLUDE } from '../work-session/work-session-view';
import { ACTIVE_RESULT_WHERE } from './work-order-progress';
import { assertVersion, lockWorkOrder } from './work-order-write.service';

const STATUS_COLUMN = 'production.work_order.status_code';
const CLOSE_ACTION = 'work-order-close';
const VARIANCE_REASON_GROUP = 'WORK_ORDER_COMPLETION_VARIANCE_REASON';
/** 아웃박스 대상 유형(승인 다형 축) — 시드 `INTERFACE_TARGET` 이 열려 있다(I-6 §1-6). */
const WORK_ORDER_TARGET = 'WORK_ORDER';
// 계약 LotLifecycleHistoryEvent.sourceDocumentTypeCode enum — L2 는 WORK_ORDER_CLOSING(L3 취소만 WORK_ORDER)
const WORK_ORDER_CLOSING_DOCUMENT = 'WORK_ORDER_CLOSING';
/** 마감할 수 없는 상태마다 할 일 — 상태 이름만 알려 주면 화면이 무엇을 할지 모른다. */
const NOT_CLOSABLE: Record<string, string> = {
  PLANNED: '편성 상태입니다. 배포·작업 시작 전의 W/O 는 마감하지 않고 취소합니다.',
  CONFIRMED: '확정 상태입니다. 배포·작업 시작 전의 W/O 는 마감하지 않고 취소합니다.',
  RELEASED: '배포 상태입니다. 작업을 시작한 적 없는 W/O 는 마감하지 않고 취소합니다.',
  CLOSED: '이미 마감된 W/O 입니다. 목록을 새로 고쳐 확인하세요.',
  CANCELLED: '취소된 W/O 입니다. 목록을 새로 고쳐 확인하세요.',
};

/** 마감한 사람 — 관리웹은 계정, POP 은 단말 작업자(`X-Worker-No`)다. */
export interface WorkOrderCloseActor {
  appUserId?: number;
  workerNo?: string;
}

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
    private readonly notifier: WorkOrderNotifier,
  ) {}

  async close(workOrderId: number, version: number, body: WorkOrderClose, actor: WorkOrderCloseActor): Promise<void> {
    // 코드값 대조는 트랜잭션 «밖»이다 — 잠글 필요가 없는 마스터 조회다(형제 선례).
    await assertCodeValues(this.prisma, [
      { field: 'reasonCode', value: body.reasonCode, groupCode: VARIANCE_REASON_GROUP },
    ]);
    // 계정이 없는 요청(단말)만 사번으로 작업자를 푼다 — 관리웹 마감은 계정이 남는다.
    const closedWorkerId = actor.appUserId === undefined ? await resolveWorkerId(this.prisma, actor.workerNo) : null;
    await this.prisma.$transaction((tx) => this.commit(tx, workOrderId, version, body, actor, closedWorkerId));
  }

  private async commit(
    tx: Tx,
    workOrderId: number,
    version: number,
    body: WorkOrderClose,
    actor: WorkOrderCloseActor,
    closedWorkerId: bigint | null,
  ): Promise<void> {
    const { appUserId } = actor;
    const locked = await lockWorkOrder(tx, workOrderId);
    assertVersion(locked, version);
    // ⭐ 열린 세션 검사가 전이 검사보다 «먼저»다 — 계약이 이 자리에만 409 봉투를 지정했고,
    //    전이가 먼저 걸리면 진행 중인 W/O 가 400 을 받아 화면이 띄울 문구를 잃는다(§5-1).
    await assertNoOpenSession(tx, workOrderId);
    // 상태가 본문보다 먼저다 — 마감할 수 없는 W/O 에 「처분을 고르라」를 먼저 보이면 고쳐도 다시 막힌다.
    const transition = this.assertClosable(locked.status_code);

    const goodSum = await goodQty(tx, workOrderId);
    const judgment = judgeCompletion(goodSum, locked.order_qty);
    assertCloseBody(judgment, body, { goodQty: goodSum, orderQty: locked.order_qty });

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
        closed_worker_id: closedWorkerId,
        // 마감 시점 판정 — 조회의 progress 판정은 마감 뒤 지연 실적으로 바뀔 수 있다.
        close_judgment_code: judgment,
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
    // W/O 당 한 번 — 재마감은 `trg_work_order_closed_immutable` 이 막는다. 양품은 위에서 센 합을 쓴다.
    await this.notifier.notify(tx, 'WORK_ORDER_CLOSED', BigInt(workOrderId), closedAt, {
      appUserId, workerNo: actor.workerNo, quantities: { goodQty: goodSum },
    });
  }

  /** ⛔ 400 이다 — 409 는 If-Match 저장 충돌이 쓴다(§1-6). 문구만 상태별 조치로 바꾼다. */
  private assertClosable(statusCode: string) {
    try {
      return this.documentState.assertTransition(STATUS_COLUMN, CLOSE_ACTION, statusCode, HttpStatus.BAD_REQUEST);
    } catch (error) {
      if (!(error instanceof ContractException)) throw error;
      const message = `진행 중이거나 중단된 W/O 만 마감됩니다 — ${NOT_CLOSABLE[statusCode] ?? `${statusCode} 상태입니다. W/O 상태를 확인하세요.`}`;
      throw new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);
    }
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
  const open = await tx.work_session.findMany({
    where: { work_order_id: BigInt(workOrderId), ended_at: null },
    orderBy: [{ started_at: 'asc' }, { work_session_id: 'asc' }],
    include: WORK_SESSION_DISPLAY_INCLUDE,
  });
  if (open.length === 0) return;
  const openSessions: OpenSessionView[] = open.map((row) => {
    const worker = row.work_session_worker[0]?.worker;
    return {
      workSessionId: Number(row.work_session_id),
      terminalId: Number(row.terminal_id),
      terminalCode: row.terminal.terminal_code,
      ...(worker === undefined ? {} : { workerId: Number(worker.worker_id), workerNo: worker.worker_no, workerName: worker.worker_name }),
      startedAt: row.started_at.toISOString(),
      statusCode: row.status_code,
    };
  });
  const first = openSessions[0];
  const who = first.workerName === undefined ? '' : `·${first.workerName}`;
  const more = openSessions.length > 1 ? ` 외 ${openSessions.length - 1}건` : '';
  throw new ConflictException(
    'user',
    `열린 작업 세션이 있어 마감할 수 없습니다(단말 ${first.terminalCode}${who}${more}). ` +
      '그 단말에서 작업을 종료하거나 관리웹에서 작업 세션을 강제 종료한 뒤 다시 마감하세요.',
    { code: ERROR_CODE.OPEN_SESSION_EXISTS, openSessions },
  );
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
