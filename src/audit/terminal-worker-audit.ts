import { UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface TerminalWorkerAuditActor {
  workerId: bigint;
  workerNo: string;
  terminalId: bigint;
  plantId: bigint;
  correlationId: string;
  operationKey: string;
}

export interface TerminalWorkerAuditInput {
  actor: TerminalWorkerAuditActor;
  targetTypeCode: string;
  targetId: bigint;
  eventTypeCode?: string;
}

/** Call after the business row is written, using the same transaction client. */
export async function recordTerminalWorkerAudit(
  tx: Prisma.TransactionClient,
  input: TerminalWorkerAuditInput,
): Promise<void> {
  const { actor, targetId, targetTypeCode } = input;
  const eventTypeCode = input.eventTypeCode ?? 'TERMINAL_WRITE';
  if (actor.workerId <= 0n || actor.terminalId <= 0n || actor.plantId <= 0n || targetId <= 0n
    || !bounded(actor.workerNo, 50) || !bounded(actor.correlationId, 150)
    || !bounded(actor.operationKey, 150) || !bounded(targetTypeCode, 50)
    || !bounded(eventTypeCode, 50)) throw new UnauthorizedException('단말 작업 감사 정보가 올바르지 않습니다.');
  const [worker, terminal] = await Promise.all([
    tx.worker.findFirst({
      where: { worker_id: actor.workerId, worker_no: actor.workerNo,
        plant_id: actor.plantId, is_active: true },
      select: { worker_id: true },
    }),
    tx.terminal.findFirst({
      where: { terminal_id: actor.terminalId, plant_id: actor.plantId, is_active: true },
      select: { terminal_id: true },
    }),
  ]);
  if (!worker || !terminal) throw new UnauthorizedException('활성 동일 공장 작업자와 단말이 필요합니다.');
  await tx.audit_event.create({ data: {
    occurred_at: new Date(),
    target_type_code: targetTypeCode,
    target_id: targetId,
    event_type_code: eventTypeCode,
    terminal_id: actor.terminalId,
    correlation_id: actor.correlationId,
    after_value: {
      workerId: actor.workerId.toString(),
      workerNo: actor.workerNo,
      plantId: actor.plantId.toString(),
      operationKey: actor.operationKey,
      targetId: targetId.toString(),
    },
  } });
}

function bounded(value: string, maxLength: number): boolean {
  return value.trim().length > 0 && value.length <= maxLength;
}
