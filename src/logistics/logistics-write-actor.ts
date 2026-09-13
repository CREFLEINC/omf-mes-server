import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminalLogisticsWorkerId } from '../auth/terminal-logistics-scope';
import { currentTerminal } from '../auth/terminal-context';
import { currentSession } from '../auth/session-resolver.service';
import { TerminalWorkerAuditActor } from '../audit/terminal-worker-audit';

export type LogisticsWriteActor =
  | { appUserId: number; workerId?: never; terminalAudit?: never }
  | { appUserId?: never; workerId: bigint; terminalAudit: TerminalWorkerAuditActor };

export function logisticsWriteActorOf(request: Request, operationKey: string): LogisticsWriteActor {
  const terminal = currentTerminal(request);
  if (terminal !== undefined) {
    const workerId = currentTerminalLogisticsWorkerId(request);
    const workerNo = request.header('X-Worker-No');
    const correlationId = request.header('Idempotency-Key');
    if (workerId === undefined || !workerNo || !correlationId)
      throw new UnauthorizedException('단말 작업자와 멱등 키가 필요합니다.');
    return { workerId, terminalAudit: { workerId, workerNo,
      terminalId: terminal.terminalId, plantId: terminal.plantId,
      correlationId, operationKey } };
  }
  const session = currentSession(request);
  if (!session) throw new UnauthorizedException('세션이 필요합니다.');
  return { appUserId: session.userId };
}
