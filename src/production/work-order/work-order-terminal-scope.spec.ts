import { PrismaService } from '../../prisma/prisma.service';
import type { TerminalContext } from '../../auth/terminal-context';
import { WorkOrderQueryService } from './work-order-query.service';

describe('POP work-order list scope', () => {
  const terminal: TerminalContext = {
    terminalId: 7n, terminalCode: 'POP-7', plantId: 3n, terminalTypeCode: 'POP', equipmentId: 5n,
  };

  it('intersects all-view with same plant and can_start_work process mappings', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = {
      terminal_process: { findMany: jest.fn().mockResolvedValue([{ process_id: 13n }, { process_id: 17n }]) },
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ work_order: { findMany, count } })),
      integration_message: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new WorkOrderQueryService(prisma);
    await service.list({ open: true, withProgress: false, page: 1, size: 20 }, terminal);
    expect(prisma.terminal_process.findMany).toHaveBeenCalledWith({
      where: { terminal_id: 7n, can_start_work: true }, select: { process_id: true },
    });
    expect(findMany.mock.calls[0][0].where).toEqual({ AND: [
      { AND: [{ released_at: { not: null }, completed_at: null, closed_at: null,
        NOT: { status_code: 'CANCELLED' } }] },
      { production_line: { plant_id: 3n } },
      { routing_operation: { process_id: { in: [13n, 17n] } } },
    ] });
  });
});
