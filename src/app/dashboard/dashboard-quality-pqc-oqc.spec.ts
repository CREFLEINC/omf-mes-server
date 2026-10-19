import { OPEN_LIST_LIMIT, REPEATED_ITEM_LIMIT, openNonconformance, repeatedItem } from './dashboard-nonconformance-open';
import { dailyReturnOut, returnReasons } from './dashboard-quality-pqc-oqc';
import { dashboardPeriod } from './dashboard-scope';

describe('dashboard quality PQC·OQC extras', () => {
  it('반품 사유는 수량 큰 순, 같으면 코드 순이고 사유 없는 줄은 끝이다', () => {
    expect(
      returnReasons([
        { reason_code: 'CLAIM', reason_name: '클레임', qty: '5.000000' },
        { reason_code: null, reason_name: null, qty: '5' },
        { reason_code: 'SUPPLIER_RETURN_OUT', reason_name: '공급사반품', qty: '10' },
        { reason_code: 'CUSTOMER_RETURN', reason_name: '고객반품', qty: '5' },
      ]),
    ).toEqual([
      { reasonCode: 'SUPPLIER_RETURN_OUT', reasonName: '공급사반품', qty: 10 },
      { reasonCode: 'CLAIM', reasonName: '클레임', qty: 5 },
      { reasonCode: 'CUSTOMER_RETURN', reasonName: '고객반품', qty: 5 },
      { reasonCode: null, reasonName: null, qty: 5 },
    ]);
  });

  it('일별 공급사 반품 출고는 일별 합격률과 같은 날짜 목록이고, 기록 없는 날은 null 이다', () => {
    const period = dashboardPeriod({ from: '2026-09-20', to: '2026-09-20' });
    const daily = dailyReturnOut([{ local_date: '2026-09-12', qty: '3' }, { local_date: '2026-09-13', qty: '0' }], period);
    expect(daily.map((row) => row.date)).toEqual(period.chartDays);
    expect(daily.slice(0, 3)).toEqual([
      { date: '2026-09-12', qty: 3 },
      { date: '2026-09-13', qty: 0 },
      { date: '2026-09-14', qty: null },
    ]);
  });

  it('반복 부적합 품목 줄 — 숫자 id · ISO 시각, 상한 5', () => {
    expect(REPEATED_ITEM_LIMIT).toBe(5);
    expect(
      repeatedItem({ item_id: 3n, item_code: 'A', item_name: 'B', nc_count: 2, last_opened_at: new Date('2026-10-02T00:00:00Z') }),
    ).toEqual({ itemId: 3, itemCode: 'A', itemName: 'B', ncCount: 2, lastOpenedAt: '2026-10-02T00:00:00.000Z' });
  });

  it('미종결 부적합 줄 — id 를 숫자로, 시각을 ISO 로, 없는 이름은 null 그대로 옮기고 상한은 5 다', () => {
    expect(OPEN_LIST_LIMIT).toBe(5);
    expect(
      openNonconformance({
        nonconformance_id: 9n,
        nonconformance_no: 'NC-1',
        item_code: null,
        item_name: null,
        severity_code: 'MAJOR',
        severity_name: null,
        status_code: 'OPEN',
        status_name: '접수',
        opened_at: new Date('2026-10-01T00:00:00Z'),
      }),
    ).toEqual({
      nonconformanceId: 9,
      nonconformanceNo: 'NC-1',
      itemCode: null,
      itemName: null,
      severityCode: 'MAJOR',
      severityName: null,
      statusCode: 'OPEN',
      statusName: '접수',
      openedAt: '2026-10-01T00:00:00.000Z',
    });
  });
});
