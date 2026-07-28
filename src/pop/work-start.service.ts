import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  equipment as equipmentModel,
  mold as moldModel,
  Prisma,
  shift as shiftModel,
  worker,
} from '@prisma/client';

import { WORKER_NO_HEADER } from '../auth/terminal-auth.decorators';
import { TerminalAuthService, TerminalPrincipal } from '../auth/terminal-auth.service';
import { PageDto } from '../common/dto/page.dto';
import { orConflict, orFail } from '../master-data/common/master-crud';
import { OperationPolicyService } from '../master-data/operation-policy/operation-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { PopWorkOrderQueryDto, StartWorkDto } from './work-start.dto';

/**
 * 현장이 집어 들 수 있는 작업지시 상태.
 *
 * 배포 전(PLANNED)은 아직 현장 것이 아니고, 마감·취소는 끝난 것이다. IN_PROGRESS가
 * 들어 있는 건 세션이 한 번 닫힌 뒤 같은 작업지시를 이어서 다시 여는 경우가 있어서다.
 */
const STARTABLE_STATUS = ['RELEASED', 'IN_PROGRESS'];

const RELEASED = 'RELEASED';
const IN_PROGRESS = 'IN_PROGRESS';

const OPEN_SESSION_STATUS = 'OPEN';
const SESSION_START_EVENT = 'START';
const OPERATOR_ROLE = 'OPERATOR';

const QUALIFICATION_POLICY = 'WORKER_QUALIFICATION_ENFORCEMENT';
const PROCESS_OPERATION = 'PROCESS_OPERATION';

/**
 * 정책행이 없을 때의 기본값. **막지 않는다** — 자격 데이터가 정비되기 전에 강제를
 * 기본으로 두면 현장이 선다(설계검토 §6-④). 막고 싶으면 정책을 등록하는 쪽이 명시적이다.
 */
const DEFAULT_ENFORCEMENT = 'OFF';

const WORK_ORDER_DETAIL = {
  item: { select: { item_code: true, item_name: true } },
  uom: { select: { uom_code: true } },
  routing_operation: {
    include: { process: { select: { process_id: true, process_code: true, process_name: true } } },
  },
  equipment: true,
  mold: true,
  shift: true,
  production_plan: { include: { production_order: { select: { plant_id: true } } } },
} satisfies Prisma.work_orderInclude;

type WorkOrderDetail = Prisma.work_orderGetPayload<{ include: typeof WORK_ORDER_DETAIL }>;

/** 현장 화면이 쓰는 작업지시 요약. 목록과 시작 응답이 같은 모양을 쓴다. */
function toSummary(workOrder: WorkOrderDetail) {
  return {
    workOrderId: workOrder.work_order_id,
    workOrderNo: workOrder.work_order_no,
    statusCode: workOrder.status_code,
    itemCode: workOrder.item.item_code,
    itemName: workOrder.item.item_name,
    orderQty: workOrder.order_qty.toNumber(),
    uomCode: workOrder.uom.uom_code,
    processCode: workOrder.routing_operation.process.process_code,
    processName: workOrder.routing_operation.process.process_name,
    operationName: workOrder.routing_operation.operation_name,
    plannedStartAt: workOrder.planned_start_at,
    plannedEndAt: workOrder.planned_end_at,
    priorityNo: workOrder.priority_no,
    plannedEquipmentCode: workOrder.equipment?.equipment_code ?? null,
    plannedMoldCode: workOrder.mold?.mold_code ?? null,
    plannedShiftCode: workOrder.shift?.shift_code ?? null,
    equipmentRequired: workOrder.routing_operation.equipment_required,
    moldRequired: workOrder.routing_operation.mold_required,
  };
}

type WorkOrderSummary = ReturnType<typeof toSummary>;

