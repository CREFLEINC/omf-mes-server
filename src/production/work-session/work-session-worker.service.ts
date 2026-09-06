import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { assertLeftAfterJoined, assertSessionVersion, lockWorkSession } from './work-session-rules';
import { WorkSessionWorkerView, workSessionWorkerView } from './work-session-view';
type Tx = Prisma.TransactionClient;
const WORKER_ROLE_GROUP = 'WORK_SESSION_WORKER_ROLE';
const SESSION_ENDED = 'ENDED';
/** 계약 `WorkSessionWorkerJoin` — required 둘. `workerRoleCode` 는 물리 기본값(`OPERATOR`)을 탄다. */
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
    if ((await this.prisma.worker.count({ where: { worker_id: BigInt(body.workerId) } })) === 0) {
      throw one(field('workerId', ERROR_CODE.INVALID, '없는 참조입니다.'));
    }
    // 안 오면 검사도 하지 않는다 — `assertCodeValues` 가 `undefined` 를 건너뛴다.
    await assertCodeValues(this.prisma, [
      { field: 'workerRoleCode', value: body.workerRoleCode, groupCode: WORKER_ROLE_GROUP },
    ]);
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
    const row = await tx.work_session_worker.create({
      data: {
        work_session_id: BigInt(workSessionId),
        worker_id: workerId,
        // 값이 없으면 칸을 «안 넣는다» — 물리 기본값 `OPERATOR` 를 탄다(설계 미정 — 문의 056).
        ...(body.workerRoleCode === undefined ? {} : { worker_role_code: body.workerRoleCode }),
        joined_at: new Date(body.joinedAt),
        created_by: context.appUserId,
      },
    });
    return workSessionWorkerView(row);
  }
  /**
   * 떠난 시각을 찍는다 — 행을 지우지 않는다(계약). ⛔ If-Match 를 읽지 않는다(계약에 없다).
   * ⭐ **종료된 세션에서도 허용한다** — `:end` 가 `left_at` 을 자동으로 안 찍으므로 이 경로를
   *    닫으면 「영원히 참여 중」이 확정된다(설계 미정 — 문의 058).
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
      const leftAt = new Date(body.leftAt);
      assertLeftAfterJoined(leftAt, row.joined_at);
      const updated = await tx.work_session_worker.update({
        where: { work_session_worker_id: row.work_session_worker_id },
        data: { left_at: leftAt },
      });
      return workSessionWorkerView(updated);
    });
  }
}
