import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertWorkerNoExists } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderNotifier } from '../work-order/work-order-notice';
import { VERSION_CONFLICT } from '../work-order/work-order-write.service';
import { assertNotEnded } from './work-session-rules';
import { EVENT_TYPE } from './work-session.constants';
import { WorkSessionContext } from './work-session.service';
import { WorkSessionView, workSessionView } from './work-session-view';
type Tx = Prisma.TransactionClient;
type LockedSession = { started_at: Date; status_code: string; version_no: number };
const STATUS_COLUMN = 'production.work_session.status_code';
const END_ACTION = 'work-session-end';
/** 계약 `WorkSessionEnd` — required 하나. `stopReasonCode` 는 받되 저장하지 않는다. */
export interface WorkSessionEnd {
  endedAt: string;
  stopReasonCode?: string;
}
/** 계약 `WorkSessionForceEnd`(장부 P-104) — 사유는 자유 텍스트, 필수(1~500 은 계약 검증이 본다). */
export interface WorkSessionForceEnd {
  reason: string;
}
const FORCE_END = 'FORCE_END';
/**
 * 세션 닫기(§4). ⛔ `work_order` 무변경 — 세션 층과 W/O 층은 다르고 W/O 는 `:close` 가 닫는다.
 * ⛔ `terminal_process` 게이팅을 안 건다(계약이 이 자리에 `can_*` 를 안 적었다 · R-5).
 * 남은 참여자는 종료 시각으로 닫는다 — 주작업자는 작업 중에 떠날 수 없어 여기서만 닫히고, 공수가 종료에서 멈춘다.
 */