@Injectable()
export class WorkStartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly terminals: TerminalAuthService,
    private readonly policies: OperationPolicyService,
  ) {}

  /**
   * 작업 시작 화면의 목록. **단말이 「작업 시작」을 할 수 있는 공정만** 보여준다 —
   * 실적 입력만 허용된 단말에 시작 버튼이 뜨면 눌러 보고 나서야 403을 만난다.
   */
  async findStartable(
    terminal: TerminalPrincipal,
    query: PopWorkOrderQueryDto,
  ): Promise<PageDto<WorkOrderSummary & { hasOpenSession: boolean }>> {
    const processCodes = this.startableProcessCodes(terminal, query.processCode);
    if (processCodes.length === 0) {
      return new PageDto([], 0, query.page, query.size);
    }

    const where: Prisma.work_orderWhereInput = {
      status_code: { in: STARTABLE_STATUS },
      routing_operation: { process: { process_code: { in: processCodes } } },
      production_plan: { production_order: { plant_id: terminal.plantId } },
    };
    if (query.keyword) {
      where.OR = [
        { work_order_no: { contains: query.keyword, mode: 'insensitive' } },
        { item: { item_code: { contains: query.keyword, mode: 'insensitive' } } },
        { item: { item_name: { contains: query.keyword, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.work_order.findMany({
        where,
        include: {
          ...WORK_ORDER_DETAIL,
          work_session: { where: { ended_at: null }, select: { work_session_id: true } },
        },
        // 우선순위가 작을수록 먼저다(priority_no 기본 100). 같으면 계획 시작이 이른 순.
        orderBy: [{ priority_no: 'asc' }, { planned_start_at: 'asc' }, { work_order_no: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.work_order.count({ where }),
    ]);

    const items = rows.map((row) => ({
      ...toSummary(row),
      // 이미 열려 있으면 시작 버튼을 비활성화할 수 있게 미리 알려준다.
      hasOpenSession: row.work_session.length > 0,
    }));

    return new PageDto(items, total, query.page, query.size);
  }

  /**
   * 「작업 시작」 — 작업 세션을 연다.
   *
   * 이 시점부터 생산실적·불량·자재투입이 세션에 매달린다. 세션·작업자 귀속·시작
   * 이벤트는 하나라도 빠지면 뒤따르는 기록의 근거가 사라져 한 트랜잭션으로 묶는다.
   */
  async start(
    terminal: TerminalPrincipal,
    workerNo: string | undefined,
    workOrderId: bigint,
    dto: StartWorkDto,
  ) {
    if (!workerNo) {
      throw new BadRequestException(
        `작업자 사번이 필요합니다. ${WORKER_NO_HEADER} 헤더로 보내십시오.`,
      );
    }
    const worker = await this.terminals.resolveWorker(workerNo);
    const workOrder = await this.getStartable(workOrderId, terminal);
    const processCode = workOrder.routing_operation.process.process_code;

    await this.terminals.assertCapability(terminal.terminalId, processCode, 'can_start_work');

    orConflict(
      await this.prisma.work_session.findFirst({
        where: { work_order_id: workOrder.work_order_id, ended_at: null },
      }),
      `이미 진행 중인 작업입니다: ${workOrder.work_order_no}`,
    );

    const warnings = await this.enforceQualification(worker, workOrder, terminal.plantId);

    const [shift, equipment, mold] = await Promise.all([
      this.resolveShift(dto.shiftCode, workOrder, terminal.plantId),
      this.resolveEquipment(dto.equipmentCode, workOrder, terminal.plantId),
      this.resolveMold(dto.moldCode, workOrder, terminal.plantId),
    ]);

    const startedAt = new Date();
    const sessionNo = await this.nextSessionNo(workOrder.work_order_id);

    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.work_session.create({
        data: {
          work_order_id: workOrder.work_order_id,
          session_no: sessionNo,
          shift_id: shift.shift_id,
          equipment_id: equipment?.equipment_id ?? null,
          mold_id: mold?.mold_id ?? null,
          terminal_id: terminal.terminalId,
          started_at: startedAt,
          status_code: OPEN_SESSION_STATUS,
          remarks: dto.remarks ?? null,
        },
      });

      await tx.work_session_worker.create({
        data: {
          work_session_id: created.work_session_id,
          worker_id: worker.worker_id,
          worker_role_code: OPERATOR_ROLE,
          joined_at: startedAt,
        },
      });

      // performed_by는 app_user를 가리킨다 — 단말에는 사람 계정이 없어 비운다.
      // 누가 시작했는지는 work_session_worker가 갖는다.
      await tx.work_session_event.create({
        data: {
          work_session_id: created.work_session_id,
          event_type_code: SESSION_START_EVENT,
          occurred_at: startedAt,
          terminal_id: terminal.terminalId,
        },
      });

      if (workOrder.status_code === RELEASED) {
        await tx.work_order.update({
          where: { work_order_id: workOrder.work_order_id },
          data: { status_code: IN_PROGRESS, version_no: { increment: 1 } },
        });
      }

      return created;
    });

    return {
      workSessionId: session.work_session_id,
      sessionNo: session.session_no,
      startedAt: session.started_at,
      statusCode: session.status_code,
      workOrder: { ...toSummary(workOrder), statusCode: IN_PROGRESS },
      worker: { workerNo: worker.worker_no, workerName: worker.worker_name },
      shift: { shiftCode: shift.shift_code, shiftName: shift.shift_name },
      equipment: equipment && { equipmentCode: equipment.equipment_code },
      mold: mold && { moldCode: mold.mold_code },
      warnings,
    };
  }

  /** 단말이 담당하면서 「작업 시작」까지 허용된 공정. 요청이 공정을 집으면 그 하나로 좁힌다. */
  private startableProcessCodes(terminal: TerminalPrincipal, requested?: string): string[] {
    const allowed = terminal.processes
      .filter((process) => process.capabilities.includes('can_start_work'))
      .map((process) => process.processCode);

    if (!requested) return allowed;
    if (!allowed.includes(requested)) {
      throw new ForbiddenException(
        `이 단말은 ${requested} 공정에서 작업을 시작할 수 없습니다.`,
      );
    }
    return [requested];
  }

  private async getStartable(
    workOrderId: bigint,
    terminal: TerminalPrincipal,
  ): Promise<WorkOrderDetail> {
    const workOrder = orFail(
      await this.prisma.work_order.findUnique({
        where: { work_order_id: workOrderId },
        include: WORK_ORDER_DETAIL,
      }),
      `작업지시(${workOrderId})`,
    );

    if (workOrder.production_plan.production_order.plant_id !== terminal.plantId) {
      throw new ForbiddenException('다른 공장의 작업지시입니다.');
    }
    if (!STARTABLE_STATUS.includes(workOrder.status_code)) {
      throw new ForbiddenException(
        `시작할 수 없는 상태입니다: ${workOrder.status_code}. 배포된 작업지시만 시작할 수 있습니다.`,
      );
    }
    return workOrder;
  }

  /**
   * 자격 강제. **판정 기준은 운영정책이 정한다** — BLOCK이면 막고, OFF면 보지 않고,
   * 그 밖(WARN·오타로 들어간 값)은 경고만 싣고 통과시킨다. 정책값 오타 하나로
   * 현장을 세우지 않으면서, 자격 미달 사실은 응답에 남긴다.
   */
  private async enforceQualification(
    worker: worker,
    workOrder: WorkOrderDetail,
    plantId: bigint,
  ): Promise<string[]> {
    const level = await this.policies.resolveText(QUALIFICATION_POLICY, DEFAULT_ENFORCEMENT, {
      plantId,
      itemId: workOrder.item_id,
      processId: workOrder.routing_operation.process_id,
    });
    if (level === DEFAULT_ENFORCEMENT) return [];

    const processCode = workOrder.routing_operation.process.process_code;
    const qualifications = await this.terminals.findValidQualifications(worker.worker_id);
    const isQualified = qualifications.some(
      (qualification) =>
        qualification.qualificationTypeCode === PROCESS_OPERATION &&
        // 공정이 지정되지 않은 자격은 공정 무관 — 어느 공정에나 통한다.
        (qualification.processCode === null || qualification.processCode === processCode),
    );
    if (isQualified) return [];

    const message = `${worker.worker_no}(${worker.worker_name})에게 ${processCode} 공정 수행 자격이 없습니다.`;
    if (level === 'BLOCK') throw new ForbiddenException(message);
    return [message];
  }

  private async resolveShift(
    shiftCode: string | undefined,
    workOrder: WorkOrderDetail,
    plantId: bigint,
  ): Promise<shiftModel> {
    if (shiftCode) {
      return orFail(
        await this.prisma.shift.findFirst({
          where: { plant_id: plantId, shift_code: shiftCode, is_active: true },
        }),
        `근무조(${shiftCode})`,
      );
    }
    if (workOrder.shift) return workOrder.shift;

    // work_session.shift_id는 NOT NULL이다. 시각으로 근무조를 추정하면 자정을 넘는
    // 교대에서 조용히 틀리므로, 계획이 없으면 현장이 고르게 한다.
    throw new BadRequestException(
      '근무조를 결정할 수 없습니다. 작업지시에 계획 근무조가 없으니 shiftCode를 지정하십시오.',
    );
  }

  private async resolveEquipment(
    equipmentCode: string | undefined,
    workOrder: WorkOrderDetail,
    plantId: bigint,
  ): Promise<equipmentModel | null> {
    const resolved = equipmentCode
      ? orFail(
          await this.prisma.equipment.findFirst({
            where: { plant_id: plantId, equipment_code: equipmentCode, is_active: true },
          }),
          `설비(${equipmentCode})`,
        )
      : workOrder.equipment;

    if (!resolved && workOrder.routing_operation.equipment_required) {
      throw new BadRequestException(
        '이 공정은 설비 지정이 필수입니다. equipmentCode를 지정하십시오.',
      );
    }
    return resolved;
  }

  private async resolveMold(
    moldCode: string | undefined,
    workOrder: WorkOrderDetail,
    plantId: bigint,
  ): Promise<moldModel | null> {
    const resolved = moldCode
      ? orFail(
          await this.prisma.mold.findFirst({
            where: { plant_id: plantId, mold_code: moldCode, is_active: true },
          }),
          `금형(${moldCode})`,
        )
      : workOrder.mold;

    if (!resolved && workOrder.routing_operation.mold_required) {
      throw new BadRequestException('이 공정은 금형 지정이 필수입니다. moldCode를 지정하십시오.');
    }
    return resolved;
  }

  /**
   * 같은 작업지시의 다음 회차. 두 단말이 동시에 같은 번호를 집으면 uq_work_session이
   * 막아 409가 된다 — 앱에서 잠그지 않고 DB 제약에 맡긴다.
   */
  private async nextSessionNo(workOrderId: bigint): Promise<number> {
    const last = await this.prisma.work_session.aggregate({
      where: { work_order_id: workOrderId },
      _max: { session_no: true },
    });
    return (last._max.session_no ?? 0) + 1;
  }
}
