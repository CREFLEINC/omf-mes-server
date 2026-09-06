import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { VERSION_CONFLICT } from '../work-order/work-order-write.service';
import { REASON_GROUP_BY_EVENT_TYPE } from './work-session.constants';

type Tx = Prisma.TransactionClient;
/** 세션 잠금이 읽는 최소 칸 — 상태를 옮길지, If-Match 를 대조할지 둘뿐이다. */
export type LockedWorkSession = { status_code: string; version_no: number };
const EVENT_TYPE_GROUP = 'WORK_SESSION_EVENT_TYPE';
const CLOSED_BY_OPERATION = '이 사건은 세션을 열고 닫는 오퍼레이션이 만듭니다.';

/**
 * 단말이 «적재하는» 두 사건 → 세션 상태기계의 액션 이름(A-25 · §5-2). 나머지 셋
 * (`START`·`END`·`CONTROL_OVERRIDE`)은 세션을 열고 닫는 오퍼레이션이 같은 트랜잭션으로
 * 만들므로 이 표에 없다 — 계약 명문 ⌜단말이 적재하는 것은 STOP·RESUME 뿐⌝ 그대로다.
 * ⚠ 액션 키 자체는 `transitions.ts` 가 PR ② 에서 만들었다 — 여기서 이름만 가리킨다.
 */
export const SESSION_ACTION: Readonly<Record<string, string>> = {
  STOP: 'work-session-stop',
  RESUME: 'work-session-resume',
};

/**
 * A-25 대응표 — 유형과 사유의 «짝»을 가르고 탈 액션 이름을 낸다(§5-2·§5-3).
 * `STOP` 은 사유 필수(화면 `P-02-10` §6 이 2026-08-23 에 차단으로 확정 — 목록에 `OTHER` 가
 * 있어 현장이 막히지 않는다) · `RESUME` 은 사유 금지다.
 */
export async function assertEventPair(
  prisma: PrismaService,
  eventTypeCode: string,
  reasonCode: string | undefined,
): Promise<string> {
  const action = SESSION_ACTION[eventTypeCode];
  if (action === undefined) {
    // 그룹 밖 문자열이면 여기서 400 `INVALID` 다. 통과하면 남은 것은 위 셋뿐이다(5값 · 시스템 소유).
    await assertCodeValues(prisma, [
      { field: 'eventTypeCode', value: eventTypeCode, groupCode: EVENT_TYPE_GROUP },
    ]);
    throw one(field('eventTypeCode', ERROR_CODE.INVALID, CLOSED_BY_OPERATION));
  }
  if (action === SESSION_ACTION.RESUME) {
    if (reasonCode !== undefined) {
      throw one(field('reasonCode', ERROR_CODE.INVALID, '재개에는 사유를 담지 않습니다.'));
    }
    return action;
  }
  if (reasonCode === undefined) {
    throw one(field('reasonCode', ERROR_CODE.REQUIRED, '중단 사유가 필요합니다.'));
  }
  await assertCodeValues(prisma, [
    { field: 'reasonCode', value: reasonCode, groupCode: REASON_GROUP_BY_EVENT_TYPE.STOP },
  ]);
  return action;
}

/** ⛔ CHECK `ck_work_session_worker_dates` 를 앞당긴다 — 위반이 공용 그물에 안 걸린다(`:end` 선례). */
export function assertLeftAfterJoined(leftAt: Date, joinedAt: Date): void {
  if (leftAt < joinedAt) throw one(field('leftAt', ERROR_CODE.RANGE, '참여 시각보다 앞설 수 없습니다.'));
}

/** ⛔ `SELECT … FOR UPDATE` — 상태 전이와 중복 참여 판정을 세션 행 하나로 직렬화한다. */
export async function lockWorkSession(tx: Tx, workSessionId: number): Promise<LockedWorkSession> {
  const rows = await tx.$queryRaw<LockedWorkSession[]>`
    SELECT status_code, version_no
      FROM production.work_session
     WHERE work_session_id = ${BigInt(workSessionId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 작업 세션입니다.');
  return rows[0];
}

/** If-Match 가 없으면 대조를 건너뛴다 — 큐에 쌓인 요청은 토큰을 싣지 않는다(C-9 · `:end` 사본). */
export function assertSessionVersion(locked: LockedWorkSession, version: number | undefined): void {
  if (version !== undefined && locked.version_no !== version) {
    assertUpdated(0, 'user', { code: VERSION_CONFLICT });
  }
}
