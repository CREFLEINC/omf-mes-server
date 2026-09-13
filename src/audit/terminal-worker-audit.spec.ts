import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit, TerminalWorkerAuditActor } from './terminal-worker-audit';

const actor: TerminalWorkerAuditActor = {
  workerId: 19n, workerNo: '900028', terminalId: 7n, plantId: 3n,
  correlationId: 'fr005-audit-1', operationKey: 'POST /inventory/adjustments',
};

function transaction() {
  const worker = jest.fn().mockResolvedValue({ worker_id: 19n });
  const terminal = jest.fn().mockResolvedValue({ terminal_id: 7n });
  const create = jest.fn().mockResolvedValue({ audit_event_id: 1n });
  const tx = { worker: { findFirst: worker }, terminal: { findFirst: terminal },
    audit_event: { create } } as unknown as Prisma.TransactionClient;
  return { tx, worker, terminal, create };
}

describe('terminal worker audit', () => {
  it('uses the caller business transaction and persists actual worker, terminal, key and target', async () => {
    const { tx, worker, terminal, create } = transaction();
    await recordTerminalWorkerAudit(tx, { actor, targetTypeCode: 'INVENTORY_ADJUSTMENT', targetId: 42n });
    expect(worker).toHaveBeenCalledWith({ where: { worker_id: 19n, worker_no: '900028',
      plant_id: 3n, is_active: true }, select: { worker_id: true } });
    expect(terminal).toHaveBeenCalledWith({ where: { terminal_id: 7n,
      plant_id: 3n, is_active: true }, select: { terminal_id: true } });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      target_type_code: 'INVENTORY_ADJUSTMENT', target_id: 42n,
      event_type_code: 'TERMINAL_WRITE', terminal_id: 7n,
      correlation_id: 'fr005-audit-1',
      after_value: { workerId: '19', workerNo: '900028', plantId: '3',
        operationKey: 'POST /inventory/adjustments', targetId: '42' },
    }) });
  });

  it('does not write an audit row for a foreign or inactive worker', async () => {
    const { tx, worker, create } = transaction();
    worker.mockResolvedValue(null);
    await expect(recordTerminalWorkerAudit(tx, {
      actor, targetTypeCode: 'INVENTORY_ADJUSTMENT', targetId: 42n,
    })).rejects.toMatchObject({ status: 401 });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a missing correlation key before touching business audit tables', async () => {
    const { tx, worker, create } = transaction();
    await expect(recordTerminalWorkerAudit(tx, {
      actor: { ...actor, correlationId: '' }, targetTypeCode: 'INVENTORY_ADJUSTMENT', targetId: 42n,
    })).rejects.toMatchObject({ status: 401 });
    expect(worker).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
