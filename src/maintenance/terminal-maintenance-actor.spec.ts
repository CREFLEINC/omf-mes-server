import type { Request } from 'express';

import { assertTerminalMaintenanceScope } from '../auth/terminal-maintenance-scope';
import { attachTerminal, type TerminalContext } from '../auth/terminal-context';
import { PrismaService } from '../prisma/prisma.service';
import { breakdownWriteContext } from './breakdown/breakdown-write-context';

it('uses the same-plant worker and terminal rather than an invented app user', async () => {
  const terminal: TerminalContext = {
    terminalId: 7n, terminalCode: 'M-7', terminalTypeCode: 'MOBILE', plantId: 3n, equipmentId: null,
  };
  const req = {
    method: 'POST', path: '/maintenance/breakdowns', params: {},
    headers: { 'x-worker-no': 'W-3', 'idempotency-key': 'maintenance-1' },
    body: { equipmentId: 4, symptom: 'stopped' },
  } as unknown as Request;
  const prisma = {
    worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 23n }) },
    equipment: { findFirst: jest.fn().mockResolvedValue({ equipment_id: 4n }) },
  } as unknown as PrismaService;
  await assertTerminalMaintenanceScope(prisma, req, 'POST /maintenance/breakdowns', terminal);
  attachTerminal(req, terminal);
  const ctx = breakdownWriteContext(req);
  expect(ctx.appUserId).toBeUndefined();
  expect(ctx.terminalAudit).toEqual({
    workerId: 23n, workerNo: 'W-3', terminalId: 7n, plantId: 3n,
    correlationId: 'maintenance-1', operationKey: 'POST /maintenance/breakdowns',
  });
});
