import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';
import { assertOwnedTarget } from './terminal-app-read-scope';

export const TERMINAL_APP_WRITE_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'POST /app/document-issues': ['POP'],
  'POST /app/document-issues/{documentIssueLogId}:report-print': ['POP'],
};

export async function assertTerminalAppWriteScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (terminal.terminalTypeCode !== 'POP') throw denied();
  const workerNo = request.headers['x-worker-no'];
  if (typeof workerNo !== 'string' || workerNo.trim() === '') throw denied();
  const worker = await prisma.worker.findFirst({
    where: { worker_no: workerNo, plant_id: terminal.plantId, is_active: true },
    select: { worker_id: true },
  });
  if (!worker) throw denied();
  if (key === 'POST /app/document-issues') {
    const body = request.body as { targets?: Array<{ targetTypeCode?: unknown; targetId?: unknown }> } | undefined;
    if (!Array.isArray(body?.targets) || body.targets.length === 0 || body.targets.length > 100) throw denied();
    for (const target of body.targets)
      await assertOwnedTarget(prisma, terminal, target?.targetTypeCode, target?.targetId);
    return;
  }
  if (key === 'POST /app/document-issues/{documentIssueLogId}:report-print') {
    const id = positiveId(request.params.documentIssueLogId);
    const issue = id === null ? null : await prisma.document_issue_log.findUnique({
      where: { document_issue_log_id: id },
      select: { target_type_code: true, target_id: true, terminal_id: true },
    });
    if (!issue || issue.terminal_id !== terminal.terminalId) throw denied();
    await assertOwnedTarget(prisma, terminal, issue.target_type_code, issue.target_id);
    return;
  }
  throw denied();
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = BigInt(value);
  return id > 0n && id < 9223372036854775808n ? id : null;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
