import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { BreakdownQueryService, downtimeAggregate } from './breakdown-query.service';
import { BreakdownRow } from './breakdown-view';

describe('BreakdownQueryService', () => {
  const raw = jest.fn();
  const findMany = jest.fn();
  const findUnique = jest.fn();
  const tx = { $queryRaw: raw, breakdown: { findMany, findUnique } };
  const transaction = jest.fn(
    async (
      work: (client: typeof tx) => Promise<unknown>,
      _options?: { isolationLevel: string },
    ) => work(tx),
  );
  const service = new BreakdownQueryService({ $transaction: transaction } as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it('필터·미발행 두 원천·count/page·정렬을 같은 스냅샷에서 처리한다', async () => {
    raw
      .mockResolvedValueOnce([
        { plant_id: 10n, timezone_code: 'Asia/Ho_Chi_Minh', has_missing_time: false },
      ])
      .mockResolvedValueOnce([{ breakdown_id: 5n }])
      .mockResolvedValueOnce([{ total: 1n }])
      .mockResolvedValueOnce([
        { breakdown_id: 5n, maintenance_order_id: 7n },
        { breakdown_id: 5n, maintenance_order_id: 7n },
      ]);
    findMany.mockResolvedValue([breakdownRow()]);
    const result = await service.list({
      equipmentId: 2,
      statusCode: 'RECEIVED',
      openOnly: false,
      reportedFrom: '2026-09-01',
      reportedTo: '2026-09-01',
      withoutMaintenanceOrder: true,
      sort: 'elapsedDesc',
    });
    const [metadata, ids, count, links] = raw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    const whereOf = (sql: Prisma.Sql): string =>
      sql.sql.slice(sql.sql.indexOf('WHERE ')).split('ORDER BY')[0].trim();
    expect(whereOf(ids)).toBe(whereOf(count));
    expect(metadata.sql).toContain('bool_or(b.reported_at IS NULL)');
    expect(ids.sql).toContain('ORDER BY b.reported_at ASC, b.breakdown_id ASC');
    expect(ids.sql).toContain('maintenance.maintenance_order o');
    expect(ids.sql).toContain('maintenance.maintenance_order_trigger t');
    expect(links.sql).toContain('UNION');
    expect(result.items[0].handling.maintenanceOrderId).toBe(7);
    expect(result.totalCount).toBe(result.page.total);
    expect(transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
  });

  it('기본 openOnly는 DONE을 AND하고 unknown status는 그대로 바인딩한다', async () => {
    raw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);
    findMany.mockResolvedValue([]);
    await service.list({ statusCode: "UNKNOWN' --" });
    const sql = raw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain("b.status_code <> 'DONE'");
    expect(sql.sql).not.toContain("UNKNOWN' --");
    expect(sql.values).toContain("UNKNOWN' --");
  });

  it('openOnly=false는 without 플래그와 무관하게 기간 두 칸을 요구한다', async () => {
    await expect(
      service.list({ openOnly: false, withoutMaintenanceOrder: true }),
    ).rejects.toMatchObject({
      errors: [
        { field: 'reportedFrom', code: 'REQUIRED' },
        { field: 'reportedTo', code: 'REQUIRED' },
      ],
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('미지원 sort는 INVALID이고 역전은 DB·시간대를 평가하지 않는다', async () => {
    await expect(service.list({ sort: 'newest' })).rejects.toMatchObject({
      errors: [{ field: 'sort', code: 'INVALID' }],
    });
    const result = await service.list({
      reportedFrom: '2026-09-02',
      reportedTo: '2026-09-01',
    });
    expect(result.totalCount).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('상세는 직접·트리거 복수 연결을 null로 두고 숫자 ETag 원천을 분리한다', async () => {
    findUnique.mockResolvedValue(breakdownRow());
    raw
      .mockResolvedValueOnce([
        { breakdown_id: 5n, maintenance_order_id: 7n },
        { breakdown_id: 5n, maintenance_order_id: 8n },
      ])
      .mockResolvedValueOnce([
        {
          linked_downtime_count: 2,
          open_linked_downtime_count: 1,
          closed_seconds: new Prisma.Decimal('60'),
        },
      ]);
    const result = await service.get(5);
    expect(result.versionNo).toBe(11);
    expect(result.view.handling.maintenanceOrderId).toBeNull();
    expect(result.view).toMatchObject({
      linkedDowntimeCount: 2,
      linkedDowntimeMinutes: 1,
      openLinkedDowntimeCount: 1,
    });
  });

  it('없는 상세은 404다', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.get(404)).rejects.toMatchObject({ status: 404 });
    expect(raw).not.toHaveBeenCalled();
  });
});

describe('downtimeAggregate', () => {
  it.each([
    ['0', 0],
    ['120', 2],
    ['60.000001', null],
    ['1', null],
  ])('초 합계 %s를 먼저 더한 뒤 정수 분 여부를 판단한다', (seconds, minutes) => {
    expect(
      downtimeAggregate({
        linked_downtime_count: 1,
        open_linked_downtime_count: 0,
        closed_seconds: new Prisma.Decimal(seconds),
      }).linkedDowntimeMinutes,
    ).toBe(minutes);
  });
});

function breakdownRow(): BreakdownRow {
  return {
    breakdown_id: 5n,
    breakdown_no: 'MLF-5',
    equipment_id: 2n,
    reported_at: new Date('2026-09-01T00:00:00Z'),
    reported_by: null,
    symptom_code: null,
    description: '누유',
    severity_code: null,
    status_code: 'RECEIVED',
    started_at: null,
    completed_at: null,
    root_cause: null,
    occurrence_state_code: 'ABNORMAL',
    stopped_at: null,
    notify_assignee: true,
    reporter_worker_no: 'W-1',
    cause_code: null,
    handling_note: null,
    handled_by: null,
    handled_at: null,
    created_at: new Date(),
    created_by: null,
    updated_at: new Date(),
    updated_by: null,
    version_no: 11,
    equipment: { equipment_code: 'EQ-1' },
  };
}
