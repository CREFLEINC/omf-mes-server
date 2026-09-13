import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { assertTerminalMaintenanceScope } from './terminal-maintenance-scope';

describe('mobile breakdown photo scope', () => {
  const terminal = { terminalId: 7n, terminalCode: 'M-7', plantId: 3n,
    terminalTypeCode: 'MOBILE', equipmentId: null };
  const prisma = {
    breakdown: { findFirst: jest.fn().mockResolvedValue({ breakdown_id: 1n }) },
    worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 9n }) },
    equipment: { findFirst: jest.fn().mockResolvedValue({ equipment_id: 5n }) },
    equipment_inspection_item_assignment: { count: jest.fn().mockResolvedValue(1) },
    equipment_downtime: { findFirst: jest.fn().mockResolvedValue({ equipment_downtime_id: 2n }) },
    mold: { findFirst: jest.fn().mockResolvedValue({ mold_id: 3n }) },
    work_order: { findFirst: jest.fn().mockResolvedValue({ work_order_id: 4n }) },
  } as unknown as PrismaService;
  const request = { params: { breakdownId: '1' }, headers: { 'x-worker-no': '900028' } } as unknown as Request;

  it('requires both same-plant breakdown and active same-plant worker', async () => {
    await expect(assertTerminalMaintenanceScope(prisma, request,
      'POST /maintenance/breakdowns/{breakdownId}/attachments', terminal))
      .resolves.toBeUndefined();
    expect(prisma.breakdown.findFirst).toHaveBeenCalledWith({
      where: { breakdown_id: 1n, equipment: { plant_id: 3n } }, select: { breakdown_id: true },
    });
    (prisma.breakdown.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalMaintenanceScope(prisma, request,
      'POST /maintenance/breakdowns/{breakdownId}/attachments', terminal))
      .rejects.toMatchObject({ status: 401 });
  });

  it('binds POP downtime and tool usage to self equipment, own mold, and mapped W/O', async () => {
    const pop = { ...terminal, terminalTypeCode: 'POP', equipmentId: 5n };
    await expect(assertTerminalMaintenanceScope(prisma,
      { body: { equipmentId: 5, breakdownId: 1 }, headers: request.headers, params: {} } as unknown as Request,
      'POST /maintenance/downtimes', pop)).resolves.toBeUndefined();
    await expect(assertTerminalMaintenanceScope(prisma,
      { body: { equipmentId: 6 }, headers: request.headers, params: {} } as unknown as Request,
      'POST /maintenance/downtimes', pop)).rejects.toMatchObject({ status: 401 });
    await expect(assertTerminalMaintenanceScope(prisma,
      { body: { moldId: 3, workOrderId: 4 }, headers: request.headers, params: {} } as unknown as Request,
      'POST /maintenance/tool-usages', pop)).resolves.toBeUndefined();
    expect(prisma.work_order.findFirst).toHaveBeenCalledWith({ where: {
      work_order_id: 4n, production_line: { plant_id: 3n },
      routing_operation: { process: { terminal_process: { some: {
        terminal_id: 7n, can_start_work: true,
      } } } },
    }, select: { work_order_id: true } });
  });

  it('checks every mobile inspection item assignment before accepting the write', async () => {
    const inspection = { body: { equipmentId: 5, lines: [{ inspectionItemId: 11 }] },
      headers: request.headers, params: {} } as unknown as Request;
    await expect(assertTerminalMaintenanceScope(prisma, inspection,
      'POST /maintenance/inspections', terminal)).resolves.toBeUndefined();
    (prisma.equipment_inspection_item_assignment.count as jest.Mock).mockResolvedValueOnce(0);
    await expect(assertTerminalMaintenanceScope(prisma, inspection,
      'POST /maintenance/inspections', terminal)).rejects.toMatchObject({ status: 401 });
  });
});
