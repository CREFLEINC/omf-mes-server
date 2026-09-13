import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminalInventoryScope } from '../auth/terminal-inventory-scope';
import { currentSession } from '../auth/session-resolver.service';
import { TerminalWorkerAuditActor } from '../audit/terminal-worker-audit';

export type InventoryWriteActor =
  | { appUserId: number; workerId?: never; terminalAudit?: never }
  | { appUserId?: never; workerId: bigint; terminalAudit: TerminalWorkerAuditActor };

export function inventoryWriteActorOf(request: Request, operationKey: string): InventoryWriteActor {
  const terminal = currentTerminalInventoryScope(request);
  if (terminal !== undefined) {
    if (terminal.workerId === undefined) throw new UnauthorizedException('작업자 인증이 없습니다.');
    const workerNo = request.header('X-Worker-No');
    const correlationId = request.header('Idempotency-Key');
    if (!workerNo || !correlationId) throw new UnauthorizedException('작업자 또는 멱등 키가 없습니다.');
    return { workerId: terminal.workerId, terminalAudit: {
      workerId: terminal.workerId,
      workerNo,
      terminalId: terminal.terminalId,
      plantId: terminal.plantId,
      correlationId,
      operationKey,
    } };
  }
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return { appUserId: session.userId };
}
