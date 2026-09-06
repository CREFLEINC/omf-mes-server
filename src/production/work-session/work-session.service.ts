import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVersion, lockWorkOrder } from '../work-order/work-order-write.service';
import { resolveShiftId } from './shift-resolver';
import { EVENT_TYPE } from './work-session.constants';
import { WorkSessionView, workSessionView } from './work-session-view';
type Tx = Prisma.TransactionClient;
const STATUS_COLUMN = 'production.work_order.status_code';
const START_ACTION = 'work-session-start';
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
  ) {}
  async create(body: WorkSessionCreate, context: WorkSessionContext): Promise<WorkSessionView> {
    await assertWorkerNo(this.prisma, context.workerNo);
    await this.assertReferences(body);
    await this.assertControlOverride(body);
    // `runIdempotent` 가 tx 를 넘겨주지 않는다 — 서비스가 자기 트랜잭션을 연다(I-9 R-10).
    return this.prisma.$transaction((tx) => this.commit(tx, body, context));
  }
  private async commit(tx: Tx, body: WorkSessionCreate, context: WorkSessionContext): Promise<WorkSessionView> {
    const workOrderId = BigInt(body.workOrderId);
    const locked = await lockWorkOrder(tx, body.workOrderId);
    assertVersion(locked, context.version);
    // ⛔ 400 이다 — CLOSED·SUSPENDED 가 여기서 막혀 마감 트리거에 닿지 않는다.
    const transition = this.documentState.assertTransition(
      STATUS_COLUMN, START_ACTION, locked.status_code, HttpStatus.BAD_REQUEST,
    );
    // ⛔ `status_code` 를 안 본다 — STOPPED 도 열린 세션이다(G-16).
    const open = await tx.work_session.findFirst({ where: { work_order_id: workOrderId, ended_at: null } });
    if (open !== null) {
      throw new ConflictException('user', '이 작업지시에 열린 세션이 이미 있습니다.', { code: ERROR_CODE.OPEN_SESSION_EXISTS });
    }
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
    await this.insertChildren(tx, row.work_session_id, body, context, startedAt);
    // ⭐ 상태가 이미 같으면 UPDATE 를 건너뛴다 — 둘째 세션마다 `version_no` 가 올라 화면의
    //    If-Match 토큰이 낡는 부작용을 없앤다(R-4).
    if (locked.status_code !== transition.to) {
      await tx.work_order.update({
        where: { work_order_id: workOrderId },
        data: { status_code: transition.to, version_no: { increment: 1 }, updated_by: context.appUserId ?? null },
      });
    }
    return workSessionView(row);
  }
  // START(+우회면 CONTROL_OVERRIDE) 사건과 참여 행. START 는 `reason_code` 를 안 쓰고(A-25),
  // 우회 `note` 는 담을 칸이 0이라 버리며(ⓖ), `worker_role_code` 는 물리 기본값을 탄다(056).
  private async insertChildren(
    tx: Tx, sessionId: bigint, body: WorkSessionCreate, context: WorkSessionContext, startedAt: Date,
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
    const workerIds = body.workerIds ?? [];
    if (workerIds.length === 0) return;
    await tx.work_session_worker.createMany({
      data: workerIds.map((workerId) => ({
        work_session_id: sessionId, worker_id: BigInt(workerId), joined_at: startedAt, created_by: context.appUserId,
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
  /** FK 존재 + 배열 중복. 400 은 모아 던진다 — 화면이 한 번에 표시한다. */
  private async assertReferences(body: WorkSessionCreate): Promise<void> {
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
    } else if (workerIds.length > 0) {
      const found = await this.prisma.worker.count({ where: { worker_id: { in: workerIds.map(BigInt) } } });
      if (found !== workerIds.length) errors.push(field('workerIds', ERROR_CODE.INVALID, MISSING_REF));
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
    throw one(field('controlOverride.reasonCode', ERROR_CODE.INVALID, '긴급 작업지시에서만 우회할 수 있습니다.'));
  }
}
// 귀속 사번 — 계약이 required 로 걸었으나 **담을 칸이 0**이라 읽고 버린다(§3-7 · 문의 057).
// `assertWorkerNo` 다섯째 사본(R-11) — 앞 넷과 달리 「없는 사번」을 가르려 조회를 한 번 한다.
export async function assertWorkerNo(prisma: PrismaService, workerNo: string | undefined): Promise<void> {
  if (workerNo === undefined || workerNo.trim() === '') {
    throw one(field('X-Worker-No', ERROR_CODE.REQUIRED, '작업자 사번 헤더가 필요합니다.'));
  }
  if ((await prisma.worker.count({ where: { worker_no: workerNo } })) === 0) {
    throw one(field('X-Worker-No', ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
  }
}
/** 계정 권한(`PermissionGuard`)과 **다른 축**이라 가드가 아니라 서비스가 낸다(§3-2). */
function forbidden(message: string): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [{ scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message }]);
}
