import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';

type TerminalType = 'POP' | 'MOBILE';

/** Explicit terminal GETs; each additional FR-005 group is reviewed for resource scope. */
export const TERMINAL_READ_OPERATIONS: Readonly<Record<string, readonly TerminalType[]>> = {
  'GET /mdm/workers': ['POP', 'MOBILE'],
  // MOBILE also reads its own row so registration can reject a non-MOBILE token before confirming (P-11).
  'GET /mdm/terminals/{terminalId}': ['POP', 'MOBILE'],
  'GET /production/work-orders': ['POP', 'MOBILE'],
  'GET /production/work-sessions': ['POP'],
  'GET /mdm/terminals/{terminalId}/processes': ['POP'],
  'GET /trace/lots': ['POP', 'MOBILE'],
  'GET /logistics/shopfloor-receipts': ['POP'],
  'GET /production/work-orders/{workOrderId}': ['POP'],
  'GET /mdm/uoms': ['POP', 'MOBILE'],
  'GET /logistics/purchase-orders': ['MOBILE'],
  'GET /mdm/items': ['POP', 'MOBILE'],
  'GET /logistics/putaway-tasks': ['MOBILE'],
  'GET /logistics/picking-orders': ['MOBILE'],
  'GET /mdm/warehouses': ['MOBILE'],
  'GET /logistics/inbound-receipts': ['MOBILE'],
  'GET /mdm/equipments/{equipmentId}/inspection-items': ['POP', 'MOBILE'],
  'GET /mdm/locations': ['MOBILE'],
  'GET /mdm/code-values': ['POP', 'MOBILE'],
  'GET /mdm/items/{itemId}': ['POP', 'MOBILE'],
  'GET /mdm/molds': ['POP'],
  'GET /mdm/molds/{moldId}': ['POP'],
  'GET /mdm/partners': ['POP', 'MOBILE'],
  'GET /mdm/equipments': ['MOBILE'],
  'GET /mdm/locations/{locationId}': ['MOBILE'],
  'GET /maintenance/breakdowns': ['POP', 'MOBILE'],
  'GET /maintenance/downtimes': ['POP'],
  'GET /maintenance/downtimes/summary': ['POP'],
  'GET /maintenance/inspections': ['POP', 'MOBILE'],
  'GET /trace/lots/{lotId}': ['POP', 'MOBILE'],
  'GET /trace/lots/{lotId}/holds': ['MOBILE'],
  'GET /trace/serial-numbers': ['POP'],
  'GET /production/material-consumptions': ['POP'],
};

