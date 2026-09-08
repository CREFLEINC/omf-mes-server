import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { resolveTerminalId } from '../../auth/terminal-token';
import { ContractException, ERROR_CODE, field } from '../../common/errors';
import {
  IdempotencyContext,
  requestFingerprint,
} from '../../common/idempotency';
import { PrismaService } from '../../prisma/prisma.service';

export type DocumentIssueReportContext = IdempotencyContext & {
  appUserId: number;
  workerNo: string;
  terminalId: bigint | null;
};

export async function documentIssueReportContext(
  request: Request,
  jwt: JwtService,
  prisma: PrismaService,
): Promise<DocumentIssueReportContext> {
  const session = currentSession(request);
  if (session === undefined)
    throw new UnauthorizedException('로그인이 필요합니다.');
  const workerNo = requiredWorkerNo(request.headers['x-worker-no']);
  const terminalId = await resolveTerminalId(jwt, prisma, request);
  return {
    key: String(request.headers['idempotency-key']),
    appUserId: session.userId,
    workerNo,
    terminalId,
    successStatus: HttpStatus.OK,
    fingerprint: requestFingerprint(`${request.method} ${request.path}`, {
      body: request.body,
      query: request.query,
      actor: {
        appUserId: session.userId,
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
