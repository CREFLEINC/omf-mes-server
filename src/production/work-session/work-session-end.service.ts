import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { VERSION_CONFLICT } from '../work-order/work-order-write.service';
import { EVENT_TYPE } from './work-session.constants';
import { WorkSessionContext, assertWorkerNo } from './work-session.service';
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
/**
 * 세션 닫기(§4). ⛔ `work_order` 무변경 — 세션 층과 W/O 층은 다르고 W/O 는 `:close` 가 닫는다.
 * ⛔ `terminal_process` 게이팅을 안 건다(계약이 이 자리에 `can_*` 를 안 적었다 · R-5) ·
 * ⛔ 참여자의 `left_at` 을 자동으로 안 찍는다(계약 침묵 · 문의 058).
 */
@Injectable()
export class WorkSessionEndService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
  ) {}
  async end(
    workSessionId: number,
    body: WorkSessionEnd,
    context: Omit<WorkSessionContext, 'idempotencyKey'>,
  ): Promise<WorkSessionView> {
    await assertWorkerNo(this.prisma, context.workerNo);
    return this.prisma.$transaction(async (tx: Tx) => {
      const locked = await lockSession(tx, workSessionId);
      // If-Match 가 없으면 대조를 건너뛴다 — 큐에 쌓인 요청은 토큰을 싣지 않는다(C-9).
      if (context.version !== undefined && locked.version_no !== context.version) {
        assertUpdated(0, 'user', { code: VERSION_CONFLICT });
      }
      // 이미 ENDED 면 400 `STATE_LOCKED` — 재로드해도 풀리지 않는다.
      const transition = this.documentState.assertTransition(
        STATUS_COLUMN, END_ACTION, locked.status_code, HttpStatus.BAD_REQUEST,
      );
      const endedAt = new Date(body.endedAt);
      // ⛔ CHECK `ck_work_session_dates` 를 앞당긴다 — 위반이 `PrismaClientUnknownRequestError`
      //    라 공용 그물에 안 걸린다.
      if (endedAt < locked.started_at) throw one(field('endedAt', ERROR_CODE.RANGE, '시작 시각보다 앞설 수 없습니다.'));
      const row = await tx.work_session.update({
        where: { work_session_id: BigInt(workSessionId) },
        // ⛔ `stop_reason_code` 무변경 — 계약이 「비우기로 정했다」(A-21·A-25). 본문에 와도
        //    저장하지 않고 400 도 내지 않는다(I-6 `:hold` 선례).
        data: {
          ended_at: endedAt,
          status_code: transition.to,
          version_no: { increment: 1 },
          updated_by: context.appUserId ?? null,
        },
      });
      await tx.work_session_event.create({
        // `terminal_id` 는 토큰이 오면 채우고 없으면 비운다 — 게이팅은 안 건다(R-1 C).
        data: {
          work_session_id: row.work_session_id,
          event_type_code: EVENT_TYPE.END,
          occurred_at: endedAt,
          performed_by: context.appUserId === undefined ? null : BigInt(context.appUserId),
          terminal_id: context.terminalId,
        },
      });
      return workSessionView(row);
    });
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
