import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import type { TerminalWorkerAuditActor } from '../audit/terminal-worker-audit';
import { currentSession } from '../auth/session-resolver.service';
import { currentTerminal } from '../auth/terminal-context';
import { currentTerminalMaintenanceWorkerId } from '../auth/terminal-maintenance-scope';

export type MaintenanceWriteActor =
  | { appUserId: number; terminalAudit?: never }
  | { appUserId?: never; terminalAudit: TerminalWorkerAuditActor };

export function maintenanceWriteActorOf(request: Request, operationKey: string): MaintenanceWriteActor {
  const terminal = currentTerminal(request);
  if (terminal !== undefined) {
    const workerId = currentTerminalMaintenanceWorkerId(request);
    const workerNo = request.headers['x-worker-no'];
    const correlationId = request.headers['idempotency-key'];
    if (workerId === undefined || typeof workerNo !== 'string' || !workerNo.trim()
      || typeof correlationId !== 'string' || !correlationId.trim())
      throw new UnauthorizedException('단말 작업자와 멱등 키가 필요합니다.');
    return { terminalAudit: {
      workerId, workerNo, terminalId: terminal.terminalId, plantId: terminal.plantId,
      correlationId, operationKey,
    } };
  }
  const session = currentSession(request);
  if (!session) throw new UnauthorizedException('로그인이 필요합니다.');
  return { appUserId: session.userId };
}
