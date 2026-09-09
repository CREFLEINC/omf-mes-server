import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DocumentStateService } from '../../core/document-state';
import { assertWorkerNoExists } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { assertEventPair, assertSessionVersion, lockWorkSession } from './work-session-rules';
import { WorkSessionContext } from './work-session.service';
import { WorkSessionEventRow, WorkSessionEventView, reasonKey, workSessionEventView } from './work-session-view';
type Tx = Prisma.TransactionClient;
const STATUS_COLUMN = 'production.work_session.status_code';
/** 계약 `WorkSessionEventCreate` — required 둘. `reasonCode` 의 필수 여부는 유형이 가른다(A-25). */
export interface WorkSessionEventCreate {
  eventTypeCode: string;
  occurredAt: string;
  reasonCode?: string;
}
/**
 * 세션 사건 적재(§5) — 단말이 보내는 것은 `STOP`·`RESUME` 둘뿐이다.
 * ⛔ **`work_order` 를 건드리지 않는다** — 계약 ⌜`…:resume` 를 부르지 않는다⌝ 의 대칭이다.
 * ⛔ `terminal_process` 게이팅 0(계약이 이 자리에 `can_*` 를 안 적었다 · R-1 C) · ETag 0 · 409 도메인 0.
 */
@Injectable()
export class WorkSessionEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
  ) {}
  async create(
    workSessionId: number,
    body: WorkSessionEventCreate,
    context: Omit<WorkSessionContext, 'idempotencyKey'>,
  ): Promise<WorkSessionEventView> {
    await assertWorkerNoExists(this.prisma, context.workerNo);
    const action = await assertEventPair(this.prisma, body.eventTypeCode, body.reasonCode);
    return this.prisma.$transaction((tx: Tx) => this.commit(tx, workSessionId, body, context, action));
  }
  private async commit(
    tx: Tx,
    workSessionId: number,
    body: WorkSessionEventCreate,
    context: Omit<WorkSessionContext, 'idempotencyKey'>,
    action: string,
  ): Promise<WorkSessionEventView> {
    const locked = await lockWorkSession(tx, workSessionId);
    assertSessionVersion(locked, context.version);
    // 종료된 세션도 여기서 400 `STATE_LOCKED` 다 — `ENDED` 는 어느 액션의 `from` 에도 없다.
    // ⚠ R-7 ⓐ: W/O `:hold` 는 세션에 손대지 않으므로 화면 [재개]가 `RUNNING` 세션에
    //    `RESUME` 을 보내면 여기서 막힌다 — 설계 미정(문의 035)이라 그대로 둔다.
    const transition = this.documentState.assertTransition(
      STATUS_COLUMN, action, locked.status_code, HttpStatus.BAD_REQUEST,
    );
    const row = await tx.work_session_event.create({
      data: {
        work_session_id: BigInt(workSessionId),
        event_type_code: body.eventTypeCode,
        // 단말 시계 그대로 — 서버가 덮지 않는다(C-12). `recordedAt` 은 `created_at` 기본값이다.
        occurred_at: new Date(body.occurredAt),
        reason_code: body.reasonCode ?? null,
        performed_by: context.appUserId === undefined ? null : BigInt(context.appUserId),
        terminal_id: context.terminalId,
      },
    });
    await tx.work_session.update({
      where: { work_session_id: BigInt(workSessionId) },
      data: { status_code: transition.to, version_no: { increment: 1 }, updated_by: context.appUserId ?? null },
    });
    return workSessionEventView(row, await reasonName(tx, row));
  }
}
/** 파생 칸 — 조회 서비스와 «같은» 「그룹:코드」 키로 한 건만 찾는다. 없으면 키를 생략한다(§1-4). */
async function reasonName(tx: Tx, row: WorkSessionEventRow): Promise<string | undefined> {
  const key = reasonKey(row);
  if (key === undefined) return undefined;
  const [groupCode, code] = key.split(':');
  const found = await tx.code_value.findFirst({
    where: { code, code_group: { group_code: groupCode } },
    select: { code_name: true },
  });
  return found?.code_name;
}
