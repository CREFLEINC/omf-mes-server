import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { currentTerminal } from '../../auth/terminal-context';
import { resolveTerminalId } from '../../auth/terminal-token';
import type { TerminalWorkerAuditActor } from '../../audit/terminal-worker-audit';
import { ContractException, ERROR_CODE, field } from '../../common/errors';
import {
  IdempotencyContext,
  requestFingerprint,
} from '../../common/idempotency';
import { PrismaService } from '../../prisma/prisma.service';

export type DocumentIssueReportContext = IdempotencyContext & {
  appUserId?: number;
  workerNo: string;
  terminalId: bigint | null;
  terminalAudit?: Omit<TerminalWorkerAuditActor, 'workerId'>;
};

export async function documentIssueReportContext(
  request: Request,
  jwt: JwtService,
  prisma: PrismaService,
): Promise<DocumentIssueReportContext> {
  const session = currentSession(request);
  const terminal = currentTerminal(request);
  if (session === undefined && terminal === undefined)
    throw new UnauthorizedException('로그인이 필요합니다.');
  const workerNo = requiredWorkerNo(request.headers['x-worker-no']);
  const terminalId = terminal?.terminalId ?? await resolveTerminalId(jwt, prisma, request);
  const key = String(request.headers['idempotency-key']);
  return {
    key,
    appUserId: session?.userId,
    workerNo,
    terminalId,
    terminalAudit: terminal === undefined ? undefined : {
      workerNo, terminalId: terminal.terminalId, plantId: terminal.plantId,
      correlationId: key, operationKey: 'POST /app/document-issues/{documentIssueLogId}:report-print',
    },
    successStatus: HttpStatus.OK,
    fingerprint: requestFingerprint(`${request.method} ${request.path}`, {
      body: request.body,
      query: request.query,
      actor: {
        appUserId: session?.userId ?? null,
        workerNo,
        terminalId: terminalId?.toString() ?? null,
      },
    }),
  };
}

function requiredWorkerNo(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw workerError(ERROR_CODE.REQUIRED, '작업자 사번이 필요합니다.');
  }
  if (value.length > 50) {
    throw workerError(ERROR_CODE.RANGE, '작업자 사번은 50자 이하여야 합니다.');
  }
  return value;
}

function workerError(code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    field('X-Worker-No', code, message),
  ]);
}
