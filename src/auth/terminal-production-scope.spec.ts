import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';
import { assertTerminalProductionScope } from './terminal-production-scope';

const terminal: TerminalContext = {
  terminalId: 7n, terminalCode: 'POP-7', plantId: 3n, terminalTypeCode: 'POP', equipmentId: 5n,
};
const prisma = {
  worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 19n }) },
  work_order: { findFirst: jest.fn().mockResolvedValue({ work_order_id: 11n }) },
  work_session: { findFirst: jest.fn().mockResolvedValue({ work_session_id: 29n }) },
  lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 43n }) },
  mold: { findFirst: jest.fn().mockResolvedValue({ mold_id: 53n }) },
} as unknown as PrismaService;

function request(body: Record<string, unknown> = {}, params: Record<string, string> = {}, workerNo?: string): Request {
  return { body, params, headers: workerNo ? { 'x-worker-no': workerNo } : {} } as unknown as Request;
}

describe('POP production terminal scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.worker.findFirst as jest.Mock).mockResolvedValue({ worker_id: 19n });
    (prisma.work_order.findFirst as jest.Mock).mockResolvedValue({ work_order_id: 11n });
    (prisma.work_session.findFirst as jest.Mock).mockResolvedValue({ work_session_id: 29n });
    (prisma.lot.findFirst as jest.Mock).mockResolvedValue({ lot_id: 43n });
    (prisma.mold.findFirst as jest.Mock).mockResolvedValue({ mold_id: 53n });
  });

  it('allows a mapped same-plant W/O and actual terminal equipment for session start', async () => {
    await assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, equipmentId: 5, moldId: 53 }, {}, '900028'),
      'POST /production/work-sessions', terminal);
    expect(prisma.work_order.findFirst).toHaveBeenCalledWith({
      where: { work_order_id: 11n, production_line: { plant_id: 3n },
        released_at: { not: null }, completed_at: null, closed_at: null,
        NOT: { status_code: 'CANCELLED' },
        routing_operation: { process: { terminal_process: {
          some: { terminal_id: 7n, can_start_work: true },
        } } },
      }, select: { work_order_id: true },
    });
  });

  it('rejects a different terminal equipment, worker plant, or unmapped W/O', async () => {
    await expect(assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, equipmentId: 6 }, {}, '900028'),
      'POST /production/work-sessions', terminal)).rejects.toMatchObject({ status: 401 });
    (prisma.worker.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, equipmentId: 5 }, {}, '900028'),
      'POST /production/work-sessions', terminal)).rejects.toMatchObject({ status: 401 });
    (prisma.work_order.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, equipmentId: 5 }, {}, '900028'),
      'POST /production/work-sessions', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('requires its own work session for read events and writes', async () => {
    await assertTerminalProductionScope(prisma,
      request({}, { workSessionId: '29' }),
      'GET /production/work-sessions/{workSessionId}/events', terminal);
    expect(prisma.work_session.findFirst).toHaveBeenCalledWith({
      where: { work_session_id: 29n, terminal_id: 7n,
        work_order: { production_line: { plant_id: 3n } } },
      select: { work_session_id: true },
    });
    (prisma.work_session.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ eventTypeCode: 'STOP' }, { workSessionId: '29' }, '900028'),
      'POST /production/work-sessions/{workSessionId}/events', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects another-plant LOT allocation and serial creation', async () => {
    (prisma.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, lotAllocations: [{ lotId: 43 }] }, {}, '900028'),
      'POST /production/production-results', terminal)).rejects.toMatchObject({ status: 401 });
    (prisma.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ lotId: 43 }, {}, '900028'),
      'POST /trace/serial-numbers', terminal)).rejects.toMatchObject({ status: 401 });
  });
});
