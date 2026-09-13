import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';

type TerminalType = 'POP' | 'MOBILE';

/** Only inventory operations reached by a terminal caller. Writes are deliberately enumerated. */
export const TERMINAL_INVENTORY_OPERATIONS: Readonly<Record<string, readonly TerminalType[]>> = {
  'GET /inventory/balances': ['MOBILE'],
  'GET /inventory/counts': ['MOBILE'],
  'GET /inventory/counts/{inventoryCountId}/lines': ['MOBILE'],
  'PUT /inventory/counts/{inventoryCountId}/lines': ['MOBILE'],
  'GET /inventory/handling-units': ['POP', 'MOBILE'],
  'GET /inventory/handling-units/{handlingUnitId}': ['POP', 'MOBILE'],
  'GET /inventory/handling-units/{handlingUnitId}/contents': ['POP', 'MOBILE'],
  'PUT /inventory/handling-units/{handlingUnitId}/contents': ['MOBILE'],
  'GET /inventory/handling-units/{handlingUnitId}/repack-events': ['POP', 'MOBILE'],
  'POST /inventory/handling-units': ['POP', 'MOBILE'],
  'POST /inventory/handling-units/{handlingUnitId}:pack': ['POP', 'MOBILE'],
  'POST /inventory/adjustments': ['MOBILE'],
};

export interface TerminalInventoryScope {
  readonly plantId: bigint;
  readonly terminalId: bigint;
  readonly terminalTypeCode: TerminalType;
  readonly workerId?: bigint;
}

const ATTACHED_INVENTORY_SCOPE = Symbol('terminalInventoryScope');

/**
 * Inventory list queries do not all expose a plantId parameter (HU scan uses q only).
 * The controller/service must consume this attached constraint before it queries rows;
 * accepting the request without that consumer would expose another plant's inventory.
 */
export function currentTerminalInventoryScope(request: Request): TerminalInventoryScope | undefined {
  return (request as Request & { [ATTACHED_INVENTORY_SCOPE]?: TerminalInventoryScope })[
    ATTACHED_INVENTORY_SCOPE
  ];
}

export async function assertTerminalInventoryScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  const allowed = TERMINAL_INVENTORY_OPERATIONS[key];
  if (!allowed || !allowed.includes(terminal.terminalTypeCode as TerminalType)) throw denied();

  const query = request.query as Record<string, unknown>;
  const body = object(request.body);
  const plantId = terminal.plantId;
  const ownWarehouse = (value: unknown) => assertWarehouse(prisma, value, plantId);
  const ownLocation = (value: unknown) => assertLocation(prisma, value, plantId);
  const ownLot = (value: unknown) => assertLot(prisma, value, plantId);
  const ownHandlingUnit = (value: unknown) => assertHandlingUnit(prisma, value, plantId);
  const ownCount = (value: unknown) => assertCount(prisma, value, plantId);
  const workerId = key.startsWith('POST ') || key.startsWith('PUT ')
    ? await assertActiveWorker(prisma, request.header('X-Worker-No'), plantId)
    : undefined;

  switch (key) {
    case 'GET /inventory/balances':
      await Promise.all([optional(ownWarehouse, query.warehouseId), optional(ownLocation, query.locationId), optional(ownLot, query.lotId)]);
      break;
    case 'GET /inventory/counts':
      await optional(ownWarehouse, query.warehouseId);
      break;
    case 'GET /inventory/counts/{inventoryCountId}/lines':
      await Promise.all([ownCount(request.params.inventoryCountId), optional(ownLocation, query.locationId)]);
      break;
    case 'PUT /inventory/counts/{inventoryCountId}/lines':
      await Promise.all([
        ownCount(request.params.inventoryCountId),
        ownLocation(body.locationId),
        ...array(body.lines).flatMap((line) => [ownLocation(object(line).locationId), optional(ownLot, object(line).lotId)]),
      ]);
      break;
    case 'GET /inventory/handling-units':
      await Promise.all([optional(ownWarehouse, query.warehouseId), optional(ownLocation, query.locationId)]);
      break;
    case 'GET /inventory/handling-units/{handlingUnitId}':
    case 'GET /inventory/handling-units/{handlingUnitId}/contents':
    case 'GET /inventory/handling-units/{handlingUnitId}/repack-events':
      await ownHandlingUnit(request.params.handlingUnitId);
      break;
    case 'PUT /inventory/handling-units/{handlingUnitId}/contents':
      await Promise.all([
        ownHandlingUnit(request.params.handlingUnitId),
        ...array(body.items).map((line) => ownLot(object(line).lotId)),
      ]);
      break;
    case 'POST /inventory/handling-units':
      await Promise.all([
        optional(ownHandlingUnit, body.parentHandlingUnitId),
        optional(ownWarehouse, body.warehouseId),
        optional(ownLocation, body.locationId),
        ...array(body.contents).map((line) => ownLot(object(line).lotId)),
      ]);
      break;
    case 'POST /inventory/handling-units/{handlingUnitId}:pack':
      await ownHandlingUnit(request.params.handlingUnitId);
      break;
    case 'POST /inventory/adjustments':
      if (body.reasonCode !== 'HOPPER_MEASUREMENT') throw denied();
      await Promise.all([
        optional(ownCount, body.inventoryCountId),
        ...array(body.lines).flatMap((line) => [ownLocation(object(line).locationId), optional(ownLot, object(line).lotId)]),
      ]);
      break;
    default:
      throw denied();
  }

  Object.defineProperty(request, ATTACHED_INVENTORY_SCOPE, {
    value: Object.freeze({ plantId, terminalId: terminal.terminalId, terminalTypeCode: terminal.terminalTypeCode as TerminalType, workerId }),
    configurable: true,
  });
}