@Injectable()
export class WorkSessionEndService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly notifier: WorkOrderNotifier,
  ) {}
  async end(
    workSessionId: number,
    body: WorkSessionEnd,
    context: Omit<WorkSessionContext, 'idempotencyKey'>,
  ): Promise<WorkSessionView> {
    await assertWorkerNoExists(this.prisma, context.workerNo);
    return this.prisma.$transaction(async (tx: Tx) => {
      const locked = await lockSession(tx, workSessionId);
      // 이미 ENDED 면 400 `STATE_LOCKED` — 재로드해도 풀리지 않는다. 버전 대조보다 먼저다: 강제 종료가 버전을 올려
      // 단말의 옛 토큰이 409 를 받으면 「다시 불러 재시도」로 읽혀 끝나지 않는 재시도가 된다.
      assertNotEnded(locked.status_code);
      // If-Match 가 없으면 대조를 건너뛴다 — 큐에 쌓인 요청은 토큰을 싣지 않는다(C-9).
      if (context.version !== undefined && locked.version_no !== context.version) {
        assertUpdated(0, 'user', { code: VERSION_CONFLICT });
      }
      const transition = this.documentState.assertTransition(
        STATUS_COLUMN, END_ACTION, locked.status_code, HttpStatus.BAD_REQUEST,
      );
      const endedAt = new Date(body.endedAt);
      // ⛔ CHECK `ck_work_session_dates` 를 앞당긴다 — 위반이 `PrismaClientUnknownRequestError`
      //    라 공용 그물에 안 걸린다.
      if (endedAt < locked.started_at) throw one(field('endedAt', ERROR_CODE.RANGE, '시작 시각보다 앞설 수 없습니다.'));
      return this.closeSession(tx, workSessionId, endedAt, transition.to, context.appUserId, {
        event_type_code: EVENT_TYPE.END,
        // `terminal_id` 는 토큰이 오면 채우고 없으면 비운다 — 게이팅은 안 건다(R-1 C).
        terminal_id: context.terminalId,
      }, context.workerNo);
    });
  }

  /**
   * 관리웹 강제 종료(장부 P-104) — 다른 단말에 열린 세션이 마감을 막을 때 관리자가 닫는다.
   * `:end` 와 다른 점: 시각은 서버 수신 시각(현장 시각이 없다) · 어느 단말 세션이든 · 사유 필수 ·
   * 사건 `FORCE_END` 에 계정·사유가 남는다(누가·언제·왜). 남은 참여자를 닫는 것과 알림은 같다.
   * ⚠ 세션만 닫는다 — 중단(SUSPENDED)된 W/O 는 그대로다.
   */
  async forceEnd(workSessionId: number, body: WorkSessionForceEnd, appUserId: number): Promise<WorkSessionView> {
    if (body.reason.trim() === '') {
      throw one(field('reason', ERROR_CODE.REQUIRED, '강제 종료 사유를 입력하세요 — 누가 왜 세션을 닫았는지 기록으로 남습니다.'));
    }
    return this.prisma.$transaction(async (tx: Tx) => {
      const locked = await lockSession(tx, workSessionId);
      if (locked.status_code === 'ENDED') {
        throw new ContractException(HttpStatus.BAD_REQUEST, [{
          scope: 'screen', code: ERROR_CODE.STATE_LOCKED,
          message: '이미 종료된 작업 세션입니다. 작업 세션 목록을 새로 고쳐 확인하세요.',
        }]);
      }
      const transition = this.documentState.assertTransition(
        STATUS_COLUMN, END_ACTION, locked.status_code, HttpStatus.BAD_REQUEST,
      );
      // 서버 시계가 단말 시작 시각보다 늦게 가면 CHECK `ck_work_session_dates` 에 걸린다 — 시작 시각으로 맞춘다.
      const now = new Date();
      const endedAt = now < locked.started_at ? locked.started_at : now;
      return this.closeSession(tx, workSessionId, endedAt, transition.to, appUserId, {
        event_type_code: FORCE_END,
        terminal_id: null,
        remarks: body.reason,
      });
    });
  }

  /** 세션 행·남은 참여자·사건·알림 — 종료와 강제 종료가 같은 순서로 닫는다. */
  private async closeSession(
    tx: Tx,
    workSessionId: number,
    endedAt: Date,
    statusTo: string,
    appUserId: number | undefined,
    event: { event_type_code: string; terminal_id: bigint | null; remarks?: string },
    workerNo?: string,
  ): Promise<WorkSessionView> {
    const row = await tx.work_session.update({
      where: { work_session_id: BigInt(workSessionId) },
      // ⛔ `stop_reason_code` 무변경 — 계약이 「비우기로 정했다」(A-21·A-25). 본문에 와도
      //    저장하지 않고 400 도 내지 않는다(I-6 `:hold` 선례).
      data: {
        ended_at: endedAt,
        status_code: statusTo,
        version_no: { increment: 1 },
        updated_by: appUserId ?? null,
      },
    });
    // 종료 뒤에 참여한 행이 있어도 참여 시각보다 앞서 닫지 않는다(`ck_work_session_worker_dates`).
    await tx.$executeRaw`
      UPDATE production.work_session_worker
         SET left_at = GREATEST(joined_at, ${endedAt})
       WHERE work_session_id = ${row.work_session_id} AND left_at IS NULL`;
    await tx.work_session_event.create({
      data: {
        ...event,
        work_session_id: row.work_session_id,
        occurred_at: endedAt,
        performed_by: appUserId === undefined ? null : BigInt(appUserId),
      },
    });
    // 양품은 종료 시점까지의 W/O 누계 스냅샷이다 — 최종값은 마감 알림이 싣는다(research R-13).
    await this.notifier.notify(tx, 'WORK_SESSION_ENDED', row.work_order_id, endedAt, {
      appUserId, workerNo, quantities: {},
    });
    return workSessionView(row);
  }
}
/** ⛔ `SELECT … FOR UPDATE` — 읽고 판정하고 쓰는 사이에 다른 요청이 상태를 옮기면 안 된다. */
async function lockSession(tx: Tx, workSessionId: number): Promise<LockedSession> {
  const rows = await tx.$queryRaw<LockedSession[]>`
    SELECT started_at, status_code, version_no
      FROM production.work_session
     WHERE work_session_id = ${BigInt(workSessionId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 작업 세션입니다.');
  return rows[0];
}
