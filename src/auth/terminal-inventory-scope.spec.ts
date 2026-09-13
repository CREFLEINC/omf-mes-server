import type { Request } from 'express';

import { ContractException } from '../common/errors';
import { inventoryWriteActorOf } from '../inventory/inventory-write-actor';
import type { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';
import {
  assertTerminalInventoryScope,
  currentTerminalInventoryScope,
  TERMINAL_INVENTORY_OPERATIONS,
} from './terminal-inventory-scope';

describe('TERMINAL_INVENTORY_OPERATIONS', () => {
  it('allows only the reviewed mobile inventory routes and never blanket write access', () => {
    expect(Object.keys(TERMINAL_INVENTORY_OPERATIONS)).toEqual([
      'GET /inventory/balances',
      'GET /inventory/counts',
      'GET /inventory/counts/{inventoryCountId}/lines',
      'PUT /inventory/counts/{inventoryCountId}/lines',
      'GET /inventory/handling-units',
      'GET /inventory/handling-units/{handlingUnitId}',
      'GET /inventory/handling-units/{handlingUnitId}/contents',
      'PUT /inventory/handling-units/{handlingUnitId}/contents',
      'GET /inventory/handling-units/{handlingUnitId}/repack-events',
      'POST /inventory/handling-units',
      'POST /inventory/handling-units/{handlingUnitId}:pack',
      'POST /inventory/adjustments',
    ]);
    expect(TERMINAL_INVENTORY_OPERATIONS['POST /inventory/counts']).toBeUndefined();
    expect(TERMINAL_INVENTORY_OPERATIONS['POST /inventory/adjustments/{inventoryAdjustmentId}:post']).toBeUndefined();
    expect(TERMINAL_INVENTORY_OPERATIONS['GET /inventory/handling-units']).toEqual(['POP', 'MOBILE']);
    expect(TERMINAL_INVENTORY_OPERATIONS['POST /inventory/handling-units']).toEqual(['POP', 'MOBILE']);
  });
});

describe('assertTerminalInventoryScope', () => {
  const terminal: TerminalContext = {
    terminalId: 11n, terminalCode: 'M-FR005', plantId: 1n, terminalTypeCode: 'MOBILE', equipmentId: null,
  };
  const request = (params: Record<string, string>, body: unknown = {}) => ({
    params, query: {}, body, header: (name: string) => name === 'X-Worker-No' ? '900028'
      : name === 'Idempotency-Key' ? 'inventory-test-key' : undefined,
  }) as unknown as Request;

  it('allows a plant-owned HU detail and attaches a concrete scope for the controller', async () => {
    const prisma = { handling_unit: { findFirst: jest.fn().mockResolvedValue({ handling_unit_id: 7n }) } } as unknown as PrismaService;
    const req = request({ handlingUnitId: '7' });
    await expect(assertTerminalInventoryScope(prisma, req, 'GET /inventory/handling-units/{handlingUnitId}', terminal)).resolves.toBeUndefined();
    expect(currentTerminalInventoryScope(req)).toMatchObject({ plantId: 1n, terminalId: 11n });
    expect((prisma.handling_unit.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({ handling_unit_id: 7n });
  });

  it('requires both a plant-owned HU and active worker for a terminal pack write', async () => {
    const prisma = {
      handling_unit: { findFirst: jest.fn().mockResolvedValue({ handling_unit_id: 7n }) },
      worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 3n }) },
    } as unknown as PrismaService;
    const req = request({ handlingUnitId: '7' });
    await expect(assertTerminalInventoryScope(prisma, req, 'POST /inventory/handling-units/{handlingUnitId}:pack', terminal)).resolves.toBeUndefined();
    expect((prisma.worker.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({ worker_no: '900028', plant_id: 1n, is_active: true });
    expect(inventoryWriteActorOf(req, 'POST /inventory/handling-units/{handlingUnitId}:pack')).toEqual({
      workerId: 3n,
      terminalAudit: { workerId: 3n, workerNo: '900028', terminalId: 11n,
        plantId: 1n, correlationId: 'inventory-test-key',
        operationKey: 'POST /inventory/handling-units/{handlingUnitId}:pack' },
    });
  });

  it('rejects a worker missing from the terminal plant before attaching an actor', async () => {
    const prisma = {
      handling_unit: { findFirst: jest.fn().mockResolvedValue({ handling_unit_id: 7n }) },
      worker: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const req = request({ handlingUnitId: '7' });
    await expect(assertTerminalInventoryScope(prisma, req, 'POST /inventory/handling-units/{handlingUnitId}:pack', terminal)).rejects.toBeInstanceOf(ContractException);
    expect(currentTerminalInventoryScope(req)).toBeUndefined();
  });

  it('rejects a detail outside the terminal plant', async () => {
    const prisma = { handling_unit: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    await expect(assertTerminalInventoryScope(prisma, request({ handlingUnitId: '9' }), 'GET /inventory/handling-units/{handlingUnitId}', terminal)).rejects.toBeInstanceOf(ContractException);
  });
});
