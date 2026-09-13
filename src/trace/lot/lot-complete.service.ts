import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { recordTerminalWorkerAudit, type TerminalWorkerAuditActor } from '../../audit/terminal-worker-audit';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues, assertWorkerNoPresent } from '../../common/master';
import { Tx, WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { COMPLETION_REASON, assertCompletionReason } from './lot-rules';
import { lotProgress } from './lot-progress';
import { LotView, lotView } from './lot-view';

/** `:complete` 의 사유 코드가 대조되는 그룹 — 시드에 6값이 있다(`work-order-close.service.ts:17` 과 같은 축). */
const VARIANCE_REASON_GROUP = 'WORK_ORDER_COMPLETION_VARIANCE_REASON';

/** 계약 `LotComplete` — required 2. 나머지 둘은 nullable 선택이다. */
export interface LotComplete {
  businessDate: string;
  occurredAt: string;
  completionVarianceReasonCode?: string | null;
  remarks?: string | null;
}

/** 본문 밖에서 오는 것. `version`(If-Match)은 **선택** — 없으면 대조를 건너뛴다(C-9). */
export interface LotCompleteContext {
  workerNo: string | undefined;
  version: number | undefined;
  appUserId: number | undefined;
  terminalAudit?: Omit<TerminalWorkerAuditActor, 'workerId'>;
}

/**
 * 생산 LOT 완료(I-7 PR ④).
 *
 * ⛔ **어느 상태 칸도 안 옮긴다.** `LOT_LIFECYCLE_STATUS` 3값(`WAITING`·`ACTIVE`·`VOIDED`)과
 * `LOT_LIFECYCLE_TRANSITION` 3값(L1·L2·L3) 어디에도 「완료」가 없다 — 설계가
 * ⌜완료·미달 마감은 `lot.status_code` 의 값이 «아니다» … **완료는 시각 필드가 담고 미달
 * 여부는 사유 유무로 갈린다**⌝ 로 이미 답했다(`P-02-06` §5-5 · 공유계약 §I-32). 그래서
 * `completed_at` 한 칸과 (미달일 때) W/O 사유 한 칸이 결과의 전부이고
 * `lot_lifecycle_history` 도 쓰지 않는다(`transition_code` 가 NOT NULL 인데 실을 값이 없다).
 *
 * ⛔ `lot.service.ts` 에 넣지 않는다 — 278줄이라 여기에 +90 이면 파일이 ~300 을 넘는다(R-14).
 */
@Injectable()
export class LotCompleteService {
  constructor(private readonly prisma: PrismaService) {}

  async complete(
    lotId: number,
    body: LotComplete,
    context: LotCompleteContext,
  ): Promise<LotView> {
    assertWorkerNoPresent(context.workerNo);
    // 코드값 대조는 트랜잭션 «밖»이다 — 잠글 필요가 없는 마스터 조회다(형제 `:close` 선례).
    await assertCodeValues(this.prisma, [
      { field: COMPLETION_REASON, value: body.completionVarianceReasonCode, groupCode: VARIANCE_REASON_GROUP },
    ]);
    return this.prisma.$transaction((tx) => this.commit(tx, lotId, body, context));
  }

  private async commit(
    tx: Tx,
    lotId: number,
    body: LotComplete,
    context: LotCompleteContext,
  ): Promise<LotView> {
    const locked = await lockLot(tx, lotId);
    // 계약이 ⌜**생산** LOT 을 완료로 옮긴다⌝ 라 적었다 — 자재·재생재 LOT 은 대상이 아니다.
    if (locked.source_type_code !== WORK_ORDER_LOT_SOURCE) {
      throw one(field('lotId', ERROR_CODE.INVALID, '생산 LOT 만 완료할 수 있습니다.'));
    }
    // 멱등 키가 다르면 재전송이 아니다 — 두 번 완료하지 않는다.
    if (locked.completed_at !== null) {
      throw one(field('lotId', ERROR_CODE.STATE_LOCKED, '이미 완료된 LOT 입니다.'));
    }
    // ⛔ 봉투에 `code` 를 안 싣는다 — I-7 7건 중 이 하나만 «일반» `ConflictResponse` 다(01 계약 · §8-4).
    if (context.version !== undefined && locked.version_no !== context.version) {
      throw new ConflictException('user', '다른 사용자가 먼저 저장했습니다. 다시 불러온 뒤 저장하세요.');
    }

    const allocated = await allocatedSum(tx, lotId);
    // 누적 0 = 배분 0건(`WAITING`)이다. 안 막으면 대기 슬롯이 `completed_at` 을 얻고 마감 L2 가
    // 그 행을 폐번해 「완료된 폐번 LOT」이 남는다(`P-02-06` §6 · R-7).
    if (allocated.isZero()) {
      throw one(field('lotId', ERROR_CODE.STATE_LOCKED, '실적이 배분되지 않은 LOT 은 완료할 수 없습니다.'));
    }
    const progress = lotProgress(locked.initial_qty, allocated);
    assertCompletionReason(progress.completionJudgmentCode, body.completionVarianceReasonCode);
    if (progress.completionJudgmentCode === 'UNDER') {
      await recordVarianceReason(tx, locked.source_id, body.completionVarianceReasonCode as string);
    }

    const updated = await tx.lot.update({
      where: { lot_id: BigInt(lotId) },
      data: {
        // ⛔ `businessDate` 는 받아서 형식만 보고 «저장하지 않는다» — 원장을 안 지나므로 실을 칸이 없다(대기 15).
        completed_at: new Date(body.occurredAt),
        ...(body.remarks === undefined ? {} : { remarks: body.remarks }),
        updated_by: context.appUserId ?? null,
        // `PUT /trace/lots/{lotId}` 가 같은 행의 If-Match 를 쓴다 — 행이 바뀌었으니 토큰도 옮긴다.
        version_no: { increment: 1 },
      },
      include: { lot_hold: true },
    });
    if (context.terminalAudit !== undefined) {
      const worker = await tx.worker.findUnique({ where: { worker_no: context.terminalAudit.workerNo },
        select: { worker_id: true } });
      if (!worker) throw new UnauthorizedException('작업자를 찾을 수 없습니다.');
      await recordTerminalWorkerAudit(tx, {
        actor: { ...context.terminalAudit, workerId: worker.worker_id },
        targetTypeCode: 'LOT', targetId: updated.lot_id, eventTypeCode: 'COMPLETED',
      });
    }
    return lotView(updated);
  }
}

interface LockedLot {
  initial_qty: Prisma.Decimal;
  source_type_code: string;
  source_id: bigint;
  completed_at: Date | null;
  version_no: number;
}

/** ⛔ `SELECT … FOR UPDATE` — 읽고 판정하고 쓰는 사이에 같은 LOT 이 완료되면 재완료 게이트가 옛 값을 본다. */
async function lockLot(tx: Tx, lotId: number): Promise<LockedLot> {
  const rows = await tx.$queryRaw<LockedLot[]>`
    SELECT initial_qty, source_type_code, source_id, completed_at, version_no
      FROM trace.lot
     WHERE lot_id = ${BigInt(lotId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 LOT 입니다.');
  return rows[0];
}

/** ⛔ `production_result.good_qty` 의 합이 «아니다» — 그건 W/O 축이다(§3-3). */
async function allocatedSum(tx: Tx, lotId: number): Promise<Prisma.Decimal> {
  const sum = await tx.production_result_lot_allocation.aggregate({
    where: { lot_id: BigInt(lotId) },
    _sum: { allocated_qty: true },
  });
  return sum._sum.allocated_qty ?? new Prisma.Decimal(0);
}

/**
 * 미달 사유는 **W/O 가 담는다** — `trace.lot` 에 LOT 단위 칸이 아직 없다(계약 x-internal-note
 * ⌜B-13 이 미충족이다⌝ · 문의 043). ⛔ `src/production/**` 의 service 를 부르지 않고 Prisma 로
 * 직접 쓴다(도메인 간 service 호출 금지 · `server-architecture.md:67`).
 */
async function recordVarianceReason(tx: Tx, workOrderId: bigint, reasonCode: string): Promise<void> {
  const workOrder = await tx.work_order.findUnique({
    where: { work_order_id: workOrderId },
    select: { closed_at: true },
  });
  if (workOrder === null) throw one(field('lotId', ERROR_CODE.INVALID, '원천 작업지시가 없습니다.'));
  // ⭐ 트리거 `trg_work_order_closed_immutable`(BEFORE UPDATE · `OLD.closed_at IS NOT NULL` 이면
  //    RAISE)을 앞당겨 400 으로 막는다 — 그냥 두면 500 이 샌다. 정상·초과는 여기 오지 않으므로
  //    마감된 W/O 의 LOT 이라도 통과한다.
  if (workOrder.closed_at !== null) {
    throw one(field('lotId', ERROR_CODE.STATE_LOCKED, '마감된 작업지시의 LOT 은 미달로 완료할 수 없습니다.'));
  }
  // ⛔ `status_code` 도 `version_no` 도 안 건드린다 — 옮기는 것은 사유 한 칸뿐이다(§3-3).
  await tx.work_order.update({
    where: { work_order_id: workOrderId },
    data: { completion_variance_reason_code: reasonCode },
  });
}