async function assertWarehouse(prisma: PrismaService, value: unknown, plantId: bigint): Promise<void> {
  const id = positiveId(value);
  if (id === null || !await prisma.warehouse.findFirst({ where: { warehouse_id: id, plant_id: plantId }, select: { warehouse_id: true } })) throw denied();
}

async function assertLocation(prisma: PrismaService, value: unknown, plantId: bigint): Promise<void> {
  const id = positiveId(value);
  if (id === null || !await prisma.location.findFirst({ where: { location_id: id, warehouse: { plant_id: plantId } }, select: { location_id: true } })) throw denied();
}

async function assertLot(prisma: PrismaService, value: unknown, plantId: bigint): Promise<void> {
  const id = positiveId(value);
  if (id === null || !await prisma.lot.findFirst({ where: { lot_id: id, plant_id: plantId }, select: { lot_id: true } })) throw denied();
}

async function assertCount(prisma: PrismaService, value: unknown, plantId: bigint): Promise<void> {
  const id = positiveId(value);
  if (id === null || !await prisma.inventory_count.findFirst({ where: { inventory_count_id: id, warehouse: { plant_id: plantId } }, select: { inventory_count_id: true } })) throw denied();
}

async function assertHandlingUnit(prisma: PrismaService, value: unknown, plantId: bigint): Promise<void> {
  const id = positiveId(value);
  if (id === null || !await prisma.handling_unit.findFirst({
    where: { handling_unit_id: id, OR: [{ warehouse: { plant_id: plantId } }, { location: { warehouse: { plant_id: plantId } } }] },
    select: { handling_unit_id: true },
  })) throw denied();
}

async function assertActiveWorker(prisma: PrismaService, workerNo: string | undefined, plantId: bigint): Promise<bigint> {
  const worker = workerNo && await prisma.worker.findFirst({ where: { worker_no: workerNo, plant_id: plantId, is_active: true }, select: { worker_id: true } });
  if (!worker) throw denied();
  return worker.worker_id;
}

function optional(check: (value: unknown) => Promise<void>, value: unknown): Promise<void> {
  return value === undefined || value === null || value === '' ? Promise.resolve() : check(value);
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = BigInt(text);
  return id > 0n && id < 9223372036854775808n ? id : null;
}
function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [{ scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' }]);
}
