import { NonconformanceQueryService } from './nonconformance-query.service';

/** `withoutInspectionRequestOnly`(omf-all-around#354) — 검사 건에 묶이지 않은 부적합만 거른다. */
describe('NonconformanceQueryService.list — withoutInspectionRequestOnly', () => {
  const PERIOD = { openedFrom: '2026-11-01T00:00:00+09:00', openedTo: '2026-11-30T00:00:00+09:00' };

  const setup = () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = { nonconformance: { findMany, count } };
    const service = new NonconformanceQueryService(prisma as never);
    return { service, findMany, count };
  };

  it('참이면 검사 의뢰가 없는 부적합만 목록 · 건수 모두에 건다', async () => {
    const { service, findMany, count } = setup();

    await service.list({ ...PERIOD, withoutInspectionRequestOnly: true });

    const where = findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ inspection_request_id: null });
    expect(count.mock.calls[0][0].where).toEqual(where);
  });

  it('주지 않거나 거짓이면 검사 의뢰로 거르지 않는다 — 기존 조회 그대로', async () => {
    for (const query of [PERIOD, { ...PERIOD, withoutInspectionRequestOnly: false }]) {
      const { service, findMany } = setup();

      await service.list(query);

      expect(findMany.mock.calls[0][0].where.AND).not.toContainEqual({ inspection_request_id: null });
    }
  });
});
