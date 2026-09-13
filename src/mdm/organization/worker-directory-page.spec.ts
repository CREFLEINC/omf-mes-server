import { WorkerService } from './worker.service';

describe('worker directory page size', () => {
  const prisma = {
    worker: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const service = new WorkerService(prisma as never);

  it('serves a 500-worker plant directory without global pagination truncation', async () => {
    const result = await service.list({ plantId: 3, includeInactive: false, page: 2, size: 500 });
    expect(prisma.worker.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ plant_id: 3 }),
      skip: 500,
      take: 500,
    }));
    expect(result.page).toEqual({ page: 2, size: 500, total: 0 });
  });

  it('still caps the worker route at 500', async () => {
    const result = await service.list({ plantId: 3, size: 501 });
    expect(result.page.size).toBe(500);
  });
});
