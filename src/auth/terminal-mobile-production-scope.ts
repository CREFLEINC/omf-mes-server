import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';

export const TERMINAL_MOBILE_PRODUCTION_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'POST /production/operation-handovers': ['MOBILE'],
  'POST /production/repair-executions': ['MOBILE'],
  'POST /production/repair-executions/{repairExecutionId}:return': ['MOBILE'],
};

const WORKER = Symbol('terminalMobileProductionWorkerId');
export function currentTerminalMobileProductionWorkerId(request: Request): bigint | undefined {
  return (request as Request & { [WORKER]?: bigint })[WORKER];
}

export async function assertTerminalMobileProductionScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (!TERMINAL_MOBILE_PRODUCTION_OPERATIONS[key] || terminal.terminalTypeCode !== 'MOBILE') throw denied();
  const workerNo = request.headers['x-worker-no'];
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof workerNo !== 'string' || !workerNo.trim()
    || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw denied();
  const worker = await prisma.worker.findFirst({ where: {
    worker_no: workerNo, plant_id: terminal.plantId, is_active: true,
  }, select: { worker_id: true } });
  if (!worker) throw denied();

  const body = request.body as Record<string, unknown> | undefined;
  switch (key) {
    case 'POST /production/operation-handovers': {
      const from = positiveId(body?.fromWorkOrderId);
      const to = positiveId(body?.toWorkOrderId);
      const lines = body?.lines;
      if (from === null || to === null || from === to || !Array.isArray(lines) || lines.length === 0) throw denied();
      const lotIds = lines.map((line) => positiveId((line as Record<string, unknown>)?.lotId));
      if (lotIds.some((id) => id === null)) throw denied();
      const [workOrders, lots] = await Promise.all([
        prisma.work_order.count({ where: {
          work_order_id: { in: [from, to] }, production_line: { plant_id: terminal.plantId },
        } }),
        prisma.lot.count({ where: { lot_id: { in: lotIds as bigint[] }, plant_id: terminal.plantId } }),
      ]);
      if (workOrders !== 2 || lots !== new Set(lotIds.map(String)).size) throw denied();
      break;
    }
    case 'POST /production/repair-executions': {
      const defectId = positiveId(body?.defectRecordId);
      if (defectId === null || !await ownDefect(prisma, defectId, terminal.plantId)) throw denied();
      break;
    }
    case 'POST /production/repair-executions/{repairExecutionId}:return': {
      const id = positiveId(request.params.repairExecutionId);
      const row = id === null ? null : await prisma.repair_execution.findFirst({ where: {
        repair_execution_id: id,
        defect_record: { OR: [
          { lot: { plant_id: terminal.plantId }, work_order_id: null },
          { work_order: { production_line: { plant_id: terminal.plantId } }, lot_id: null },
          { lot: { plant_id: terminal.plantId }, work_order: { production_line: { plant_id: terminal.plantId } } },
        ] },
      }, select: { repair_execution_id: true } });
      if (!row) throw denied();
      break;
    }
    default: throw denied();
  }
  Object.defineProperty(request, WORKER, { value: worker.worker_id, configurable: true });
}

async function ownDefect(prisma: PrismaService, defectId: bigint, plantId: bigint): Promise<boolean> {
  const row = await prisma.defect_record.findFirst({ where: {
    defect_record_id: defectId,
    OR: [
      { lot: { plant_id: plantId }, work_order_id: null },
      { work_order: { production_line: { plant_id: plantId } }, lot_id: null },
      { lot: { plant_id: plantId }, work_order: { production_line: { plant_id: plantId } } },
    ],
  }, select: { defect_record_id: true } });
  return row !== null;
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
