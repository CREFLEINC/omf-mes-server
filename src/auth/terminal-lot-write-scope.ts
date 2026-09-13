import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';

export const TERMINAL_LOT_WRITE_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'POST /trace/lots': ['POP', 'MOBILE'],
  'POST /trace/lots/{lotId}:request-iqc-skip': ['MOBILE'],
};

const WORKER = Symbol('terminalLotWorkerId');
export function currentTerminalLotWorkerId(request: Request): bigint | undefined {
  return (request as Request & { [WORKER]?: bigint })[WORKER];
}

export async function assertTerminalLotWriteScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (!TERMINAL_LOT_WRITE_OPERATIONS[key]?.includes(terminal.terminalTypeCode as 'POP' | 'MOBILE')) throw denied();
  const workerNo = request.headers['x-worker-no'];
  const correlationId = request.headers['idempotency-key'];
  if (typeof workerNo !== 'string' || !workerNo.trim()
    || typeof correlationId !== 'string' || !correlationId.trim()) throw denied();
  const worker = await prisma.worker.findFirst({ where: {
    worker_no: workerNo, plant_id: terminal.plantId, is_active: true,
  }, select: { worker_id: true } });
  if (!worker) throw denied();
  if (key === 'POST /trace/lots') {
    const body = request.body as Record<string, unknown> | undefined;
    const sourceId = positiveId(body?.sourceId);
    if (positiveId(body?.plantId) !== terminal.plantId || body?.sourceTypeCode !== 'INBOUND_RECEIPT_LINE'
      || sourceId === null) throw denied();
    const source = await prisma.inbound_receipt_line.findFirst({ where: {
      inbound_receipt_line_id: sourceId,
      inbound_receipt: { plant_id: terminal.plantId },
      lot_id: null,
    }, select: { inbound_receipt_line_id: true } });
    if (!source) throw denied();
  } else {
    const lotId = positiveId(request.params.lotId);
    const lot = lotId === null ? null : await prisma.lot.findFirst({ where: {
      lot_id: lotId, plant_id: terminal.plantId, source_type_code: 'INBOUND_RECEIPT_LINE',
    }, select: { lot_id: true } });
    if (!lot) throw denied();
  }
  Object.defineProperty(request, WORKER, { value: worker.worker_id, configurable: true });
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
