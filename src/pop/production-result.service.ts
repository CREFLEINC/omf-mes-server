import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, production_result } from '@prisma/client';

import { TerminalAuthService, TerminalPrincipal } from '../auth/terminal-auth.service';
import { isDuplicateIdempotencyKey } from '../common/idempotency/idempotency.util';
import { orFail } from '../master-data/common/master-crud';
import { NumberingService } from '../master-data/numbering/numbering.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionResultDto } from './production-result.dto';

/** 실적을 올릴 수 있는 세션 상태. 종료된 세션에 뒤늦게 실적을 붙이지 않는다. */
const OPEN_SESSION_STATUS = 'OPEN';

/** 채번 문서유형 — DOCUMENT_TYPE 코드그룹. */
const DOCUMENT_TYPE = 'PRODUCTION_RESULT';

/** 현장 단말이 올린 실적임을 남긴다 — 설비 자동수집·관리 화면 수기와 구분한다. */
const RESULT_SOURCE_POP = 'POP';

/** 등록 직후 상태. 정정·취소는 이 상태에서 갈라진다. */
const RESULT_STATUS_CONFIRMED = 'CONFIRMED';

const SESSION_DETAIL = {
  work_order: {
    include: {
      item: { select: { item_code: true, item_name: true } },
      uom: { select: { uom_id: true, uom_code: true } },
      routing_operation: { select: { process: { select: { process_code: true } } } },
      production_plan: { include: { production_order: { select: { plant_id: true } } } },
    },
  },
  work_session_worker: { include: { worker: { select: { worker_id: true, worker_no: true } } } },
} satisfies Prisma.work_sessionInclude;

type SessionDetail = Prisma.work_sessionGetPayload<{ include: typeof SESSION_DETAIL }>;

@Injectable()
export class ProductionResultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly terminals: TerminalAuthService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * 생산실적 등록 — 세션에 만든 수량을 매단다.
   *
   * **초과 생산을 막지 않는다.** 지시수량을 넘겨도 통과시킨다 — 초과분은 추가 생산LOT
   * 발행으로 처리하는 것이 확정 설계다(도식 02 태그 464:6653). 여기서 막으면 현장이
   * 이미 만든 물건을 시스템에 올리지 못한다.
   */
  async create(
    terminal: TerminalPrincipal,
    workSessionId: bigint,
    idempotencyKey: string,
    dto: CreateProductionResultDto,
  ) {
    // 재전송이 먼저다 — 세션이 이미 닫힌 뒤 도착한 재전송도 처음 만든 결과를 돌려줘야 한다.
    const replayed = await this.findReplay(idempotencyKey, workSessionId);
    if (replayed) return this.toResponse(replayed, true);

    const session = await this.getOpenSession(workSessionId, terminal);
    const workOrder = session.work_order;

    await this.terminals.assertCapability(
      terminal.terminalId,
      workOrder.routing_operation.process.process_code,
      'can_input_result',
    );

    const plantId = workOrder.production_plan.production_order.plant_id;
    const occurredAt = dto.occurredAt ?? new Date();
    const resultNo = await this.numbering.issue(DOCUMENT_TYPE, { plantId, on: occurredAt });

    try {
      const created = await this.prisma.production_result.create({
        data: {
          production_result_no: resultNo,
          work_order_id: workOrder.work_order_id,
          work_session_id: session.work_session_id,
          result_sequence: await this.nextSequence(workOrder.work_order_id),
          good_qty: dto.goodQty,
          uom_id: workOrder.uom.uom_id,
          result_source_code: RESULT_SOURCE_POP,
          occurred_at: occurredAt,
          worker_id: this.currentWorkerId(session),
          equipment_id: session.equipment_id,
          mold_id: session.mold_id,
          shift_id: session.shift_id,
          terminal_id: terminal.terminalId,
          status_code: RESULT_STATUS_CONFIRMED,
          idempotency_key: idempotencyKey,
          remarks: dto.remarks ?? null,
        },
      });
      return this.toResponse(created, false);
    } catch (error) {
      // 같은 키의 요청 둘이 동시에 들어오면 선제 조회를 둘 다 통과한다 — 진 쪽이 여기로
      // 온다. 이긴 쪽이 만든 결과를 그대로 돌려주는 것이 멱등이다(설계검토 §138).
      if (isDuplicateIdempotencyKey(error)) {
        const winner = await this.findReplay(idempotencyKey, workSessionId);
        if (winner) return this.toResponse(winner, true);
      }
      throw error;
    }
  }

  /**
   * 같은 키로 이미 만든 실적. **다른 세션의 것이면 거부한다** — 클라이언트가 키를
   * 재사용한 것이라, 남의 실적을 돌려주면 「등록됐다」는 거짓 응답이 된다.
   */
  private async findReplay(
    idempotencyKey: string,
    workSessionId: bigint,
  ): Promise<production_result | null> {
    const found = await this.prisma.production_result.findUnique({
      where: { idempotency_key: idempotencyKey },
    });
    if (!found) return null;

    if (found.work_session_id !== workSessionId) {
      throw new ConflictException(
        '다른 요청에 이미 사용된 Idempotency-Key입니다. 요청마다 새 키를 생성하십시오.',
      );
    }
    return found;
  }

  private async getOpenSession(
    workSessionId: bigint,
    terminal: TerminalPrincipal,
  ): Promise<SessionDetail> {
    const session = orFail(
      await this.prisma.work_session.findUnique({
        where: { work_session_id: workSessionId },
        include: SESSION_DETAIL,
      }),
      `작업 세션(${workSessionId})`,
    );

    if (session.work_order.production_plan.production_order.plant_id !== terminal.plantId) {
      throw new ForbiddenException('다른 공장의 작업 세션입니다.');
    }
    if (session.status_code !== OPEN_SESSION_STATUS || session.ended_at !== null) {
      throw new ForbiddenException(
        `열려 있지 않은 세션에는 실적을 올릴 수 없습니다: ${session.status_code}`,
      );
    }
    return session;
  }

  /** 실적 귀속 작업자 — 세션에 아직 남아 있는(퇴장하지 않은) 작업자가 주인이다. */
  private currentWorkerId(session: SessionDetail): bigint {
    const active = session.work_session_worker.find((row) => row.left_at === null);
    return (active ?? session.work_session_worker[0]).worker_id;
  }

  /**
   * 작업지시 안에서 1부터 증가한다. 경합으로 같은 값이 나가면 uq_production_result_seq가
   * 막아 409가 된다 — 앱에서 잠그지 않고 DB 제약에 맡긴다.
   */
  private async nextSequence(workOrderId: bigint): Promise<number> {
    const last = await this.prisma.production_result.aggregate({
      where: { work_order_id: workOrderId },
      _max: { result_sequence: true },
    });
    return (last._max.result_sequence ?? 0) + 1;
  }

  private toResponse(result: production_result, replayed: boolean) {
    return {
      productionResultId: result.production_result_id,
      productionResultNo: result.production_result_no,
      resultSequence: result.result_sequence,
      goodQty: result.good_qty.toNumber(),
      occurredAt: result.occurred_at,
      statusCode: result.status_code,
      // 재전송이 반영된 건지 처음 등록된 건지 현장이 구분할 수 있어야 한다.
      replayed,
    };
  }
}
