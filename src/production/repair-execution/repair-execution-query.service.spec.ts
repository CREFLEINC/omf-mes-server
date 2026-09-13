import { PrismaService } from '../../prisma/prisma.service';
import { RepairExecutionQueryService } from './repair-execution-query.service';

describe('RepairExecutionQueryService terminal list scope', () => {
  it('applies plant ownership to both open-list rows and count', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const service = new RepairExecutionQueryService({
      repair_execution: { findMany, count },
    } as unknown as PrismaService);
    await service.list({ open: true, page: 1, size: 20 }, 3n);
    const expected = { returned_at: null, OR: [
      { defect_record: { lot: { plant_id: 3n }, OR: [
        { work_order_id: null },
        { work_order: { production_line: { plant_id: 3n } } },
      ] } },
      { defect_record: { lot_id: null, work_order: { production_line: { plant_id: 3n } } } },
    ] };
    expect(findMany.mock.calls[0][0].where).toEqual(expected);
    expect(count.mock.calls[0][0].where).toEqual(expected);
  });
});