export async function assertTerminalReadScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  const query = request.query as Record<string, unknown>;
  const plantId = terminal.plantId;

  const ownWorkOrder = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.work_order.findFirst({
      where: { work_order_id: id, production_line: { plant_id: plantId },
        ...(terminal.terminalTypeCode === 'POP'
          ? { released_at: { not: null }, completed_at: null, closed_at: null,
              NOT: { status_code: 'CANCELLED' },
              routing_operation: { process: { terminal_process: { some: {
                terminal_id: terminal.terminalId, can_start_work: true,
              } } } } } : {}) },
      select: { work_order_id: true },
    });
    if (!row) throw denied();
  };
  const ownEquipment = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    if (id === null || (terminal.terminalTypeCode === 'POP' && id !== terminal.equipmentId)) throw denied();
    const row = await prisma.equipment.findFirst({
      where: { equipment_id: id, plant_id: plantId }, select: { equipment_id: true },
    });
    if (!row) throw denied();
  };
  const ownLot = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.lot.findFirst({
      where: { lot_id: id, plant_id: plantId }, select: { lot_id: true },
    });
    if (!row) throw denied();
  };
  switch (key) {
    case 'GET /mdm/workers':
      if (terminal.terminalTypeCode === 'POP' && !nonempty(query.workerNo)
        && positiveId(query.plantId) !== plantId) throw denied();
      requirePlantQuery(request, plantId);
      break;
    case 'GET /mdm/terminals/{terminalId}':
    case 'GET /mdm/terminals/{terminalId}/processes':
      if (positiveId(request.params.terminalId) !== terminal.terminalId) throw denied();
      break;
    case 'GET /production/work-orders':
      if (terminal.terminalTypeCode === 'POP') {
        if (terminal.equipmentId === null || query.open !== 'true'
          || (query.plannedEquipmentId !== undefined
            && positiveId(query.plannedEquipmentId) !== terminal.equipmentId)) throw denied();
        // The query service intersects the list with this terminal's can_start_work processes.
      } else {
        await ownWorkOrder(query.successorOfWorkOrderId);
      }
      break;
    case 'GET /production/work-sessions':
    case 'GET /logistics/shopfloor-receipts':
    case 'GET /production/material-consumptions':
      await ownWorkOrder(query.workOrderId);
      break;
    case 'GET /production/work-orders/{workOrderId}':
      if (terminal.terminalTypeCode === 'POP') {
        const id = positiveId(request.params.workOrderId);
        const row = id === null ? null : await prisma.work_order.findFirst({
          where: { work_order_id: id, production_line: { plant_id: plantId },
            released_at: { not: null }, completed_at: null, closed_at: null,
            NOT: { status_code: 'CANCELLED' },
            routing_operation: { process: { terminal_process: {
              some: { terminal_id: terminal.terminalId, can_start_work: true },
            } } },
          },
          select: { work_order_id: true },
        });
        if (!row) throw denied();
      } else {
        await ownWorkOrder(request.params.workOrderId);
      }
      break;
    case 'GET /trace/lots':
      if (!nonempty(query.lotNo) && !nonempty(query.q) && positiveId(query.itemId) === null
        && positiveId(query.workOrderId) === null) throw denied();
      if (query.workOrderId !== undefined) await ownWorkOrder(query.workOrderId);
      requirePlantQuery(request, plantId);
      break;
    case 'GET /logistics/purchase-orders':
      if (positiveId(query.itemId) === null) throw denied();
      requirePlantQuery(request, plantId);
      break;
    case 'GET /logistics/inbound-receipts':
      requirePlantQuery(request, plantId);
      break;
    case 'GET /logistics/putaway-tasks':
    case 'GET /logistics/picking-orders': {
      const workerId = positiveId(query.assignedWorkerId);
      const worker = workerId === null ? null : await prisma.worker.findFirst({
        where: { worker_id: workerId, plant_id: plantId, is_active: true },
        select: { worker_id: true },
      });
      if (!worker) throw denied();
      break;
    }
    case 'GET /mdm/equipments/{equipmentId}/inspection-items': {
      const equipmentId = positiveId(request.params.equipmentId);
      if (terminal.terminalTypeCode === 'POP' && equipmentId !== terminal.equipmentId) throw denied();
      const equipment = equipmentId === null ? null : await prisma.equipment.findFirst({
        where: { equipment_id: equipmentId, plant_id: plantId },
        select: { equipment_id: true },
      });
      if (!equipment) throw denied();
      break;
    }
    case 'GET /mdm/locations': {
      const warehouseId = positiveId(query.warehouseId);
      const warehouse = warehouseId === null ? null : await prisma.warehouse.findFirst({
        where: { warehouse_id: warehouseId, plant_id: plantId },
        select: { warehouse_id: true },
      });
      if (!warehouse) throw denied();
      break;
    }
    case 'GET /mdm/locations/{locationId}': {
      const locationId = positiveId(request.params.locationId);
      const location = locationId === null ? null : await prisma.location.findFirst({
        where: { location_id: locationId, warehouse: { plant_id: plantId } },
        select: { location_id: true },
      });
      if (!location) throw denied();
      break;
    }
    case 'GET /mdm/molds':
    case 'GET /mdm/equipments':
      requirePlantQuery(request, plantId);
      break;
    case 'GET /mdm/molds/{moldId}': {
      const moldId = positiveId(request.params.moldId);
      const mold = moldId === null ? null : await prisma.mold.findFirst({
        where: { mold_id: moldId, plant_id: plantId },
        select: { mold_id: true },
      });
      if (!mold) throw denied();
      break;
    }
    case 'GET /mdm/items':
    case 'GET /mdm/items/{itemId}':
    case 'GET /mdm/partners':
    case 'GET /mdm/code-values':
    case 'GET /mdm/uoms':
    case 'GET /mdm/warehouses':
      break;
    case 'GET /maintenance/breakdowns':
    case 'GET /maintenance/downtimes':
    case 'GET /maintenance/downtimes/summary':
    case 'GET /maintenance/inspections':
      await ownEquipment(query.equipmentId);
      break;
    case 'GET /trace/lots/{lotId}':
    case 'GET /trace/lots/{lotId}/holds':
      await ownLot(request.params.lotId);
      break;
    case 'GET /trace/serial-numbers':
      await ownLot(query.lotId);
      break;
    default:
      throw denied();
  }
}

function requirePlantQuery(request: Request, plantId: bigint): void {
  const query = request.query as Record<string, unknown>;
  if (query.plantId !== undefined && positiveId(query.plantId) !== plantId) throw denied();
  Object.defineProperty(request, 'query', {
    value: { ...query, plantId: Number(plantId) }, writable: true, configurable: true,
  });
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = BigInt(text);
  return id > 0n && id < 9223372036854775808n ? id : null;
}

function nonempty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
