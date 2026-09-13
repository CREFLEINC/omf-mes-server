import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';
import { terminalQualityWorkOrderWhere } from './terminal-quality-read-scope';

export const TERMINAL_QUALITY_WRITE_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'POST /quality/inspection-results': ['POP'],
};

const ATTACHED = Symbol('terminalQualityWorkerId');

export function currentTerminalQualityWorkerId(request: Request): bigint | undefined {
  return (request as Request & { [ATTACHED]?: bigint })[ATTACHED];
}

/** A POP result may only target an inspection request for one of its assigned plant processes. */
export async function assertTerminalQualityWriteScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (key !== 'POST /quality/inspection-results' || terminal.terminalTypeCode !== 'POP') throw denied();
  const workerNo = request.headers['x-worker-no'];
  const requestId = positiveId((request.body as Record<string, unknown> | undefined)?.inspectionRequestId);
  const correlationId = request.headers['idempotency-key'];
  if (typeof workerNo !== 'string' || !workerNo.trim() || typeof correlationId !== 'string' || !correlationId.trim()
    || requestId === null) throw denied();
  const [worker, inspection] = await Promise.all([
    prisma.worker.findFirst({ where: {
      worker_no: workerNo, plant_id: terminal.plantId, is_active: true,
    }, select: { worker_id: true } }),
    prisma.inspection_request.findFirst({ where: {
      inspection_request_id: requestId,
      work_order: terminalQualityWorkOrderWhere({
        plantId: terminal.plantId, terminalId: terminal.terminalId, terminalTypeCode: 'POP',
      }),
    }, select: { inspection_request_id: true } }),
  ]);
  if (!worker || !inspection) throw denied();
  Object.defineProperty(request, ATTACHED, { value: worker.worker_id, configurable: true });
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^\d+$/.test(String(value))) return null;
  const id = BigInt(value);
  return id > 0n && id < 9223372036854775808n ? id : null;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
