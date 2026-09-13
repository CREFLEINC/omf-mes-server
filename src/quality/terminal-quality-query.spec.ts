import { PrismaService } from '../prisma/prisma.service';
import { TerminalQualityReadScope } from '../auth/terminal-quality-read-scope';
import { DefectRecordService } from './defect/defect-record.service';
import { InspectionRequestService } from './inspection/inspection-request.service';

const scope: TerminalQualityReadScope = { plantId: 3n, terminalId: 7n, terminalTypeCode: 'POP' };

describe('quality query terminal filters', () => {
  it('intersects the POP inspection request list with its mapped process on both rows and count', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const service = new InspectionRequestService({ inspection_request: { findMany, count } } as unknown as PrismaService);
    await service.list({ workOrderId: 42, pendingOnly: true }, scope);
    const where = findMany.mock.calls[0][0].where;
    expect(count.mock.calls[0][0].where).toEqual(where);
    expect(where.work_order).toEqual({
      production_line: { plant_id: 3n },
      routing_operation: { process: { terminal_process: {
        some: { terminal_id: 7n, can_start_work: true },
      } } },
    });
    expect(where.work_order_id).toBe(42);
  });

  it('intersects MOBILE defect records with LOT ownership while preserving the scanned LOT and date range', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const service = new DefectRecordService({ defect_record: { findMany, count } } as unknown as PrismaService);
    await service.list({ lotId: 6, detectedFrom: '2026-09-01T00:00:00Z', detectedTo: '2026-09-13T00:00:00Z' },
      { ...scope, terminalTypeCode: 'MOBILE' });
    const where = findMany.mock.calls[0][0].where;
    expect(count.mock.calls[0][0].where).toEqual(where);
    expect(where.lot).toEqual({ plant_id: 3n });
    expect(where.lot_id).toBe(6);
    expect(where.detected_at).toEqual({
      gte: new Date('2026-09-01T00:00:00Z'), lt: new Date('2026-09-13T00:00:00Z'),
    });
  });
});
