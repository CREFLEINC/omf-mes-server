import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';

/** POP production actions supported by an installed terminal, never administrator actions. */
export const TERMINAL_PRODUCTION_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'GET /production/work-sessions/{workSessionId}/events': ['POP'],
  'GET /production/work-sessions/{workSessionId}/workers': ['POP'],
  'POST /production/work-sessions/{workSessionId}/workers': ['POP'],
  'POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave': ['POP'],
  'POST /production/precheck-decisions': ['POP'],
  'POST /production/work-sessions': ['POP'],
  'POST /production/work-orders/{workOrderId}:hold': ['POP'],
  'POST /production/work-orders/{workOrderId}:resume': ['POP'],
  'POST /production/work-sessions/{workSessionId}/events': ['POP'],
  'POST /production/production-results': ['POP'],
  'POST /trace/serial-numbers': ['POP'],
  'POST /production/material-consumptions': ['POP'],
  'POST /trace/lots/{lotId}:complete': ['POP'],
  'POST /production/work-sessions/{workSessionId}:end': ['POP'],
};

export async function assertTerminalProductionScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (terminal.terminalTypeCode !== 'POP' || !TERMINAL_PRODUCTION_OPERATIONS[key]) throw denied();
  const body = object(request.body);
  /** 단말 범위 안의 W/O 면 그 계획 설비를 돌려준다. */
  const ownWorkOrder = async (value: unknown): Promise<bigint | null> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.work_order.findFirst({
      where: { work_order_id: id, production_line: { plant_id: terminal.plantId },
        released_at: { not: null }, completed_at: null, closed_at: null,
        NOT: { status_code: 'CANCELLED' },
        routing_operation: { process: { terminal_process: {
          some: { terminal_id: terminal.terminalId, can_start_work: true },
        } } },
      },
      select: { work_order_id: true, planned_equipment_id: true },
    });
    if (!row) throw denied();
    return row.planned_equipment_id ?? null;
  };
  /**
   * 이 단말이 그 W/O 에 걸 수 있는 설비 — 설비 단말은 자기 설비, 설비 없는 단말은 W/O 의 계획 설비다.
   * 둘 다 없으면 걸 설비가 없다(작업 전 점검 없이 시작한다).
   */
  const usableEquipment = (plannedEquipmentId: bigint | null): bigint | null => terminal.equipmentId ?? plannedEquipmentId;
  const ownSession = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.work_session.findFirst({
      where: { work_session_id: id, terminal_id: terminal.terminalId,
        work_order: { production_line: { plant_id: terminal.plantId } } },
      select: { work_session_id: true },
    });
    if (!row) throw denied();
  };
  const ownLot = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.lot.findFirst({
      where: { lot_id: id, plant_id: terminal.plantId }, select: { lot_id: true },
    });
    if (!row) throw denied();
  };

  if (key.startsWith('POST ')) await activeWorker(prisma, request, terminal.plantId);
  switch (key) {
    case 'GET /production/work-sessions/{workSessionId}/events':
    case 'GET /production/work-sessions/{workSessionId}/workers':
    case 'POST /production/work-sessions/{workSessionId}/events':
    case 'POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave':
    case 'POST /production/work-sessions/{workSessionId}:end':
      await ownSession(request.params.workSessionId);
      break;
    case 'POST /production/work-sessions/{workSessionId}/workers': {
      await ownSession(request.params.workSessionId);
      // 함께 일할 사람도 이 단말 공장의 재직 작업자여야 한다.
      const workerId = positiveId(body.workerId);
      if (workerId === null || !await prisma.worker.findFirst({
        where: { worker_id: workerId, plant_id: terminal.plantId, is_active: true }, select: { worker_id: true },
      })) throw denied();
      break;
    }
    case 'POST /production/precheck-decisions': {
      const equipmentId = usableEquipment(await ownWorkOrder(body.workOrderId));
      if (equipmentId === null || positiveId(body.equipmentId) !== equipmentId) throw denied();
      break;
    }
    case 'POST /production/work-sessions': {
      const equipmentId = usableEquipment(await ownWorkOrder(body.workOrderId));
      if (body.equipmentId !== undefined && (equipmentId === null || positiveId(body.equipmentId) !== equipmentId)) throw denied();
      if (body.moldId !== undefined) {
        const moldId = positiveId(body.moldId);
        if (moldId === null || !await prisma.mold.findFirst({
          where: { mold_id: moldId, plant_id: terminal.plantId }, select: { mold_id: true },
        })) throw denied();
      }
      break;
    }
    case 'POST /production/work-orders/{workOrderId}:hold':
    case 'POST /production/work-orders/{workOrderId}:resume':
      await ownWorkOrder(request.params.workOrderId);
      break;
    case 'POST /production/production-results':
      await ownWorkOrder(body.workOrderId);
      for (const allocation of array(body.lotAllocations)) await ownLot(object(allocation).lotId);
      break;
    case 'POST /trace/serial-numbers':
      await ownLot(body.lotId);
      break;
    case 'POST /production/material-consumptions':
      await ownWorkOrder(body.workOrderId);
      await ownLot(body.lotId);
      if (body.workSessionId !== undefined) await ownSession(body.workSessionId);
      break;
    case 'POST /trace/lots/{lotId}:complete':
      await ownLot(request.params.lotId);
      break;
    default:
      throw denied();
  }
}

async function activeWorker(prisma: PrismaService, request: Request, plantId: bigint): Promise<void> {
  const workerNo = request.headers['x-worker-no'];
  if (typeof workerNo !== 'string' || !workerNo.trim() || !await prisma.worker.findFirst({
    where: { worker_no: workerNo.trim(), plant_id: plantId, is_active: true },
    select: { worker_id: true },
  })) throw denied();
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = BigInt(text);
  return id > 0n && id < 9223372036854775808n ? id : null;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
