import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { EMPLOYED_WORKER, MAX_OPEN_WORKERS, NOT_EMPLOYED_MESSAGE, WORKER_ROLE } from './crew';
import { assertLeftAfterJoined, assertSessionVersion, lockWorkSession } from './work-session-rules';
import { WORK_SESSION_WORKER_INCLUDE, WorkSessionWorkerView, workSessionWorkerView } from './work-session-view';
type Tx = Prisma.TransactionClient;
const SESSION_ENDED = 'ENDED';
/** 계약 `WorkSessionWorkerJoin` — required 둘. 작업 중 참여는 부작업자뿐이다(주작업자는 작업을 시작한 사람 하나). */
export interface WorkSessionWorkerJoin {
  workerId: number;
  workerRoleCode?: string;
  joinedAt: string;
}
/** 계약 `WorkSessionWorkerLeave` — required 하나. */
export interface WorkSessionWorkerLeave {
  leftAt: string;
}
/** 참여가 읽는 요청 밖 값. ⛔ 사번은 없다 — 계약이 두 오퍼레이션에 `X-Worker-No` 를 안 걸었다(R-13 ⓠ). */
export interface WorkSessionWorkerContext {
  version: number | undefined;
  appUserId: number | undefined;
}
/**
 * 세션 작업자 참여·이탈(§6). 세션을 닫지 않고 사람을 더하고 뺀다.
 * ⛔ **`work_order`·`work_session` 무변경** — 참여도 이탈도 세션 행을 UPDATE 하지 않으므로
 *    `version_no` 가 올라가지 않는다(§6-2 1 · 알려둘 것 ⓘ). ⛔ 전이표를 타지 않는다.
 */
@Injectable()
export class WorkSessionWorkerService {
  constructor(private readonly prisma: PrismaService) {}
  async join(
    workSessionId: number,
    body: WorkSessionWorkerJoin,
    context: WorkSessionWorkerContext,
  ): Promise<WorkSessionWorkerView> {
    const worker = await this.prisma.worker.findUnique({
      where: { worker_id: BigInt(body.workerId) }, select: { is_active: true },
    });
    if (worker === null) throw one(field('workerId', ERROR_CODE.INVALID, '없는 참조입니다.'));
    if (worker.is_active !== EMPLOYED_WORKER.is_active) {
      throw one(field('workerId', ERROR_CODE.INVALID, NOT_EMPLOYED_MESSAGE));
    }
    if (body.workerRoleCode !== undefined && body.workerRoleCode !== WORKER_ROLE.SUB) {
      throw one(field('workerRoleCode', ERROR_CODE.INVALID, '작업 중에는 부작업자로만 참여합니다.'));
    }
    return this.prisma.$transaction((tx: Tx) => this.commitJoin(tx, workSessionId, body, context));
  }
  private async commitJoin(
    tx: Tx,
    workSessionId: number,
    body: WorkSessionWorkerJoin,
    context: WorkSessionWorkerContext,
  ): Promise<WorkSessionWorkerView> {
    // ⭐ 세션 행을 잠가 중복 참여 판정을 직렬화한다 — 물리에 UNIQUE 가 없다(§6-2 4).
    const locked = await lockWorkSession(tx, workSessionId);
    assertSessionVersion(locked, context.version);
    // 전이표에 담을 수 없는 가장자리라 손검사다 — 상태가 «안 바뀌는» 자리다(§6-2 5).
    if (locked.status_code === SESSION_ENDED) {
      throw one(field('workSessionId', ERROR_CODE.STATE_LOCKED, '종료된 세션에는 참여할 수 없습니다.'));
    }
    const workerId = BigInt(body.workerId);
    // ⭐ 떠난 사람의 재참여는 허용한다 — 계약이 「참여 «구간»」을 세웠다(`joinedAt`·`leftAt`).
    const joined = await tx.work_session_worker.count({
      where: { work_session_id: BigInt(workSessionId), worker_id: workerId, left_at: null },
    });
    if (joined > 0) {
      throw one(field('workerId', ERROR_CODE.STATE_LOCKED, '이미 참여 중인 작업자입니다.'));
    }
    const open = await tx.work_session_worker.count({ where: { work_session_id: BigInt(workSessionId), left_at: null } });
    if (open >= MAX_OPEN_WORKERS) {
      throw one(field('workerId', ERROR_CODE.INVALID, `동시에 참여할 수 있는 작업자는 ${MAX_OPEN_WORKERS}명까지입니다.`));
    }
    const row = await tx.work_session_worker.create({
      data: {
        work_session_id: BigInt(workSessionId),
        worker_id: workerId,
        worker_role_code: WORKER_ROLE.SUB,
        joined_at: new Date(body.joinedAt),
        created_by: context.appUserId,
      },
      include: WORK_SESSION_WORKER_INCLUDE,
    });
    return workSessionWorkerView(row, null, new Date());
  }
  /**
   * 떠난 시각을 찍는다 — 행을 지우지 않는다(계약). ⛔ If-Match 를 읽지 않는다(계약에 없다).
   * 주작업자는 세션이 열린 동안 떠날 수 없다 — 작업의 책임자가 비면 실적 배분의 끝전을 받을 사람이 없다.
   * 종료된 세션에서도 허용한다 — `:end` 가 남은 참여자를 닫기 전의 옛 행이 남아 있을 수 있다.
   */
  async leave(
    workSessionId: number,
    workSessionWorkerId: number,
    body: WorkSessionWorkerLeave,
  ): Promise<WorkSessionWorkerView> {
    return this.prisma.$transaction(async (tx: Tx) => {
      await lockWorkSession(tx, workSessionId);
      const row = await tx.work_session_worker.findUnique({
        where: { work_session_worker_id: BigInt(workSessionWorkerId) },
      });
      // 남의 세션의 참여 행을 경로로 물어도 못 찾게 한다(§6-3 1).
      if (row === null || row.work_session_id !== BigInt(workSessionId)) {
        throw new NotFoundException('없는 세션 참여 기록입니다.');
      }
      if (row.left_at !== null) {
        throw one(field('workSessionWorkerId', ERROR_CODE.STATE_LOCKED, '이미 이탈한 작업자입니다.'));
      }
      const session = await tx.work_session.findUniqueOrThrow({
        where: { work_session_id: row.work_session_id }, select: { ended_at: true },
      });
      if (row.worker_role_code === WORKER_ROLE.MAIN && session.ended_at === null) {
        throw one(field('workSessionWorkerId', ERROR_CODE.STATE_LOCKED, '주작업자는 작업 중에 이탈할 수 없습니다.'));
      }
      const leftAt = new Date(body.leftAt);
      assertLeftAfterJoined(leftAt, row.joined_at);
      const updated = await tx.work_session_worker.update({
        where: { work_session_worker_id: row.work_session_worker_id },
        data: { left_at: leftAt },
        include: WORK_SESSION_WORKER_INCLUDE,
      });
      return workSessionWorkerView(updated, session.ended_at, new Date());
    });
  }
}
