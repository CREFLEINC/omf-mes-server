import { Prisma } from '@prisma/client';

import { PlannedLine, distributeShortage, openQty, plannedLines, sumPlanned } from './planned-stock';

const d = (value: number) => new Prisma.Decimal(value);

function line(over: Partial<Omit<PlannedLine, 'plannedQty'>> & { plannedQty: number }): PlannedLine {
  return {
    warehouseId: 1n,
    itemId: 10n,
    requestId: 100n,
    requestLineId: 1000n,
    issueWorkDate: new Date('2026-11-13T00:00:00Z'),
    ...over,
    plannedQty: d(over.plannedQty),
  };
}

describe('출고 예정 재고', () => {
  it('줄 예정 = 요청 − 집은 양, 더 집었으면 0', () => {
    expect(openQty(d(70), d(0)).toNumber()).toBe(70);
    expect(openQty(d(70), d(30)).toNumber()).toBe(40);
    expect(openQty(d(70), d(80)).toNumber()).toBe(0);
  });

  it('활성(대기·배포)·닫히지 않음·출발 창고 있음만 센다 — 옛 요청·취소·닫힘·취소된 피킹은 뺀다', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        material_issue_request_line_id: 1000n,
        item_id: 10n,
        requested_qty: d(70),
        material_issue_request: { material_issue_request_id: 100n, source_warehouse_id: 1n, issue_work_date: null },
        picking_line: [{ picked_qty: d(20) }, { picked_qty: d(10) }],
      },
    ]);
    const db = { material_issue_request_line: { findMany } } as unknown as Prisma.TransactionClient;

    const lines = await plannedLines(db, { warehouseIds: [1n], itemIds: [10n] });

    expect(lines.map((l) => l.plannedQty.toNumber())).toEqual([40]);
    const where = findMany.mock.calls[0][0].where;
    expect(where.material_issue_request).toMatchObject({
      status_code: { in: ['WAITING', 'REGISTERED'] },
      closed_at: null,
      source_warehouse_id: { in: [1n] },
    });
    expect(findMany.mock.calls[0][0].select.picking_line.where).toEqual({
      picking_order: { status_code: { not: 'CANCELLED' } },
    });
  });

  it('US4-9 예정은 (창고, 품목)별로 갈린다 — A 의 예정이 B 에 섞이지 않는다', () => {
    const sums = sumPlanned([
      line({ warehouseId: 1n, plannedQty: 70 }),
      line({ warehouseId: 2n, plannedQty: 30, requestLineId: 1001n }),
      line({ warehouseId: 1n, plannedQty: 5, requestLineId: 1002n }),
    ]);
    expect(sums.get('1:10')?.toNumber()).toBe(75);
    expect(sums.get('2:10')?.toNumber()).toBe(30);
  });

  it('FR-018 동적 부족은 출고 작업일이 늦은 줄부터, 줄의 예정을 넘지 않게 나눈다', () => {
    const early = line({ requestLineId: 1n, requestId: 11n, plannedQty: 50, issueWorkDate: new Date('2026-11-10T00:00:00Z') });
    const late = line({ requestLineId: 2n, requestId: 12n, plannedQty: 30, issueWorkDate: new Date('2026-11-20T00:00:00Z') });
    const result = distributeShortage(d(40), [early, late]);
    expect(result.map((r) => [r.requestLineId, r.shortageQty.toNumber()])).toEqual([
      [2n, 30],
      [1n, 10],
    ]);
  });

  it('FR-018 같은 출고 작업일이면 나중에 만든 줄부터 · 초과가 없으면 비어 있다', () => {
    const a = line({ requestLineId: 1n, plannedQty: 20 });
    const b = line({ requestLineId: 2n, plannedQty: 20 });
    expect(distributeShortage(d(5), [a, b]).map((r) => r.requestLineId)).toEqual([2n]);
    expect(distributeShortage(d(0), [a, b])).toEqual([]);
  });
});
