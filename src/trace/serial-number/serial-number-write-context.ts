import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { currentTerminal } from '../../auth/terminal-context';
import { resolveTerminalId } from '../../auth/terminal-token';
import { ContractException, ERROR_CODE, field } from '../../common/errors';
import {
  IdempotencyContext,
  requestFingerprint,
} from '../../common/idempotency';
import { PrismaService } from '../../prisma/prisma.service';

export type SerialNumberWriteContext = IdempotencyContext & {
  appUserId?: number;
  workerNo: string;
  terminalId: bigint | null;
};

export async function serialNumberWriteContext(
  request: Request,
  jwt: JwtService,
  prisma: PrismaService,
): Promise<SerialNumberWriteContext> {
  const session = currentSession(request);
  const terminal = currentTerminal(request);
  if (session === undefined && terminal === undefined)
    throw new UnauthorizedException('로그인이 필요합니다.');
  const workerNo = requiredWorkerNo(request.headers['x-worker-no']);
  const terminalId = await resolveTerminalId(jwt, prisma, request);
  // A field worker need not have an app account. Keep the worker number and
  // terminal as the actor; use a linked account for created_by only if one exists.
  const worker = terminal === undefined ? null : await prisma.worker.findFirst({
    where: { worker_no: workerNo, plant_id: terminal.plantId, is_active: true },
    select: { app_user_id: true },
  });
  if (terminal !== undefined && worker === null) throw new UnauthorizedException('작업자를 확인할 수 없습니다.');
  const appUserId = session?.userId ?? (worker?.app_user_id === undefined || worker?.app_user_id === null
    ? undefined : Number(worker.app_user_id));
  return {
    key: String(request.headers['idempotency-key']),
    ...(appUserId === undefined ? {} : { appUserId }),
    workerNo,
    terminalId,
    successStatus: HttpStatus.CREATED,
    fingerprint: requestFingerprint(`${request.method} ${request.path}`, {
      body: request.body,
      actor: {
        appUserId: appUserId ?? null,
        workerNo,
        terminalId: terminalId?.toString() ?? null,
      },
    }),
  };
}

function requiredWorkerNo(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw workerError(ERROR_CODE.REQUIRED, '작업자 사번이 필요합니다.');
  if (value.length > 50)
    throw workerError(ERROR_CODE.RANGE, '작업자 사번은 50자 이하여야 합니다.');
  return value;
}

function workerError(code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    field('X-Worker-No', code, message),
  ]);
}
