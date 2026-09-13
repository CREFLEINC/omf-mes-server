import { Prisma } from '@prisma/client';

import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryWriteActor } from '../inventory-write-actor';
import { InventoryAdjustmentQueryService } from './inventory-adjustment-query.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';

const ACTOR: InventoryWriteActor = { workerId: 8n, terminalAudit: {
  workerId: 8n, workerNo: '900028', terminalId: 7n, plantId: 61n,
  correlationId: 'hopper-1', operationKey: 'POST /inventory/adjustments',
} };
const INPUT = { reasonCode: 'HOPPER_MEASUREMENT', businessDate: '2026-09-12',
  occurredAt: '2026-09-12T04:00:00.000Z', lines: [
    { locationId: 21, itemId: 11, adjustmentQty: 1, uomId: 31, reasonCode: 'HOPPER_MEASUREMENT' },
  ] };

function fixture(options: { auditFails?: boolean; workerActive?: boolean; terminalActive?: boolean } = {}) {
  const events: string[] = [];
  const committed: string[] = [];
  const auditCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    events.push('audit');
    if (options.auditFails) throw new Error('audit insert failed');
    return data;
  });
  const tx = {
    inventory_adjustment: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      events.push('adjustment');
      return { inventory_adjustment_id: 71n, data };
    }) },
    worker: { findFirst: jest.fn().mockResolvedValue(options.workerActive === false ? null : { worker_id: 8n }) },
    terminal: { findFirst: jest.fn().mockResolvedValue(options.terminalActive === false ? null : { terminal_id: 7n }) },
    audit_event: { create: auditCreate },
  };
  const prisma = {
    item: { findMany: jest.fn().mockResolvedValue([{ item_id: 11n }]) },
    lot: { findMany: jest.fn().mockResolvedValue([]) },
    uom: { findMany: jest.fn().mockResolvedValue([{ uom_id: 31n }]) },
    location: { findMany: jest.fn().mockResolvedValue([{
      location_id: 21n, warehouse_id: 41n,
      warehouse: { business_unit_id: 51n, plant_id: 61n, plant: { legal_entity_id: 81n } },
    }]) },
    inventory_count_line: { findMany: jest.fn().mockResolvedValue([]) },
    code_value: { findMany: jest.fn().mockResolvedValue([{
      code: 'HOPPER_MEASUREMENT', code_group: { group_code: 'INVENTORY_ADJUSTMENT_REASON' },
    }]) },
    inventory_balance: { findMany: jest.fn().mockResolvedValue([{
      legal_entity_id: 81n, business_unit_id: 51n, plant_id: 61n, warehouse_id: 41n,
      location_id: 21n, item_id: 11n, lot_id: null,
      quality_status_code: 'GOOD', inventory_status_code: 'AVAILABLE',
      on_hand_qty: new Prisma.Decimal(10),
    }]) },
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
      const result = await work(tx);
      committed.push(...events);
      return result;
    }),
  } as unknown as PrismaService;
  const queries = { get: jest.fn().mockResolvedValue({ detail: {
    inventoryAdjustment: { inventoryAdjustmentId: 71, statusCode: 'POSTED' }, lines: [],
  }, versionNo: 2 }) };
  const service = new InventoryAdjustmentService(
    prisma, queries as unknown as InventoryAdjustmentQueryService,
    { next: jest.fn().mockResolvedValue('IA-001') } as unknown as NumberingService,
    undefined as never, undefined as never, undefined as never,
  );
  // Ledger posting itself is covered by adjustment-posting.spec; this test
  // enforces create → post → worker audit inside the same transaction client.
  const postWithin = jest.fn(async (actualTx: unknown, _id: number, _version: number,
    post: { businessDate: string; occurredAt: string }, actor: InventoryWriteActor) => {
    expect(actualTx).toBe(tx);
    expect(post).toEqual({ businessDate: INPUT.businessDate, occurredAt: INPUT.occurredAt });
    expect(actor).toBe(ACTOR);
    events.push('post');
    return {};
  });
  Object.defineProperty(service, 'postWithin', { value: postWithin });
  return { service, prisma, tx, queries, postWithin, events, committed, auditCreate };
}

describe('terminal hopper adjustment atomic worker audit', () => {
  it('creates, posts and records the actual worker/terminal/key in one transaction', async () => {
    const { service, tx, queries, events, committed, auditCreate } = fixture();
    const result = await service.create(INPUT, ACTOR);
    expect(events).toEqual(['adjustment', 'post', 'audit']);
    expect(committed).toEqual(events);
    expect(tx.inventory_adjustment.create.mock.calls[0][0].data).toMatchObject({
      created_by: null, updated_by: null,
      inventory_adjustment_line: { create: [expect.objectContaining({ created_by: null })] },
    });
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      target_type_code: 'INVENTORY_ADJUSTMENT', target_id: 71n,
      event_type_code: 'HOPPER_MEASUREMENT_POST', terminal_id: 7n, correlation_id: 'hopper-1',
      after_value: expect.objectContaining({ workerId: '8', workerNo: '900028',
        plantId: '61', operationKey: 'POST /inventory/adjustments' }),
    }) });
    expect(queries.get).toHaveBeenCalledWith(71);
    expect(result.versionNo).toBe(2);
  });

  it('rolls back the business result when audit insertion fails', async () => {
    const { service, committed, queries, events } = fixture({ auditFails: true });
    await expect(service.create(INPUT, ACTOR)).rejects.toThrow('audit insert failed');
    expect(events).toEqual(['adjustment', 'post', 'audit']);
    expect(committed).toEqual([]);
    expect(queries.get).not.toHaveBeenCalled();
  });

  it.each([{ workerActive: false }, { terminalActive: false }])(
    'rejects a worker or terminal no longer active in the plant', async (option) => {
      const { service, committed, auditCreate } = fixture(option);
      await expect(service.create(INPUT, ACTOR)).rejects.toMatchObject({ status: 401 });
      expect(committed).toEqual([]);
      expect(auditCreate).not.toHaveBeenCalled();
    },
  );

  it('does not let a terminal post an arbitrary reason or omit fixed moments', async () => {
    const { service, prisma } = fixture();
    await expect(service.create({ ...INPUT, reasonCode: 'COUNT_ERROR' }, ACTOR)).rejects.toMatchObject({ status: 400 });
    await expect(service.create({ ...INPUT, businessDate: undefined }, ACTOR)).rejects.toMatchObject({ status: 400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
