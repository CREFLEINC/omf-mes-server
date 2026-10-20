import { Prisma } from '@prisma/client';

import type { DashboardPlant } from './dashboard-availability.service';
import { CONFIRMED_INSPECTION_RECORD, DashboardNonconformanceService } from './dashboard-nonconformance.service';
import { dashboardPeriod } from './dashboard-scope';

/** omf-all-around#124 — 불량현상 파레토·원인 대분류는 확정 전 검사 결과의 기록을 세지 않는다. */
describe('DashboardNonconformanceService — 불량 기록 모집단', () => {
  const plant = { plantId: 3n, timezone: 'Asia/Ho_Chi_Minh' } as DashboardPlant;

  it('확정 조건은 결과 없는 기록을 남기고 결과가 CONFIRMED 인 기록만 더한다', () => {
    expect(CONFIRMED_INSPECTION_RECORD.sql.replace(/\s+/g, ' ')).toBe(
      "(dr.inspection_result_id IS NULL OR EXISTS ( SELECT 1 FROM quality.inspection_result ir WHERE ir.inspection_result_id = dr.inspection_result_id AND ir.status_code = 'CONFIRMED'))",
    );
  });

  it('현상·원인 두 조회가 모두 확정 조건을 건다 — 월 수치 조회는 불량 기록을 읽지 않는다', async () => {
    const queries: Prisma.Sql[] = [];
    const tx = {
      $queryRaw: jest.fn((query: Prisma.Sql) => {
        queries.push(query);
        return Promise.resolve([]);
      }),
    } as unknown as Prisma.TransactionClient;

    await new DashboardNonconformanceService().read(tx, [plant], dashboardPeriod({ from: '2026-10-20', to: '2026-10-20' }));

    const defectQueries = queries.filter((query) => query.sql.includes('quality.defect_record'));
    expect(defectQueries).toHaveLength(2);
    for (const query of defectQueries) expect(query.sql).toContain(CONFIRMED_INSPECTION_RECORD.sql);
  });
});
