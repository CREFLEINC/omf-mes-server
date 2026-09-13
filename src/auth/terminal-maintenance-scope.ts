import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';

/** Exact client maintenance writes. Each route checks its own equipment and worker scope. */
export const TERMINAL_MAINTENANCE_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'POST /maintenance/breakdowns': ['MOBILE'],
  'POST /maintenance/breakdowns/{breakdownId}/attachments': ['MOBILE'],
  'POST /maintenance/inspections': ['MOBILE'],
  'POST /maintenance/downtimes': ['POP'],
  'POST /maintenance/downtimes/{downtimeId}:close': ['POP'],
  'POST /maintenance/tool-usages': ['POP'],
};

const WORKER = Symbol('terminalMaintenanceWorkerId');

export function currentTerminalMaintenanceWorkerId(request: Request): bigint | undefined {
  return (request as Request & { [WORKER]?: bigint })[WORKER];
}

export async function assertTerminalMaintenanceScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  const workerNo = request.headers['x-worker-no'];
  const worker = typeof workerNo !== 'string' || !workerNo.trim() ? null : await prisma.worker.findFirst({
    where: { worker_no: workerNo.trim(), plant_id: terminal.plantId, is_active: true },
    select: { worker_id: true },
  });
  if (!worker) throw denied();
  const body = request.body as Record<string, unknown> | undefined;
  switch (key) {
    case 'POST /maintenance/breakdowns':
    case 'POST /maintenance/inspections':
    case 'POST /maintenance/downtimes': {
      const mobile = key !== 'POST /maintenance/downtimes';
      if (terminal.terminalTypeCode !== (mobile ? 'MOBILE' : 'POP')) throw denied();
      const equipmentId = positiveId(body?.equipmentId);
      if (equipmentId === null) throw denied();
      await ownEquipment(prisma, terminal, equipmentId);
      if (key === 'POST /maintenance/downtimes' && body?.breakdownId != null)
        await ownBreakdown(prisma, terminal, positiveId(body.breakdownId), equipmentId);
      if (key === 'POST /maintenance/inspections') {
        const lines = body?.lines;
        if (!Array.isArray(lines) || lines.length === 0) throw denied();
        const ids = lines.map((line) => positiveId((line as Record<string, unknown>)?.inspectionItemId));
        if (ids.some((id) => id === null)) throw denied();
        const count = await prisma.equipment_inspection_item_assignment.count({ where: {
          equipment_id: equipmentId, equipment_inspection_item_id: { in: ids as bigint[] }, is_active: true,
        } });
        if (count !== new Set(ids.map(String)).size) throw denied();
      }
      break;
    }
    case 'POST /maintenance/breakdowns/{breakdownId}/attachments':
      if (terminal.terminalTypeCode !== 'MOBILE') throw denied();
      await ownBreakdown(prisma, terminal, positiveId(request.params.breakdownId));
      break;
    case 'POST /maintenance/downtimes/{downtimeId}:close': {
      if (terminal.terminalTypeCode !== 'POP' || terminal.equipmentId === null) throw denied();
      const downtimeId = positiveId(request.params.downtimeId);
      const row = downtimeId === null ? null : await prisma.equipment_downtime.findFirst({
        where: { equipment_downtime_id: downtimeId, equipment_id: terminal.equipmentId,
          equipment: { plant_id: terminal.plantId } }, select: { equipment_downtime_id: true },
      });
      if (!row) throw denied();
      break;
    }
    case 'POST /maintenance/tool-usages': {
      if (terminal.terminalTypeCode !== 'POP') throw denied();
      const moldId = positiveId(body?.moldId);
      const workOrderId = positiveId(body?.workOrderId);
      const [mold, workOrder] = await Promise.all([
        moldId === null ? null : prisma.mold.findFirst({ where: { mold_id: moldId, plant_id: terminal.plantId }, select: { mold_id: true } }),
        workOrderId === null ? null : prisma.work_order.findFirst({ where: {
          work_order_id: workOrderId, production_line: { plant_id: terminal.plantId },
          routing_operation: { process: { terminal_process: { some: {
            terminal_id: terminal.terminalId, can_start_work: true,
          } } } },
        }, select: { work_order_id: true } }),
      ]);
      if (!mold || !workOrder) throw denied();
      break;
    }
    default:
      throw denied();
  }
  Object.defineProperty(request, WORKER, { value: worker.worker_id, configurable: true });
}

async function ownEquipment(prisma: PrismaService, terminal: TerminalContext, equipmentId: bigint | null): Promise<void> {
  if (equipmentId === null || (terminal.terminalTypeCode === 'POP' && equipmentId !== terminal.equipmentId)) throw denied();
  const row = await prisma.equipment.findFirst({ where: { equipment_id: equipmentId, plant_id: terminal.plantId },
    select: { equipment_id: true } });
  if (!row) throw denied();
}

async function ownBreakdown(prisma: PrismaService, terminal: TerminalContext,
  breakdownId: bigint | null, equipmentId?: bigint | null): Promise<void> {
  const row = breakdownId === null ? null : await prisma.breakdown.findFirst({ where: {
    breakdown_id: breakdownId, equipment: { plant_id: terminal.plantId },
    ...(equipmentId === undefined || equipmentId === null ? {} : { equipment_id: equipmentId }),
  }, select: { breakdown_id: true } });
  if (!row) throw denied();
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = BigInt(text);
  return id > 0n && id < 9223372036854775808n ? id : null;
}
function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
