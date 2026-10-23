import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertCodeValues, resolveWorkerId } from '../../common/master';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderNotifier } from '../work-order/work-order-notice';
import { assertVersion, lockWorkOrder } from '../work-order/work-order-write.service';
import { EMPLOYED_WORKER, MAX_OPEN_WORKERS, NOT_EMPLOYED_MESSAGE, WORKER_ROLE } from './crew';
import { resolveShiftId } from './shift-resolver';
import { EVENT_TYPE } from './work-session.constants';
import { WorkSessionView, workSessionView } from './work-session-view';
type Tx = Prisma.TransactionClient;
const STATUS_COLUMN = 'production.work_order.status_code';
const START_ACTION = 'work-session-start';
const RESUME_ACTION = 'work-order-resume';
const SUSPENDED = 'SUSPENDED';
/** 작업을 시작할 수 없는 상태마다 할 일 — 상태 이름만으로는 현장이 무엇을 할지 모른다. */
const NOT_STARTABLE: Record<string, string> = {
  PLANNED: '배포 전입니다. 관리웹에서 W/O 를 배포한 뒤 시작하세요.',
  CONFIRMED: '배포 전입니다. 관리웹에서 W/O 를 배포한 뒤 시작하세요.',
  COMPLETED: '완료된 W/O 입니다. W/O 목록을 새로 고쳐 확인하세요.',
  CLOSED: '마감된 W/O 입니다. W/O 목록을 새로 고쳐 확인하세요.',
  CANCELLED: '취소된 W/O 입니다. W/O 목록을 새로 고쳐 확인하세요.',
};
/** 태어나는 상태. `ENDED` 는 `:end` 가 전이표의 `to` 로 받는다 · `EMERGENCY` 만 우회를 연다. */
const SESSION_RUNNING = 'RUNNING';
const OVERRIDE_REASON_GROUP = 'CONTROL_OVERRIDE_REASON';
const EMERGENCY = 'EMERGENCY';
const MISSING_REF = '없는 참조입니다.';
/** 계약 `WorkSessionCreate` — required 둘(`workOrderId`·`startedAt`). */
export interface WorkSessionCreate {
  workOrderId: number;
  shiftId?: number;
  equipmentId?: number;
  moldId?: number;
  startedAt: string;
  workerIds?: number[];
  controlOverride?: { reasonCode: string; note?: string };
}
/** 본문 밖에서 오는 것. `terminalId` 는 단말 토큰이 준다 — 안 보냈으면 `null` 이다(R-1). */
export interface WorkSessionContext {
  workerNo: string | undefined;
  idempotencyKey: string;
  version: number | undefined;
  appUserId: number | undefined;
  terminalId: bigint | null;
}
/** 세션 열기(§3-1). ⛔ 원장·채번·승인·LOT 코어 0 · ⛔ `precheck_decision` 을 안 읽는다(§3-6). */
@Injectable()
export class WorkSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly notifier: WorkOrderNotifier,
  ) {}
  async create(body: WorkSessionCreate, context: WorkSessionContext): Promise<WorkSessionView> {
    // 작업을 시작하는 사람이 이 세션의 주작업자다.
    const mainWorkerId = await resolveWorkerId(this.prisma, context.workerNo);
    if ((await this.prisma.worker.count({ where: { worker_id: mainWorkerId, ...EMPLOYED_WORKER } })) === 0) {
      throw one(field('X-Worker-No', ERROR_CODE.INVALID, NOT_EMPLOYED_MESSAGE));
    }
    await this.assertReferences(body, mainWorkerId);
    await this.assertControlOverride(body);
    // `runIdempotent` 가 tx 를 넘겨주지 않는다 — 서비스가 자기 트랜잭션을 연다(I-9 R-10).
    return this.prisma.$transaction((tx) => this.commit(tx, body, context, mainWorkerId));
  }
  private async commit(tx: Tx, body: WorkSessionCreate, context: WorkSessionContext, mainWorkerId: bigint): Promise<WorkSessionView> {
    const workOrderId = BigInt(body.workOrderId);
    const locked = await lockWorkOrder(tx, body.workOrderId);
    assertVersion(locked, context.version);
    const resumed = locked.status_code === SUSPENDED;
    // 시작도 재개도 할 수 없는 상태(편성·마감·취소 등)는 상태 문구가 먼저다 — 열린 세션은 그 다음 문제다.
    if (!resumed) this.assertStartable(locked.status_code);
    // ⛔ `status_code` 를 안 본다 — STOPPED 도 열린 세션이다(G-16). 중단 W/O 에서는 상태보다 먼저다: 중단 세션이 열려
    //    있으면 새 세션이 아니라 그 세션의 RESUME 으로 재개해야 해서 이 409 가 할 일을 정확히 알린다.
    const open = await tx.work_session.findFirst({ where: { work_order_id: workOrderId, ended_at: null } });
    if (open !== null) {
      throw new ConflictException(
        'user',
        '이 MES W/O 에 이미 열린 작업 세션이 있습니다. 목록을 새로 고친 뒤 [재개] 또는 [작업 이어하기]로 그 세션을 이어 가세요 — '
          + '다른 단말의 세션이면 그 단말에서 재개·종료하거나 관리웹에서 강제 종료하세요.',
        { code: ERROR_CODE.OPEN_SESSION_EXISTS },
      );
    }
    // ⭐ 중단·열린 세션 없음 W/O 는 같은 트랜잭션에서 재개하고 시작한다 — 따로 부르면 재개만 되고 시작이 실패하는
    //    부분 실패가 남는다. 재개는 세션 사건을 남기지 않는다(START 만).
    const from = resumed
      ? this.documentState.assertTransition(STATUS_COLUMN, RESUME_ACTION, locked.status_code, HttpStatus.BAD_REQUEST).to
      : locked.status_code;
    const transition = this.assertStartable(from);
    const plantId = await this.assertTerminalGate(tx, workOrderId, context.terminalId);
    const startedAt = new Date(body.startedAt);
    // W/O 를 이미 잠갔다 — `uq_work_session` 의 순번을 손으로 채워도 경합이 없다.
    const max = await tx.work_session.aggregate({ where: { work_order_id: workOrderId }, _max: { session_no: true } });
    const row = await tx.work_session.create({
      data: {
        work_order_id: workOrderId,
        session_no: (max._max.session_no ?? 0) + 1,
        shift_id: await this.resolveShift(tx, body, plantId, startedAt),
        equipment_id: body.equipmentId === undefined ? null : BigInt(body.equipmentId),
        mold_id: body.moldId === undefined ? null : BigInt(body.moldId),
        terminal_id: context.terminalId as bigint,
        started_at: startedAt,
        status_code: SESSION_RUNNING,
        // 헤더 값 «그대로» — 멱등 기록이 만료된 뒤의 재전송을 이 UNIQUE 가 둘째 그물로 막는다.
        idempotency_key: context.idempotencyKey,
        created_by: context.appUserId,
      },
    });
    await this.insertChildren(tx, row.work_session_id, body, context, startedAt, mainWorkerId);
    // ⭐ 상태가 이미 같으면 UPDATE 를 건너뛴다 — 둘째 세션마다 `version_no` 가 올라 화면의
    //    If-Match 토큰이 낡는 부작용을 없앤다(R-4).
    if (locked.status_code !== transition.to) {
      // 재개와 시작이 한 번의 UPDATE 다 — 버전은 한 번만 오른다.
      await tx.work_order.update({
        where: { work_order_id: workOrderId },
        data: { status_code: transition.to, version_no: { increment: 1 }, updated_by: context.appUserId ?? null },
      });
    }
    // 재시작마다 보낸다 — START 사건 시각이 달라 같은 W/O 의 여러 시작이 겹치지 않는다(research R-6).
    await this.notifier.notify(tx, 'WORK_SESSION_STARTED', workOrderId, startedAt, {
      appUserId: context.appUserId, workerNo: context.workerNo,
    });
    return workSessionView(row);
  }

  /** ⛔ 400 이다 — CLOSED 등이 여기서 막혀 마감 트리거에 닿지 않는다. 문구만 상태별 조치로 바꾼다. */
  private assertStartable(statusCode: string) {
    try {
      return this.documentState.assertTransition(STATUS_COLUMN, START_ACTION, statusCode, HttpStatus.BAD_REQUEST);
    } catch (error) {
      if (!(error instanceof ContractException)) throw error;
      const message = `작업을 시작할 수 없는 W/O 입니다 — ${NOT_STARTABLE[statusCode] ?? `${statusCode} 상태입니다. W/O 상태를 확인하세요.`}`;
      throw new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);
    }
  }
  // START(+우회면 CONTROL_OVERRIDE) 사건과 참여 행. START 는 `reason_code` 를 안 쓰고(A-25),
  // 우회 `note` 는 담을 칸이 0이라 버린다(ⓖ). 참여 행은 시작한 사람이 주작업자, 본문 사람들이 부작업자다.
  private async insertChildren(
    tx: Tx, sessionId: bigint, body: WorkSessionCreate, context: WorkSessionContext, startedAt: Date, mainWorkerId: bigint,
  ): Promise<void> {
    const override = body.controlOverride;
    const common = {
      work_session_id: sessionId,
      occurred_at: startedAt,
      performed_by: context.appUserId === undefined ? null : BigInt(context.appUserId),
      terminal_id: context.terminalId,
    };
    await tx.work_session_event.createMany({
      data: [
        { ...common, event_type_code: EVENT_TYPE.START },
        ...(override ? [{ ...common, event_type_code: EVENT_TYPE.CONTROL_OVERRIDE, reason_code: override.reasonCode }] : []),
      ],
    });
    const crew = [
      { workerId: mainWorkerId, role: WORKER_ROLE.MAIN },
      ...(body.workerIds ?? []).map((workerId) => ({ workerId: BigInt(workerId), role: WORKER_ROLE.SUB })),
    ];
    await tx.work_session_worker.createMany({
      data: crew.map(({ workerId, role }) => ({
        work_session_id: sessionId, worker_id: workerId, worker_role_code: role, joined_at: startedAt, created_by: context.appUserId,
      })),
    });
  }
  // 게이팅 — 단말을 못 풀면 **판정할 수 없으므로** 403 이다(F-6 · R-1 · 문의 054). 행이 없어도
  // 거부하고(`P-02-01` §5-1), `process_id` 가 NOT NULL 이라 NULL 분기가 없다(R-5).
  private async assertTerminalGate(tx: Tx, workOrderId: bigint, terminalId: bigint | null): Promise<bigint> {
    if (terminalId === null) throw forbidden('단말을 확인할 수 없어 작업을 시작할 수 없습니다.');
    const workOrder = await tx.work_order.findUniqueOrThrow({
      where: { work_order_id: workOrderId }, select: { routing_operation: { select: { process_id: true } } },
    });
    const gate = await tx.terminal_process.findUnique({
      where: { terminal_id_process_id: { terminal_id: terminalId, process_id: workOrder.routing_operation.process_id } },
      select: { can_start_work: true },
    });
    if (gate?.can_start_work !== true) throw forbidden('이 단말은 이 공정의 작업을 시작할 수 없습니다.');
    const terminal = await tx.terminal.findUniqueOrThrow({ where: { terminal_id: terminalId }, select: { plant_id: true } });
    return terminal.plant_id;
  }
  /** 본문 값이 있으면 그대로. 없으면 「시작 시각 + 단말의 공장」으로 푼다(§3-3). */
  private async resolveShift(tx: Tx, body: WorkSessionCreate, plantId: bigint, startedAt: Date): Promise<bigint | null> {
    if (body.shiftId !== undefined) return BigInt(body.shiftId);
    try {
      return await resolveShiftId(tx, plantId, startedAt);
    } catch {
      // 타임존 코드가 잘못돼도 세션은 선다 — 계약 「세션을 막지 않는다」 · #258 리뷰 Minor.
      return null;
    }
  }
  /** FK 존재 + 배열 중복 + 동시 참여 상한. 400 은 모아 던진다 — 화면이 한 번에 표시한다. */
  private async assertReferences(body: WorkSessionCreate, mainWorkerId: bigint): Promise<void> {
    const errors: ErrorItem[] = [];
    const absent = async (name: string, value: number | undefined, count: (id: bigint) => Promise<number>) => {
      if (value !== undefined && (await count(BigInt(value))) === 0) errors.push(field(name, ERROR_CODE.INVALID, MISSING_REF));
    };
    await absent('shiftId', body.shiftId, (id) => this.prisma.shift.count({ where: { shift_id: id } }));
    await absent('equipmentId', body.equipmentId, (id) => this.prisma.equipment.count({ where: { equipment_id: id } }));
    await absent('moldId', body.moldId, (id) => this.prisma.mold.count({ where: { mold_id: id } }));
    const workerIds = body.workerIds ?? [];
    if (new Set(workerIds).size !== workerIds.length) {
      errors.push(field('workerIds', ERROR_CODE.INVALID, '같은 작업자를 두 번 넣을 수 없습니다.'));
    } else if (workerIds.some((workerId) => BigInt(workerId) === mainWorkerId)) {
      errors.push(field('workerIds', ERROR_CODE.INVALID, '작업을 시작하는 작업자는 이미 주작업자로 참여합니다.'));
    } else if (1 + workerIds.length > MAX_OPEN_WORKERS) {
      errors.push(field('workerIds', ERROR_CODE.INVALID, `동시에 참여할 수 있는 작업자는 ${MAX_OPEN_WORKERS}명까지입니다.`));
    } else if (workerIds.length > 0) {
      const ids = { worker_id: { in: workerIds.map(BigInt) } };
      const found = await this.prisma.worker.count({ where: ids });
      if (found !== workerIds.length) errors.push(field('workerIds', ERROR_CODE.INVALID, MISSING_REF));
      else if ((await this.prisma.worker.count({ where: { ...ids, ...EMPLOYED_WORKER } })) !== workerIds.length) {
        errors.push(field('workerIds', ERROR_CODE.INVALID, NOT_EMPLOYED_MESSAGE));
      }
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
  /** 통제 우회 — 사유는 그룹 값이어야 하고 **긴급 작업지시에서만** 우회할 수 있다(§3-6). */
  private async assertControlOverride(body: WorkSessionCreate): Promise<void> {
    const override = body.controlOverride;
    if (override === undefined) return;
    await assertCodeValues(this.prisma, [
      { field: 'controlOverride.reasonCode', value: override.reasonCode, groupCode: OVERRIDE_REASON_GROUP },
    ]);
    const workOrder = await this.prisma.work_order.findUnique({
      where: { work_order_id: BigInt(body.workOrderId) }, select: { work_order_type_code: true },
    });
    // 없는 W/O 는 트랜잭션 1번이 404 로 낸다 — 여기서 가로채지 않는다.
    if (workOrder === null || workOrder.work_order_type_code === EMERGENCY) return;
    throw one(field('controlOverride.reasonCode', ERROR_CODE.INVALID, '긴급 MES W/O 에서만 우회할 수 있습니다.'));
  }
}
/** 계정 권한(`PermissionGuard`)과 **다른 축**이라 가드가 아니라 서비스가 낸다(§3-2). */
function forbidden(message: string): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [{ scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message }]);
}
